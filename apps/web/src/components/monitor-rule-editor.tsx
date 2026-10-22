"use client";

import { AlertCircle, BellRing, CheckCircle2, Clock3, Database, LoaderCircle, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MonitorEventType, OfferTrackingPolicy, SourceId, SuspectNoticePolicy, WatchDossierKind } from "@jpgr/core";
import { apiFetch } from "@/lib/client-api";
import type { MonitorRuleApiResponse, MonitorRuleView } from "@/lib/monitor-rule-contract";

interface MonitorSource {
  id: SourceId;
  label: string;
}

interface MonitorRuleEditorProps {
  profileId: string;
  dossierKind: WatchDossierKind;
  sources: MonitorSource[];
  onSaved: () => Promise<void>;
}

interface EventOption {
  type: MonitorEventType;
  label: string;
  detail: string;
}

const dossierEventOptions: Record<WatchDossierKind, readonly EventOption[]> = {
  item: [
    { type: "listing.price_changed", label: "价格下降", detail: "达到最小降幅并完成二次确认后提醒。涨价是单独一项，见下方。" },
    { type: "product.offer_below_target_listing_price", label: "低于目标标价", detail: "这个来源商品的日元公开标价首次进入目标范围时触发。" },
  ],
  exact_product: [
    { type: "product.new_comparable_offer", label: "出现新的确认同款", detail: "跨来源新 listing 通过同款判定后，作为一条新报价进入摘要。" },
    { type: "listing.price_changed", label: "已发现的同款降价", detail: "每件被持续检查的确认同款只要降价（降 1 日元也算）就提醒。只想蹲到目标价的，不要勾这项，只勾下面的目标标价。雅虎商城与 eBay 暂不支持逐件检查。" },
    { type: "product.offer_below_target_listing_price", label: "同款报价低于目标标价", detail: "每轮从当前可购买同款中判断；首次确认进入目标范围时触发。" },
    { type: "product.condition_match_seen", label: "新同款符合品相大类", detail: "发现新同款时，按新品、中古等大类提醒；不区分磨损等级，不追溯已有报价。" },
    { type: "product.complete_set_seen", label: "出现明确完整套装", detail: "只有来源或清洗事实明确证明完整时触发；未知不会冒充完整。" },
  ],
  keyword: [
    { type: "product.new_comparable_offer", label: "关键词出现新商品", detail: "建立基线后，把首次进入相关范围的商品合并为摘要。" },
  ],
};

const conditionOptions = [
  { value: "new", label: "新品" },
  { value: "used", label: "中古" },
  { value: "collectible", label: "收藏品" },
  { value: "refurbished", label: "翻新" },
  { value: "unknown", label: "品相未确认" },
] as const;

const completenessOptions = [
  { value: "complete", label: "明确完整" },
  { value: "incomplete", label: "明确缺件" },
  { value: "unknown", label: "完整度未知" },
] as const;

function toggleValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function sourceIncluded(source: MonitorSource, denied: readonly string[]): boolean {
  return !denied.includes(source.id);
}

