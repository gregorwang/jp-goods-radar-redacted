import type { SourceId } from "@jpgr/core";

export const SOURCE_RUNNER_IDS = [
  "amiami",
  "mercari_jp",
  "rakuten_ichiba",
  "surugaya",
  "yahoo_shopping",
  "yahoo_auctions_jp",
  "yahoo_fleamarket_jp",
] as const satisfies readonly SourceId[];

export type SourceRunnerId = (typeof SOURCE_RUNNER_IDS)[number];

export const SOURCE_RUNNER_SEARCH_IDS = [
  "amiami",
  "mercari_jp",
  "surugaya",
  "yahoo_shopping",
  "yahoo_auctions_jp",
  "yahoo_fleamarket_jp",
] as const satisfies readonly SourceRunnerId[];

export type SourceRunnerSearchId = (typeof SOURCE_RUNNER_SEARCH_IDS)[number];

export const SOURCE_RUNNER_ITEM_IDS = [
  "amiami",
  "mercari_jp",
  "rakuten_ichiba",
  "surugaya",
  "yahoo_auctions_jp",
  "yahoo_fleamarket_jp",
] as const satisfies readonly SourceRunnerId[];

export type SourceRunnerItemId = (typeof SOURCE_RUNNER_ITEM_IDS)[number];

type SourceUrlPolicy = {
  hostname: string;
  allowedPath(pathname: string): boolean;
};

const SOURCE_URL_POLICIES = {
  amiami: {
    hostname: "api.amiami.com",
    allowedPath: (pathname) => pathname === "/api/v1.0/items" || pathname === "/api/v1.0/item",
  },
  mercari_jp: {
    hostname: "api.mercari.jp",
    allowedPath: (pathname) => pathname === "/v2/entities:search" || pathname === "/items/get",
  },
  rakuten_ichiba: {
    hostname: "item.rakuten.co.jp",
    allowedPath: (pathname) => /^\/[^/]{1,100}\/[^/]{1,540}\/?$/u.test(pathname),
  },
  surugaya: {
    hostname: "www.suruga-ya.jp",
    allowedPath: (pathname) => pathname === "/search"
      || /^\/product\/detail\/[A-Za-z0-9_-]+\/?$/u.test(pathname),
  },
  yahoo_shopping: {
    hostname: "shopping.yahoo.co.jp",
    allowedPath: (pathname) => pathname.startsWith("/search/"),
  },
  yahoo_auctions_jp: {
    hostname: "auctions.yahoo.co.jp",
    allowedPath: (pathname) => pathname === "/search/search"
      || pathname === "/closedsearch/closedsearch"
      || /^\/jp\/auction\/[A-Za-z0-9]{8,16}\/?$/u.test(pathname),
  },
  yahoo_fleamarket_jp: {
    hostname: "paypayfleamarket.yahoo.co.jp",
    allowedPath: (pathname) => /^\/search\/[^/]{1,800}$/u.test(pathname)
      || /^\/item\/[A-Za-z0-9_-]{1,100}\/?$/u.test(pathname),
  },
} as const satisfies Record<SourceRunnerId, SourceUrlPolicy>;

export function isSourceRunnerId(value: SourceId): value is SourceRunnerId {
  return (SOURCE_RUNNER_IDS as readonly SourceId[]).includes(value);
}

export function isAllowedSourceRunnerUrl(sourceId: SourceRunnerId, value: string | URL): boolean {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    return false;
  }
  const policy = SOURCE_URL_POLICIES[sourceId];
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && !url.port
    && url.hostname === policy.hostname
    && policy.allowedPath(url.pathname);
}

export function requireAllowedSourceRunnerUrl(sourceId: SourceRunnerId, value: string | URL): URL {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (!isAllowedSourceRunnerUrl(sourceId, url)) {
    throw new Error(`source_runner_url_rejected:${sourceId}`);
  }
  return url;
}
