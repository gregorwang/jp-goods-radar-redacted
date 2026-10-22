export function isUnexpectedEmptySearch(input: {
  bindingKind: "keyword" | "item";
  exactProduct: boolean;
  previousTypicalCount: number;
  rawResultCount: number;
  collectionOutcome?: "items" | "verified_empty";
}): boolean {
  return input.bindingKind === "keyword"
    && !input.exactProduct
    && input.previousTypicalCount >= 5
    && input.rawResultCount === 0
    && input.collectionOutcome !== "verified_empty";
}
