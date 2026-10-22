"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Plus, RotateCcw, X } from "lucide-react";
import { formatJpy, mutedProductLabel } from "@jpgr/core";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import { tokyoFull } from "@/lib/format-time";
import { ConfirmDialog } from "@/components/confirm-dialog";
import styles from "./muted-products.module.css";

interface Rule {
  id: string;
  termGroups: string[];
  label: string;
  sample: { title: string; url: string | null; imageUrl: string | null } | null;
  createdAt: string;
  recentHits: number;
}

interface Sample {
  sourceName: string;
  title: string;
  url: string;
  imageUrl: string | null;
  price: number | null;
  tokens: string[];
}

interface MutedData {
  profile: { id: string; name: string };
  windowDays: number;
  recentTotal: number;
  limit: number;
  rules: Rule[];
  sample: Sample | null;
}

interface PreviewListing {
  sourceId: string;
  sourceName: string;
  sourceItemId: string;
  title: string;
  url: string;
  imageUrl: string | null;
  price: number | null;
  purchasable: boolean;
}

interface Preview {
  recentTotal: number;
  matchedTotal: number;
  examples: PreviewListing[];
}

const MAX_GROUPS = 6;

function sameWord(left: string, right: string): boolean {
  return left.normalize("NFKC").toLocaleLowerCase() === right.normalize("NFKC").toLocaleLowerCase();
}

/**
 * 屏蔽单品：从邮件里某件商品点进来（`?source=&item=`），点选标题里能认出它的几个词，
 * 先看过去 30 天会挡掉哪些，再保存。之后标题里同时有这几个词的商品不再进日报。
 */
