import { describe, expect, it } from "vitest";
import { parseSurugayaResponse } from "../../packages/adapters/src/surugaya/parser";

describe("Surugaya Worker parser", () => {
  it("decodes HTML entities in image URLs returned by HTMLRewriter", async () => {
    expect(typeof HTMLRewriter).toBe("function");

    const html = `<!doctype html>
      <html lang="ja"><body><div id="search_result"><div class="item_box"><div class="item">
        <div class="photo_box"><p class="thum">
          <a href="/product/detail/120139149"><img src="https://www.suruga-ya.jp/database/photo.php?shinaban=120139149&amp;size=m"></a>
        </p></div>
        <div class="item_detail">
          <div class="title"><a href="/product/detail/120139149"><h3 class="product-name">エミリア 商品</h3></a></div>
          <div class="item_price"><p class="price_teika"><strong>1,680円</strong></p></div>
        </div>
      </div></div></div></body></html>`;

    const listings = await parseSurugayaResponse(
      new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } }),
      html,
    );

    expect(listings).toHaveLength(1);
    expect(listings[0]?.imageUrl).toBe("https://www.suruga-ya.jp/database/photo.php?shinaban=120139149&size=m");
    expect(listings[0]?.rawMetadata).toMatchObject({ parserVersion: "surugaya-html-v5" });
  });
});
