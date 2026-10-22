export const OVERNIGHT_COLLECTION_OVERRIDE_FLAG = "overnight_collection_override_v1";
export const OVERNIGHT_COLLECTION_START_HOUR_JST = 0;
export const OVERNIGHT_COLLECTION_END_HOUR_JST = 5;

const TOKYO_OFFSET_MS = 9 * 60 * 60_000;

export interface OvernightCollectionFlagRow {
  enabled: number;
  config_json: string;
}

export interface OvernightCollectionPolicy {
  timeZone: "Asia/Tokyo";
  quietHoursStart: "00:00";
  quietHoursEnd: "05:00";
  quietHoursActive: boolean;
  overrideActive: boolean;
  overrideExpiresAt: string | null;
  automaticCollectionAllowed: boolean;
}

function timestamp(value: Date | string | number): number {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("collection_policy_time_invalid");
  return parsed;
}

function overrideExpiry(configJson: string | undefined): string | null {
  if (!configJson) return null;
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).expiresAt;
    return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

export function isTokyoOvernightQuietHours(value: Date | string | number): boolean {
  const shifted = new Date(timestamp(value) + TOKYO_OFFSET_MS);
  const hour = shifted.getUTCHours();
  return hour >= OVERNIGHT_COLLECTION_START_HOUR_JST && hour < OVERNIGHT_COLLECTION_END_HOUR_JST;
}

export function nextOvernightCollectionExpiry(value: Date | string | number): string {
  const shifted = new Date(timestamp(value) + TOKYO_OFFSET_MS);
  const localExpiry = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + (shifted.getUTCHours() >= OVERNIGHT_COLLECTION_END_HOUR_JST ? 1 : 0),
    OVERNIGHT_COLLECTION_END_HOUR_JST,
  );
  return new Date(localExpiry - TOKYO_OFFSET_MS).toISOString();
}

export function overnightCollectionPolicy(
  value: Date | string | number,
  flag?: OvernightCollectionFlagRow | null,
): OvernightCollectionPolicy {
  const now = timestamp(value);
  const expiresAt = overrideExpiry(flag?.config_json);
  const overrideActive = flag?.enabled === 1
    && expiresAt !== null
    && Date.parse(expiresAt) > now;
  const quietHoursActive = isTokyoOvernightQuietHours(now);
  return {
    timeZone: "Asia/Tokyo",
    quietHoursStart: "00:00",
    quietHoursEnd: "05:00",
    quietHoursActive,
    overrideActive,
    overrideExpiresAt: expiresAt,
    automaticCollectionAllowed: !quietHoursActive || overrideActive,
  };
}