export function MutedProducts({ profileId, sourceId, sourceItemId }: {
  profileId: string;
  sourceId?: string;
  sourceItemId?: string;
}) {
  const [data, setData] = useState<MutedData | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState("");
  const [requestKey, setRequestKey] = useState(0);
  const [groups, setGroups] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  // 预演结果记着它是哪组词算出来的：词一改，旧结果自然作废，不用在 effect 里清空。
  const [previewResult, setPreviewResult] = useState<{ key: string; preview: Preview | null; failed: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Rule | null>(null);
  // 保存过一次后，邮件带进来的那件商品就用完了，表单回到"自己填词"。
  const [sampleUsed, setSampleUsed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const query = sourceId && sourceItemId && !sampleUsed
      ? `?${new URLSearchParams({ source: sourceId, item: sourceItemId }).toString()}`
      : "";
    apiFetch<MutedData>(`/api/watch-profiles/${profileId}/muted-products${query}`, { signal: controller.signal })
      .then((body) => {
        setData(body);
        setState("loaded");
        setError("");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(apiErrorMessage(reason, "屏蔽清单读取失败"));
        setState("error");
      });
    return () => controller.abort();
  }, [profileId, sourceId, sourceItemId, sampleUsed, requestKey]);

  const reload = useCallback(() => setRequestKey((current) => current + 1), []);

  // 选的词一变就重新预演；停顿 400ms 再发，连点几个词只算一次。
  const termGroups = groups.map((group) => group.trim()).filter(Boolean);
  const groupsKey = JSON.stringify(termGroups);
  useEffect(() => {
    const previewGroups = JSON.parse(groupsKey) as string[];
    if (previewGroups.length === 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      apiFetch<Preview>(`/api/watch-profiles/${profileId}/muted-products/preview`, {
        method: "POST",
        body: JSON.stringify({ termGroups: previewGroups }),
        signal: controller.signal,
      })
        .then((body) => setPreviewResult({ key: groupsKey, preview: body, failed: false }))
        .catch(() => {
          if (!controller.signal.aborted) setPreviewResult({ key: groupsKey, preview: null, failed: true });
        });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [profileId, groupsKey]);

  function toggleToken(token: string) {
    setMessage("");
    setGroups((current) => current.some((group) => sameWord(group, token))
      ? current.filter((group) => !sameWord(group, token))
      : current.length >= MAX_GROUPS ? current : [...current, token]);
  }

  function addDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const word = draft.trim();
    if (!word) return;
    setMessage("");
    setGroups((current) => current.some((group) => sameWord(group, word)) || current.length >= MAX_GROUPS
      ? current
      : [...current, word]);
    setDraft("");
  }

  async function save() {
    if (!data || termGroups.length === 0) return;
    setSaving(true);
    setError("");
    const sample = data.sample && !sampleUsed
      ? { title: data.sample.title, url: data.sample.url, imageUrl: data.sample.imageUrl }
      : null;
    try {
      const saved = await apiFetch<{ label: string }>(`/api/watch-profiles/${profileId}/muted-products`, {
        method: "POST",
        body: JSON.stringify({ termGroups, sample }),
      });
      setMessage(`已屏蔽「${saved.label}」。今天还没发出的日报里就会去掉，以后新挂出来的也不再推送。`);
      setGroups([]);
      if (sample) setSampleUsed(true);
      else reload();
    } catch (reason) {
      setError(apiErrorMessage(reason, "屏蔽没保存上，请稍后再试"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(rule: Rule) {
    await apiFetch(`/api/watch-profiles/${profileId}/muted-products?${new URLSearchParams({ rule: rule.id }).toString()}`, {
      method: "DELETE",
    });
    setPendingDelete(null);
    setData((current) => current && { ...current, rules: current.rules.filter((entry) => entry.id !== rule.id) });
  }

  const backHref = `/watches/${encodeURIComponent(profileId)}` as Route;

  if (state === "loading" && !data) {
    return <p className="watch-listing-state" role="status">正在读取屏蔽清单…</p>;
  }
  if (state === "error" && !data) {
    return (
      <div className="watch-listing-state" role="alert">
        <p>{error}</p>
        <button className="ghost-button" type="button" onClick={reload}>重新读取</button>
      </div>
    );
  }
  if (!data) return null;
  const sample = sampleUsed ? null : data.sample;
  const current = previewResult?.key === groupsKey ? previewResult : null;
  const preview = current?.preview ?? null;
  const previewFailed = current?.failed === true;
  const full = data.rules.length >= data.limit;

  return (
    <div className="detail-stack reveal reveal-delay-1">
      <section className="paper-panel">
        <div className="panel-header">
          <div><p className="eyebrow">MUTED PRODUCTS</p><h2>屏蔽单品 · {data.profile.name}</h2></div>
          <Link className="ghost-button" href={backHref}><ArrowLeft size={14} aria-hidden="true" />回到档案</Link>
        </div>
        <div className={`panel-body ${styles.intro}`}>
          <p>
            景品、一番赏这类商品每天都有新卖家挂出来，日报按链接去重拦不住。在这里选几个能认出这件商品的词——
            标题里这几个词<strong>同时出现</strong>的，以后都不进日报。保存之前会先列出过去 {data.windowDays} 天会挡掉哪些，
            挡多了就少选一个词，挡少了就给某个词加别的写法。
          </p>
          {error && <p className={styles.error} role="alert">{error}</p>}
          {message && <p className={styles.saved} role="status">{message}</p>}
        </div>
      </section>

      <section className="watch-listing-evidence" aria-labelledby="muted-new">
        <header>
          <div>
            <p className="eyebrow">NEW</p>
            <h3 id="muted-new">屏蔽一件商品</h3>
            <p>{sample ? "点标题里能认出这件商品的词，比如型号、年份、「SPA」「ムチュート」这种。" : "写下能认出这件商品的词，每个词单独加。比如型号、年份、「SPA」「ムチュート」这种；同一个词有别的写法用「|」接上。"}</p>
          </div>
        </header>
        <div className={styles.builder}>
          {sample && (
            <div className={styles.sample}>
              <div className="watch-listing-media">
                {sample.imageUrl
                  ? <Image src={sample.imageUrl} alt={sample.title} width={144} height={144} sizes="88px" />
                  : <div aria-label="商品图片暂缺" />}
              </div>
              <div className={styles.sampleMain}>
                <a href={sample.url} target="_blank" rel="noopener noreferrer">{sample.title}<ArrowUpRight size={13} aria-hidden="true" /></a>
                <span>{sample.sourceName} · {sample.price === null ? "价格待确认" : formatJpy(sample.price)}</span>
                <div className={styles.tokens} role="group" aria-label="标题里的词">
                  {sample.tokens.map((token) => {
                    const selected = groups.some((group) => sameWord(group, token));
                    return (
                      <button key={token} type="button" aria-pressed={selected} onClick={() => toggleToken(token)}>{token}</button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div className={styles.selected}>
            <p className={styles.label}>同时出现这些词才算这件商品</p>
            {groups.length === 0
              ? <p className={styles.hint}>{sample ? "还没选词。" : "还没加词。"}</p>
              : (
                <ol>
                  {groups.map((group, index) => (
                    <li key={`${index}:${group}`}>
                      <input
                        className="text-input"
                        aria-label={`第 ${index + 1} 个词`}
                        value={group}
                        maxLength={100}
                        onChange={(event) => {
                          const value = event.target.value;
                          setGroups((current) => current.map((entry, position) => position === index ? value : entry));
                        }}
                        onBlur={() => setGroups((current) => current.filter((entry) => entry.trim()))}
                      />
                      <button type="button" aria-label={`去掉「${group}」`} onClick={() => setGroups((current) => current.filter((_, position) => position !== index))}>
                        <X size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            <p className={styles.hint}>同一个词有别的写法，用「|」接在后面，比如 ムチュート|Muchute，任一写法出现都算。</p>
            <form className={styles.addWord} onSubmit={addDraft}>
              <input
                className="text-input"
                aria-label="再加一个词"
                placeholder="再加一个词"
                value={draft}
                maxLength={100}
                onChange={(event) => setDraft(event.target.value)}
                disabled={groups.length >= MAX_GROUPS}
              />
              <button className="ghost-button" type="submit" disabled={!draft.trim() || groups.length >= MAX_GROUPS}>
                <Plus size={13} aria-hidden="true" />加词
              </button>
            </form>
          </div>

          {groups.length > 0 && (
            <div className={styles.preview} aria-live="polite">
              <p className={styles.label}>
                {previewFailed
                  ? "预演没读出来，稍等再改一下词试试"
                  : !preview
                    ? "正在算会挡掉哪些…"
                    : `过去 ${data.windowDays} 天这个档案采到 ${preview.recentTotal} 件，「${mutedProductLabel(termGroups)}」会挡掉 ${preview.matchedTotal} 件`}
              </p>
              {preview && preview.matchedTotal === 0 && (
                <p className={styles.hint}>一件都没挡到。可能是词选得太具体，或者这件商品过去 30 天没出现过；保存后对以后新挂出来的照样生效。</p>
              )}
              {preview && preview.examples.length > 0 && (
                <ol className={styles.examples}>
                  {preview.examples.map((item) => (
                    <li key={`${item.sourceId}:${item.sourceItemId}`}>
                      <div className={styles.thumb}>
                        {item.imageUrl
                          ? <Image src={item.imageUrl} alt="" width={96} height={96} sizes="48px" />
                          : <div aria-hidden="true" />}
                      </div>
                      <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
                      <span>{item.sourceName} · {item.price === null ? "价格待确认" : formatJpy(item.price)}{item.purchasable ? "" : " · 已售出或下架"}</span>
                    </li>
                  ))}
                </ol>
              )}
              {preview && preview.matchedTotal > preview.examples.length && (
                <p className={styles.hint}>另有 {preview.matchedTotal - preview.examples.length} 件没列出来。</p>
              )}
            </div>
          )}

          <div className={styles.actions}>
            <button className="primary-button" type="button" disabled={termGroups.length === 0 || saving || full} onClick={() => void save()}>
              {saving ? "正在保存…" : "屏蔽，以后不再推送"}
            </button>
            {full && <p className={styles.hint}>已经屏蔽了 {data.limit} 件，到上限了。先撤销几条不需要的，或者考虑把关键词本身收窄。</p>}
          </div>
        </div>
      </section>

      <section className="watch-listing-evidence" aria-labelledby="muted-list">
        <header>
          <div>
            <p className="eyebrow">MUTED</p>
            <h3 id="muted-list">已屏蔽的商品</h3>
            <p>撤销后，从下一轮采集起这件商品会重新进日报。</p>
          </div>
          <span>{data.rules.length} 件</span>
        </header>
        {data.rules.length === 0
          ? <p className="watch-listing-state">还没有屏蔽任何商品。</p>
          : (
            <ol className={styles.rules}>
              {data.rules.map((rule) => (
                <li key={rule.id}>
                  <strong>{rule.label}</strong>
                  {rule.sample && (
                    rule.sample.url
                      ? <a href={rule.sample.url} target="_blank" rel="noopener noreferrer">从这件点进来的：{rule.sample.title}</a>
                      : <span className={styles.ruleSample}>从这件点进来的：{rule.sample.title}</span>
                  )}
                  <span className={styles.ruleMeta}>过去 {data.windowDays} 天挡掉 {rule.recentHits} 件 · <time dateTime={rule.createdAt}>{tokyoFull(rule.createdAt)}</time> 屏蔽</span>
                  <button type="button" onClick={() => setPendingDelete(rule)}>
                    <RotateCcw size={12} aria-hidden="true" />撤销
                  </button>
                </li>
              ))}
            </ol>
          )}
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        eyebrow="UNMUTE"
        title={`撤销屏蔽「${pendingDelete?.label ?? ""}」？`}
        description="从下一轮采集起，标题里同时有这几个词的商品会重新进日报。之后想再屏蔽，回这页重新选词即可。"
        confirmLabel="撤销屏蔽"
        cancelLabel="先不撤销"
        busyLabel="正在撤销…"
        errorFallback="撤销没成功，请稍后再试。"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete ? remove(pendingDelete) : Promise.resolve()}
      />
    </div>
  );
}
