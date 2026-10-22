"use client";

import type { Route } from "next";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ImagePlus, Plus, Trash2 } from "lucide-react";
import {
  buildProductSearchPlan,
  fingerprintFromExtractedProductName,
  PRODUCT_MATCH_VERSION,
  type ProductTargetExtractionInput,
  type SourceId,
  type WatchDossierKind,
} from "@jpgr/core";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import { tokyoDateTime } from "@/lib/format-time";
import { LoadStateNotice, type LoadState } from "@/components/load-state-notice";
import { EditorialSelect } from "@/components/editorial-select";
import { MONITORING_INTERVAL_OPTIONS } from "@/components/monitoring-options";
import { MAX_REFERENCE_IMAGES, prepareReferenceImage, REFERENCE_IMAGE_EXPLAINER, uploadReferenceImage, type PreparedReferenceImage } from "@/components/reference-image-panel";
import { ItemScheduleControls } from "@/components/item-schedule-controls";
import { watchDossierDescription, watchDossierTitle } from "@/lib/watch-dossier-copy";
import { isTerminalWatchLifecycle, watchOverviewLabel, type WatchLifecycleReason, type WatchLifecycleStatus } from "@/lib/watch-lifecycle";
import { watchSourcesForPreset, type WatchSourcePreset } from "@/lib/watch-source-presets";
import { EXACT_PRODUCT_CONFIG_PROMPT, parseExactProductConfig } from "@/lib/exact-product-config";
import { KEYWORD_RADAR_CONFIG_PROMPT, parseKeywordRadarConfig } from "@/lib/keyword-radar-config";
import {
  WatchSourcePicker,
  watchSourceLabel,
  type WatchSourceChoice,
} from "@/components/watch-source-picker";

interface WatchRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  binding_count: number;
  active_binding_count: number;
  healthy_binding_count: number;
  paused_binding_count: number;
  next_run_at: string | null;
  last_success_at: string | null;
  failing_binding_count: number;
  monitoring_purposes: string | null;
  dossier_kind: WatchDossierKind;
  lifecycle_status: WatchLifecycleStatus;
  lifecycle_reason: WatchLifecycleReason;
}

interface ItemWatchCreateResult {
  profileId: string;
  bindingId: string;
  paused: boolean;
  alreadyWatching: boolean;
  resumed: boolean;
  checkQueued: boolean;
  intervalMinutes: number;
  listing: {
    sourceId: SourceId;
    title: string;
    availability: string;
    canonicalUrl: string;
    currentPrice: number | null;
    lifecycleKind: "one_off" | "replenishable" | "auction";
  };
}

type ComposerMode = "item" | "exact_product" | "keyword";
type FormMode = Exclude<ComposerMode, "item">;

const composerModes: readonly ComposerMode[] = ["item", "exact_product", "keyword"];
const composerModeDetails = {
  item: {
    index: "01",
    title: "商品监控",
    description: "锁定真实商品，观察价格与库存",
    imageSrc: "/art/emilia-01-grin-lineart.svg",
    panelId: "composer-panel-item",
  },
  exact_product: {
    index: "02",
    title: "精确同款雷达",
    description: "锁定商品身份，每轮核对当前可购买同款与目标价",
    imageSrc: "/art/emilia-02-pout-lineart.svg",
    panelId: "composer-panel-exact-product",
  },
  keyword: {
    index: "03",
    title: "关键词雷达",
    description: "跨来源巡回，发现首次出现的商品",
    imageSrc: "/art/emilia-03-thinking-lineart.svg",
    panelId: "composer-panel-keyword",
  },
} satisfies Record<ComposerMode, {
  index: string;
  title: string;
  description: string;
  imageSrc: string;
  panelId: string;
}>;

const EXACT_CONFIG_PLACEHOLDER = JSON.stringify({
  canonical_name: "完整日文商品名",
  title_queries: ["短标题召回式"],
  identity_groups: [["角色名", "别名"], ["品类"]],
  evidence_groups: [["作品名", "作品简称"]],
  exclude_terms: ["フィギュア"],
  price: { target: 7000, strong_alert: true },
  cadence: { minutes: 60 },
  sources: { enabled: ["mercari", "yahoo_fleamarket", "yahoo_auction", "surugaya"] },
}, null, 2);

const KEYWORD_CONFIG_PLACEHOLDER = JSON.stringify({
  name: "爱蜜莉雅毛绒上新",
  query: "エミリア ぬいぐるみ",
  max_price: 5000,
  include_groups: [["エミリア", "EMILIA"]],
  exclude_terms: ["エミリア・クラーク"],
  cadence: { minutes: 1440 },
  sources: { enabled: ["mercari", "yahoo_fleamarket", "yahoo_auction", "surugaya"] },
}, null, 2);

function dossierTypeLabel(kind: WatchDossierKind | undefined, value: string | null): string {
  if (kind === "item") return "商品监控";
  if (kind === "exact_product") return "精确同款雷达";
  if (kind === "keyword") return "关键词上新";
  const hasItem = value?.includes("item_price") === true;
  const hasNewListing = value?.includes("keyword_new_listing") === true;
  if (hasItem && hasNewListing) return "历史混合档案";
  if (hasItem) return "商品监控";
  return "关键词上新";
}

function splitTerms(value: string): string[] {
  return value.split(/[，,、\n]/).map((term) => term.trim()).filter(Boolean).slice(0, 30);
}

