import type { WatchDossierKind } from "@jpgr/core";

const exactProductNamePrefix = /^同款\s*[·・]\s*/u;
const exactProductDescriptionPrefix = "具体日文商品名：";

function comparableText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function watchDossierTitle(kind: WatchDossierKind | undefined, name: string): string {
  if (kind !== "exact_product") return name;
  const title = name.replace(exactProductNamePrefix, "").trim();
  return title || name;
}

export function watchDossierDescription(
  kind: WatchDossierKind | undefined,
  name: string,
  description: string | null,
): string | null {
  if (!description || kind !== "exact_product") return description;
  if (!description.startsWith(exactProductDescriptionPrefix)) return description;
  const describedTitle = description.slice(exactProductDescriptionPrefix.length);
  return comparableText(describedTitle) === comparableText(watchDossierTitle(kind, name)) ? null : description;
}
