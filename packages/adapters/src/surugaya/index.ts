import type { SourceAdapter } from "../../../core/src/index.js";
import { getSurugayaItem } from "./item.js";
import { searchSurugaya } from "./search.js";
import { SURUGAYA_PARSER_VERSION } from "./selectors.js";

export const surugayaAdapter: SourceAdapter = {
  id: "surugaya",
  transport: "html_endpoint",
  parserVersion: SURUGAYA_PARSER_VERSION,
  coverage: "rolling_window",
  healthcheckQuery: "千反田える",
  healthcheckSourceConfig: { pages: 1 },
  capabilities: {
    keywordSearch: true,
    itemLookup: true,
    newestSort: false,
    modificationTimeSort: true,
    priceFilter: true,
    conditionFilter: true,
    supportsUsed: true,
    supportsMarketplace: true,
    historySearchSupported: false,
  },
  search: searchSurugaya,
  getItem: getSurugayaItem,
};

export * from "./errors.js";
export * from "./item.js";
export * from "./normalize.js";
export * from "./parser.js";
export * from "./search.js";
export * from "./selectors.js";
