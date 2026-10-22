import type { SourceId } from "@jpgr/core";

export type WatchSourcePreset = "resale" | "retail" | "all";

const RESALE_SOURCES = new Set<SourceId>([
  "amiami",
  "yahoo_auctions_jp",
  "yahoo_fleamarket_jp",
  "mercari_jp",
  "surugaya",
]);

const RETAIL_SOURCES = new Set<SourceId>([
  "amiami",
  "rakuten_ichiba",
  "rakuten_books",
  "yahoo_shopping",
  "amazon_jp",
  "charaon",
  "cospa",
  "animate",
]);

export function watchSourcesForPreset(
  choices: readonly { id: SourceId; adapter_available: boolean }[],
  preset: WatchSourcePreset,
): SourceId[] {
  const selected = preset === "resale" ? RESALE_SOURCES : preset === "retail" ? RETAIL_SOURCES : null;
  return choices
    .filter((source) => source.adapter_available && (!selected || selected.has(source.id)))
    .map((source) => source.id);
}
