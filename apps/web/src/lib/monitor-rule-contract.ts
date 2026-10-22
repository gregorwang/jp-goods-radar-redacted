import type {
  MonitorDeliveryMode,
  MonitorEventType,
  MonitorScopeType,
  MonitorStaleSourcePolicy,
  OfferTrackingPolicy,
  SuspectNoticePolicy,
  WatchDossierKind,
} from "@jpgr/core";

export interface MonitorRuleView {
  id: string;
  ruleKey: string;
  version: number;
  scopeType: MonitorScopeType;
  scopeId: string;
  scopeIdentityStatus: "bound" | "pending";
  eventTypes: MonitorEventType[];
  sourceAllow: string[];
  sourceDeny: string[];
  conditions: string[];
  completeness: string[];
  targetListingPrice: number | null;
  targetLandedCost: number | null;
  landedCostProfile: {
    id: string;
    version: number;
    name: string;
  } | null;
  deliveryMode: MonitorDeliveryMode;
  quietHours: { start: string; end: string } | null;
  timezone: "Asia/Tokyo";
  dedupeWindowMinutes: number;
  cooldownMinutes: number;
  staleSourcePolicy: MonitorStaleSourcePolicy;
  enabled: boolean;
  validFrom: string;
  createdBy: "migration" | "user" | "system";
}

export interface MonitorRuleApiResponse {
  featureEnabled: boolean;
  landedCostFeatureEnabled: boolean;
  dossierKind: WatchDossierKind;
  productVariantId: string | null;
  offerTrackingPolicy: OfferTrackingPolicy;
  suspectNoticePolicy: SuspectNoticePolicy;
  currentCostProfile: {
    id: string;
    version: number;
    name: string;
  } | null;
  rule: MonitorRuleView | null;
  versionCount: number;
  itemSignals: {
    notifyPriceDrop: boolean;
    notifyPriceRise: boolean;
    notifyRestock: boolean;
    notifySoldOut: boolean;
    minDropAmount: number;
  } | null;
}

export interface MonitorRuleHistoryEntry extends MonitorRuleView {
  validTo: string | null;
}

export interface MonitorRuleHistoryResponse {
  versions: MonitorRuleHistoryEntry[];
  nextBeforeVersion: number | null;
}
