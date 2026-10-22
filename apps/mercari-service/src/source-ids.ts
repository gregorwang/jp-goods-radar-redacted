import type { FixedHtmlSourceId } from "./schemas.js";

export const FIXED_HTML_SOURCE_IDS = ["charaon", "cospa", "animate"] as const satisfies readonly FixedHtmlSourceId[];
export const SOURCE_SERVICE_IDS = ["mercari_jp", "surugaya", "yahoo_shopping", ...FIXED_HTML_SOURCE_IDS] as const;