function itemWatchFailureMessage(reason: unknown): string {
  const code = apiErrorMessage(reason, "商品监控建立失败");
  const messages: Record<string, string> = {
    invalid_request: "请粘贴完整的已支持来源商品详情链接。",
    invalid_item_url: "这不是当前可识别的商品详情链接。请粘贴 AmiAmi、Mercari、Yahoo!、Amazon Japan、骏河屋、Animate、COSPA、CharaON 或乐天的单品页。",
    invalid_rakuten_item_url: "只支持 item.rakuten.co.jp 的乐天市场商品详情链接。",
    item_lookup_rate_limited: "该来源正在限流，请稍后再试；系统没有把这次失败记成无货。",
    item_lookup_source_unavailable: "该商品来源当前暂停单品查询，请先到来源控制台确认状态。",
    item_lookup_failed: "暂时无法读取该商品的价格与状态，请稍后重试。",
    item_identity_mismatch: "来源返回的商品身份与链接不一致，系统已拒绝建立错误监控。",
    item_payload_invalid: "来源返回的商品资料不完整，系统没有建立不可靠的监控。",
    rakuten_item_lookup_rate_limited: "乐天 API 正在限流，请稍后再试；系统没有把这次失败记成无货。",
    rakuten_item_source_unavailable: "乐天商品查询当前暂停，请先到来源控制台确认服务状态。",
    rakuten_item_lookup_failed: "暂时无法读取该乐天商品的库存，请稍后重试。",
    rakuten_item_identity_mismatch: "乐天返回的商品身份与链接不一致，系统已拒绝建立错误监控。",
    rakuten_item_payload_invalid: "乐天返回的商品资料不完整，系统没有建立不可靠的监控。",
    watch_profile_completed: "这条商品的上一轮监控已经结束或已购买归档；如需重新监控，请先删除旧档案。",
  };
  return messages[code] ?? code;
}

