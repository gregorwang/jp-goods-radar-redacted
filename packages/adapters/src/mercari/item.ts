import type { AdapterContext, NormalizedListing } from "../../../core/src/index.js";
import { AdapterError } from "../http.js";
import { createDpopSigner } from "./dpop.js";
import { normalizeMercariListing } from "./normalize.js";
import { mercariJson } from "./request.js";
import { mercariItemData } from "./schema.js";

function mercariItemId(value: string): string {
  const match = value.match(/(?:^|\/)(?:item|shops\/product)\/([^/?#]+)(?:$|[/?#])/iu)
    ?? value.match(/(?:^|\/)(m\d{8,})(?:$|[/?#])/iu);
  return match?.[1] ?? value.trim();
}

/**
 * C2C 商品 ID 形如 `m` + 数字；Mercari Shops 商品是 22 位 base62（`2JVMipnZ…`）。
 * `/items/get` 只服务前者，喂给它 Shops ID 只会拿到固定的 400 InvalidArgument。
 */
const C2C_ITEM_ID = /^m\d{8,}$/u;

export function canGetMercariItem(urlOrId: string): boolean {
  return C2C_ITEM_ID.test(mercariItemId(urlOrId));
}

export function buildMercariItemUrl(itemId: string): URL {
  const url = new URL("https://api.mercari.jp/items/get");
  url.searchParams.set("id", itemId);
  url.searchParams.set("include_item_attributes", "true");
  url.searchParams.set("include_product_page_component", "true");
  url.searchParams.set("include_non_ui_item_attributes", "true");
  url.searchParams.set("include_donation", "true");
  url.searchParams.set("include_item_attributes_sections", "true");
  url.searchParams.set("include_auction", "true");
  return url;
}

export async function getMercariItem(urlOrId: string, context: AdapterContext): Promise<NormalizedListing> {
  const id = mercariItemId(urlOrId);
  if (!C2C_ITEM_ID.test(id)) {
    throw new AdapterError(`Mercari Shops 商品 ${id} 不支持单品详情查询`, "item_lookup_unsupported");
  }
  const url = buildMercariItemUrl(id);
  const signer = await createDpopSigner();
  const body = await mercariJson(context.fetch, signer, url, "GET", undefined, context.signal);
  return normalizeMercariListing(mercariItemData(body));
}
