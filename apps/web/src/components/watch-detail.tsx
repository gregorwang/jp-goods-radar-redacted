"use client";

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useState } from "react";
import { Archive, ArrowUpRight, Check, ChevronDown, Pause, Play, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { strongReminderPolicyFromSourceConfig, type MonitoringPurpose, type SourceId, type WatchDossierKind } from "@jpgr/core";
import { apiFetch } from "@/lib/client-api";
import { tokyoDateTime, tokyoFull } from "@/lib/format-time";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DigestExtrasPanel } from "@/components/digest-extras-panel";
import { DeliveryChannelsPanel } from "@/components/delivery-channels-panel";
import { EditorialSelect, type EditorialSelectOption } from "@/components/editorial-select";
import { ItemScheduleControls } from "@/components/item-schedule-controls";
import { effectiveItemIntervalMinutes, itemSchedulePolicy, itemScheduleReasonLabel, readItemScheduleState,
  supportsAdaptiveItemSchedule, type ItemScheduleMode } from "@jpgr/core";
import { KEYWORD_MONITORING_PURPOSE_OPTIONS, MONITORING_INTERVAL_OPTIONS } from "@/components/monitoring-options";
import { MonitorRuleEditor } from "@/components/monitor-rule-editor";
import { ProfileChangeLog } from "@/components/profile-change-log";
import { ReferenceImagePanel } from "@/components/reference-image-panel";
import { WatchListingEvidence } from "@/components/watch-listing-evidence";
import { watchDossierDescription, watchDossierTitle } from "@/lib/watch-dossier-copy";
import { isTerminalWatchLifecycle, watchLifecycleLabel, type WatchLifecycleReason, type WatchLifecycleStatus } from "@/lib/watch-lifecycle";

interface Binding {
  id: string;
  source_id: SourceId;
  display_name: string;
  kind: "keyword" | "item";
  monitoring_purpose: MonitoringPurpose;
  query: string | null;
  target_url: string | null;
  source_config_json: string;
  listing_id: string | null;
  matched_listing_count: number;
  schedule_interval_minutes: number;
  enabled: number;
  baseline_completed: number;
  next_run_at: string;
  cooldown_until?: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  health_status: string;
  credential_status: string;
  target_price: number | null;
  min_drop_amount: number;
  notify_new_listing: number;
  notify_price_drop: number;
  notify_restock: number;
  notify_sold_out: number;
  updated_at: string;
}

interface WatchRun {
  id: string;
  trigger_type: string;
  status: string;
  started_at: string;
  duration_ms: number | null;
  result_count: number;
  new_count: number;
  changed_count: number;
  coverage: string;
  error_code: string | null;
  error_message: string | null;
}

interface Profile {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  include_terms_json: string;
  exclude_terms_json: string;
  /** 关键词档案的最低价（送达门槛），null = 不限。 */
  min_listing_price?: number | string | null;
  dossier_kind?: WatchDossierKind;
  lifecycle_status: WatchLifecycleStatus;
  lifecycle_reason: WatchLifecycleReason;
}

interface SourceChoice {
  id: SourceId;
  display_name: string;
  enabled: number;
  adapter_available: boolean;
  health_status: string;
  monitoring_allowed: boolean;
}

interface WatchDetailBody {
  profile: Profile;
  bindings: Binding[];
  runs: Record<string, WatchRun[]>;
}

type DeleteTarget = { kind: "profile" } | { kind: "archive" } | { kind: "binding"; binding: Binding };

const sourceLabels: Partial<Record<SourceId, string>> = {
  amiami: "AmiAmi（あみあみ）",
  rakuten_ichiba: "乐天市场",
  rakuten_books: "Rakuten Books",
  yahoo_shopping: "Yahoo! Shopping（实验）",
  yahoo_auctions_jp: "Yahoo!オークション（实验）",
  yahoo_fleamarket_jp: "Yahoo!フリマ",
  mercari_jp: "Mercari",
  surugaya: "骏河屋",
  charaon: "CharaON",
  cospa: "COSPA",
  animate: "Animate 通贩",
};

function purposeLabel(purpose: MonitoringPurpose): string {
  if (purpose === "item_price") return "商品监控";
  return "关键词上新";
}

function bindingSourceConfig(binding: Binding): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(binding.source_config_json);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isExactProductBinding(binding: Binding): boolean {
  return binding.kind === "keyword" && bindingSourceConfig(binding).searchMode === "exact_product";
}

function productTargetSummary(binding: Binding): string {
  const target = bindingSourceConfig(binding).productTarget;
  if (!target || typeof target !== "object" || Array.isArray(target)) return "商品指纹缺失";
  const value = target as Record<string, unknown>;
  const terms = [value.manufacturer, value.model, value.jan, value.series, value.size]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const characters = Array.isArray(value.characters)
    ? value.characters.filter((item): item is string => typeof item === "string").slice(0, 2)
    : [];
  return [...characters, ...terms].join(" · ") || "使用锚点标题与查询证据";
}

function localDateTime(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function scheduleLabel(binding: Binding, dossierKind?: WatchDossierKind): string {
  const scoped = { ...binding, profile_dossier_kind: dossierKind };
  if (supportsAdaptiveItemSchedule(scoped)) {
    const interval = effectiveItemIntervalMinutes(scoped);
    const frequency = interval >= 60 ? `${Math.round(interval / 60 * 10) / 10} 小时` : `${interval} 分钟`;
    return itemSchedulePolicy(binding).mode === "adaptive" ? `自动调整 · 当前约每 ${frequency}` : `固定每 ${frequency}`;
  }
  return MONITORING_INTERVAL_OPTIONS.find((option) => option.value === String(binding.schedule_interval_minutes))?.label
    ?? `每 ${binding.schedule_interval_minutes} 分钟`;
}

function credentialStatusLabel(status: string): string {
  return ({
    ready: "已就绪",
    not_required: "无需凭据",
    missing: "未配置",
    invalid: "不可用",
  } as Record<string, string>)[status] ?? status;
}

function sourceHealthLabel(status: string): string {
  return ({
    healthy: "正常",
    degraded: "不稳定",
    blocked: "已阻断",
    disabled: "已停用",
    unknown: "待确认",
  } as Record<string, string>)[status] ?? status;
}

type SourceDisplayState = "success" | "empty" | "failed" | "disabled" | "cooldown" | "running" | "pending";

function sourceDisplayState(binding: Binding, latestRun?: WatchRun): SourceDisplayState {
  if (!binding.enabled) return "disabled";
  if (binding.cooldown_until && new Date(binding.cooldown_until).getTime() > Date.now()) return "cooldown";
  if (latestRun?.status === "running") return "running";
  if (latestRun?.status === "rate_limited") return "cooldown";
  if (binding.last_error_message || latestRun?.status === "failed" || latestRun?.status === "blocked") return "failed";
  if (latestRun?.status === "success" && latestRun.result_count === 0) return "empty";
  if (latestRun?.status === "success" || binding.baseline_completed) return "success";
  return "pending";
}

function sourceStateLabel(state: SourceDisplayState, exactProduct = false): string {
  return ({
    success: "成功",
    empty: "空结果",
    failed: "失败",
    disabled: "已暂停",
    cooldown: "冷却中",
    running: "执行中",
    pending: exactProduct ? "等待首次巡回" : "等待基线",
  } as const)[state];
}

function sourceStateClass(state: SourceDisplayState): string {
  if (state === "success") return "good";
  if (state === "failed" || state === "disabled" || state === "cooldown") return "warn";
  return "";
}

function keywordSettingsSignature(binding: Binding): string {
  const sourceConfig = bindingSourceConfig(binding);
  const productIdentity = sourceConfig.searchMode === "exact_product"
    ? JSON.stringify({
        searchMode: "exact_product",
        productTarget: sourceConfig.productTarget ?? null,
        strongReminder: sourceConfig.strongReminder ?? null,
        matchVersion: sourceConfig.matchVersion ?? null,
        deepSearch: sourceConfig.deepSearch === true,
      })
    : "keyword";
  return [
    binding.query,
    binding.monitoring_purpose,
    // 频率不算：二手站每小时、一手店每天是故意的（2026-10-11），算进来就永远「不一致」。
    binding.notify_new_listing,
    productIdentity,
  ].join(":");
}

function parseTerms(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((term): term is string => typeof term === "string") : [];
  } catch {
    return [];
  }
}

function profileActionErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "档案状态更新失败";
  if (error.message === "no_resumable_sources") {
    return "当前没有可启动的来源；停用来源和关闭中的实验来源会保留绑定，但不会开始巡回。";
  }
  if (error.message === "watch_profile_has_no_bindings") return "这份档案还没有数据来源，请先添加来源。";
  return error.message;
}

interface ResumeProfileResponse {
  resumedBindings: number;
  alreadyActiveBindings: number;
  skippedBindings: Array<{ sourceId: string; reason: "source_monitoring_not_allowed" }>;
}

function splitTermInput(value: string): string[] {
  return value.split(/[，,、\n]/).map((term) => term.trim()).filter(Boolean).slice(0, 30);
}

async function fetchWatchDetail(id: string, signal?: AbortSignal): Promise<WatchDetailBody> {
  return apiFetch<WatchDetailBody>(`/api/watch-profiles/${id}`, { signal });
}

function BindingScheduleEditor({ binding, dossierKind, onSaved }: {
  binding: Binding; dossierKind?: WatchDossierKind; onSaved: () => Promise<void>;
}) {
  const exactProduct = isExactProductBinding(binding);
  const scoped = { ...binding, profile_dossier_kind: dossierKind };
  const itemScheduleSupported = supportsAdaptiveItemSchedule(scoped);
  const schedulePolicy = itemSchedulePolicy(binding);
  const scheduleState = readItemScheduleState(scoped);
  const [scheduleMode, setScheduleMode] = useState<ItemScheduleMode>(schedulePolicy.mode);
  const [scheduleMaxMinutes, setScheduleMaxMinutes] = useState(String(schedulePolicy.maxIntervalMinutes));
  const [purpose, setPurpose] = useState<MonitoringPurpose>(binding.monitoring_purpose);
  const [interval, setInterval] = useState(String(binding.schedule_interval_minutes));
  const [nextRun, setNextRun] = useState(localDateTime(binding.next_run_at));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      await apiFetch(`/api/watch-bindings/${binding.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          monitoringPurpose: purpose,
          intervalMinutes: Number(interval),
          ...(nextRun !== localDateTime(binding.next_run_at) ? { nextRunAt: new Date(nextRun).toISOString() } : {}),
          ...(itemScheduleSupported ? { itemScheduleMode: scheduleMode, itemScheduleMaxMinutes: Number(scheduleMaxMinutes) } : {}),
        }),
      });
      setMessage("检查计划已保存；上方事件规则没有改变。");
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "巡回设置保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="binding-schedule-editor" onSubmit={save}>
      <div className="watch-schedule-grid">
        {binding.kind === "keyword" && !exactProduct
          ? <EditorialSelect index="01" label="监控目的" caption="Purpose" value={purpose} options={KEYWORD_MONITORING_PURPOSE_OPTIONS} onValueChange={(value) => setPurpose(value as MonitoringPurpose)} />
          : <div className="schedule-fixed-purpose"><span>监控目的</span><strong>{exactProduct ? "精确同款与目标价巡回" : "商品监控"}</strong></div>}
        <EditorialSelect index="02" label={itemScheduleSupported && scheduleMode === "adaptive" ? "基础检查频率" : "巡回频率"} caption="Cadence" value={interval} options={MONITORING_INTERVAL_OPTIONS} onValueChange={setInterval} />
      </div>
      {itemScheduleSupported && <ItemScheduleControls mode={scheduleMode} maxMinutes={scheduleMaxMinutes}
        onModeChange={setScheduleMode} onMaxMinutesChange={setScheduleMaxMinutes} />}
      {itemScheduleSupported && schedulePolicy.mode === "adaptive" && <p className="schedule-separation-note">
        {itemScheduleReasonLabel(scheduleState.reason)}。
        {scheduleState.holdUntil && `密切观察至 ${tokyoFull(scheduleState.holdUntil)}。`}
      </p>}
      <div className="field"><label htmlFor={`binding-next-${binding.id}`}>下一次巡回</label><input id={`binding-next-${binding.id}`} className="text-input" type="datetime-local" value={nextRun} onChange={(event) => setNextRun(event.target.value)} required /></div>
      <p className="schedule-separation-note">这里仅决定何时检查来源；降价、库存、同款上新和目标价统一由上方版本化事件规则决定。</p>
      <button className="ghost-button" type="submit" disabled={saving}>{saving ? "保存中…" : "保存检查计划"}</button>
      {message && <p className="item-alert-message" role="status">{message}</p>}
    </form>
  );
}

const TOKYO_OFFSET_MS = 9 * 60 * 60_000;

/** 东京时间的日期「2026-10-16」和时刻「17:00」。页面上的时间一律按东京时间，不看浏览器所在时区。 */
function tokyoParts(iso: string | number): { day: string; time: string } {
  const shifted = new Date(new Date(iso).getTime() + TOKYO_OFFSET_MS).toISOString();
  return { day: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

function tokyoIso(day: string, time: string): string {
  return new Date(`${day}T${time}:00+09:00`).toISOString();
}

function shortDay(day: string): string {
  return `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
}

function nextRunDayOptions(current: string): EditorialSelectOption[] {
  const options = ["今天", "明天", "后天"].map((name, offset) => {
    const day = tokyoParts(Date.now() + offset * 86_400_000).day;
    return { value: day, label: `${name} ${shortDay(day)}`, code: shortDay(day) };
  });
  if (!options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: shortDay(current), code: shortDay(current) });
  }
  return options;
}