export function WatchManager() {
  const [items, setItems] = useState<WatchRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [sourceChoices, setSourceChoices] = useState<WatchSourceChoice[]>([]);
  const [composerMode, setComposerMode] = useState<ComposerMode>("item");
  const [isComposerSwitching, setIsComposerSwitching] = useState(false);
  const composerSwitchTimer = useRef<number | null>(null);
  const [itemUrl, setItemUrl] = useState("");
  const [itemIntervalMinutes, setItemIntervalMinutes] = useState("30");
  const [itemScheduleMode, setItemScheduleMode] = useState<import("@jpgr/core").ItemScheduleMode>("adaptive");
  const [itemScheduleMaxMinutes, setItemScheduleMaxMinutes] = useState("4320");
  const [itemTargetPrice, setItemTargetPrice] = useState("");
  const [itemMinDropAmount, setItemMinDropAmount] = useState("100");
  const [itemNotifyPriceDrop, setItemNotifyPriceDrop] = useState(true);
  const [itemNotifyRestock, setItemNotifyRestock] = useState(true);
  const [itemNotifySoldOut, setItemNotifySoldOut] = useState(true);
  const [keywordName, setKeywordName] = useState("");
  const [keywordQuery, setKeywordQuery] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [includeTerms, setIncludeTerms] = useState("");
  const [excludeTerms, setExcludeTerms] = useState("");
  const [keywordSources, setKeywordSources] = useState<SourceId[]>([]);
  const [keywordIntervalMinutes, setKeywordIntervalMinutes] = useState("1440");
  const [keywordNextRunLocal, setKeywordNextRunLocal] = useState("");
  const [keywordConfigText, setKeywordConfigText] = useState("");
  const [keywordConfigNotice, setKeywordConfigNotice] = useState<string[]>([]);
  const [exactQuery, setExactQuery] = useState("");
  const [exactSources, setExactSources] = useState<SourceId[]>([]);
  const [exactIntervalMinutes, setExactIntervalMinutes] = useState("1440");
  const [exactNextRunLocal, setExactNextRunLocal] = useState("");
  const [exactTargetPrice, setExactTargetPrice] = useState("");
  const [exactRecallQueries, setExactRecallQueries] = useState("");
  const [exactRequiredGroups, setExactRequiredGroups] = useState("");
  const [exactSupportingGroups, setExactSupportingGroups] = useState("");
  const [exactExcludedTerms, setExactExcludedTerms] = useState("");
  const [exactStrongReminder, setExactStrongReminder] = useState(false);
  const [exactConfigText, setExactConfigText] = useState("");
  const [exactConfigNotice, setExactConfigNotice] = useState<string[]>([]);
  const [busyMode, setBusyMode] = useState<ComposerMode | null>(null);
  const [notices, setNotices] = useState<Record<ComposerMode, string>>({ item: "", exact_product: "", keyword: "" });
  const [exactReferenceImages, setExactReferenceImages] = useState<PreparedReferenceImage[]>([]);

  const exactPlan = exactQuery.trim() ? (() => {
    const inferred = buildProductSearchPlan({ query: exactQuery, mode: "exact_product" });
    return inferred.target ? buildProductSearchPlan({
      query: exactQuery,
      mode: "exact_product",
      intentKind: "named_product",
      target: {
        ...inferred.target,
        recallQueries: splitTerms(exactRecallQueries).slice(0, 4),
        requiredTermGroups: splitTerms(exactRequiredGroups).slice(0, 12),
        supportingTermGroups: splitTerms(exactSupportingGroups).slice(0, 12),
        excludedTerms: splitTerms(exactExcludedTerms).slice(0, 12),
      },
    }) : inferred;
  })() : undefined;
  const composerModeIndex = composerModes.indexOf(composerMode);
  const nextComposerMode = composerModes[(composerModeIndex + 1) % composerModes.length]!;
  const activeComposer = composerModeDetails[composerMode];
  const nextComposer = composerModeDetails[nextComposerMode];

  const load = useCallback(async () => {
    const body = await apiFetch<{ items: WatchRow[] }>("/api/watch-profiles");
    setItems(body.items);
  }, []);

  const applyProfiles = useCallback((watchBody: { items: WatchRow[] }, sourceBody: { items: WatchSourceChoice[] }) => {
    setItems(watchBody.items);
    const visible = sourceBody.items.filter((source) => source.id !== "rakuten_books" && watchSourceLabel(source.id));
    setSourceChoices(visible);
    const available = visible.filter((source) => source.enabled && source.adapter_available).map((source) => source.id);
    setKeywordSources(available);
    setExactSources(available);
    setLoadState("loaded");
  }, []);

  const fetchProfiles = useCallback((signal?: AbortSignal) => Promise.all([
    apiFetch<{ items: WatchRow[] }>("/api/watch-profiles", signal ? { signal } : undefined),
    apiFetch<{ items: WatchSourceChoice[] }>("/api/sources", signal ? { signal } : undefined),
  ]), []);

  function startLoadProfiles() {
    setLoadState("loading");
    setLoadError("");
    fetchProfiles()
      .then(([watchBody, sourceBody]) => applyProfiles(watchBody, sourceBody))
      .catch((reason: unknown) => { setLoadError(apiErrorMessage(reason)); setLoadState("error"); });
  }

  // 状态只在 then/catch 回调里更新；初始值本来就是 loading。
  useEffect(() => {
    const controller = new AbortController();
    fetchProfiles(controller.signal)
      .then(([watchBody, sourceBody]) => applyProfiles(watchBody, sourceBody))
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(apiErrorMessage(reason));
        setLoadState("error");
      });
    return () => controller.abort();
  }, [applyProfiles, fetchProfiles]);

  useEffect(() => () => {
    if (composerSwitchTimer.current !== null) window.clearTimeout(composerSwitchTimer.current);
  }, []);

  function cycleComposerMode() {
    if (isComposerSwitching) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setComposerMode(nextComposerMode);
      return;
    }
    setIsComposerSwitching(true);
    composerSwitchTimer.current = window.setTimeout(() => {
      setComposerMode(nextComposerMode);
      setIsComposerSwitching(false);
      composerSwitchTimer.current = null;
    }, 170);
  }

  function toggleSource(mode: FormMode, source: SourceId) {
    const update = (current: SourceId[]) => current.includes(source)
      ? current.filter((id) => id !== source)
      : [...current, source];
    if (mode === "exact_product") setExactSources(update);
    else setKeywordSources(update);
  }

  function selectAllSources(mode: FormMode) {
    const available = sourceChoices.filter((source) => source.adapter_available).map((source) => source.id);
    if (mode === "exact_product") setExactSources(available);
    else setKeywordSources(available);
  }

  function selectSourcePreset(mode: FormMode, preset: WatchSourcePreset) {
    const selected = watchSourcesForPreset(sourceChoices, preset);
    if (mode === "exact_product") setExactSources(selected);
    else setKeywordSources(selected);
  }

  function setFormNotice(mode: ComposerMode, message: string) {
    setNotices((current) => ({ ...current, [mode]: message }));
  }

  async function createItemWatch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyMode("item");
    setFormNotice("item", "");
    try {
      const result = await apiFetch<ItemWatchCreateResult>("/api/item-watches", {
        method: "POST",
        body: JSON.stringify({
          targetUrl: itemUrl,
          intervalMinutes: Number(itemIntervalMinutes),
          itemScheduleMode,
          itemScheduleMaxMinutes: Number(itemScheduleMaxMinutes),
          minDropAmount: Number(itemMinDropAmount),
          ...(itemTargetPrice ? { targetPrice: Number(itemTargetPrice) } : {}),
          notifyPriceDrop: itemNotifyPriceDrop,
          notifyRestock: itemNotifyRestock,
          notifySoldOut: itemNotifySoldOut,
        }),
      });
      const itemName = result.listing.title.length > 48
        ? `${result.listing.title.slice(0, 48)}…`
        : result.listing.title;
      const sourceName = watchSourceLabel(result.listing.sourceId) ?? result.listing.sourceId;
      const action = result.resumed
        ? "原有监控已恢复"
        : result.alreadyWatching
          ? "这个商品已经在监控中"
          : "商品监控已建立";
      const queueNote = result.checkQueued
        ? "已安排立即复查"
        : "定时巡回会自动接手";
      const lifecycleLabel = result.listing.lifecycleKind === "one_off"
        ? "一次性挂牌"
        : result.listing.lifecycleKind === "auction" ? "拍卖商品" : "可补货商家商品";
      const stateNote = result.listing.availability === "available"
        ? `已识别为${lifecycleLabel}；当前${result.listing.currentPrice === null ? "价格待确认" : `价格 ¥${result.listing.currentPrice.toLocaleString("ja-JP")}`}，${queueNote}。`
        : result.listing.availability === "sold_out"
          ? "当前检查显示无货，系统已开始等待；恢复库存时会立即发邮件。"
          : `当前库存状态尚未明确，${queueNote}；查询失败不会被当成无货。`;
      setFormNotice("item", result.paused
        ? `已确认 ${sourceName} 的「${itemName}」，但该来源定时监控当前处于暂停状态，请到来源控制台启用后再运行。`
        : `${action}：${sourceName}「${itemName}」。${stateNote}`,
      );
      setItemUrl("");
      await load();
    } catch (reason) {
      setFormNotice("item", itemWatchFailureMessage(reason));
    } finally {
      setBusyMode(null);
    }
  }

  async function createKeyword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyMode("keyword");
    setFormNotice("keyword", "");
    try {
      const result = await apiFetch<{ id: string; pausedBindings: number }>("/api/watch-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: keywordName,
          dossierKind: "keyword",
          defaultMaxPrice: maxPrice ? Number(maxPrice) : undefined,
          includeTerms: splitTerms(includeTerms),
          excludeTerms: splitTerms(excludeTerms),
          bindings: keywordSources.map((source) => ({
            source,
            kind: "keyword",
            monitoringPurpose: "keyword_new_listing",
            query: keywordQuery,
            intervalMinutes: Number(keywordIntervalMinutes),
            nextRunAt: keywordNextRunLocal ? new Date(keywordNextRunLocal).toISOString() : undefined,
            sourceConfig: {
              pages: 2,
              maxPrice: maxPrice ? Number(maxPrice) : undefined,
              availabilityMode: "purchasable",
              inStockOnly: true,
            },
          })),
        }),
      });
      setKeywordName("");
      setKeywordQuery("");
      setMaxPrice("");
      setIncludeTerms("");
      setExcludeTerms("");
      setKeywordNextRunLocal("");
      setFormNotice("keyword", result.pausedBindings > 0
        ? `关键词雷达已建立；${result.pausedBindings} 个来源当前只保存条件，不会定时采集。`
        : "关键词雷达已建立。第一次巡回只记录基线，不发送提醒。",
      );
      await load();
    } catch (reason) {
      setFormNotice("keyword", reason instanceof Error ? reason.message : "创建失败");
    } finally {
      setBusyMode(null);
    }
  }

  /**
   * 建档时把商品名交给 AI 抽成结构化字段。失败一律返回 undefined，调用方退回原有
   * 启发式——抽取是增益，不能变成建档的前置依赖（AGENTS.md §4）。
   */
  async function extractProductTarget(canonicalName: string): Promise<ProductTargetExtractionInput | undefined> {
    type JobBody = { jobId: string; status: string; extraction: ProductTargetExtractionInput | null };
    try {
      const started = await apiFetch<JobBody>("/api/ai/product-target", {
        method: "POST",
        body: JSON.stringify({ canonicalName }),
      });
      if (started.extraction) return started.extraction;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 1_500); });
        const polled = await apiFetch<JobBody>(`/api/ai/product-target?jobId=${encodeURIComponent(started.jobId)}`);
        if (polled.extraction) return polled.extraction;
        if (polled.status === "failed") return undefined;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** 配置单里的来源只勾选当前可用的那些，不可用的列出来，返回要展示的提示。 */
  function applyConfigSources(mode: FormMode, sources: SourceId[] | undefined): string[] {
    if (!sources) return [];
    const available = new Set(sourceChoices.filter((source) => source.adapter_available).map((source) => source.id));
    const usable = sources.filter((source) => available.has(source));
    const unavailable = sources.filter((source) => !available.has(source));
    if (mode === "exact_product") setExactSources(usable);
    else setKeywordSources(usable);
    return unavailable.length
      ? [`来源当前不可用，未勾选：${unavailable.map((source) => watchSourceLabel(source) ?? source).join("、")}`]
      : [];
  }

  async function copyConfigPrompt(prompt: string, setNotice: (messages: string[]) => void) {
    try {
      await navigator.clipboard.writeText(prompt);
      setNotice(["配置单提示词已复制。发给 AI 并在末尾写上商品，再把它输出的 JSON 贴回这里。"]);
    } catch {
      setNotice(["复制失败，浏览器没有允许访问剪贴板。"]);
    }
  }

  function applyKeywordRadarConfig() {
    try {
      const fill = parseKeywordRadarConfig(keywordConfigText, MONITORING_INTERVAL_OPTIONS.map((option) => option.value));
      setKeywordName(fill.name);
      setKeywordQuery(fill.query);
      setMaxPrice(fill.maxPrice);
      setIncludeTerms(fill.includeTerms);
      setExcludeTerms(fill.excludeTerms);
      if (fill.intervalMinutes) setKeywordIntervalMinutes(fill.intervalMinutes);
      setKeywordConfigNotice([
        "已填入下方表单，请核对后再点“建立关键词雷达”。",
        ...applyConfigSources("keyword", fill.sources),
        ...fill.ignored.map((item) => `未使用 · ${item}`),
      ]);
    } catch (reason) {
      setKeywordConfigNotice([reason instanceof Error ? reason.message : "配置单解析失败"]);
    }
  }

  function applyExactProductConfig() {
    try {
      const fill = parseExactProductConfig(exactConfigText, MONITORING_INTERVAL_OPTIONS.map((option) => option.value));
      setExactQuery(fill.query);
      setExactRecallQueries(fill.recallQueries);
      setExactRequiredGroups(fill.requiredGroups);
      setExactSupportingGroups(fill.supportingGroups);
      setExactExcludedTerms(fill.excludedTerms);
      setExactTargetPrice(fill.targetPrice);
      setExactStrongReminder(fill.strongReminder);
      if (fill.intervalMinutes) setExactIntervalMinutes(fill.intervalMinutes);
      setExactConfigNotice([
        "已填入下方表单，请核对后再点“建立精确同款雷达”。",
        ...applyConfigSources("exact_product", fill.sources),
        ...fill.ignored.map((item) => `未使用 · ${item}`),
      ]);
    } catch (reason) {
      setExactConfigNotice([reason instanceof Error ? reason.message : "配置单解析失败"]);
    }
  }

  async function createExactProduct(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const plan = exactPlan;
    const target = plan?.target;
    if (!plan || !target) {
      setFormNotice("exact_product", "请填写完整日文商品名。");
      return;
    }
    if (exactStrongReminder && !exactTargetPrice) {
      setFormNotice("exact_product", "强提醒必须先填写目标价；只有确认同款达到目标价后才会连续提醒。");
      return;
    }
    setBusyMode("exact_product");
    setFormNotice("exact_product", "正在解析商品名…");
    try {
      const extraction = await extractProductTarget(plan.originalQuery);
      const extracted = extraction
        ? fingerprintFromExtractedProductName(plan.originalQuery, extraction)
        : undefined;
      // 用户手填的召回词排在 AI 生成的前面：显式输入优先于推断。
      const effectivePlan = extracted
        ? buildProductSearchPlan({
          query: exactQuery,
          mode: "exact_product",
          target: {
            ...extracted,
            recallQueries: [
              ...splitTerms(exactRecallQueries),
              ...(extracted.recallQueries ?? []),
            ].slice(0, 4),
            requiredTermGroups: splitTerms(exactRequiredGroups).slice(0, 12),
            supportingTermGroups: splitTerms(exactSupportingGroups).slice(0, 12),
            excludedTerms: splitTerms(exactExcludedTerms).slice(0, 12),
          },
        })
        : plan;
      const effectiveTarget = effectivePlan.target ?? target;
      setFormNotice("exact_product", "");
      const targetPrice = exactTargetPrice ? Number(exactTargetPrice) : undefined;
      const result = await apiFetch<{ id: string; pausedBindings: number }>("/api/watch-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: plan.originalQuery.slice(0, 120),
          dossierKind: "exact_product",
          offerTrackingPolicy: "all_confirmed_offers",
          defaultMaxPrice: targetPrice,
          includeTerms: [],
          excludeTerms: [],
          bindings: exactSources.map((source) => ({
            source,
            kind: "keyword",
            monitoringPurpose: "keyword_new_listing",
            query: plan.originalQuery,
            intervalMinutes: Number(exactIntervalMinutes),
            nextRunAt: exactNextRunLocal ? new Date(exactNextRunLocal).toISOString() : undefined,
            sourceConfig: {
              pages: 1,
              searchMode: "exact_product",
              productTarget: effectiveTarget,
              matchVersion: PRODUCT_MATCH_VERSION,
              intentKind: effectivePlan.intentKind,
              intentVersion: effectivePlan.intentVersion,
              deepSearch: false,
              availabilityMode: "all",
              inStockOnly: false,
              strongReminder: {
                enabled: exactStrongReminder,
                intervalMinutes: 20,
                repeatCount: 3,
              },
            },
          })),
        }),
      });
      // 参考图在档案建好之后再传：传失败不影响雷达本身，详情页可以补传。
      let referenceFailure = "";
      for (const image of exactReferenceImages) {
        try {
          await uploadReferenceImage(result.id, image);
        } catch (reason) {
          referenceFailure = reason instanceof Error ? reason.message : "上传失败";
        }
      }
      setExactReferenceImages([]);
      setExactQuery("");
      setExactNextRunLocal("");
      setExactTargetPrice("");
      setExactRecallQueries("");
      setExactRequiredGroups("");
      setExactSupportingGroups("");
      setExactExcludedTerms("");
      setExactStrongReminder(false);
      setFormNotice("exact_product", `${result.pausedBindings > 0
        ? `精确同款雷达已建立；${result.pausedBindings} 个来源当前只保存条件，不会定时采集。`
        : targetPrice !== undefined
          ? `精确同款雷达已建立；若首次巡回已有不高于 ¥${targetPrice.toLocaleString("ja-JP")} 的确认同款，也会立即提醒。`
          : "精确同款雷达已建立。首次巡回确认到同款就会发送邮件，并同时登记去重。"}${referenceFailure
        ? ` 参考图没传上去（${referenceFailure}），可以在档案详情页补传。`
        : ""}`,
      );
      await load();
    } catch (reason) {
      setFormNotice("exact_product", reason instanceof Error ? reason.message : "创建失败");
    } finally {
      setBusyMode(null);
    }
  }

  const ongoingItems = items.filter((item) => !isTerminalWatchLifecycle(item.lifecycle_status));
  const endedItems = items.filter((item) => isTerminalWatchLifecycle(item.lifecycle_status));

  function renderDossierCard(item: WatchRow, index: number) {
    const active = Boolean(item.enabled && item.active_binding_count > 0);
    const lifecycleLabel = watchOverviewLabel({
      status: item.lifecycle_status,
      reason: item.lifecycle_reason,
      failingBindingCount: item.failing_binding_count,
      pausedBindingCount: item.paused_binding_count,
    });
    const nextRun = item.lifecycle_status === "archived" || item.lifecycle_status === "completed"
      ? "生命周期已结束"
      : item.next_run_at ? tokyoDateTime(item.next_run_at) : "等待可用来源";
    const title = watchDossierTitle(item.dossier_kind, item.name);
    const description = watchDossierDescription(item.dossier_kind, item.name, item.description);
    return (
      <article className="dossier-card" key={item.id} data-paused={!active}>
        <span className="dossier-number">{String(index + 1).padStart(2, "0")}</span>
        <div className="dossier-main">
        <p className="eyebrow">{dossierTypeLabel(item.dossier_kind, item.monitoring_purposes)} · {lifecycleLabel}</p>
          <h3>{item.dossier_kind === "exact_product" ? <><span className="dossier-title-kind">同款</span><span className="dossier-title-separator" aria-hidden="true">·</span><span>{title}</span></> : title}</h3>
          {description && <p>{description}</p>}
        </div>
        <Link className="dossier-open" href={`/watches/${item.id}` as Route}>查看档案 <ArrowUpRight size={14} aria-hidden="true" /></Link>
        <dl className="dossier-stats">
          <div><dt>正常运行</dt><dd>{item.healthy_binding_count}/{item.binding_count}</dd></div>
          <div><dt>需处理</dt><dd data-alert={item.failing_binding_count > 0}>{item.failing_binding_count}</dd></div>
          <div><dt>暂停</dt><dd>{item.paused_binding_count}</dd></div>
          <div><dt>下一次巡回</dt><dd>{nextRun}</dd></div>
        </dl>
      </article>
    );
  }

  return (
    <div className="watch-workspace reveal reveal-delay-1">
      <aside className="watch-composer-deck" data-active={composerMode}>
        <button
          id="composer-mode-switch"
          className="composer-mode-switch"
          type="button"
          aria-controls={activeComposer.panelId}
          aria-label={`切换监控类型。当前是${activeComposer.title}，下一项是${nextComposer.title}`}
          data-mode={composerMode}
          data-switching={isComposerSwitching}
          onClick={cycleComposerMode}
        >
          <span className="composer-mode-copy" key={`copy-${composerMode}`}>
            <span className="composer-mode-sequence" aria-hidden="true">
              <span className="composer-mode-index">{activeComposer.index}</span>
              <span className="composer-mode-total">/ 03</span>
              <span className="composer-mode-kicker">WATCH MODE</span>
            </span>
            <strong>{activeComposer.title}</strong>
            <small>{activeComposer.description}</small>
            <span className="composer-mode-next" aria-hidden="true">
              <span>点击卡片或右侧头像切换</span>
              <span>NEXT {nextComposer.index}</span>
            </span>
          </span>
          <span className="composer-mode-art" key={`art-${composerMode}`} aria-hidden="true">
            <Image
              className="composer-mode-portrait"
              src={activeComposer.imageSrc}
              alt=""
              width={1254}
              height={1254}
              sizes="(max-width: 600px) 112px, 176px"
              unoptimized
            />
            <span className="composer-mode-progress">
              {composerModes.map((mode) => (
                <span key={mode} data-active={mode === composerMode} />
              ))}
            </span>
          </span>
        </button>

        <section
          id="composer-panel-item"
          className="watch-composer"
          role="region"
          aria-label="建立商品监控"
          hidden={composerMode !== "item"}
          data-mode="item"
        >
          <form onSubmit={createItemWatch}>
            <div className="composer-form-heading">
              <span>多来源商品页 · 价格与状态</span>
              <h2>粘贴链接，持续追踪</h2>
              <p>系统会识别来源和稳定商品 ID，先核对当前价格与可购状态，再按固定节奏直接复查这个商品，不需要先跑一次搜索。</p>
            </div>
            <div className="field">
              <label htmlFor="direct-item-url">商品详情链接</label>
              <input
                id="direct-item-url"
                className="text-input"
                type="url"
                inputMode="url"
                autoComplete="off"
                value={itemUrl}
                onChange={(event) => setItemUrl(event.target.value)}
                required
                maxLength={2_000}
                placeholder="https://jp.mercari.com/item/m…"
              />
              <small>支持 AmiAmi、Mercari、Yahoo!拍卖、Yahoo!フリマ、Amazon Japan、骏河屋、Animate、COSPA、CharaON 与乐天商品页；分享参数会自动移除。</small>
            </div>
            <div className="watch-schedule-grid">
              <div className="schedule-fixed-purpose">
                <span>01</span>
                <small>通知条件 / Signal</small>
                <strong>按你的购买意图</strong>
              </div>
              <EditorialSelect
                index="02"
                label={itemScheduleMode === "adaptive" ? "基础检查频率" : "检查频率"}
                caption="Cadence"
                value={itemIntervalMinutes}
                options={MONITORING_INTERVAL_OPTIONS}
                onValueChange={setItemIntervalMinutes}
              />
            </div>
            <ItemScheduleControls mode={itemScheduleMode} maxMinutes={itemScheduleMaxMinutes}
              onModeChange={setItemScheduleMode} onMaxMinutesChange={setItemScheduleMaxMinutes} />
            <div className="monitor-event-options item-watch-intents">
              <label data-selected={itemNotifyPriceDrop}>
                <input type="checkbox" checked={itemNotifyPriceDrop} onChange={(event) => setItemNotifyPriceDrop(event.target.checked)} />
                <span><strong>价格下降</strong><small>达到下方最小降幅时提醒；价格上涨不提醒。</small></span>
              </label>
              <label data-selected={itemNotifyRestock}>
                <input type="checkbox" checked={itemNotifyRestock} onChange={(event) => setItemNotifyRestock(event.target.checked)} />
                <span><strong>恢复可购买</strong><small>适合商家缺货、补货和预售转现货；一次性挂牌会自动忽略。</small></span>
              </label>
              <label data-selected={itemNotifySoldOut}>
                <input type="checkbox" checked={itemNotifySoldOut} onChange={(event) => setItemNotifySoldOut(event.target.checked)} />
                <span><strong>售出或确认下架</strong><small>一次性商品售出、或连续确认商品页消失时提醒。</small></span>
              </label>
            </div>
            <div className="watch-target-grid">
              <div className="field">
                <label htmlFor="direct-item-target-price">目标价 / 日元（可选）</label>
                <input id="direct-item-target-price" className="text-input" inputMode="numeric" value={itemTargetPrice} onChange={(event) => setItemTargetPrice(event.target.value.replace(/\D/g, ""))} placeholder="例如 3800" />
              </div>
              <div className="field">
                <label htmlFor="direct-item-min-drop">最小降幅 / 日元</label>
                <input id="direct-item-min-drop" className="text-input" inputMode="numeric" required value={itemMinDropAmount} onChange={(event) => setItemMinDropAmount(event.target.value.replace(/\D/g, ""))} />
              </div>
            </div>
            <p className="monitoring-purpose-note">
              首轮会记录当前价格与状态。系统验证链接后会识别一次性挂牌、商家库存或拍卖，并只保留对该生命周期有效的条件；来源超时或失败只记为故障。
            </p>
            {notices.item && <p className="form-note" role="status">{notices.item}</p>}
            <button className="primary-button composer-submit" disabled={busyMode !== null || !itemUrl.trim()}>
              <Plus size={16} aria-hidden="true" />
              {busyMode === "item" ? "正在核对商品…" : "验证链接并开始监控"}
            </button>
            <p className="item-watch-alternative">
              <Link className="text-link" href="/search">
                只有商品名？去跨站搜索选择商品 <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            </p>
          </form>
        </section>

        <section
          id="composer-panel-exact-product"
          className="watch-composer"
          role="region"
          aria-label="建立精确同款雷达"
          hidden={composerMode !== "exact_product"}
          data-mode="exact_product"
        >
          <form onSubmit={createExactProduct}>
            <div className="composer-form-heading">
              <span>自动识别商品身份</span>
              <h2>输入商品名，开始巡回</h2>
              <p>填写一个完整日文商品名。系统直接生成同款指纹和巡回计划，不需要先跳到搜索页跑一次结果。</p>
            </div>
            <details className="exact-product-config">
              <summary>粘贴配置单，一键填表</summary>
              <div className="field">
                <label htmlFor="exact-product-config">配置单 JSON</label>
                <textarea id="exact-product-config" className="text-input" rows={8} value={exactConfigText} onChange={(event) => setExactConfigText(event.target.value)} maxLength={20000} placeholder={EXACT_CONFIG_PLACEHOLDER} />
                <small>只会填入下方各栏，不会直接建档；表单暂不支持的字段会列出来告诉你。</small>
              </div>
              <div className="exact-product-config-actions">
                <button type="button" className="ghost-button" disabled={!exactConfigText.trim()} onClick={applyExactProductConfig}>填入表单</button>
                <button type="button" className="ghost-button" onClick={() => copyConfigPrompt(EXACT_PRODUCT_CONFIG_PROMPT, setExactConfigNotice)}>复制配置单提示词</button>
              </div>
              {exactConfigNotice.length > 0 && (
                <ul className="form-note" role="status">
                  {exactConfigNotice.map((message) => <li key={message}>{message}</li>)}
                </ul>
              )}
            </details>
            <div className="field">
              <label htmlFor="exact-product-query">完整日文商品名</label>
              <input id="exact-product-query" className="text-input" value={exactQuery} onChange={(event) => setExactQuery(event.target.value)} required maxLength={200} placeholder="雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青" />
              <small>尽量保留作品、角色、厂商、系列、品类、型号和限定版本；雷达名称会自动生成。</small>
            </div>
            <div className="field">
              <label htmlFor="exact-product-recall-queries">同款短标题召回式（可选）</label>
              <textarea id="exact-product-recall-queries" className="text-input" rows={4} value={exactRecallQueries} onChange={(event) => setExactRecallQueries(event.target.value)} maxLength={800} placeholder={"加藤恵 ふわぷち 私服\n加藤恵 ふわぷち M\n冴えカノ 加藤恵 ふわぷち"} />
              <small>可留空。每行一条，最多 4 条；它们只负责把卖家缩写标题捞回来，不能单独证明是同款。</small>
            </div>
            <div className="field">
              <label htmlFor="exact-product-required-groups">必要身份组（AND，可选）</label>
              <input id="exact-product-required-groups" className="text-input" value={exactRequiredGroups} onChange={(event) => setExactRequiredGroups(event.target.value)} maxLength={1200} placeholder="加藤恵|加藤 恵|加藤惠, ふわぷち|フワプチ|Fuwapuchi" />
              <small>可留空。填写后，逗号分隔的每组都必须命中；组内用“|”填写同义写法。</small>
            </div>
            <div className="field">
              <label htmlFor="exact-product-supporting-groups">辅助证据组（OR，可选）</label>
              <input id="exact-product-supporting-groups" className="text-input" value={exactSupportingGroups} onChange={(event) => setExactSupportingGroups(event.target.value)} maxLength={1200} placeholder="私服|私服Ver|私服ver, M|Mぬいぐるみ|ぬいぐるみ, 冴えカノ|冴えない彼女" />
              <small>可留空。填写后，命中任一组会增强短标题的同款证据；最终仍须通过商品身份判断。</small>
            </div>
            <div className="field">
              <label htmlFor="exact-product-excluded-terms">冲突排除词（可选）</label>
              <input id="exact-product-excluded-terms" className="text-input" value={exactExcludedTerms} onChange={(event) => setExactExcludedTerms(event.target.value)} maxLength={1200} placeholder="制服, パジャマ, セーター, Luminasta|ルミナスタ, フィギュア" />
              <small>可留空。填写后，任一组命中即视为冲突款，不会被确认为目标同款或发送通知。</small>
            </div>
            <div className="field">
              <label htmlFor="exact-product-reference-images">参考图（可选，最多 {MAX_REFERENCE_IMAGES} 张）</label>
              <div className="reference-image-grid">
                {exactReferenceImages.map((image, index) => (
                  <figure key={image.previewUrl.slice(-40)} className="reference-image-tile">
                    {/* eslint-disable-next-line @next/next/no-img-element -- 本地预览 data URL */}
                    <img src={image.previewUrl} alt={`参考图 ${index + 1}`} />
                    <figcaption>
                      <span>{image.width}×{image.height}</span>
                      <button className="ghost-button danger-button" type="button" onClick={() => setExactReferenceImages((current) => current.filter((_, at) => at !== index))}>
                        <Trash2 size={13} aria-hidden="true" />移除
                      </button>
                    </figcaption>
                  </figure>
                ))}
                {exactReferenceImages.length < MAX_REFERENCE_IMAGES && (
                  <label className="reference-image-add" htmlFor="exact-product-reference-images">
                    <ImagePlus size={18} aria-hidden="true" />
                    <span>选择图片</span>
                    <small>JPEG / PNG / WebP</small>
                    <input
                      id="exact-product-reference-images"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = "";
                        void (async () => {
                          try {
                            const prepared = await Promise.all(files.map(prepareReferenceImage));
                            setExactReferenceImages((current) => [...current, ...prepared].slice(0, MAX_REFERENCE_IMAGES));
                          } catch (reason) {
                            setFormNotice("exact_product", reason instanceof Error ? reason.message : "图片读取失败");
                          }
                        })();
                      }}
                    />
                  </label>
                )}
              </div>
              <small>{REFERENCE_IMAGE_EXPLAINER}建好之后也能在档案详情页补传或更换。</small>
            </div>
            {exactPlan?.target && (
              <div className="exact-product-identity">
                <span>商品身份预览</span>
                <strong>{exactPlan.target.canonicalName}</strong>
                <p>已生成 {exactPlan.variants.filter((variant) => variant.lane === "source_native").length} 组跨站召回式；每轮保留抓取明细，只让当前可购买且确认同款的商品参与目标价判断。</p>
                {exactPlan.warnings.map((warning) => <small key={warning}>{warning}</small>)}
              </div>
            )}
            <div className="watch-schedule-grid">
              <div className="schedule-fixed-purpose"><span>01</span><small>监控目的 / Purpose</small><strong>精确同款与目标价巡回</strong></div>
              <EditorialSelect index="02" label="巡回频率" caption="Cadence" value={exactIntervalMinutes} options={MONITORING_INTERVAL_OPTIONS} onValueChange={setExactIntervalMinutes} />
            </div>
            <div className="field"><label htmlFor="exact-product-first-run">首次巡回时间</label><input id="exact-product-first-run" className="text-input" type="datetime-local" value={exactNextRunLocal} onChange={(event) => setExactNextRunLocal(event.target.value)} /><small>留空会立即巡回；首次确认的同款也会按当前通知规则提醒，并同时登记用于后续去重。</small></div>
            <div className="field"><label htmlFor="exact-product-target-price">目标价 / ¥（可选）</label><input id="exact-product-target-price" className="text-input" inputMode="numeric" maxLength={10} value={exactTargetPrice} onChange={(event) => setExactTargetPrice(event.target.value.replace(/\D/g, ""))} placeholder="例如 4500" /><small>填写后只在发现价格不高于该金额的确认同款时通知；留空则按默认同款上新规则通知。</small></div>
            <div className="monitor-event-options item-watch-intents">
              <label data-selected={exactStrongReminder}>
                <input type="checkbox" checked={exactStrongReminder} onChange={(event) => setExactStrongReminder(event.target.checked)} />
                <span><strong>目标价强提醒</strong><small>确认同款达到目标价后立即发一次邮件，并在 20、40 分钟后各补发一次；商品售出、涨价或档案暂停会取消后续提醒。</small></span>
              </label>
            </div>
            <p className="monitoring-purpose-note">{exactTargetPrice ? "首次巡回若有确认同款达到目标价，会立即提醒并登记去重；之后持续检查每个确认报价。" : "首次巡回确认到同款就会发送同款发现邮件，并同时登记去重；之后只通知首次出现的新同款。"}</p>
            <WatchSourcePicker
              choices={sourceChoices}
              selected={exactSources}
              onToggle={(source) => toggleSource("exact_product", source)}
              onSelectAll={() => selectAllSources("exact_product")}
              onSelectPreset={(preset) => selectSourcePreset("exact_product", preset)}
              onClear={() => setExactSources([])}
            />
            {notices.exact_product && <p className="form-note" role="status">{notices.exact_product}</p>}
            <button className="primary-button composer-submit" disabled={busyMode !== null || !exactQuery.trim() || exactSources.length === 0}><Plus size={16} aria-hidden="true" />{busyMode === "exact_product" ? "正在建立…" : "建立精确同款雷达"}</button>
          </form>
        </section>

        <section
          id="composer-panel-keyword"
          className="watch-composer"
          role="region"
          aria-label="建立关键词雷达"
          hidden={composerMode !== "keyword"}
          data-mode="keyword"
        >
          <form onSubmit={createKeyword}>
            <div className="composer-form-heading"><span>跨来源持续巡回</span><h2>输入关键词，发现新品</h2><p>同一关键词可以同时巡回多个来源，把首次出现的新商品合并通知。</p></div>
            <details className="exact-product-config">
              <summary>粘贴配置单，一键填表</summary>
              <div className="field">
                <label htmlFor="keyword-radar-config">配置单 JSON</label>
                <textarea id="keyword-radar-config" className="text-input" rows={8} value={keywordConfigText} onChange={(event) => setKeywordConfigText(event.target.value)} maxLength={20000} placeholder={KEYWORD_CONFIG_PLACEHOLDER} />
                <small>只会填入下方各栏，不会直接建档；表单暂不支持的字段会列出来告诉你。</small>
              </div>
              <div className="exact-product-config-actions">
                <button type="button" className="ghost-button" disabled={!keywordConfigText.trim()} onClick={applyKeywordRadarConfig}>填入表单</button>
                <button type="button" className="ghost-button" onClick={() => copyConfigPrompt(KEYWORD_RADAR_CONFIG_PROMPT, setKeywordConfigNotice)}>复制配置单提示词</button>
              </div>
              {keywordConfigNotice.length > 0 && (
                <ul className="form-note" role="status">
                  {keywordConfigNotice.map((message) => <li key={message}>{message}</li>)}
                </ul>
              )}
            </details>
            <div className="field"><label htmlFor="watch-name">雷达名称</label><input id="watch-name" className="text-input" value={keywordName} onChange={(event) => setKeywordName(event.target.value)} required maxLength={120} placeholder="例如：氷菓收藏行情" /></div>
            <div className="field"><label htmlFor="watch-query">日文关键词</label><input id="watch-query" className="text-input" value={keywordQuery} onChange={(event) => setKeywordQuery(event.target.value)} required maxLength={200} placeholder="氷菓 Blu-ray" /></div>
            <div className="field"><label htmlFor="watch-budget">预算上限 / ¥</label><input id="watch-budget" className="text-input" inputMode="numeric" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value.replace(/\D/g, ""))} placeholder="可不填" /></div>
            <div className="field"><label htmlFor="watch-includes">必须包含</label><input id="watch-includes" className="text-input" value={includeTerms} onChange={(event) => setIncludeTerms(event.target.value)} placeholder="エミリア|EMILIA|艾米莉亚|爱蜜莉雅" /><small>逗号分隔的每组都必须命中；同组内用“|”填写任一可接受的别名。留空时按日文关键词自动校验。</small></div>
            <div className="field"><label htmlFor="watch-excludes">命中即排除</label><input id="watch-excludes" className="text-input" value={excludeTerms} onChange={(event) => setExcludeTerms(event.target.value)} placeholder="Emilia Clarke|エミリア・クラーク, Emilia-Romagna" /><small>任一排除组命中就不会进入基线、变化记录或邮件。</small></div>
            <div className="watch-schedule-grid">
              <div className="schedule-fixed-purpose"><span>01</span><small>监控目的 / Purpose</small><strong>关键词上新</strong></div>
              <EditorialSelect index="02" label="巡回频率" caption="Cadence" value={keywordIntervalMinutes} options={MONITORING_INTERVAL_OPTIONS} onValueChange={setKeywordIntervalMinutes} />
            </div>
            <div className="field"><label htmlFor="watch-first-run">首次巡回时间</label><input id="watch-first-run" className="text-input" type="datetime-local" value={keywordNextRunLocal} onChange={(event) => setKeywordNextRunLocal(event.target.value)} /><small>留空会立即建立第一次基线；之后保持这个巡回频率。</small></div>
            <p className="monitoring-purpose-note">第一次会建立基线并发送完成摘要；已有商品不会冒充上新。之后每轮将首次出现的新商品合并为一封邮件。</p>
            <WatchSourcePicker
              choices={sourceChoices}
              selected={keywordSources}
              onToggle={(source) => toggleSource("keyword", source)}
              onSelectAll={() => selectAllSources("keyword")}
              onSelectPreset={(preset) => selectSourcePreset("keyword", preset)}
              onClear={() => setKeywordSources([])}
            />
            {notices.keyword && <p className="form-note" role="status">{notices.keyword}</p>}
            <button className="primary-button composer-submit" disabled={busyMode !== null || !keywordName.trim() || !keywordQuery.trim() || keywordSources.length === 0}><Plus size={16} aria-hidden="true" />{busyMode === "keyword" ? "正在建立…" : "建立关键词雷达"}</button>
          </form>
        </section>
      </aside>

      <section className="watch-dossiers">
        <header className="dossier-heading"><div><p className="eyebrow">WATCH DOSSIERS</p><h2>关注档案</h2><p className="dossier-status-guide">正常运行＝正在工作 · 需处理＝最近失败 · 暂停＝当前不运行</p></div><strong>{ongoingItems.length}</strong></header>
        {items.length > 0 ? (
          <>
            {ongoingItems.length > 0 ? (
              <div className="dossier-list">{ongoingItems.map(renderDossierCard)}</div>
            ) : (
              <p className="dossier-none-ongoing">目前没有进行中的档案。</p>
            )}
            {endedItems.length > 0 && (
              <details className="dossier-ended">
                <summary><span>已结束</span><small>监控已完成或已购买归档，只保留历史，不再巡回</small><strong>{endedItems.length}</strong></summary>
                <div className="dossier-list">{endedItems.map(renderDossierCard)}</div>
              </details>
            )}
          </>
        ) : (
          <>
            <LoadStateNotice
              state={loadState}
              title="关注档案读取失败"
              loadingTitle="正在读取关注档案"
              loadingHint="读取完成后再判断是否为空。"
              error={loadError}
              onRetry={startLoadProfiles}
            />
            {loadState === "loaded" && (
              <div className="empty-state dossier-empty"><div><span className="dossier-zero">00</span><h3>还没有关注档案</h3><p>从左侧选择商品监控、精确同款雷达或关键词雷达，让搜索变成持续的等待。</p></div></div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
