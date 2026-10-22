export function formatJpy(value: number | null | undefined): string {
  if (value === null || value === undefined) return "価格未取得";
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value);
}

export function normalizeIntegerPrice(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
}
