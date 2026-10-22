import type { SourceAdapter, SourceId } from "../../core/src/index.js";
import { rakutenBooksAdapter } from "./rakuten-books.js";
import { rakutenIchibaAdapter } from "./rakuten-ichiba.js";
import { mercariAdapter } from "./mercari/index.js";
import { surugayaAdapter } from "./surugaya/index.js";
import { yahooShoppingAdapter } from "./yahoo-shopping.js";
import { yahooAuctionsAdapter } from "./yahoo-auctions.js";
import { yahooFleamarketAdapter } from "./yahoo-fleamarket/index.js";
import { animateAdapter } from "./animate/index.js";
import { charaonAdapter } from "./charaon/index.js";
import { cospaAdapter } from "./cospa/index.js";
import { amazonJapanAdapter } from "./amazon/index.js";
import { amiamiAdapter } from "./amiami/index.js";

const adapters = new Map<SourceId, SourceAdapter>([
  [rakutenIchibaAdapter.id, rakutenIchibaAdapter],
  [rakutenBooksAdapter.id, rakutenBooksAdapter],
  [yahooShoppingAdapter.id, yahooShoppingAdapter],
  [yahooAuctionsAdapter.id, yahooAuctionsAdapter],
  [yahooFleamarketAdapter.id, yahooFleamarketAdapter],
  [mercariAdapter.id, mercariAdapter],
  [surugayaAdapter.id, surugayaAdapter],
  [charaonAdapter.id, charaonAdapter],
  [cospaAdapter.id, cospaAdapter],
  [animateAdapter.id, animateAdapter],
  [amazonJapanAdapter.id, amazonJapanAdapter],
  [amiamiAdapter.id, amiamiAdapter],
]);

export function getAdapter(sourceId: SourceId): SourceAdapter | undefined {
  return adapters.get(sourceId);
}

export function listAvailableAdapters(): SourceAdapter[] {
  return [...adapters.values()];
}
