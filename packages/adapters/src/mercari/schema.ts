import { list, record, text } from "../http.js";
import { MercariSchemaChangedError } from "./errors.js";

export function mercariSearchItems(body: unknown): { items: Record<string, unknown>[]; nextPageToken?: string; totalAvailable?: number } {
  const root = record(body);
  if (!Array.isArray(root.items)) throw new MercariSchemaChangedError("Mercari 搜索响应缺少 items 数组");
  const meta = record(root.meta);
  const total = Number(meta.numFound);
  return {
    items: list(root.items).map(record),
    nextPageToken: text(meta.nextPageToken) ?? text(root.nextPageToken),
    totalAvailable: Number.isFinite(total) ? total : undefined,
  };
}

export function mercariItemData(body: unknown): Record<string, unknown> {
  const root = record(body);
  const data = record(root.data);
  if (!text(data.id) || !text(data.name)) throw new MercariSchemaChangedError("Mercari 单品响应缺少 data.id/data.name");
  return data;
}
