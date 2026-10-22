export interface ParsedRakutenIchibaItemUrl {
  sourceId: "rakuten_ichiba";
  sourceItemId: string;
  canonicalUrl: string;
}

const RAKUTEN_ITEM_HOST = "item.rakuten.co.jp";
const SHOP_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (
      !decoded
      || decoded !== decoded.trim()
      || decoded.includes("/")
      || decoded.includes("\\")
      || decoded.includes(":")
      || CONTROL_CHARACTER_PATTERN.test(decoded)
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Converts a canonical Rakuten Ichiba item URL into the stable itemCode used
 * by the official API. Tracking query parameters are deliberately discarded.
 */
export function parseRakutenIchibaItemUrl(value: string): ParsedRakutenIchibaItemUrl | null {
  if (!value || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.hostname !== RAKUTEN_ITEM_HOST
      || url.username
      || url.password
      || url.port
    ) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) return null;
    const decodedShopCode = decodePathSegment(segments[0]!);
    const itemCode = decodePathSegment(segments[1]!);
    if (!decodedShopCode || !itemCode || itemCode.length > 180) return null;
    const shopCode = decodedShopCode.toLowerCase();
    if (!SHOP_CODE_PATTERN.test(shopCode)) return null;
    return {
      sourceId: "rakuten_ichiba",
      sourceItemId: `${shopCode}:${itemCode}`,
      canonicalUrl: `https://${RAKUTEN_ITEM_HOST}/${encodeURIComponent(shopCode)}/${encodeURIComponent(itemCode)}/`,
    };
  } catch {
    return null;
  }
}
