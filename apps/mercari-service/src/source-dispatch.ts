import { animateAdapter } from "../../../packages/adapters/src/animate/index.js";
import { charaonAdapter } from "../../../packages/adapters/src/charaon/index.js";
import { cospaAdapter } from "../../../packages/adapters/src/cospa/index.js";
import type { SourceAdapter } from "../../../packages/core/src/index.js";
import type { FixedHtmlSourceId } from "./schemas.js";
import { FIXED_HTML_SOURCE_IDS } from "./source-ids.js";

const fixedSourceAdapters = {
  charaon: charaonAdapter,
  cospa: cospaAdapter,
  animate: animateAdapter,
} as const satisfies Record<FixedHtmlSourceId, SourceAdapter>;

export function fixedSourceAdapter(sourceId: FixedHtmlSourceId): SourceAdapter {
  return fixedSourceAdapters[sourceId];
}
