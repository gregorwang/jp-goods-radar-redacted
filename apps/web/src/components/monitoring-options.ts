import type { EditorialSelectOption } from "@/components/editorial-select";

export const MONITORING_INTERVAL_OPTIONS: readonly EditorialSelectOption[] = [
  { value: "30", label: "每 30 分钟", code: "URGENT" },
  { value: "60", label: "每小时", code: "HOURLY" },
  { value: "180", label: "每 3 小时", code: "3 HOURS" },
  { value: "240", label: "每 4 小时", code: "4 HOURS" },
  { value: "360", label: "每 6 小时", code: "6 HOURS" },
  { value: "720", label: "每 12 小时", code: "12 HOURS" },
  { value: "1440", label: "每天", code: "DAILY" },
];

export const KEYWORD_MONITORING_PURPOSE_OPTIONS: readonly EditorialSelectOption[] = [
  { value: "keyword_new_listing", label: "关键词上新", code: "关键词上新" },
];
