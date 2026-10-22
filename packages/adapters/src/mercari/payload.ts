import { searchAvailabilityMode, type SearchRequest } from "../../../core/src/index.js";

export type MercariSearchStatus = "STATUS_ON_SALE" | "STATUS_SOLD_OUT" | "STATUS_TRADING";

export interface MercariSearchInput {
  keyword: string;
  excludeKeyword?: string;
  priceMin?: number;
  priceMax?: number;
  status?: MercariSearchStatus[];
  itemConditionId?: number[];
  sort?: "SORT_CREATED_TIME" | "SORT_PRICE" | "SORT_SCORE";
  order?: "ORDER_DESC" | "ORDER_ASC";
  pageSize?: number;
  pageToken?: string;
  searchSessionId?: string;
}

export function mercariInput(request: SearchRequest): MercariSearchInput {
  const config = request.sourceConfig ?? {};
  const sort = request.filters.sort === "price_asc" || request.filters.sort === "price_desc"
    ? "SORT_PRICE"
    : request.filters.sort === "relevance" ? "SORT_SCORE" : "SORT_CREATED_TIME";
  const availabilityMode = searchAvailabilityMode(request.filters);
  const status: MercariSearchStatus[] = availabilityMode === "purchasable"
    ? ["STATUS_ON_SALE"]
    : availabilityMode === "sold_out"
      ? ["STATUS_SOLD_OUT", "STATUS_TRADING"]
      : ["STATUS_ON_SALE", "STATUS_SOLD_OUT", "STATUS_TRADING"];
  return {
    keyword: request.query,
    excludeKeyword: typeof config.excludeKeyword === "string" ? config.excludeKeyword : "",
    priceMin: request.filters.minPrice,
    priceMax: request.filters.maxPrice,
    status,
    itemConditionId: Array.isArray(config.itemConditionId)
      ? config.itemConditionId.filter((value): value is number => typeof value === "number" && Number.isInteger(value))
      : [],
    sort,
    order: request.filters.sort === "price_asc" ? "ORDER_ASC" : "ORDER_DESC",
    pageSize: request.filters.pageSize,
    pageToken: typeof config.pageToken === "string" ? config.pageToken : "",
  };
}

export function buildMercariSearchPayload(input: MercariSearchInput, deviceUuid = ""): Record<string, unknown> {
  const pageSize = Math.max(1, Math.min(input.pageSize ?? 120, 120));
  return {
    userId: "",
    pageSize,
    pageToken: input.pageToken ?? "",
    searchSessionId: input.searchSessionId ?? crypto.randomUUID(),
    source: "BaseSerp",
    indexRouting: "INDEX_ROUTING_UNSPECIFIED",
    thumbnailTypes: [],
    searchCondition: {
      keyword: input.keyword,
      excludeKeyword: input.excludeKeyword ?? "",
      sort: input.sort ?? "SORT_CREATED_TIME",
      order: input.order ?? "ORDER_DESC",
      status: input.status ?? ["STATUS_ON_SALE"],
      sizeId: [], categoryId: [], brandId: [], sellerId: [],
      priceMin: input.priceMin ?? 0,
      priceMax: input.priceMax ?? 0,
      itemConditionId: input.itemConditionId ?? [],
      shippingPayerId: [], shippingFromArea: [], shippingMethod: [], colorId: [],
      hasCoupon: false, attributes: [],
      itemTypes: [],
      skuIds: [], shopIds: [], excludeShippingMethodIds: [],
    },
    serviceFrom: "suruga",
    withItemBrand: true,
    withItemSize: false,
    withItemPromotions: true,
    withItemSizes: false,
    withShopname: false,
    useDynamicAttribute: true,
    withSuggestedItems: false,
    withOfferPricePromotion: false,
    withProductSuggest: false,
    withParentProducts: false,
    withProductArticles: false,
    withSearchConditionId: false,
    withAuction: true,
    laplaceDeviceUuid: deviceUuid,
  };
}
