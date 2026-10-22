import { describe, expect, it, vi } from "vitest";
import { mercariAdapter } from "../packages/adapters/src/mercari";
import { createDpopSigner } from "../packages/adapters/src/mercari/dpop";
import { normalizeMercariListing } from "../packages/adapters/src/mercari/normalize";
import { buildMercariSearchPayload } from "../packages/adapters/src/mercari/payload";
import { normalizedListingSchema } from "../packages/validation/src";
import itemAuctionFixture from "./fixtures/mercari/item-auction.json";
import searchAuctionsFixture from "./fixtures/mercari/search-auctions.json";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jwtPart(proof: string, index: number): Record<string, unknown> {
  const part = proof.split(".")[index] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("Mercari shared fixed-price and auction source", () => {
  it("binds every DPoP proof and search body to one request-scoped device UUID", async () => {
    const signer = await createDpopSigner();
    const url = "https://api.mercari.jp/v2/entities:search";
    const first = await signer.createProof("POST", url);
    const second = await signer.createProof("POST", url);
    const firstPayload = jwtPart(first, 1);
    const secondPayload = jwtPart(second, 1);

    expect(firstPayload).toMatchObject({ htm: "POST", htu: url, uuid: signer.deviceUuid });
    expect(secondPayload).toMatchObject({ htm: "POST", htu: url, uuid: signer.deviceUuid });
    expect(firstPayload.jti).not.toBe(secondPayload.jti);
    expect(Buffer.from(first.split(".")[2] ?? "", "base64url")).toHaveLength(64);

    const body = buildMercariSearchPayload({ keyword: "オークション" }, signer.deviceUuid);
    expect(body).toMatchObject({ withAuction: true, laplaceDeviceUuid: signer.deviceUuid });
  });

  it("requests mixed results and preserves only safe fixed-price and auction facts", async () => {
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return jsonResponse(searchAuctionsFixture);
    }) as unknown as typeof fetch;

    const result = await mercariAdapter.search(
      { query: "Mercari 商品", filters: { availabilityMode: "all", pageSize: 30 } },
      { fetch: fetcher, secrets: {} },
    );
    const headers = new Headers(requestInit?.headers);
    const requestBody = JSON.parse(String(requestInit?.body)) as {
      withAuction?: boolean;
      laplaceDeviceUuid?: string;
    };
    const proofPayload = jwtPart(headers.get("dpop") ?? "", 1);

    expect(headers.get("x-country-code")).toBe("JP");
    expect(requestBody.withAuction).toBe(true);
    expect(requestBody.laplaceDeviceUuid).toBe(proofPayload.uuid);
    expect(result).toMatchObject({
      sourceId: "mercari_jp",
      parserVersion: "mercari-internal-v2",
      nextCursor: "auction:v1:1",
      totalAvailable: 2,
    });
    expect(result.listings).toHaveLength(2);
    expect(result.listings[0]).toMatchObject({
      sourceItemId: "m11111111111",
      currentPrice: 1650,
      rawMetadata: { saleMode: "fixed_price", priceType: "fixed" },
      facts: {
        displayFacts: [{ key: "mercari.sale_mode", value: "普通一口价出品" }],
      },
    });
    expect(result.listings[1]).toMatchObject({
      sourceItemId: "m22222222222",
      currentPrice: 6100,
      rawMetadata: {
        saleMode: "auction",
        priceType: "current_bid",
        startingPrice: 6000,
        bidCount: 1,
        auctionState: "unknown",
        auctionEndAt: "2026-07-15T11:00:00.000Z",
      },
    });
    expect(result.listings[1]?.facts?.displayFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mercari.sale_mode", value: "普通拍卖" }),
      expect.objectContaining({ key: "mercari.price_type", value: "当前最高出价" }),
      expect.objectContaining({ key: "mercari.starting_price", value: "￥6,000" }),
      expect.objectContaining({ key: "mercari.bid_count", value: "1 次" }),
    ]));
    result.listings.forEach((listing) => expect(normalizedListingSchema.safeParse(listing).success).toBe(true));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("must-not-leak-seller");
    expect(serialized).not.toContain("must-not-leak-buyer");
    expect(serialized).not.toContain("must-not-leak-auction-id");
  });

  it("requests auction detail with an exact signed URL and normalizes flash-auction state", async () => {
    let requestedUrl = "";
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestInit = init;
      return jsonResponse(itemAuctionFixture);
    }) as unknown as typeof fetch;

    const listing = await mercariAdapter.getItem!("m33333333333", { fetch: fetcher, secrets: {} });
    const requested = new URL(requestedUrl);
    const proofPayload = jwtPart(new Headers(requestInit?.headers).get("dpop") ?? "", 1);

    expect(requested.searchParams.get("id")).toBe("m33333333333");
    expect(requested.searchParams.get("include_auction")).toBe("true");
    expect(proofPayload).toMatchObject({ htm: "GET", htu: requestedUrl });
    expect(listing).toMatchObject({
      sourceItemId: "m33333333333",
      currentPrice: 6100,
      sellerName: "公开卖家名",
      rawMetadata: {
        saleMode: "flash_auction",
        priceType: "current_bid",
        startingPrice: 6000,
        bidCount: 1,
        auctionState: "ongoing",
        auctionTypeRaw: "AUCTION_TYPE_FLASH",
        auctionStateRaw: "STATE_ONGOING",
        auctionStartAt: "2026-07-14T22:00:29.000Z",
        auctionEndAt: "2026-07-15T11:00:00.000Z",
      },
    });
    expect(listing.facts?.displayFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mercari.sale_mode", value: "3 小时拍卖" }),
      expect.objectContaining({ key: "mercari.auction_state", value: "竞拍中" }),
    ]));
    expect(normalizedListingSchema.safeParse(listing).success).toBe(true);
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toContain("must-not-leak-seller");
    expect(serialized).not.toContain("must-not-leak-buyer");
    expect(serialized).not.toContain("must-not-leak-auction-id");
  });

  it("reports the starting price when a no-bid auction has a zero highest bid", () => {
    const listing = normalizeMercariListing({
      id: "m55555555555",
      name: "暂无出价的拍卖",
      status: "on_sale",
      price: "0",
      auction: {
        state: "STATE_NO_BID",
        highestBid: 0,
        initialPrice: 6000,
        totalBid: 0,
      },
    });

    expect(listing.currentPrice).toBe(6000);
    expect(listing.rawMetadata).toMatchObject({
      saleMode: "auction",
      priceType: "current_bid",
      startingPrice: 6000,
      bidCount: 0,
      auctionState: "no_bid",
    });
    expect(listing.facts?.displayFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mercari.starting_price", value: "￥6,000" }),
      expect.objectContaining({ key: "mercari.auction_state", value: "暂无出价" }),
    ]));
    expect(normalizedListingSchema.safeParse(listing).success).toBe(true);
  });

  it("never accepts a partially numeric auction amount", () => {
    const listing = normalizeMercariListing({
      id: "m44444444444",
      name: "格式异常的拍卖摘要",
      status: "on_sale",
      price: "6000",
      auction: {
        highestBid: "6100abc",
        initialPrice: "6000abc",
        totalBid: "1x",
      },
    });

    expect(listing.currentPrice).toBe(6000);
    expect(listing.rawMetadata).toMatchObject({ saleMode: "auction", priceType: "current_bid" });
    expect(listing.rawMetadata).not.toHaveProperty("startingPrice");
    expect(listing.rawMetadata).not.toHaveProperty("bidCount");
  });
});
