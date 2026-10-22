import type { SourceAdapter } from "../../../core/src/index.js";
import { canGetMercariItem, getMercariItem } from "./item.js";
import { searchMercari } from "./search.js";

export const mercariAdapter: SourceAdapter = {
  id: "mercari_jp",
  transport: "internal_api",
  parserVersion: "mercari-internal-v2",
  coverage: "rolling_window",
  healthcheckQuery: "千反田える",
  capabilities: {
    keywordSearch: true,
    itemLookup: true,
    newestSort: true,
    priceFilter: true,
    conditionFilter: true,
    supportsUsed: true,
    supportsSoldOut: true,
    historySearchSupported: true,
  },
  search: searchMercari,
  getItem: getMercariItem,
  canGetItem: canGetMercariItem,
};

export * from "./dpop.js";
export * from "./errors.js";
export * from "./item.js";
export * from "./normalize.js";
export * from "./payload.js";
export * from "./search.js";
