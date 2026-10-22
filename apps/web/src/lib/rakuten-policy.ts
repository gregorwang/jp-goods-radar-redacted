export const RAKUTEN_SOURCE_IDS = ["rakuten_ichiba", "rakuten_books"] as const;
export type RakutenSourceId = (typeof RAKUTEN_SOURCE_IDS)[number];

export interface RakutenRuntimePolicy {
  affiliateMode?: boolean;
  privateMonitoringEnabled?: boolean;
  privateMonitoringBySource?: Partial<Record<RakutenSourceId, boolean>>;
  publicPreviewEnabled?: boolean;
}

export function isRakutenSourceId(sourceId: string): sourceId is RakutenSourceId {
  return (RAKUTEN_SOURCE_IDS as readonly string[]).includes(sourceId);
}

export function rakutenMonitoringEnabledForSource(sourceId: RakutenSourceId, policy: RakutenRuntimePolicy): boolean {
  return policy.privateMonitoringBySource?.[sourceId] ?? policy.privateMonitoringEnabled === true;
}
