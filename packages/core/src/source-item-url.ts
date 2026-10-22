import { parseRakutenIchibaItemUrl } from "./rakuten-item-url.js";
import type { SourceId } from "./types.js";

export interface ParsedSourceItemUrl {
  sourceId: SourceId;
  sourceItemId: string;
  canonicalUrl: string;
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function safeHttpsUrl(value: string): URL | null {
  if (!value || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

function decodedSegment(value: string | undefined, pattern: RegExp): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (
      !decoded
      || decoded !== decoded.trim()
      || decoded.includes("/")
      || decoded.includes("\\")
      || decoded.includes(":")
      || CONTROL_CHARACTER_PATTERN.test(decoded)
      || !pattern.test(decoded)
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Recognizes canonical product-detail URLs for sources whose adapters support
 * stable single-item lookup. Query strings and fragments are intentionally
 * discarded so sharing/tracking parameters cannot create duplicate watches.
 */
export function parseSourceItemUrl(value: string): ParsedSourceItemUrl | null {
  const rakuten = parseRakutenIchibaItemUrl(value);
  if (rakuten) return rakuten;

  const url = safeHttpsUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();

  if ((host === "www.amiami.com" && /^\/(?:eng|cn)\/detail\/?$/u.test(url.pathname))
    || (host === "www.amiami.jp" && /^\/top\/detail\/detail\/?$/u.test(url.pathname))) {
    const offer = url.searchParams.has("scode");
    const id = url.searchParams.get(offer ? "scode" : "gcode");
    if (!id || id.length > 100 || !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u.test(id)) return null;
    const canonical = new URL("https://www.amiami.com/eng/detail/");
    canonical.searchParams.set(offer ? "scode" : "gcode", id);
    return { sourceId: "amiami", sourceItemId: id, canonicalUrl: canonical.href };
  }

  if (host === "jp.mercari.com") {
    const itemMatch = url.pathname.match(/^\/(item|shops\/product)\/([^/]+)\/?$/u);
    const sourceItemId = decodedSegment(
      itemMatch?.[2],
      itemMatch?.[1] === "item" ? /^m\d{8,}$/u : /^[A-Za-z0-9_-]{4,160}$/u,
    );
    if (!sourceItemId) return null;
    return {
      sourceId: "mercari_jp",
      sourceItemId,
      canonicalUrl: `https://jp.mercari.com/${itemMatch![1]}/${encodeURIComponent(sourceItemId)}`,
    };
  }

  if (host === "paypayfleamarket.yahoo.co.jp") {
    const sourceItemId = decodedSegment(
      url.pathname.match(/^\/item\/([^/]+)\/?$/u)?.[1],
      /^[A-Za-z0-9_-]{1,100}$/u,
    );
    return sourceItemId ? {
      sourceId: "yahoo_fleamarket_jp",
      sourceItemId,
      canonicalUrl: `https://paypayfleamarket.yahoo.co.jp/item/${encodeURIComponent(sourceItemId)}`,
    } : null;
  }

  if (host === "auctions.yahoo.co.jp") {
    const sourceItemId = decodedSegment(
      url.pathname.match(/^\/jp\/auction\/([^/]+)\/?$/u)?.[1],
      /^[A-Za-z0-9]{8,16}$/u,
    );
    return sourceItemId ? {
      sourceId: "yahoo_auctions_jp",
      sourceItemId,
      canonicalUrl: `https://auctions.yahoo.co.jp/jp/auction/${encodeURIComponent(sourceItemId)}`,
    } : null;
  }

  if (host === "amazon.co.jp" || host === "www.amazon.co.jp") {
    const asin = decodedSegment(
      url.pathname.match(/\/(?:dp|gp\/product)\/([^/]+)(?:\/|$)/u)?.[1],
      /^[A-Za-z0-9]{10}$/u,
    )?.toUpperCase();
    return asin ? {
      sourceId: "amazon_jp",
      sourceItemId: asin,
      canonicalUrl: `https://www.amazon.co.jp/dp/${asin}`,
    } : null;
  }

  if (host === "suruga-ya.jp" || host === "www.suruga-ya.jp") {
    const sourceItemId = decodedSegment(
      url.pathname.match(/^\/product\/detail\/([^/]+)\/?$/u)?.[1],
      /^[A-Za-z0-9_-]{1,160}$/u,
    );
    return sourceItemId ? {
      sourceId: "surugaya",
      sourceItemId,
      canonicalUrl: `https://www.suruga-ya.jp/product/detail/${encodeURIComponent(sourceItemId)}`,
    } : null;
  }

  if (host === "charaon.jp" || host === "www.charaon.jp") {
    const sourceItemId = decodedSegment(
      url.pathname.match(/^\/SHOP\/([^/]+)\.html$/u)?.[1],
      /^[A-Za-z0-9_-]{2,80}$/u,
    );
    return sourceItemId ? {
      sourceId: "charaon",
      sourceItemId,
      canonicalUrl: `https://www.charaon.jp/SHOP/${encodeURIComponent(sourceItemId)}.html`,
    } : null;
  }

  if (host === "cospa.com" || host === "www.cospa.com") {
    const match = url.pathname.match(/^\/(cospa|nijigencospa)\/detail\/id\/([^/]+)\/?$/u);
    const sourceItemId = decodedSegment(match?.[2], /^\d{5,20}$/u);
    return sourceItemId && match?.[1] ? {
      sourceId: "cospa",
      sourceItemId,
      canonicalUrl: `https://www.cospa.com/${match[1]}/detail/id/${sourceItemId}`,
    } : null;
  }

  if (host === "animate-onlineshop.jp" || host === "www.animate-onlineshop.jp") {
    const sourceItemId = decodedSegment(
      url.pathname.match(/^\/pn\/[^/]+\/pd\/([^/]+)\/?$/u)?.[1],
      /^\d{4,20}$/u,
    );
    return sourceItemId ? {
      sourceId: "animate",
      sourceItemId,
      canonicalUrl: `https://www.animate-onlineshop.jp/pn/_/pd/${sourceItemId}/`,
    } : null;
  }

  return null;
}