export function MonitorRuleEditor({ profileId, dossierKind, sources, onSaved }: MonitorRuleEditorProps) {
  const [response, setResponse] = useState<MonitorRuleApiResponse | null>(null);
  const [eventTypes, setEventTypes] = useState<MonitorEventType[]>([]);
  const [sourceDeny, setSourceDeny] = useState<string[]>([]);
  const [conditions, setConditions] = useState<string[]>([]);
  const [completeness, setCompleteness] = useState<string[]>([]);
  const [targetPrice, setTargetPrice] = useState("");
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState("22:00");
  const [quietEnd, setQuietEnd] = useState("08:00");
  const [dedupeWindow, setDedupeWindow] = useState("1440");
  const [cooldown, setCooldown] = useState("180");
  const [stalePolicy, setStalePolicy] = useState<"include" | "annotate" | "exclude">("annotate");
  const [enabled, setEnabled] = useState(true);
  const [offerTrackingPolicy, setOfferTrackingPolicy] = useState<OfferTrackingPolicy>("all_confirmed_offers");
  const [suspectNoticePolicy, setSuspectNoticePolicy] = useState<SuspectNoticePolicy>("confirmed_only");
  const [notifyPriceRise, setNotifyPriceRise] = useState(false);
  const [notifyRestock, setNotifyRestock] = useState(false);
  const [notifySoldOut, setNotifySoldOut] = useState(false);
  const [minDropAmount, setMinDropAmount] = useState("100");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!message) return;
    if (saveError) messageRef.current?.focus({ preventScroll: true });
    messageRef.current?.scrollIntoView({ block: "nearest" });
  }, [message, saveError]);

  const applyRule = useCallback((body: MonitorRuleApiResponse, rule: MonitorRuleView | null) => {
    setResponse({ ...body, rule });
    if (!rule) return;
    setEventTypes(rule.eventTypes.filter((type) => type !== "product.offer_below_target_landed_cost"));
    setSourceDeny(rule.sourceDeny);
    setConditions(rule.conditions);
    setCompleteness(rule.completeness);
    setTargetPrice(rule.targetListingPrice === null ? "" : String(rule.targetListingPrice));
    setQuietEnabled(rule.quietHours !== null);
    setQuietStart(rule.quietHours?.start ?? "22:00");
    setQuietEnd(rule.quietHours?.end ?? "08:00");
    setDedupeWindow(String(rule.dedupeWindowMinutes));
    setCooldown(String(rule.cooldownMinutes));
    setStalePolicy(rule.staleSourcePolicy);
    setEnabled(rule.enabled);
    setOfferTrackingPolicy(body.offerTrackingPolicy);
    setSuspectNoticePolicy(body.suspectNoticePolicy);
    setNotifyPriceRise(body.itemSignals?.notifyPriceRise ?? false);
    setNotifyRestock(body.itemSignals?.notifyRestock ?? false);
    setNotifySoldOut(body.itemSignals?.notifySoldOut ?? false);
    setMinDropAmount(String(body.itemSignals?.minDropAmount ?? 100));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<MonitorRuleApiResponse>(`/api/watch-profiles/${profileId}/monitor-rule`, { signal: controller.signal })
      .then((body) => {
        if (!controller.signal.aborted) applyRule(body, body.rule);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMessage(error instanceof Error ? error.message : "事件规则读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [applyRule, profileId]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!response?.rule || saving) return;
    setSaveError(true);
    const numericTarget = targetPrice === "" ? null : Number(targetPrice);
    if (numericTarget !== null && (!Number.isSafeInteger(numericTarget) || numericTarget < 0)) {
      setMessage("目标价必须是非负整数日元。");
      return;
    }
    if (eventTypes.includes("product.offer_below_target_listing_price") && numericTarget === null) {
      setMessage("请填写目标价，或取消目标标价提醒后再保存。");
      return;
    }
    const numericMinDrop = Number(minDropAmount);
    if (dossierKind === "item" && (!Number.isSafeInteger(numericMinDrop) || numericMinDrop < 0)) {
      setMessage("最小降幅必须是非负整数日元。");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      // 降价由“价格下降”这一项决定，涨价是独立开关，两者不能互相带开：
      // 只勾涨价的人不该突然开始收到降价提醒。但 V2 事实共用 listing.price_changed
      // 这一个类型，所以任一项开启都要把它写进规则，否则涨价只有邮件、没有事实记录。
      const priceDropSelected = eventTypes.includes("listing.price_changed");
      const savedEventTypes = dossierKind === "item"
        ? [
            ...eventTypes.filter((type) => type !== "listing.availability_changed" && type !== "listing.price_changed"),
            ...(priceDropSelected || notifyPriceRise ? ["listing.price_changed" as const] : []),
            ...(notifyRestock || notifySoldOut ? ["listing.availability_changed" as const] : []),
          ]
        : eventTypes;
      const result = await apiFetch<{ updated: boolean; rule: MonitorRuleView }>(
        `/api/watch-profiles/${profileId}/monitor-rule`,
        {
          method: "PUT",
          body: JSON.stringify({
            eventTypes: savedEventTypes,
            sourceAllow: [],
            sourceDeny,
            conditions,
            completeness,
            targetListingPrice: numericTarget,
            targetLandedCost: null,
            costProfileId: null,
            deliveryMode: dossierKind === "item" ? "instant" : "digest",
            quietHours: dossierKind === "item" && quietEnabled ? { start: quietStart, end: quietEnd } : null,
            timezone: "Asia/Tokyo",
            dedupeWindowMinutes: Number(dedupeWindow),
            cooldownMinutes: Number(cooldown),
            staleSourcePolicy: stalePolicy,
            enabled,
            itemSignals: dossierKind === "item" ? {
              notifyPriceDrop: priceDropSelected,
              notifyPriceRise,
              notifyRestock,
              notifySoldOut,
              minDropAmount: numericMinDrop,
            } : null,
            offerTrackingPolicy: dossierKind === "exact_product" ? offerTrackingPolicy : null,
            suspectNoticePolicy: dossierKind === "exact_product" ? suspectNoticePolicy : null,
          }),
        },
      );
      applyRule({
        ...response,
        offerTrackingPolicy,
        suspectNoticePolicy,
        itemSignals: dossierKind === "item" ? {
          notifyPriceDrop: priceDropSelected,
          notifyPriceRise,
          notifyRestock,
          notifySoldOut,
          minDropAmount: numericMinDrop,
        } : null,
      }, result.rule);
      setSaveError(false);
      const savedMessage = result.updated
        ? `${result.rule.targetListingPrice === null ? "提醒条件已更新。" : `目标标价 ¥${result.rule.targetListingPrice.toLocaleString("ja-JP")}。`}后续检查使用新策略，历史提醒保留。`
        : "和当前设置一致，没有改动。";
      setMessage(savedMessage);
      try {
        await onSaved();
      } catch {
        setMessage(`${savedMessage} 档案概览刷新失败，请刷新页面查看。`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="monitor-rule-loading" role="status">正在读取…</div>;
  }
  if (!response?.rule) {
    return <div className="monitor-rule-loading" role="alert">{message || "这份档案缺少事件规则，请暂时不要修改旧通知选项。"}</div>;
  }

  const targetEventEnabled = eventTypes.includes("product.offer_below_target_listing_price");
  const conditionEventEnabled = eventTypes.includes("product.condition_match_seen");
  const completenessEventEnabled = eventTypes.includes("product.complete_set_seen");
  const eventOptions = dossierEventOptions[dossierKind];

  return (
    <form className="monitor-rule-editor" onSubmit={save} onChange={() => { if (message) setMessage(""); }} aria-busy={saving}>
      <header className="monitor-rule-hero">
        <div>
          <p className="eyebrow">MONITORING STRATEGY</p>
          <h3><BellRing size={18} aria-hidden="true" />发生什么时提醒我</h3>
          <p>{dossierKind === "item"
            ? "这份规则只观察一个真实来源商品；已经售出的终局商品不会被包装成“等待降价”。"
            : dossierKind === "exact_product"
              ? "父任务按计划寻找新同款；候选报价是否持续独立检查，由下面的报价追踪策略决定。"
              : "这份规则观察关键词范围内首次出现的新商品。"}</p>
        </div>
      </header>

      {!response.featureEnabled && <p className="radar-settings-warning" role="alert">V2 运行开关当前已关闭；规则可读但不能保存或产生新事件。</p>}

      <section className="monitor-rule-section" aria-labelledby={`event-goals-${profileId}`}>
        <div className="monitor-rule-section-heading">
          <span>01</span><div><h4 id={`event-goals-${profileId}`}>事件目标</h4><p>先决定值得打扰你的变化；检查频率在下面单独管理。</p></div>
        </div>
        {eventOptions.length > 0 ? (
          <div className="monitor-event-options">
            {eventOptions.map((option) => (
              <label key={option.type} data-selected={eventTypes.includes(option.type)}>
                <input
                  type="checkbox"
                  checked={eventTypes.includes(option.type)}
                  onChange={() => setEventTypes((current) => toggleValue(current, option.type))}
                />
                <span><strong>{option.label}</strong><small>{option.detail}</small></span>
              </label>
            ))}
          </div>
        ) : (
          <div className="monitor-record-only"><Database size={18} aria-hidden="true" /><p><strong>仅积累行情证据</strong>商品级事件应在稳定同款页建立，避免把宽泛行情样本误当成可购买同款。</p></div>
        )}

        {targetEventEnabled && (
          <div className="monitor-target-price">
            <label htmlFor={`monitor-target-${profileId}`}>目标公开标价 / 日元</label>
            <div><span>¥</span><input id={`monitor-target-${profileId}`} inputMode="numeric" maxLength={10} value={targetPrice} onChange={(event) => setTargetPrice(event.target.value.replace(/\D/g, ""))} placeholder="例如 3800" /></div>
            <small>这里只比较来源商品公开标价，不额外计入买家承担的日本国内运费、国际运费、税费或代购费。</small>
            <small>达标提醒后仍继续监控；修改目标价并保存后，按新目标等待下一次符合条件的报价。要停止监控，请暂停整份档案。</small>
          </div>
        )}

        {dossierKind === "item" && (
          <div className="monitor-event-options item-lifecycle-signals">
            <label data-selected={notifyPriceRise}>
              <input type="checkbox" checked={notifyPriceRise} onChange={(event) => setNotifyPriceRise(event.target.checked)} />
              <span><strong>价格上涨</strong><small>涨幅达到下方最小降幅时提醒。一次性挂牌（Mercari、雅虎拍卖 / フリマ、eBay）涨价常是卖家在试探、这件快要走了，默认开；商家目录商品涨跌只是普通波动，默认关。</small></span>
            </label>
            <label data-selected={notifyRestock}>
              <input type="checkbox" checked={notifyRestock} onChange={(event) => setNotifyRestock(event.target.checked)} />
              <span><strong>恢复可购买</strong><small>只在已确认缺货、不可购买、预售或候补后重新变为现货时提醒；解析未知恢复不会冒充补货。</small></span>
            </label>
            <label data-selected={notifySoldOut}>
              <input type="checkbox" checked={notifySoldOut} onChange={(event) => setNotifySoldOut(event.target.checked)} />
              <span><strong>售出或确认下架</strong><small>详情页明确不可购买，或连续两次确认商品页消失时提醒。</small></span>
            </label>
            <div className="monitor-target-price">
              <label htmlFor={`monitor-min-drop-${profileId}`}>最小降幅 / 日元</label>
              <div><span>¥</span><input id={`monitor-min-drop-${profileId}`} inputMode="numeric" maxLength={10} value={minDropAmount} onChange={(event) => setMinDropAmount(event.target.value.replace(/\D/g, ""))} /></div>
              <small>只有启用“价格下降”时使用；设置为 0 仍需价格真实变化并通过确认。</small>
            </div>
          </div>
        )}

        {dossierKind === "exact_product" && (conditionEventEnabled || conditions.length > 0 || completenessEventEnabled) && (
          <div className="monitor-fact-filters">
            {(conditionEventEnabled || conditions.length > 0) && <fieldset><legend>品相大类</legend>{conditionOptions.map((option) => <label key={option.value}><input type="checkbox" checked={conditions.includes(option.value)} onChange={() => setConditions((current) => toggleValue(current, option.value))} />{option.label}</label>)}<p className="monitor-condition-note">所选品相也会限制目标价等其他提醒。煤炉的“未使用に近い”至“全体的に状態が悪い”均归为中古；未知品相只在勾选“品相未确认”时匹配。部分来源品相可能缺失，请结合商品原页判断。</p>{!conditionEventEnabled && <button type="button" className="monitor-history-link" onClick={() => setConditions([])}>清除品相限制</button>}</fieldset>}
            {completenessEventEnabled && <fieldset><legend>完整度事实</legend>{completenessOptions.map((option) => <label key={option.value}><input type="checkbox" checked={completeness.includes(option.value)} onChange={() => setCompleteness((current) => toggleValue(current, option.value))} />{option.label}</label>)}</fieldset>}
          </div>
        )}

      </section>

      {sources.length > 0 && dossierKind !== "item" && (
        <section className="monitor-rule-section" aria-labelledby={`source-policy-${profileId}`}>
          <div className="monitor-rule-section-heading"><span>02</span><div><h4 id={`source-policy-${profileId}`}>参与事件判断的来源</h4><p>这里只决定这个来源找到的商品算不算数；要停掉某个来源的采集，到页面下方「来源状态与控制」里暂停。</p></div></div>
          {dossierKind === "exact_product" && <div className="monitor-policy-grid">
            <label>候选报价追踪
              <select value={offerTrackingPolicy} onChange={(event) => setOfferTrackingPolicy(event.target.value as OfferTrackingPolicy)}>
                <option value="all_confirmed_offers">持续检查全部确认同款</option>
                <option value="search_window">只检查每轮巡回结果</option>
              </select>
              <small>{offerTrackingPolicy === "all_confirmed_offers" ? "新确认的同款会建立独立报价检查；即使暂时跌出搜索结果，也继续观察价格。" : "只处理当前巡回重新找到的报价，不建立独立报价检查。"}</small>
            </label>
          </div>}
          <div className="monitor-source-policy">{sources.map((source) => <label key={source.id} data-selected={sourceIncluded(source, sourceDeny)}><input type="checkbox" checked={sourceIncluded(source, sourceDeny)} onChange={() => setSourceDeny((current) => toggleValue(current, source.id))} /><span><strong>{source.label}</strong><small>{sourceIncluded(source, sourceDeny) ? "参与判断" : "只保留采集证据"}</small></span></label>)}</div>
        </section>
      )}

      {/* 去重窗口、冷却、来源异常时怎么办、时区都是定死的技术参数，不摆出来让人填（原值照存）。
          只留下真正因档案而异、用户会去选的：精确同款「发到哪一档」、单品的静默时段。 */}
      {(dossierKind === "exact_product" || dossierKind === "item") && <section className="monitor-rule-section" aria-labelledby={`delivery-policy-${profileId}`}>
        <div className="monitor-rule-section-heading"><span>{sources.length > 0 && dossierKind !== "item" ? "03" : "02"}</span><div><h4 id={`delivery-policy-${profileId}`}>{dossierKind === "item" ? "什么时候别打扰" : "哪些值得发给你"}</h4><p>{dossierKind === "item" ? "静默期间照常记录，提醒延后到结束时间再发。" : "判定照常记录在档案里；这里只决定哪一档进邮件。"}</p></div></div>
        {dossierKind === "exact_product" && (
          <div className="monitor-policy-grid">
            <label>邮件发到哪一档
              <select value={suspectNoticePolicy} onChange={(event) => setSuspectNoticePolicy(event.target.value as SuspectNoticePolicy)}>
                <option value="confirmed_only">只发确认同款</option>
                <option value="strong_suspects">确认同款 + 高度疑似</option>
                <option value="all_suspects">连相关商品一起发</option>
              </select>
              <small>{suspectNoticePolicy === "confirmed_only"
                ? "只有确认是同一件商品才进收件箱。没有确认的一轮不发信。"
                : suspectNoticePolicy === "strong_suspects"
                  ? "再加上系统没把握的候选（差一个身份要素、或模型自己也说不准）。已被判定不是同款的不发。"
                  : "共享作品线的相关商品、疑似套装也一起发。最不容易漏，也最吵。"}</small>
            </label>
          </div>
        )}
        {dossierKind === "item" && (
          <div className="monitor-quiet-hours">
            <label><input type="checkbox" checked={quietEnabled} onChange={(event) => setQuietEnabled(event.target.checked)} /><Clock3 size={15} aria-hidden="true" />启用静默时段</label>
            {quietEnabled && <div><label>开始<input type="time" value={quietStart} onChange={(event) => setQuietStart(event.target.value)} /></label><label>结束<input type="time" value={quietEnd} onChange={(event) => setQuietEnd(event.target.value)} /></label><small>静默期间事实照常记录，邮件延后到结束时间。</small></div>}
          </div>
        )}
      </section>}

      <footer className="monitor-rule-footer">
        <div className="monitor-rule-controls">
          <label className="monitor-rule-enabled">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span><strong>启用这份提醒策略</strong><small>关闭提醒后，来源仍按计划采集。</small></span>
          </label>
          <div className="monitor-rule-actions">
            <button className="primary-button" type="submit" disabled={saving || !response.featureEnabled}>
              {saving ? <LoaderCircle className="monitor-save-spinner" size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              {saving ? "正在保存策略…" : "保存策略"}
            </button>
          </div>
        </div>
        {message && <div ref={messageRef} className="monitor-save-feedback" data-tone={saveError ? "error" : "success"} role={saveError ? "alert" : "status"} tabIndex={-1}>
          {saveError ? <AlertCircle size={19} aria-hidden="true" /> : <CheckCircle2 size={19} aria-hidden="true" />}
          <div><strong>{saveError ? "未能保存策略" : "已保存"}</strong><p>{message}</p></div>
        </div>}
      </footer>
    </form>
  );
}
