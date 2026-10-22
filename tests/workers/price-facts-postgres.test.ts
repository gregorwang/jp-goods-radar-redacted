/// <reference path="../../apps/collector/worker-configuration.d.ts" />
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  ingestAnalyticsSearchRun,
  ingestProductIdentityProjection,
  type AnalyticsSearchRun,
  type ProductIdentityProjection,
} from "@jpgr/analytics";

const runId = "81de8edb-2821-49b1-8869-bc23b79ea4d1";
const closedAuctionId = "p1closed123";
const openAuctionId = "p1open12345";
const surugayaId = "p1-surugaya-reference";
const legacySurugayaId = "p1-surugaya-legacy-reference";
const watchCanonicalProductId = `cp_${"1".repeat(24)}`;
const watchProductVariantId = `pv_${"2".repeat(24)}`;
const watchComparisonProfileId = `cmp_${"3".repeat(24)}_v1`;

function listing(input: {
  sourceId: "yahoo_auctions_jp" | "surugaya";
  sourceItemId: string;
  price: number;
  originalPrice?: number;
  priceBasis: "listing_price" | "auction_current_bid";
  availability: "available" | "sold_out";
  facts?: Record<string, unknown>;
  rawMetadata?: Record<string, unknown>;
}) {
  const canonicalUrl = input.sourceId === "yahoo_auctions_jp"
    ? `https://auctions.yahoo.co.jp/jp/auction/${input.sourceItemId}`
    : `https://www.suruga-ya.jp/product/detail/${input.sourceItemId}`;
  return {
    sourceId: input.sourceId,
    sourceItemId: input.sourceItemId,
    identityScope: "listing",
    canonicalUrl,
    title: `P1 fixture ${input.sourceItemId}`,
    productKey: `listing:${input.sourceId}:${input.sourceItemId}`,
    productMatchMethod: "listing_identity" as const,
    currency: "JPY",
    currentPrice: input.price,
    ...(input.originalPrice === undefined ? {} : { originalPrice: input.originalPrice }),
    priceBasis: input.priceBasis,
    condition: "used",
    availability: input.availability,
    facts: input.facts ?? {},
    rawMetadata: input.rawMetadata ?? {},
  };
}

function run(): AnalyticsSearchRun {
  return {
    id: runId,
    origin: "manual_search",
    query: "P1 price facts",
    queryKey: "p1 price facts",
    filters: { searchMode: "keyword", availabilityMode: "all" },
    status: "success",
    resultCount: 4,
    searchedAt: "2026-07-28T06:00:00.000Z",
    groups: [{
      sourceId: "yahoo_auctions_jp",
      status: "success",
      coverage: "best_effort",
      parserVersion: "p1-fixture",
      listings: [
        listing({
          sourceId: "yahoo_auctions_jp",
          sourceItemId: closedAuctionId,
          price: 8_800,
          priceBasis: "listing_price",
          availability: "sold_out",
          rawMetadata: {
            verifiedSaleEvidence: {
              evidenceVersion: "verified-sale-v1",
              kind: "closed_auction_with_bid",
              sourceSaleId: closedAuctionId,
              soldPriceJpy: 8_800,
              soldAt: "2026-07-28T05:50:00.000Z",
              bidCount: 4,
              sourceStatus: "CLOSED",
            },
          },
        }),
        listing({
          sourceId: "yahoo_auctions_jp",
          sourceItemId: openAuctionId,
          price: 3_000,
          priceBasis: "auction_current_bid",
          availability: "available",
        }),
      ],
    }, {
      sourceId: "surugaya",
      status: "success",
      coverage: "rolling_window",
      parserVersion: "p1-fixture",
      listings: [
        listing({
          sourceId: "surugaya",
          sourceItemId: surugayaId,
          price: 6_600,
          originalPrice: 11_000,
          priceBasis: "listing_price",
          availability: "sold_out",
          facts: {
            priceReferences: [{
              kind: "official_list",
              amountJpy: 11_000,
              currency: "JPY",
              taxStatus: "unknown",
              shippingStatus: "unknown",
              sourceLabel: "骏河屋商品详情「定価」",
            }],
          },
        }),
        listing({
          sourceId: "surugaya",
          sourceItemId: legacySurugayaId,
          price: 1_800,
          priceBasis: "listing_price",
          availability: "sold_out",
          rawMetadata: { referenceListPrice: 2_200 },
        }),
      ],
    }],
  };
}

async function client(): Promise<Client> {
  const connection = new Client({ connectionString: env.ANALYTICS_DB.connectionString });
  await connection.connect();
  return connection;
}

afterEach(async () => {
  const connection = await client();
  try {
    await connection.query(
      "DELETE FROM radar_analytics.source_listings WHERE source_item_id=ANY($1::text[])",
      [[closedAuctionId, openAuctionId, surugayaId, legacySurugayaId]],
    );
    await connection.query("DELETE FROM radar_analytics.search_runs WHERE id=$1::uuid", [runId]);
    await connection.query(
      "DELETE FROM radar_analytics.product_variants WHERE id=$1",
      [watchProductVariantId],
    );
    await connection.query(
      "DELETE FROM radar_analytics.canonical_products WHERE id=$1",
      [watchCanonicalProductId],
    );
  } finally {
    await connection.end();
  }
});

