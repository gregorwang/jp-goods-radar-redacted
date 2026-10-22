"use client";

import { useCallback, useEffect, useState } from "react";
import type { DigestExtras, DigestPriceReference } from "@jpgr/core";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * 关键词日报里每件商品下面附带哪几样价格参考（packages/core/src/digest-extras.ts）。
 * 关掉的部分发信时就不再请求：关掉 AI 预测就不调估价模型，两样都关就整个价格接口都不调。
 */
interface DigestExtrasState {
  profileId: string;
  current: DigestExtras;
  defaults: DigestExtras;
  keywordProfileCount: number;
}

const PRICE_OPTIONS: readonly { value: DigestPriceReference; label: string; detail: string }[] = [
  {
    value: "official_and_ai",
    label: "官方定価 + AI 预测",
    detail: "查到官方定価就写定価；查不到时写 AI 按标题预测的价格（带区间，仅供参考）。",
  },
  {
    value: "official_only",
    label: "只要官方定価",
    detail: "只写按标题查到、核对过的官方定価，不再调用 AI 估价。查不到就不写。",
  },
  {
    value: "off",
    label: "不显示原价",
    detail: "定価和 AI 预测都不写，也不再去查。",
  },
];

export function digestExtrasSummary(extras: DigestExtras): string {
  const price = extras.priceReference === "official_and_ai" ? "官方定価 + AI 预测"
    : extras.priceReference === "official_only" ? "只要官方定価" : "";
  const parts = [price, extras.showSales ? "同款成交" : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "只列商品";
}

const sameExtras = (left: DigestExtras, right: DigestExtras) =>
  left.priceReference === right.priceReference && left.showSales === right.showSales;

export function DigestExtrasPanel({ profileId, onSaved }: { profileId: string; onSaved?: () => void }) {
  const [state, setState] = useState<DigestExtrasState | null>(null);
  const [draft, setDraft] = useState<DigestExtras | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);

  const fetchState = useCallback((signal?: AbortSignal) => apiFetch<DigestExtrasState>(
    `/api/watch-profiles/${encodeURIComponent(profileId)}/digest-extras`,
    signal ? { signal } : undefined,
  ), [profileId]);

  useEffect(() => {
    const controller = new AbortController();
    fetchState(controller.signal).then((body) => {
      setState(body);
      setDraft(body.current);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setNotice(apiErrorMessage(error, "日报附带信息读取失败，刷新页面再试。"));
    });
    return () => controller.abort();
  }, [fetchState]);

  async function save(options: { applyTo: "this" | "all_keyword"; saveAsDefault: boolean }) {
    if (!draft) return;
    const body = await apiFetch<DigestExtrasState>(`/api/watch-profiles/${encodeURIComponent(profileId)}/digest-extras`, {
      method: "PUT",
      body: JSON.stringify({ ...draft, ...options }),
    });
    setState(body);
    setDraft(body.current);
    onSaved?.();
    return body;
  }

  async function run(options: { applyTo: "this" | "all_keyword"; saveAsDefault: boolean }, done: (body: DigestExtrasState) => string) {
    setBusy(true);
    setNotice("");
    try {
      const body = await save(options);
      if (body) setNotice(done(body));
    } catch (error) {
      setNotice(`没保存上（${apiErrorMessage(error, "网络或服务出错")}），页面上的选择还在，可以再点一次。`);
    } finally {
      setBusy(false);
    }
  }

  if (!state || !draft) {
    return (
      <section className="paper-panel digest-extras-panel">
        <div className="panel-header"><div><p className="eyebrow">DAILY DIGEST</p><h2>日报附带信息</h2></div></div>
        <div className="panel-body"><p className="digest-extras-intro">{notice || "正在读取…"}</p></div>
      </section>
    );
  }

  const dirty = !sameExtras(draft, state.current);
  const othersCount = Math.max(0, state.keywordProfileCount - 1);
  const nothingShown = draft.priceReference === "off" && !draft.showSales;

  return (
    <section className="paper-panel digest-extras-panel">
      <div className="panel-header">
        <div><p className="eyebrow">DAILY DIGEST</p><h2>日报附带信息</h2></div>
        <span className="status-pill">{digestExtrasSummary(state.current)}</span>
      </div>
      <div className="panel-body">
        <p className="digest-extras-intro">
          每天的日报里，每件商品下面可以附带原价和同款成交。用不上的就关掉：关掉的部分不再去查，
          关掉 AI 预测就不再调用估价模型（它按用量计费）。这里只改这个档案的日报。
        </p>

        <fieldset className="digest-extras-group">
          <legend>原价</legend>
          <div className="monitor-event-options digest-extras-price-options">
            {PRICE_OPTIONS.map((option) => (
              <label key={option.value} data-selected={draft.priceReference === option.value}>
                <input
                  type="radio"
                  name={`digest-price-${profileId}`}
                  value={option.value}
                  checked={draft.priceReference === option.value}
                  onChange={() => setDraft({ ...draft, priceReference: option.value })}
                />
                <span><strong>{option.label}</strong><small>{option.detail}</small></span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="digest-extras-group">
          <legend>同款成交</legend>
          <div className="monitor-event-options digest-extras-sales-option">
            <label data-selected={draft.showSales}>
              <input
                type="checkbox"
                checked={draft.showSales}
                onChange={(event) => setDraft({ ...draft, showSales: event.target.checked })}
              />
              <span><strong>显示同款成交</strong><small>二手平台上标题逐条核对过的同款成交，附中位数和可点开的成交链接。</small></span>
            </label>
          </div>
        </fieldset>

        {nothingShown && <p className="schedule-separation-note">两样都关掉后，日报只列商品本身（来源、图、价格），发信时不再调用价格接口。</p>}

        <div className="digest-extras-actions">
          <button
            className="ghost-button"
            type="button"
            disabled={busy || !dirty}
            onClick={() => void run({ applyTo: "this", saveAsDefault: false }, () => "已保存，从下一封日报开始生效。")}
          >
            {busy ? "正在保存…" : dirty ? "保存到这个档案" : "已保存"}
          </button>
          {othersCount > 0 && <button className="ghost-button" type="button" disabled={busy} onClick={() => setConfirmAll(true)}>
            应用到全部 {state.keywordProfileCount} 个关键词档案
          </button>}
          <button
            className="ghost-button"
            type="button"
            disabled={busy || (sameExtras(draft, state.defaults) && !dirty)}
            onClick={() => void run({ applyTo: "this", saveAsDefault: true }, () => "已保存到这个档案，以后新建的关键词档案也默认这样。")}
          >
            设为新建档案的默认
          </button>
        </div>
        <p className="digest-extras-default">新建关键词档案默认：{digestExtrasSummary(state.defaults)}</p>
        {notice && <p className="item-alert-message" role="status">{notice}</p>}
      </div>

      <ConfirmDialog
        open={confirmAll}
        eyebrow="BULK UPDATE"
        title={`把这套设置用到全部 ${state.keywordProfileCount} 个关键词档案？`}
        description={`「${digestExtrasSummary(draft)}」会覆盖另外 ${othersCount} 个档案各自的设置，从下一封日报开始生效。之后仍可以在每个档案里单独改回来。新建档案的默认值不受影响。`}
        confirmLabel="全部应用"
        cancelLabel="取消"
        busyLabel="正在应用…"
        errorFallback="没应用上，请稍后再试。"
        onCancel={() => setConfirmAll(false)}
        onConfirm={async () => {
          const body = await save({ applyTo: "all_keyword", saveAsDefault: false });
          setConfirmAll(false);
          if (body) setNotice(`已应用到全部 ${body.keywordProfileCount} 个关键词档案，从下一封日报开始生效。`);
        }}
      />
    </section>
  );
}
