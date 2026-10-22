"use client";

import type { Route } from "next";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import pushStyles from "./push-channels.module.css";
import styles from "./delivery-channels.module.css";

/**
 * 这个档案的通知发到哪（apps/web/src/app/api/watch-profiles/[id]/delivery）：邮件、飞书两个开关，点了马上生效。
 * 管这个档案的全部通知（日报、精确同款上新、降价等商品变化）；来源故障提醒、精确同款周报不归它管。
 */
interface DeliveryState {
  profileId: string;
  notifyEmail: boolean;
  notifyFeishu: boolean;
  reach: { pushEnabled: boolean; ownerPrivate: boolean; groups: string[] } | null;
}

export function deliverySummary(state: Pick<DeliveryState, "notifyEmail" | "notifyFeishu">): string {
  if (state.notifyEmail && state.notifyFeishu) return "邮件 + 飞书";
  if (state.notifyEmail) return "只发邮件";
  if (state.notifyFeishu) return "只发飞书";
  return "只巡回，不通知";
}

function FeishuNotes({ state }: { state: DeliveryState }) {
  const { reach } = state;
  if (!state.notifyFeishu) {
    return reach && reach.groups.length > 0
      ? <p className={styles.note}>「推送」页上有 {reach.groups.length} 个群勾了这个档案（{reach.groups.map((name) => `「${name}」`).join("")}），打开飞书后才会发过去。</p>
      : null;
  }
  if (!reach) return <p className={styles.note}>读不到推送服务的状态，看不出飞书现在能不能送到；开关照样已经生效。</p>;
  const fallback = state.notifyEmail ? "" : "，所以每次都会改发邮件";
  if (!reach.pushEnabled) {
    return <p className={styles.warn}>飞书推送的总闸（owner_push_v1）关着，现在一条都不会发到飞书{fallback}。</p>;
  }
  if (reach.groups.length === 0 && !reach.ownerPrivate) {
    return (
      <p className={styles.warn}>
        飞书开着，但没有群收这个档案，飞书私聊也没开{fallback}。去 <Link href={"/push" as Route}>「推送」页</Link> 给一个群勾上它。
      </p>
    );
  }
  const places = [
    ...reach.groups.map((name) => `群「${name}」`),
    ...(reach.ownerPrivate ? ["我的飞书私聊"] : []),
  ];
  return <p className={styles.note}>飞书会发到：{places.join("、")}。发到哪个群在 <Link href={"/push" as Route}>「推送」页</Link> 改。</p>;
}

export function DeliveryChannelsPanel({ profileId, onSaved }: { profileId: string; onSaved?: () => void }) {
  const [state, setState] = useState<DeliveryState | null>(null);
  const [busy, setBusy] = useState<"" | "email" | "feishu">("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<DeliveryState>(`/api/watch-profiles/${encodeURIComponent(profileId)}/delivery`, { signal: controller.signal })
      .then(setState)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setNotice({ ok: false, text: apiErrorMessage(error, "通知去向读取失败，刷新页面再试。") });
      });
    return () => controller.abort();
  }, [profileId]);

  async function toggle(channel: "email" | "feishu") {
    if (!state) return;
    const next = {
      notifyEmail: channel === "email" ? !state.notifyEmail : state.notifyEmail,
      notifyFeishu: channel === "feishu" ? !state.notifyFeishu : state.notifyFeishu,
    };
    setBusy(channel);
    setNotice(null);
    try {
      const body = await apiFetch<DeliveryState>(`/api/watch-profiles/${encodeURIComponent(profileId)}/delivery`, {
        method: "PUT",
        body: JSON.stringify(next),
      });
      setState(body);
      onSaved?.();
      setNotice({ ok: true, text: `改好了：${deliverySummary(body)}。从下一条通知开始生效。` });
    } catch (error) {
      setNotice({ ok: false, text: `没改成（${apiErrorMessage(error, "网络或服务出错")}），还是原来的「${deliverySummary(state)}」，可以再点一次。` });
    } finally {
      setBusy("");
    }
  }

  const head = (
    <div className="panel-header">
      <div><p className="eyebrow">DELIVERY</p><h2>通知发到哪</h2></div>
      {state && <span className="status-pill">{deliverySummary(state)}</span>}
    </div>
  );
  if (!state) {
    return (
      <section className="paper-panel">
        {head}
        <div className="panel-body"><p className={styles.intro}>{notice?.text ?? "正在读取…"}</p></div>
      </section>
    );
  }

  const silent = !state.notifyEmail && !state.notifyFeishu;
  return (
    <section className="paper-panel">
      {head}
      <div className="panel-body">
        <p className={styles.intro}>
          这个档案的全部通知（日报、同款上新、降价等）发到哪，两个开关各管各的，点了马上生效。
          两个都关就是只巡回、不通知。来源出故障的提醒和精确同款周报不归这里管，照发邮件。
        </p>
        <ul className={styles.rows}>
          <li className={styles.row} data-on={state.notifyEmail}>
            <div className={styles.rowTitle}>
              <strong>邮件<em className={styles.state}>{state.notifyEmail ? "开着" : "关着"}</em></strong>
              <span>发到你的邮箱。</span>
            </div>
            <button type="button" className={pushStyles.switch} aria-pressed={state.notifyEmail} disabled={busy !== ""} onClick={() => void toggle("email")}>
              {busy === "email" ? "正在切换…" : state.notifyEmail ? "关掉邮件" : "打开邮件"}
            </button>
          </li>
          <li className={styles.row} data-on={state.notifyFeishu}>
            <div className={styles.rowTitle}>
              <strong>飞书<em className={styles.state}>{state.notifyFeishu ? "开着" : "关着"}</em></strong>
              <span>发到「推送」页上勾了这个档案的群，以及我的飞书私聊（开着的话）。</span>
            </div>
            <button type="button" className={pushStyles.switch} aria-pressed={state.notifyFeishu} disabled={busy !== ""} onClick={() => void toggle("feishu")}>
              {busy === "feishu" ? "正在切换…" : state.notifyFeishu ? "关掉飞书" : "打开飞书"}
            </button>
          </li>
        </ul>
        <div className={styles.notes}>
          {silent && <p className={styles.warn}>只巡回，不通知：这个档案照常巡回、记录商品，但不发邮件也不发飞书。</p>}
          {state.notifyFeishu && !state.notifyEmail && (
            <p className={styles.note}>只开了飞书：飞书没送到时（没有群收、飞书出错、额度到线）会自动改发邮件，邮件开头写明原因。</p>
          )}
          <FeishuNotes state={state} />
          {notice && <p className={notice.ok ? pushStyles.ok : pushStyles.error} role="status">{notice.text}</p>}
        </div>
      </div>
    </section>
  );
}
