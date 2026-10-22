export const SURUGAYA_SELECTORS = {
  item: "#search_result .item_box .item, #search_result .item",
  titleLink: ".item_detail .title > a, .title a",
  productName: ".item_detail .product-name, .title .product-name, .title a",
  thumbnail: ".thum img",
  detailLink: ".thum a, .item_detail .title > a",
  normalPrice: ".item_price .price_teika strong, .price_teika strong",
  marketplacePrice: ".item_price .highlight-box .text-red strong, .makeplaTit .text-red strong",
  soldOut: ".item_price .price",
  nextPage: "li.next a",
} as const;

export const SURUGAYA_PARSER_VERSION = "surugaya-html-v5";
