interface ListingLibraryFilters {
  source: string | null;
  query: string | null;
}

export interface ListingLibraryQuery {
  sql: string;
  values: string[];
}

export function listingLibraryQuery(filters: ListingLibraryFilters): ListingLibraryQuery {
  const clauses: string[] = [];
  const values: string[] = [];
  if (filters.source) {
    clauses.push("l.source_id=?");
    values.push(filters.source);
  }
  if (filters.query) {
    // 转义 LIKE 的通配符：不转义时输入 `%` 会匹配全部，型号里的 `_` 会匹配任意字符，
    // 搜索行为对使用者不可预测（值本身是绑定参数，不构成注入）。
    const escaped = filters.query.replace(/[\\%_]/g, (char) => `\\${char}`);
    clauses.push("(l.title LIKE ? ESCAPE '\\' OR l.source_item_id LIKE ? ESCAPE '\\')");
    values.push(`%${escaped}%`, `%${escaped}%`);
  }
  return {
    sql: `SELECT l.id,l.title,l.source_id,l.source_item_id,l.canonical_url,l.image_url,l.current_price,l.original_price,
     l.availability,l.item_condition,l.brand,l.manufacturer,l.jan,l.isbn,l.model_number,l.release_date,l.preorder_deadline,
     l.first_seen_at,l.last_seen_at,l.last_changed_at,b.id watch_binding_id,b.watch_profile_id,
     CASE WHEN b.enabled=1 AND p.enabled=1 THEN 1 ELSE 0 END watch_enabled,
     b.monitoring_purpose,b.schedule_interval_minutes,b.next_run_at
     FROM listings l
     JOIN watch_bindings b ON b.kind='item' AND b.monitoring_purpose='item_price'
       AND b.source_id=l.source_id AND b.source_item_id=l.source_item_id
     JOIN watch_profiles p ON p.id=b.watch_profile_id
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY l.last_changed_at DESC LIMIT 200`,
    values,
  };
}
