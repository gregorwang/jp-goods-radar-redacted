/**
 * Exact-product dossiers preserve source evidence before applying shopping or
 * notification rules. Keep this server-side so alternate clients cannot put
 * target price, condition, or stock filters back into the acquisition query.
 */
export function exactProductSourceConfig(config: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...config };
  const rawFilters = rest.filters;
  delete rest.minPrice;
  delete rest.maxPrice;
  delete rest.conditions;
  delete rest.filters;
  const filters = rawFilters && typeof rawFilters === "object" && !Array.isArray(rawFilters)
    ? rawFilters as Record<string, unknown>
    : undefined;
  const sanitizedFilters = filters
    ? Object.fromEntries(Object.entries(filters).filter(([key]) => ![
        "minPrice",
        "maxPrice",
        "conditions",
        "inStockOnly",
        "availabilityMode",
      ].includes(key)))
    : undefined;
  return {
    ...rest,
    ...(sanitizedFilters && Object.keys(sanitizedFilters).length ? { filters: sanitizedFilters } : {}),
    availabilityMode: "all",
    inStockOnly: false,
  };
}