describe("P1 PostgreSQL price facts", () => {
  it("ingests auction bids, explicit list prices, and strict verified sales without mixing their roles", async () => {
    await ingestAnalyticsSearchRun(env.ANALYTICS_DB.connectionString, run());
    await ingestAnalyticsSearchRun(env.ANALYTICS_DB.connectionString, run());

    const connection = await client();
    try {
      const facts = await connection.query<{
        source_item_id: string;
        price_role: string;
        amount_jpy: number;
        price_basis: string;
        knowledge_at: Date;
      }>(
        `SELECT source_item_id,price_role,amount_jpy,price_basis,knowledge_at
         FROM radar_analytics.strategy_price_facts_v1
         WHERE source_item_id=ANY($1::text[])
         ORDER BY source_item_id,price_role`,
        [[closedAuctionId, openAuctionId, surugayaId, legacySurugayaId]],
      );
      expect(facts.rows.map((row) => ({
        sourceItemId: row.source_item_id,
        role: row.price_role,
        amount: row.amount_jpy,
        basis: row.price_basis,
        hasKnowledgeTime: row.knowledge_at instanceof Date,
      }))).toEqual([
        {
          sourceItemId: legacySurugayaId,
          role: "official_list",
          amount: 2_200,
          basis: "listing_price",
          hasKnowledgeTime: true,
        },
        {
          sourceItemId: legacySurugayaId,
          role: "source_sold_status_price",
          amount: 1_800,
          basis: "listing_price",
          hasKnowledgeTime: true,
        },
        {
          sourceItemId: surugayaId,
          role: "official_list",
          amount: 11_000,
          basis: "listing_price",
          hasKnowledgeTime: true,
        },
        {
          sourceItemId: surugayaId,
          role: "source_sold_status_price",
          amount: 6_600,
          basis: "listing_price",
          hasKnowledgeTime: true,
        },
        {
          sourceItemId: closedAuctionId,
          role: "source_sold_status_price",
          amount: 8_800,
          basis: "listing_price",
          hasKnowledgeTime: true,
        },
        {
          sourceItemId: closedAuctionId,
          role: "verified_sale",
          amount: 8_800,
          basis: "listing_price",
          hasKnowledgeTime: true,
        },
        {
          sourceItemId: openAuctionId,
          role: "auction_current_bid",
          amount: 3_000,
          basis: "auction_current_bid",
          hasKnowledgeTime: true,
        },
      ]);
      const sales = await connection.query<{ source_item_id: string; count: number }>(
        `SELECT listing.source_item_id,count(*)::int AS count
         FROM radar_analytics.sale_records AS sale
         JOIN radar_analytics.source_listings AS listing ON listing.id=sale.source_listing_id
         WHERE listing.source_item_id=ANY($1::text[])
         GROUP BY listing.source_item_id`,
        [[closedAuctionId, openAuctionId, surugayaId, legacySurugayaId]],
      );
      expect(sales.rows).toEqual([{ source_item_id: closedAuctionId, count: 1 }]);
      const unsafeAmounts = await connection.query<{ malformed: number | null; too_large: number | null }>(
        `SELECT radar_analytics.safe_positive_jpy('not-a-price') AS malformed,
                radar_analytics.safe_positive_jpy('1000000001') AS too_large`,
      );
      expect(unsafeAmounts.rows[0]).toEqual({ malformed: null, too_large: null });
    } finally {
      await connection.end();
    }
  });

  it("retries watch identity projections until their search run and listings are present", async () => {
    const projection: ProductIdentityProjection = {
      projectionId: `pip_${"4".repeat(32)}`,
      projectionHash: "4".repeat(64),
      workflowTaskId: "watch:gemini-p1-fixture",
      searchHistoryId: runId,
      identityVersion: "product-identity-v1",
      membershipVersion: "product-listing-membership-v1",
      projectedAt: "2026-07-28T06:01:00.000Z",
      canonicalProduct: {
        id: watchCanonicalProductId,
        identityHash: "1".repeat(64),
        identityVersion: "product-identity-v1",
        canonicalName: "P1 watch fixture",
        characterNames: [],
        targetFingerprint: {},
      },
      productVariant: {
        id: watchProductVariantId,
        canonicalProductId: watchCanonicalProductId,
        identityHash: "2".repeat(64),
        identityVersion: "product-identity-v1",
        variantName: "P1 watch fixture",
        attributes: {},
        targetFingerprint: {},
      },
      comparisonProfile: {
        id: watchComparisonProfileId,
        profileVersion: 1,
        ruleVersion: "product-comparison-rules-v1",
        name: "P1 watch fixture",
        conditionPolicy: "broad_public_asking_price",
        allowedConditions: ["used"],
        allowedCompleteness: ["unknown"],
        allowedPriceBases: ["listing_price"],
        allowedOfficialStatuses: ["unknown"],
      },
      memberships: [{
        id: `pm_${"5".repeat(32)}`,
        sourceId: "surugaya",
        sourceItemId: surugayaId,
        decision: "confirmed",
        decisionSource: "workflow_matcher",
        relation: "exact",
        confidence: "high",
        evidence: { origin: "exact_product_watch" },
      }],
    };

    await expect(ingestProductIdentityProjection(
      env.ANALYTICS_DB.connectionString,
      projection,
    )).rejects.toThrow("analytics_watch_identity_dependencies_pending");

    await ingestAnalyticsSearchRun(env.ANALYTICS_DB.connectionString, run());
    await expect(ingestProductIdentityProjection(
      env.ANALYTICS_DB.connectionString,
      projection,
    )).resolves.toBeUndefined();

    const connection = await client();
    try {
      const membership = await connection.query<{
        decision: string;
        search_run_id: string;
      }>(
        `SELECT decision,search_run_id::text
         FROM radar_analytics.product_listing_memberships
         WHERE id=$1`,
        [projection.memberships[0]!.id],
      );
      expect(membership.rows).toEqual([{
        decision: "confirmed",
        search_run_id: runId,
      }]);
    } finally {
      await connection.end();
    }
  });
});