function nextRunTimeOptions(current: string): EditorialSelectOption[] {
  const hours = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
  const times = hours.includes(current) ? hours : [...hours, current].sort();
  return times.map((time) => ({ value: time, label: time, code: "东京" }));
}

/**
 * 表单里显示的「下次巡回」：正在巡回的来源里最早、且还没到的那个。
 * 以前直接取第一个来源，碰上那个来源失败卡住，就把「昨天」显示出来，
 * 再一保存就把全部来源改成昨天、当场多跑一轮（2026-10-16 加藤惠）。
 */
function displayedNextRun(bindings: Binding[]): string {
  const now = Date.now();
  const active = bindings.filter((binding) => binding.enabled === 1).map((binding) => binding.next_run_at);
  const upcoming = active.filter((iso) => Date.parse(iso) > now).sort();
  return upcoming[0] ?? active.sort()[0] ?? bindings[0]!.next_run_at;
}

function KeywordRadarSettingsEditor({ profile, bindings, onSaved }: {
  profile: Profile;
  bindings: Binding[];
  onSaved: () => Promise<void>;
}) {
  const template = bindings[0]!;
  const exactProduct = bindings.every(isExactProductBinding);
  const initialIncludeTerms = parseTerms(profile.include_terms_json).join(", ");
  const initialExcludeTerms = parseTerms(profile.exclude_terms_json).join(", ");
  const initialMinListingPrice = profile.min_listing_price === null || profile.min_listing_price === undefined ? "" : String(Number(profile.min_listing_price));
  const initialNextRun = tokyoParts(displayedNextRun(bindings));
  const templateSourceConfig = bindingSourceConfig(template);
  const templateProductTarget = objectValue(templateSourceConfig.productTarget);
  const initialProduct = {
    recallQueries: stringArrayValue(templateProductTarget.recallQueries).join("\n"),
    requiredGroups: stringArrayValue(templateProductTarget.requiredTermGroups).join(", "),
    supportingGroups: stringArrayValue(templateProductTarget.supportingTermGroups).join(", "),
    productExcludedTerms: stringArrayValue(templateProductTarget.excludedTerms).join(", "),
    strongReminder: strongReminderPolicyFromSourceConfig(templateSourceConfig).enabled,
  };
  const [query, setQuery] = useState(template.query ?? "");
  const [includeTerms, setIncludeTerms] = useState(initialIncludeTerms);
  const [excludeTerms, setExcludeTerms] = useState(initialExcludeTerms);
  const [minListingPrice, setMinListingPrice] = useState(initialMinListingPrice);
  // 关键词档案只有「关键词上新」一种目的，不再给一个只有一个选项的下拉。
  const purpose: MonitoringPurpose = exactProduct ? "keyword_new_listing" : template.monitoring_purpose;
  const initialInterval = String(template.schedule_interval_minutes);
  const [interval, setInterval] = useState(initialInterval);
  const intervalTouched = interval !== initialInterval;
  const mixedIntervals = new Set(bindings.map((binding) => binding.schedule_interval_minutes)).size > 1;
  const [nextRunDay, setNextRunDay] = useState(initialNextRun.day);
  const [nextRunTime, setNextRunTime] = useState(initialNextRun.time);
  const [recallQueries, setRecallQueries] = useState(initialProduct.recallQueries);
  const [requiredGroups, setRequiredGroups] = useState(initialProduct.requiredGroups);
  const [supportingGroups, setSupportingGroups] = useState(initialProduct.supportingGroups);
  const [productExcludedTerms, setProductExcludedTerms] = useState(initialProduct.productExcludedTerms);
  const [strongReminder, setStrongReminder] = useState(initialProduct.strongReminder);
  const targetPriceConfigured = bindings.every((binding) => binding.target_price !== null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const aligned = new Set(bindings.map(keywordSettingsSignature)).size === 1;

  const nextRunTouched = nextRunDay !== initialNextRun.day || nextRunTime !== initialNextRun.time;
  const productTouched = exactProduct && (
    recallQueries !== initialProduct.recallQueries
    || requiredGroups !== initialProduct.requiredGroups
    || supportingGroups !== initialProduct.supportingGroups
    || productExcludedTerms !== initialProduct.productExcludedTerms
    || strongReminder !== initialProduct.strongReminder
  );
  const profilePatch = exactProduct ? {} : {
    ...(includeTerms !== initialIncludeTerms ? { includeTerms: splitTermInput(includeTerms) } : {}),
    ...(excludeTerms !== initialExcludeTerms ? { excludeTerms: splitTermInput(excludeTerms) } : {}),
    ...(minListingPrice !== initialMinListingPrice ? { minListingPrice: minListingPrice ? Number(minListingPrice) : null } : {}),
  };
  // 每个来源只发它和表单不一样的那几项，没改的不碰。
  // 以前不管改没改都把频率和下次时间整份写回去，点一次保存就等于「全部来源立刻再跑一轮」。
  const bindingPatches = bindings.map((binding) => ({
    binding,
    patch: {
      ...(query.trim() !== (binding.query ?? "") ? { query: query.trim() } : {}),
      ...(purpose !== binding.monitoring_purpose ? { monitoringPurpose: purpose } : {}),
      // 只有亲手改了频率才写：各来源频率不同时，表单里显示的只是第一个来源的值，
      // 以前改个排除词点保存，二手站的每小时就被悄悄改回了每天。
      ...(intervalTouched && Number(interval) !== binding.schedule_interval_minutes ? { intervalMinutes: Number(interval) } : {}),
      ...(nextRunTouched ? { nextRunAt: tokyoIso(nextRunDay, nextRunTime) } : {}),
      ...(productTouched ? {
        sourceConfig: {
          ...bindingSourceConfig(binding),
          productTarget: {
            ...templateProductTarget,
            recallQueries: splitTermInput(recallQueries).slice(0, 4),
            requiredTermGroups: splitTermInput(requiredGroups).slice(0, 12),
            supportingTermGroups: splitTermInput(supportingGroups).slice(0, 12),
            excludedTerms: splitTermInput(productExcludedTerms).slice(0, 12),
          },
          strongReminder: {
            enabled: targetPriceConfigured && strongReminder,
            intervalMinutes: 20,
            repeatCount: 3,
          },
        },
      } : {}),
    },
  })).filter(({ patch }) => Object.keys(patch).length > 0);
  const profileDirty = Object.keys(profilePatch).length > 0;
  const dirty = profileDirty || bindingPatches.length > 0;
  const intervalLabel = MONITORING_INTERVAL_OPTIONS.find((option) => option.value === interval)?.label ?? `每 ${interval} 分钟`;
  const cadenceText = mixedIntervals && !intervalTouched ? "各来源按各自的频率" : intervalLabel;
  const intervalGroups = [...bindings.reduce((groups, binding) => {
    const label = MONITORING_INTERVAL_OPTIONS.find((option) => option.value === String(binding.schedule_interval_minutes))?.label
      ?? `每 ${binding.schedule_interval_minutes} 分钟`;
    return groups.set(label, [...groups.get(label) ?? [], binding.display_name]);
  }, new Map<string, string[]>())].map(([label, names]) => `${names.join("、")}${label}`).join("；");

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    if (nextRunTouched && Date.parse(tokyoIso(nextRunDay, nextRunTime)) <= Date.now()) {
      setMessage({ ok: false, text: `东京时间 ${shortDay(nextRunDay)} ${nextRunTime} 已经过去了，这次没有保存。请选一个还没到的时间；想现在就跑，用下面来源列表里的「只巡回这个来源」。` });
      return;
    }
    setSaving(true);
    setMessage(null);
    const [profileResult, ...results] = await Promise.allSettled([
      profileDirty
        ? apiFetch(`/api/watch-profiles/${profile.id}`, { method: "PATCH", body: JSON.stringify(profilePatch) })
        : Promise.resolve(null),
      ...bindingPatches.map(({ binding, patch }) => apiFetch(`/api/watch-bindings/${binding.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      })),
    ]);
    const failures = results.flatMap((result, index) => result.status === "rejected" ? [bindingPatches[index]!.binding.display_name] : []);
    const profileFailed = profileResult?.status === "rejected";
    setMessage(profileFailed || failures.length > 0
      ? { ok: false, text: `${profileFailed ? "包含 / 排除词和最低价没存上；" : ""}${failures.length > 0 ? `${failures.join("、")} 没存上；` : ""}其余已保存。可以再点一次保存。` }
      : { ok: true, text: "已保存。这次改了什么，记在页面最下面的「改动记录」里。" },
    );
    if (profileResult?.status === "fulfilled" || results.some((result) => result.status === "fulfilled")) await onSaved();
    setSaving(false);
  }

  return (
    <form className="binding-schedule-editor radar-shared-settings" onSubmit={save}>
      <div className="radar-shared-intro">
        <span>{exactProduct ? "精确同款雷达共同规则" : "关键词雷达共同规则"}</span>
        <strong>{query || "尚未填写关键词"}</strong>
        <p>{exactProduct ? `所有来源共享同一个商品指纹：${productTargetSummary(template)}。这里可调整召回描述、频率和通知；要更换锚点商品请回到搜索页重新建立雷达。` : "这里保存一次，全部来源用同一套关键词、筛选和巡回时间；各来源的运行状态与错误仍在下面各自记录。"}</p>
      </div>
      {!aligned && <p className="radar-settings-warning" role="status">各来源的设置不完全一样；保存时会把有差别的来源改成这里的值。</p>}
      <div className="field">
        <label htmlFor="radar-shared-query">日文关键词</label>
        <input id="radar-shared-query" className="text-input" value={query} onChange={(event) => { setQuery(event.target.value); setMessage(null); }} required maxLength={200} placeholder="エミリア" />
      </div>
      {!exactProduct && <div className="field">
        <label htmlFor="radar-include-terms">必须包含</label>
        <input id="radar-include-terms" className="text-input" value={includeTerms} onChange={(event) => { setIncludeTerms(event.target.value); setMessage(null); }} placeholder="エミリア|EMILIA|艾米莉亚|爱蜜莉雅" />
        <small>逗号分隔的每组都必须命中；同组内用“|”填写别名。留空时按日文关键词自动校验。</small>
      </div>}
      {!exactProduct && <div className="field">
        <label htmlFor="radar-exclude-terms">命中即排除</label>
        <input id="radar-exclude-terms" className="text-input" value={excludeTerms} onChange={(event) => { setExcludeTerms(event.target.value); setMessage(null); }} placeholder="Emilia Clarke|エミリア・クラーク, Emilia-Romagna" />
        <small>任一排除组命中后，不进入基线、变化记录或邮件。</small>
      </div>}
      {!exactProduct && <div className="field">
        <label htmlFor="radar-min-listing-price">最低价 / ¥</label>
        <input id="radar-min-listing-price" className="text-input" inputMode="numeric" value={minListingPrice} onChange={(event) => { setMinListingPrice(event.target.value.replace(/\D/g, "").slice(0, 8)); setMessage(null); }} placeholder="不限" />
        <small>低于这个价的商品不进日报。拍卖按当前出价算，1 円起拍的也会被挡掉；没标价的不挡。改它不会重新建档。</small>
      </div>}
      {!exactProduct && <p className="schedule-separation-note">
        某一件商品天天出现、不想再看到？到 <Link href={`/watches/${encodeURIComponent(profile.id)}/muted-products` as Route}>屏蔽单品</Link> 里点选它标题里的几个词。
      </p>}
      {exactProduct && <>
        <div className="field">
          <label htmlFor="radar-product-recall-queries">同款短标题召回式（可选）</label>
          <textarea id="radar-product-recall-queries" className="text-input" rows={4} value={recallQueries} onChange={(event) => { setRecallQueries(event.target.value); setMessage(null); }} maxLength={800} />
          <small>可留空。每行一条，最多 4 条；短查询只负责召回候选，不能单独证明是同款。</small>
        </div>
        <div className="field">
          <label htmlFor="radar-product-required-groups">必要身份组（AND，可选）</label>
          <input id="radar-product-required-groups" className="text-input" value={requiredGroups} onChange={(event) => { setRequiredGroups(event.target.value); setMessage(null); }} maxLength={1200} placeholder="加藤恵|加藤 恵|加藤惠, ふわぷち|フワプチ|Fuwapuchi" />
          <small>可留空。填写后，逗号分隔的每组都必须命中；同组别名使用“|”。</small>
        </div>
        <div className="field">
          <label htmlFor="radar-product-supporting-groups">辅助证据组（OR，可选）</label>
          <input id="radar-product-supporting-groups" className="text-input" value={supportingGroups} onChange={(event) => { setSupportingGroups(event.target.value); setMessage(null); }} maxLength={1200} placeholder="私服|私服Ver, M|Mぬいぐるみ|ぬいぐるみ, 冴えカノ|冴えない彼女" />
          <small>可留空。填写后，命中任一组会增强短标题的同款证据，最终仍须通过商品身份判断。</small>
        </div>
        <div className="field">
          <label htmlFor="radar-product-excluded-terms">冲突排除词（可选）</label>
          <input id="radar-product-excluded-terms" className="text-input" value={productExcludedTerms} onChange={(event) => { setProductExcludedTerms(event.target.value); setMessage(null); }} maxLength={1200} placeholder="制服, パジャマ, セーター, Luminasta|ルミナスタ, フィギュア" />
          <small>可留空。填写后，任一组命中即视为冲突款，不会被确认为目标同款或发送通知。</small>
        </div>
        <div className="monitor-event-options item-watch-intents">
          <label data-selected={strongReminder}>
            <input type="checkbox" checked={strongReminder} disabled={!targetPriceConfigured} onChange={(event) => { setStrongReminder(event.target.checked); setMessage(null); }} />
            <span><strong>目标价强提醒</strong><small>{targetPriceConfigured ? "确认同款达到目标价后在 0、20、40 分钟各发一封邮件；停售、涨价、暂停时取消尚未发送的邮件。" : "请先在上方事件规则中为所有来源设置目标价，才能开启三次强提醒。"}</small></span>
          </label>
        </div>
      </>}
      <div className="watch-schedule-grid">
        <EditorialSelect index="01" label="巡回频率" caption="Cadence" value={interval} options={MONITORING_INTERVAL_OPTIONS} onValueChange={(value) => { setInterval(value); setMessage(null); }} />
        <EditorialSelect index="02" label="下次巡回" caption="东京时间" value={nextRunDay} options={nextRunDayOptions(nextRunDay)} onValueChange={(value) => { setNextRunDay(value); setMessage(null); }} />
        <EditorialSelect index="03" label="几点" caption="东京时间" value={nextRunTime} options={nextRunTimeOptions(nextRunTime)} onValueChange={(value) => { setNextRunTime(value); setMessage(null); }} />
      </div>
      <p className="schedule-separation-note">
        {nextRunTouched
          ? `保存后，全部来源在东京时间 ${shortDay(nextRunDay)} ${nextRunTime} 一起跑，之后${cadenceText}一轮。`
          : `下一轮：东京时间 ${shortDay(nextRunDay)} ${nextRunTime}，之后${cadenceText}一轮。只改频率时，这个时间不变。`}
      </p>
      {mixedIntervals && <p className="schedule-separation-note">
        {intervalTouched
          ? `保存后全部来源改成${intervalLabel}。现在是：${intervalGroups}。`
          : `各来源频率不同：${intervalGroups}。不动「巡回频率」就各自保持，改别的设置也不会碰它。`}
      </p>}
      <div className="radar-settings-savebar" data-dirty={dirty}>
        <span>{saving ? "正在保存…" : dirty ? "有改动还没保存" : "和当前生效的设置一致"}</span>
        <button className="primary-button" type="submit" disabled={saving || !dirty || !query.trim()}>{saving ? "正在保存…" : dirty ? "保存改动" : "已保存"}</button>
      </div>
      {message && <p className="item-alert-message" data-tone={message.ok ? "ok" : "error"} role={message.ok ? "status" : "alert"}>{message.text}</p>}
    </form>
  );
}

export function WatchDetail({ id }: { id: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [runs, setRuns] = useState<Record<string, WatchRun[]>>({});
  const [sourceChoices, setSourceChoices] = useState<SourceChoice[]>([]);
  const [newSources, setNewSources] = useState<SourceId[]>([]);
  const [notice, setNotice] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [addingSources, setAddingSources] = useState(false);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [expandedBindingId, setExpandedBindingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [changeLogVersion, setChangeLogVersion] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const body = await fetchWatchDetail(id, signal);
    setProfile(body.profile);
    setBindings(body.bindings);
    setRuns(body.runs);
    setLoadError("");
    setChangeLogVersion((current) => current + 1);
  }, [id]);
  const refreshChangeLog = useCallback(() => setChangeLogVersion((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchWatchDetail(id, controller.signal),
      apiFetch<{ items: SourceChoice[] }>("/api/sources", { signal: controller.signal }),
    ]).then(([body, sourceBody]) => {
      const visible = sourceBody.items.filter((source) => source.id !== "rakuten_books" && sourceLabels[source.id]);
      setProfile(body.profile);
      setBindings(body.bindings);
      setRuns(body.runs);
      setSourceChoices(visible);
      setNewSources([]);
      setLoadError("");
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(error instanceof Error ? error.message : "关注档案读取失败");
    });
    return () => controller.abort();
  }, [id]);

  const itemBindings = bindings.filter((binding) => binding.kind === "item");
  const keywordBindings = bindings.filter((binding) => binding.kind === "keyword");
  const isItemDossier = profile?.dossier_kind === "item"
    || (!profile?.dossier_kind && itemBindings.length > 0 && keywordBindings.length === 0);
  const keywordTemplate = keywordBindings[0];
  const isExactProductDossier = profile?.dossier_kind === "exact_product"
    || (!profile?.dossier_kind && keywordBindings.length > 0 && keywordBindings.every(isExactProductBinding));
  const isKeywordDossier = profile?.dossier_kind === "keyword"
    || isExactProductDossier
    || (!profile?.dossier_kind && keywordBindings.length > 0 && itemBindings.length === 0);
  const boundSources = new Set(bindings.map((binding) => binding.source_id));
  const unboundSourceChoices = sourceChoices.filter((source) => !boundSources.has(source.id));
  const selectableNewSources = unboundSourceChoices.filter((source) => source.adapter_available);
  const keywordSettingsAligned = new Set(keywordBindings.map(keywordSettingsSignature)).size <= 1;
  const keywordSourceStates = keywordBindings.map((binding) => sourceDisplayState(binding, runs[binding.id]?.[0]));
  const keywordAttentionCount = keywordSourceStates.filter((state) => state === "failed" || state === "disabled" || state === "cooldown").length;
  async function action(binding: Binding, name: "run" | "pause" | "resume") {
    const actionKey = `${binding.id}:${name}`;
    setPendingAction(actionKey);
    setNotice("");
    try {
      if (name === "resume" && profile && !profile.enabled) {
        await apiFetch(`/api/watch-profiles/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
      }
      await apiFetch(`/api/watch-bindings/${binding.id}/${name}`, { method: "POST" });
      setNotice(name === "run"
        ? `已排入一次真实巡回；结果会写入本档案并按现有提醒规则处理。原定下次巡回 ${tokyoFull(binding.next_run_at)} 不会顺延；若本次触发来源冷却，定时任务会等待冷却结束。`
        : name === "pause" ? "这个来源的定时巡回已暂停。" : "这个来源的定时巡回已恢复。",
      );
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setPendingAction("");
    }
  }

  async function profileAction(name: "pause" | "resume") {
    setPendingAction(`profile:${name}`);
    setNotice("");
    try {
      if (name === "pause") {
        await apiFetch(`/api/watch-profiles/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
        });
        setNotice("整份档案已暂停；来源绑定、基线和历史记录都已保留。你可以随时重新启动。");
      } else {
        const result = await apiFetch<ResumeProfileResponse>(`/api/watch-profiles/${id}/resume`, { method: "POST" });
        const unavailable = result.skippedBindings.filter((binding) => binding.reason === "source_monitoring_not_allowed").length;
        const skipped = unavailable > 0 ? `${unavailable} 个来源仍未开放` : "";
        setNotice(`已启动 ${result.resumedBindings} 个来源${result.alreadyActiveBindings > 0 ? `，另有 ${result.alreadyActiveBindings} 个原本已在运行` : ""}${skipped ? `；${skipped}` : ""}。`);
      }
      await load();
    } catch (error) {
      setNotice(profileActionErrorMessage(error));
    } finally {
      setPendingAction("");
    }
  }

  async function deleteProfile() {
    await apiFetch(`/api/watch-profiles/${id}`, { method: "DELETE" });
    window.location.assign("/watches");
  }

  async function archivePurchasedProfile() {
    setPendingAction("profile:archive");
    try {
      await apiFetch(`/api/watch-profiles/${id}/archive`, { method: "POST" });
      setDeleteTarget(null);
      setNotice("已按“我已购买”归档：全部巡回已经停止，商品、价格快照和历史事件仍然保留。");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "归档失败");
    } finally {
      setPendingAction("");
    }
  }

  async function deleteBinding(binding: Binding) {
    await apiFetch(`/api/watch-bindings/${binding.id}`, { method: "DELETE" });
    setDeleteTarget(null);
    await load();
  }

  function toggleNewSource(source: SourceId) {
    setNewSources((current) => current.includes(source) ? current.filter((id) => id !== source) : [...current, source]);
  }

  async function addSources(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!keywordTemplate || newSources.length === 0) return;
    if (!keywordSettingsAligned) {
      setNotice("当前来源规则不一致；请先在“雷达共同规则”中保存一次，再添加新来源。");
      return;
    }
    setAddingSources(true);
    setNotice("");
    try {
      const selected = newSources.filter((source) => !boundSources.has(source));
      const sharedSourceConfig = bindingSourceConfig(keywordTemplate);
      const exactProduct = isExactProductBinding(keywordTemplate);
      const results = await Promise.allSettled(selected.map(async (source) => {
        const result = await apiFetch<{ paused: boolean }>(`/api/watch-profiles/${id}/bindings`, {
          method: "POST",
          body: JSON.stringify({
            source,
            kind: "keyword",
            monitoringPurpose: keywordTemplate.monitoring_purpose,
            query: keywordTemplate.query,
            intervalMinutes: keywordTemplate.schedule_interval_minutes,
            sourceConfig: {
              ...sharedSourceConfig,
              pages: exactProduct ? 1 : 2,
              availabilityMode: "purchasable",
              inStockOnly: true,
            },
          }),
        });
        return { source, paused: result.paused };
      }));
      const succeeded = new Set<SourceId>();
      let pausedCount = 0;
      const failures: string[] = [];
      results.forEach((result, index) => {
        const source = selected[index]!;
        if (result.status === "fulfilled") {
          succeeded.add(source);
          if (result.value.paused) pausedCount += 1;
        } else {
          failures.push(`${sourceLabels[source] ?? source}：${result.reason instanceof Error ? result.reason.message : "添加失败"}`);
        }
      });
      setNewSources((current) => current.filter((source) => !succeeded.has(source)));
      setNotice(failures.length > 0
        ? `已加入 ${succeeded.size} 个来源，${failures.length} 个失败。${failures[0]}`
        : pausedCount > 0 ? `已加入 ${succeeded.size} 个来源；其中 ${pausedCount} 个当前只保存条件。` : `已加入 ${succeeded.size} 个来源，并沿用现有关键词与巡回计划。`,
      );
      if (succeeded.size > 0) {
        await load();
        if (failures.length === 0) setShowSourcePicker(false);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "来源添加失败");
    } finally {
      setAddingSources(false);
    }
  }

  if (!profile) return <div className="empty-state"><p>{loadError || "正在读取订阅配置…"}</p></div>;

  const dossierCode = isItemDossier ? "商品监控" : isExactProductDossier ? "精确同款雷达" : isKeywordDossier ? "关键词雷达" : "历史混合档案";
  const dossierDescription = isItemDossier
    ? "这是一份商品监控档案，只管理具体来源商品的巡回计划、提醒与来源状态。"
    : isExactProductDossier
      ? `这是一份跨来源精确同款雷达。所有来源共享同一个商品指纹（${keywordTemplate ? productTargetSummary(keywordTemplate) : "待确认"}），这里管理各来源的计划与状态；网页补漏只允许在搜索页手动执行。`
    : isKeywordDossier
      ? "这是一份关键词雷达。所有来源共享同一个关键词与分析目的，这里只保留各来源的配置、状态和错误。"
      : "这份历史档案同时包含单品与关键词绑定。界面不会再向其中加入新类型，以免继续扩大混合边界。";
  const deleteBindingTarget = deleteTarget?.kind === "binding" ? deleteTarget.binding : null;
  const lifecycleClosed = isTerminalWatchLifecycle(profile.lifecycle_status);
  const activeBindingCount = bindings.filter((binding) => binding.enabled === 1).length;
  const profileRunning = profile.enabled === 1 && activeBindingCount > 0;
  const profileStatus = watchLifecycleLabel(profile.lifecycle_status, profile.lifecycle_reason);
  const profileActionName = profileRunning ? "pause" : "resume";
  const profileActionBusy = pendingAction === `profile:${profileActionName}`;
  const effectiveDossierKind: WatchDossierKind = isItemDossier
    ? "item"
    : isExactProductDossier
      ? "exact_product"
      : "keyword";
  const profileTitle = watchDossierTitle(effectiveDossierKind, profile.name);
  const profileDescription = watchDossierDescription(effectiveDossierKind, profile.name, profile.description) ?? dossierDescription;
  const monitorSources = [...new Map(bindings.map((binding) => [
    binding.source_id,
    { id: binding.source_id, label: binding.display_name },
  ])).values()];

  return (
    <div className="detail-stack reveal reveal-delay-1">
      <section className="paper-panel watch-profile-summary" data-kind={isItemDossier ? "item" : isExactProductDossier ? "exact_product" : isKeywordDossier ? "keyword" : "mixed"}>
        <div className="panel-header">
          <div><p className="eyebrow">{dossierCode}</p><h2>{profileTitle}</h2></div>
          <div className="profile-header-actions">
            <span className={`status-pill ${profile.lifecycle_status === "active" ? "good" : "warn"}`}>{profileStatus}</span>
            {!lifecycleClosed && <a className="ghost-button" href="#monitoring-strategy"><Settings2 size={14} aria-hidden="true" />调整策略</a>}
            <Link className="ghost-button" href={`/changes?watch=${encodeURIComponent(profile.id)}` as Route}>查看每日巡回结果 <ArrowUpRight size={13} aria-hidden="true" /></Link>
            {isKeywordDossier && !isExactProductDossier && <Link className="ghost-button" href={`/inbox?watch=${encodeURIComponent(profile.id)}&view=ai` as Route}>收件箱 · AI 拦下的 <ArrowUpRight size={13} aria-hidden="true" /></Link>}
            {isKeywordDossier && !isExactProductDossier && <Link className="ghost-button" href={`/watches/${encodeURIComponent(profile.id)}/muted-products` as Route}>屏蔽单品 <ArrowUpRight size={13} aria-hidden="true" /></Link>}
            {!lifecycleClosed && <button className="ghost-button" type="button" disabled={Boolean(pendingAction)} onClick={() => void profileAction(profileActionName)}>
              {profileRunning ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
              {profileActionBusy ? "正在更新…" : profileRunning ? "暂停整份档案" : "启动全部可用来源"}
            </button>}
            {!lifecycleClosed && (isItemDossier || isExactProductDossier) && <button className="ghost-button" type="button" disabled={Boolean(pendingAction)} onClick={() => setDeleteTarget({ kind: "archive" })}><Check size={14} aria-hidden="true" />已购买并归档</button>}
            <button className="ghost-button danger-button" type="button" disabled={Boolean(pendingAction)} onClick={() => setDeleteTarget({ kind: "profile" })}><Trash2 size={14} aria-hidden="true" />删除整份档案</button>
          </div>
        </div>
        <div className="panel-body detail-summary">
          <p>{profileDescription}</p>
          {profile.lifecycle_status === "archived" && <p><Archive size={14} aria-hidden="true" /> 你已确认购买完成；这份档案只保留历史，不会再进入下一轮监控。</p>}
          {!isItemDossier && !isExactProductDossier && <><p>包含词：{parseTerms(profile.include_terms_json).join("、") || "—"}</p><p>排除词：{parseTerms(profile.exclude_terms_json).join("、") || "—"}</p></>}
        </div>
      </section>

      {isExactProductDossier && profile.dossier_kind === "exact_product" && <ReferenceImagePanel profileId={profile.id} />}

      {!lifecycleClosed && <section id="monitoring-strategy" className="paper-panel monitor-rule-panel">
        <div className="panel-body">
          <MonitorRuleEditor
            profileId={profile.id}
            dossierKind={effectiveDossierKind}
            sources={monitorSources}
            onSaved={load}
          />
        </div>
      </section>}

      {!lifecycleClosed && <DeliveryChannelsPanel profileId={profile.id} onSaved={refreshChangeLog} />}

      {isKeywordDossier && keywordTemplate ? (
        <>
          <section className="paper-panel radar-settings-panel">
            <div className="panel-header">
              <div><p className="eyebrow">{isExactProductDossier ? "精确同款雷达" : "关键词雷达"}</p><h2>雷达共同规则</h2></div>
              <span className="status-pill">同步 {keywordBindings.length} 个来源</span>
            </div>
            <div className="panel-body">
              <KeywordRadarSettingsEditor profile={profile} bindings={keywordBindings} onSaved={load} />
            </div>
          </section>

          {!isExactProductDossier && profile.dossier_kind === "keyword" && <DigestExtrasPanel profileId={profile.id} onSaved={refreshChangeLog} />}

          <section className="paper-panel radar-sources-panel">
            <div className="panel-header">
              <div><p className="eyebrow">SOURCE STATUS & CONTROL</p><h2>来源状态与控制</h2></div>
              <div className="radar-panel-actions">
                <span className={`status-pill ${keywordAttentionCount === 0 ? "good" : "warn"}`}>{keywordBindings.length} 个来源{keywordAttentionCount > 0 ? ` · ${keywordAttentionCount} 个需处理` : " · 状态平稳"}</span>
                {unboundSourceChoices.length > 0 && <button className="ghost-button" type="button" aria-expanded={showSourcePicker} aria-controls="radar-source-picker" onClick={() => { setShowSourcePicker((current) => !current); setNewSources([]); }}><Plus size={14} aria-hidden="true" />{showSourcePicker ? "收起添加面板" : "添加来源"}</button>}
              </div>
            </div>
            <div className="panel-body radar-source-body">
              {showSourcePicker && unboundSourceChoices.length > 0 && (
                <form id="radar-source-picker" className="radar-source-picker-panel" onSubmit={addSources}>
                  <div className="keyword-extension-summary">
                    <span>沿用共同规则</span><strong>{keywordTemplate.query}</strong>
                    <p>{isExactProductDossier ? `商品指纹：${productTargetSummary(keywordTemplate)}` : purposeLabel(keywordTemplate.monitoring_purpose)} · {scheduleLabel(keywordTemplate)}。这里只列出尚未加入的来源，默认不替你选择。</p>
                  </div>
                  {!keywordSettingsAligned && <p className="radar-settings-warning">当前来源规则不一致；请先保存上方共同规则。</p>}
                  <fieldset className="watch-source-picker">
                    <legend>选择要加入的来源</legend>
                    <div className="source-picker-toolbar">
                      <span>待加入 {newSources.length} 个</span>
                      <button type="button" onClick={() => setNewSources(selectableNewSources.map((source) => source.id))}>全选可用</button>
                      <button type="button" onClick={() => setNewSources([])}>清空</button>
                    </div>
                    {unboundSourceChoices.map((source) => (
                      <label key={source.id} data-selected={newSources.includes(source.id)} data-disabled={!source.adapter_available}>
                        <input type="checkbox" checked={newSources.includes(source.id)} disabled={!source.adapter_available} onChange={() => toggleNewSource(source.id)} />
                        <span><strong>{sourceLabels[source.id] ?? source.display_name}</strong><small>{!source.adapter_available ? "适配器未就绪" : source.monitoring_allowed ? "可自动巡回" : "可先保存；来源开放后再启动"}</small></span>
                      </label>
                    ))}
                  </fieldset>
                  <button className="primary-button keyword-source-submit" disabled={addingSources || newSources.length === 0 || !keywordSettingsAligned}><Plus size={15} aria-hidden="true" />{addingSources ? "正在加入…" : `加入 ${newSources.length} 个来源`}</button>
                </form>
              )}

              <ol className="radar-source-list">
                {keywordBindings.map((binding, index) => {
                  const bindingRuns = runs[binding.id] ?? [];
                  const latestRun = bindingRuns[0];
                  const state = sourceDisplayState(binding, latestRun);
                  const expanded = expandedBindingId === binding.id;
                  const runBusy = pendingAction === `${binding.id}:run`;
                  const stateBusy = pendingAction === `${binding.id}:${binding.enabled ? "pause" : "resume"}`;
                  return (
                    <li className="radar-source-item" key={binding.id} data-state={state}>
                      <div className="radar-source-summary">
                        <div className="radar-source-identity">
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <div><strong>{binding.display_name}</strong><small>{binding.last_error_message ? `${binding.last_error_code ?? "来源错误"}：${binding.last_error_message}` : binding.baseline_completed ? `${isExactProductDossier ? "首次同款巡回已完成" : "关键词结果基线已建立"}` : isExactProductDossier ? "等待首次同款巡回" : "等待建立关键词结果基线"}</small></div>
                        </div>
                        <span className={`status-pill ${sourceStateClass(state)}`}>{sourceStateLabel(state, isExactProductDossier)}</span>
                        <div className="radar-source-fact"><span>最近成功</span><strong>{binding.last_success_at ? tokyoDateTime(binding.last_success_at) : "尚无"}</strong></div>
                        <div className="radar-source-fact"><span>下次巡回</span><strong>{binding.enabled ? tokyoDateTime(binding.next_run_at) : "已暂停"}</strong></div>
                        <button className="ghost-button radar-source-open" type="button" aria-expanded={expanded} aria-controls={`source-control-${binding.id}`} onClick={() => setExpandedBindingId(expanded ? null : binding.id)}><Settings2 size={14} aria-hidden="true" />{expanded ? "收起" : "管理来源"}<ChevronDown size={13} aria-hidden="true" /></button>
                      </div>

                      {expanded && (
                        <div className="radar-source-detail" id={`source-control-${binding.id}`}>
                          <dl className="radar-source-meta">
                            <div><dt>最近成功</dt><dd>{binding.last_success_at ? tokyoFull(binding.last_success_at) : "尚无"}</dd></div>
                            <div><dt>来源健康</dt><dd>{sourceHealthLabel(binding.health_status)}</dd></div>
                            <div><dt>凭据</dt><dd>{credentialStatusLabel(binding.credential_status)}</dd></div>
                          </dl>
                          {binding.last_error_message && <p className="error-copy">{binding.last_error_code ?? "source_error"}：{binding.last_error_message}</p>}
                          <WatchListingEvidence
                            bindingId={binding.id}
                            sourceName={binding.display_name}
                            totalCount={Number(binding.matched_listing_count || 0)}
                            dossierKind={isExactProductDossier ? "exact_product" : "keyword"}
                          />
                          <div className="binding-action-block">
                            <div className="action-row">
                              <button className="ghost-button" type="button" disabled={Boolean(pendingAction) || lifecycleClosed} onClick={() => void action(binding, "run")}><RefreshCw size={14} aria-hidden="true" />{runBusy ? "正在排队…" : "只巡回这个来源"}</button>
                              <button className="ghost-button" type="button" disabled={Boolean(pendingAction) || lifecycleClosed} onClick={() => void action(binding, binding.enabled ? "pause" : "resume")}>{binding.enabled ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{stateBusy ? "正在更新…" : binding.enabled ? "暂停该来源" : "恢复该来源"}</button>
                              {keywordBindings.length > 1 && <button className="ghost-button danger-button" type="button" onClick={() => setDeleteTarget({ kind: "binding", binding })}><Trash2 size={14} aria-hidden="true" />移除该来源</button>}
                            </div>
                            <p className="manual-run-note">手动巡回只运行这个来源，不会顺延原定计划；限流或阻断仍会按安全规则进入冷却。</p>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          </section>
        </>
      ) : (
        <section className="paper-panel">
          <div className="panel-header"><h2>{isItemDossier ? "检查计划与来源控制" : "历史混合档案"}</h2><span className="status-pill">{bindings.length} 个绑定</span></div>
          <div className="panel-body stack-list">
            {bindings.map((binding) => {
              const runBusy = pendingAction === `${binding.id}:run`;
              const stateBusy = pendingAction === `${binding.id}:${binding.enabled ? "pause" : "resume"}`;
              return <article className="stack-card binding-card" key={binding.id} data-kind={binding.kind}>
                <div className="binding-overview">
                  <p className="eyebrow">{binding.display_name} · {purposeLabel(binding.monitoring_purpose)}</p>
                  <h3>{binding.kind === "item" ? profile.name : binding.query}</h3>
                  {binding.kind === "item" && binding.target_url && <p className="binding-target-url">{binding.target_url}</p>}
                  <p>{isItemDossier ? `商品基线${binding.baseline_completed ? "已建立" : "待建立"}` : `关键词结果基线${binding.baseline_completed ? "已建立" : "待建立"}`} · {scheduleLabel(binding, profile.dossier_kind)} · 下次 {tokyoFull(binding.next_run_at)}</p>
                  <p>最近成功：{binding.last_success_at ? tokyoFull(binding.last_success_at) : "尚无"} · 凭据 {credentialStatusLabel(binding.credential_status)}</p>
                  {binding.last_error_message && <p className="error-copy">{binding.last_error_code}：{binding.last_error_message}</p>}
                </div>
                <BindingScheduleEditor key={`schedule:${binding.id}:${binding.updated_at}`} binding={binding} dossierKind={profile.dossier_kind} onSaved={load} />
                <div className="binding-action-block">
                  <div className="action-row">
                    <button className="ghost-button" type="button" disabled={Boolean(pendingAction) || lifecycleClosed} onClick={() => void action(binding, "run")}><RefreshCw size={14} aria-hidden="true" />{runBusy ? "正在排队…" : "立即巡回一次"}</button>
                    <button className="ghost-button" type="button" disabled={Boolean(pendingAction) || lifecycleClosed} onClick={() => void action(binding, binding.enabled ? "pause" : "resume")}>{binding.enabled ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{stateBusy ? "正在更新…" : binding.enabled ? "暂停巡回" : "恢复巡回"}</button>
                  </div>
                  <p className="manual-run-note">立即巡回会马上排入一次真实扫描，结果照常写入档案并按现有提醒规则处理；它不会把原定的下一次巡回向后顺延。</p>
                </div>
              </article>;
            })}
            {!bindings.length && <p>暂无来源绑定。</p>}
          </div>
        </section>
      )}

      <ProfileChangeLog profileId={profile.id} sourceCount={bindings.length} refreshKey={changeLogVersion} />

      {notice && <p className="form-note detail-global-notice" role="status">{notice}</p>}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget?.kind === "profile" ? "删除整份关注档案？" : deleteTarget?.kind === "archive" ? "确认已经购买并归档？" : "移除这个扫描来源？"}
        description={deleteTarget?.kind === "profile"
          ? `“${profile.name}”的来源绑定、全部轮询记录与未来计划会被移除；已经保存的商品、价格快照与行情样本仍留在历史库中。这个操作不能撤销。`
          : deleteTarget?.kind === "archive"
            ? `“${profile.name}”的全部巡回会立即停止，并以“已购买”作为结束原因。历史商品、价格和事件证据都会保留；它不会再被普通恢复操作重新启动。`
          : deleteBindingTarget
            ? `${deleteBindingTarget.display_name} 的绑定与轮询记录会被删除；其他来源、商品快照和行情样本不受影响。`
            : ""}
        confirmLabel={deleteTarget?.kind === "profile" ? "删除档案" : deleteTarget?.kind === "archive" ? "确认购买并归档" : "移除这个来源"}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={deleteTarget?.kind === "profile" ? deleteProfile : deleteTarget?.kind === "archive" ? archivePurchasedProfile : async () => { if (deleteBindingTarget) await deleteBinding(deleteBindingTarget); }}
      />
    </div>
  );
}
