"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Plus, RotateCw } from "lucide-react";
import { formatJpy } from "@jpgr/core";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import { tokyoDateTime } from "@/lib/format-time";
import styles from "./inbox.module.css";

/**
 * 侧栏「收件箱」（2026-10-16 用户要的）：日报标注、AI 复核、被排除词挡掉的合成一页，照手机 App 的标注页做——
 * 一行一件、按档案分栏、按天分段，每行右边点一下就存，再点一次撤销；点过的变淡但留在原位，看得出标到哪儿了。
 * 邮件、飞书都关掉的档案，日报只在这里看（日报照样生成，只是不发）。
 *
 * 三栏，各自只有它那一种结论：
 * - 推给我的：「不想看」（用户 2026-10-12 定，不设「还想看」）和「盯住」——看中的放进商品库，
 *   每小时查一次详情页，点赞 / 评论涨了发邮件（2026-10-16 用户定，/api/inbox/watch）；
 * - AI 拦下的：AI 拿不准 / 可能误杀 / 没判出来按规则发了的，判「确实不是 / 其实是」，下面是排除词建议；
 * - 排除词挡掉的：只有「挡错了」，用来收窄排除词。
 */

type View = "digest" | "ai" | "excluded";

interface Profile {
  id: string;
  name: string;
  enabled: boolean;
  notifyEmail: boolean;
  notifyFeishu: boolean;
}

interface DigestItem {
  profileId: string;
  digestEventId: string;
  digestAt: string;
  sourceId: string;
  sourceName: string;
  sourceItemId: string;
  title: string;
  url: string | null;
  imageUrl: string | null;
  price: number | null;
  auction: boolean;
  listedAt: string | null;
  verdict: "hide" | "keep" | null;
}

interface ExcludedItem {
  profileId: string;
  sourceId: string;
  sourceName: string;
  sourceItemId: string;
  title: string;
  url: string;
  imageUrl: string | null;
  price: number | null;
  auction: boolean;
  listedAt: string;
  term: string;
  inTitle: boolean;
  wanted: boolean;
}

interface WatchedItem {
  sourceId: string;
  sourceItemId: string;
  likeCount: number | null;
  commentCount: number | null;
}

interface InboxData {
  digestWindowDays: number;
  excludedWindowDays: number;
  profiles: Profile[];
  digest: DigestItem[];
  excluded: ExcludedItem[];
  watchLimit: number;
  watches: WatchedItem[];
}

function itemKey(item: { sourceId: string; sourceItemId: string }): string {
  return `${item.sourceId}\u0000${item.sourceItemId}`;
}

/** 「盯住」按钮的失败原因，接口回的是代号。 */
const watchErrors: Record<string, string> = {
  watch_limit_reached: "同时盯的商品已经满了",
  watch_profile_completed: "这件以前盯完了（已卖掉或下架）",
  source_monitoring_paused: "这个来源的巡回暂停着",
  listing_not_found: "商品库里找不到这件",
  terminal_listing_requires_product_radar: "这件已经卖掉或下架了",
};

function interestText(watch: WatchedItem | undefined): string | null {
  if (!watch) return null;
  const parts = [
    watch.likeCount === null ? null : `点赞 ${watch.likeCount}`,
    watch.commentCount === null ? null : `评论 ${watch.commentCount}`,
  ].filter(Boolean);
  return parts.length > 0 ? `盯住中 · ${parts.join(" · ")}` : "盯住中 · 下一轮巡回后显示点赞";
}

type AiVerdict = "ai_correct" | "ai_wrong";

interface AiItem {
  bindingId: string;
  sourceId: string;
  sourceName: string;
  sourceItemId: string;
  title: string;
  url: string;
  imageUrl: string | null;
  price: number | null;
  purchasable: boolean;
  observedAt: string;
  aiRelevance: "irrelevant" | "uncertain" | null;
  aiReason: string | null;
  flag: { kind: "ai_uncertain" | "series_signal" | "rule_fallback"; terms: { term: string; confirmedCount: number }[] };
  /** 只在本页：这次打开后判过的，留在原位、变淡。 */
  judged?: AiVerdict;
}

interface Suggestion {
  term: string;
  blockedCount: number;
  examples: { title: string; url: string; aiReason: string | null }[];
}

interface AiData {
  profile: { id: string; name: string; excludeTerms: string[] };
  windowDays: number;
  queue: AiItem[];
  suggestions: Suggestion[];
}

const EXCLUDE_GROUP_LIMIT = 30;
const EXCLUDE_GROUP_LENGTH = 100;

/** 每个新词单独占一组，组数到上限后才拼进最后一组，免得把用户自己分好的组搅乱。 */
function withExcludeTerm(current: readonly string[], term: string): string[] | null {
  if (current.length < EXCLUDE_GROUP_LIMIT) return [...current, term];
  const last = current.at(-1);
  if (last === undefined || `${last}|${term}`.length > EXCLUDE_GROUP_LENGTH) return null;
  return [...current.slice(0, -1), `${last}|${term}`];
}

const viewCopy: Record<View, string> = { digest: "推给我的", ai: "AI 拦下的", excluded: "排除词挡掉的" };

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });

function tokyoDay(value: string): string {
  return dayFormat.format(new Date(value));
}

function dayLabel(day: string): string {
  const today = tokyoDay(new Date().toISOString());
  const yesterday = tokyoDay(new Date(Date.now() - 86_400_000).toISOString());
  if (day === today) return "今天";
  if (day === yesterday) return "昨天";
  const [, month, date] = day.split("-");
  return `${Number(month)}月${Number(date)}日`;
}

function groupByDay<T>(items: readonly T[], at: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const day = tokyoDay(at(item));
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }
  return [...groups];
}

function digestKey(item: { profileId: string; sourceId: string; sourceItemId: string }): string {
  return `${item.profileId}\u0000${item.sourceId}\u0000${item.sourceItemId}`;
}

function aiKey(item: { bindingId: string; sourceId: string; sourceItemId: string }): string {
  return `${item.bindingId}\u0000${item.sourceId}\u0000${item.sourceItemId}`;
}

/** 以前标的「还想看」当没标（标注只剩「不想看」一种）。 */
function hidden(item: DigestItem): boolean {
  return item.verdict === "hide";
}

function pushState(profile: Profile): string {
  if (profile.notifyEmail && profile.notifyFeishu) return "邮件、飞书都开着";
  if (profile.notifyFeishu) return "只推飞书";
  if (profile.notifyEmail) return "只发邮件";
  return "邮件、飞书都关着，只在这里看";
}

function aiFlag(item: AiItem): string {
  if (item.flag.kind === "rule_fallback") return "AI 没判，按规则发了";
  if (item.flag.kind === "ai_uncertain") return "AI 拿不准";
  const [first, second] = item.flag.terms;
  return `AI 拒了，但标题里有「${first?.term ?? ""}」${second ? `「${second.term}」` : ""}`;
}

function readParams(): { watch: string | null; view: View } {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  return { watch: params.get("watch"), view: view === "ai" || view === "excluded" ? view : "digest" };
}

function writeParams(watch: string | null, view: View) {
  const url = new URL(window.location.href);
  if (watch) url.searchParams.set("watch", watch);
  if (view === "digest") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  window.history.replaceState(null, "", url);
}

export function Inbox() {
  const [data, setData] = useState<InboxData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [view, setView] = useState<View>("digest");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);
  /** 按档案缓存「AI 拦下的」；还没有这一项就是正在读。 */
  const [ai, setAi] = useState<Record<string, AiData | { error: string }>>({});
  const [pendingTerm, setPendingTerm] = useState<Suggestion | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<InboxData>("/api/inbox", { signal: controller.signal })
      .then((body) => {
        setData(body);
        setLoadError("");
        const requested = readParams();
        setProfileId((current) => {
          const keep = current ?? requested.watch;
          if (keep && body.profiles.some((profile) => profile.id === keep)) return keep;
          // 默认打开没标的最多的那个档案（和 App 一样）。
          const todo = (id: string) => body.digest.filter((item) => item.profileId === id && !hidden(item)).length;
          return [...body.profiles].sort((left, right) => todo(right.id) - todo(left.id))[0]?.id ?? null;
        });
        setView((current) => (reload === 0 ? requested.view : current));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setLoadError(apiErrorMessage(reason, "收件箱读取失败"));
      });
    return () => controller.abort();
    // reload 只用来触发重读；view 的初值只在第一次从网址里取。
  }, [reload]);

  useEffect(() => {
    if (profileId) writeParams(profileId, view);
  }, [profileId, view]);

  const aiEntry = profileId ? ai[profileId] : undefined;
  useEffect(() => {
    if (view !== "ai" || !profileId || aiEntry !== undefined) return;
    const controller = new AbortController();
    apiFetch<AiData>(`/api/watch-profiles/${profileId}/ai-review`, { signal: controller.signal })
      .then((body) => setAi((current) => ({ ...current, [profileId]: body })))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setAi((current) => ({ ...current, [profileId]: { error: apiErrorMessage(reason, "AI 复核数据读取失败") } }));
      });
    return () => controller.abort();
  }, [view, profileId, aiEntry]);

  const refresh = useCallback(() => {
    setLoadError("");
    setReload((current) => current + 1);
    if (profileId) setAi((current) => {
      const next = { ...current };
      delete next[profileId];
      return next;
    });
  }, [profileId]);

  const withBusy = useCallback(async (key: string, task: () => Promise<void>) => {
    if (busy.has(key)) return;
    setBusy((current) => new Set(current).add(key));
    setSaveError("");
    try {
      await task();
    } catch (reason) {
      setSaveError(`没存上：${apiErrorMessage(reason, "没连上主站")}。再点一次试试。`);
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [busy]);

  function toggleHide(item: DigestItem) {
    const key = digestKey(item);
    const next = hidden(item) ? null : "hide";
    void withBusy(key, async () => {
      await apiFetch(`/api/watch-profiles/${item.profileId}/digest-labels`, {
        method: "POST",
        body: JSON.stringify({ digestEventId: item.digestEventId, sourceId: item.sourceId, sourceItemId: item.sourceItemId, verdict: next ?? "undo" }),
      });
      setData((current) => current && {
        ...current,
        digest: current.digest.map((entry) => digestKey(entry) === key ? { ...entry, verdict: next } : entry),
      });
    });
  }

  function toggleWatch(item: DigestItem) {
    const key = `w\u0000${itemKey(item)}`;
    const watching = data?.watches.some((entry) => itemKey(entry) === itemKey(item)) ?? false;
    void withBusy(key, async () => {
      try {
        await apiFetch("/api/inbox/watch", {
          method: watching ? "DELETE" : "POST",
          body: JSON.stringify({ sourceId: item.sourceId, sourceItemId: item.sourceItemId }),
        });
      } catch (reason) {
        const code = reason instanceof Error ? reason.message : "";
        const known = watchErrors[code];
        if (!known) throw reason;
        throw new Error(code === "watch_limit_reached" ? `${known}（最多 ${data?.watchLimit ?? 30} 件），先到商品库停掉几件` : known);
      }
      setData((current) => current && {
        ...current,
        watches: watching
          ? current.watches.filter((entry) => itemKey(entry) !== itemKey(item))
          : [...current.watches, { sourceId: item.sourceId, sourceItemId: item.sourceItemId, likeCount: null, commentCount: null }],
      });
    });
  }

  function toggleWanted(item: ExcludedItem) {
    const key = `x\u0000${digestKey(item)}`;
    void withBusy(key, async () => {
      await apiFetch("/api/inbox/excluded", {
        method: "POST",
        body: JSON.stringify({ profileId: item.profileId, sourceId: item.sourceId, sourceItemId: item.sourceItemId, wanted: !item.wanted }),
      });
      setData((current) => current && {
        ...current,
        excluded: current.excluded.map((entry) => digestKey(entry) === digestKey(item) ? { ...entry, wanted: !item.wanted } : entry),
      });
    });
  }

  function judge(item: AiItem, verdict: AiVerdict) {
    if (!profileId) return;
    const owner = profileId;
    const key = `a\u0000${aiKey(item)}`;
    // 再点一次已选的那个 = 撤销。
    const next = item.judged === verdict ? "undo" : verdict;
    void withBusy(key, async () => {
      await apiFetch(`/api/watch-profiles/${owner}/ai-review`, {
        method: "POST",
        body: JSON.stringify({ bindingId: item.bindingId, sourceId: item.sourceId, sourceItemId: item.sourceItemId, verdict: next }),
      });
      setAi((current) => {
        const entry = current[owner];
        if (!entry || "error" in entry) return current;
        return {
          ...current,
          [owner]: {
            ...entry,
            queue: entry.queue.map((row) => aiKey(row) === aiKey(item) ? { ...row, judged: next === "undo" ? undefined : next } : row),
          },
        };
      });
    });
  }

  async function addExcludeTerm(suggestion: Suggestion) {
    if (!profileId || !aiEntry || "error" in aiEntry) return;
    const next = withExcludeTerm(aiEntry.profile.excludeTerms, suggestion.term);
    if (!next) throw new Error("排除词已经写满 30 组，请先到档案里合并几组再加。");
    await apiFetch(`/api/watch-profiles/${profileId}`, { method: "PATCH", body: JSON.stringify({ excludeTerms: next }) });
    const owner = profileId;
    setPendingTerm(null);
    setAi((current) => {
      const entry = current[owner];
      if (!entry || "error" in entry) return current;
      return {
        ...current,
        [owner]: {
          ...entry,
          profile: { ...entry.profile, excludeTerms: next },
          suggestions: entry.suggestions.filter((row) => row.term !== suggestion.term),
        },
      };
    });
  }

  const profile = data?.profiles.find((entry) => entry.id === profileId) ?? null;
  const digest = useMemo(() => data?.digest.filter((item) => item.profileId === profileId) ?? [], [data, profileId]);
  const excluded = useMemo(() => data?.excluded.filter((item) => item.profileId === profileId) ?? [], [data, profileId]);
  const aiData = aiEntry && !("error" in aiEntry) ? aiEntry : null;
  const watched = useMemo(() => new Map((data?.watches ?? []).map((entry) => [itemKey(entry), entry])), [data]);

  if (!data) {
    return loadError
      ? (
        <div className="watch-listing-state" role="alert">
          <p>{loadError}</p>
          <button className="ghost-button" type="button" onClick={refresh}>重新读取</button>
        </div>
      )
      : <p className="watch-listing-state" role="status">正在拉取收件箱…</p>;
  }
  if (!profile) return <p className="watch-listing-state">还没有关键词档案。</p>;

  const todoOf = (id: string) => data.digest.filter((item) => item.profileId === id && !hidden(item)).length;
  const counts: Record<View, string> = {
    digest: String(digest.filter((item) => !hidden(item)).length),
    ai: aiData ? String(aiData.queue.filter((item) => !item.judged).length) : "",
    excluded: String(excluded.length),
  };

  return (
    <div className="detail-stack reveal reveal-delay-1">
      <section className="paper-panel">
        <div className="panel-header">
          <div><p className="eyebrow">INBOX</p><h2>收件箱</h2></div>
          <button className="ghost-button" type="button" onClick={refresh}><RotateCw size={13} aria-hidden="true" />刷新</button>
        </div>
        <div className={`panel-body ${styles.head}`}>
          <p className={styles.lead}>
            每个档案推过来的商品、AI 拦下的、排除词挡掉的，都在这一页。点一下就存，再点一次撤销；
            点过的变淡但留在原位。「不想看」攒够了，跟 Claude 说「看下标注」，它会归纳成排除词。
            看中的点「盯住」：每小时查一次，点赞或评论变多了就发邮件告诉你「有人盯上了」，降价、卖掉也会提醒。
          </p>
          <nav className={styles.profiles} aria-label="关键词档案">
            {data.profiles.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={entry.id === profileId}
                data-paused={!entry.enabled}
                onClick={() => setProfileId(entry.id)}
              >
                {entry.name}<span>{todoOf(entry.id)}</span>
              </button>
            ))}
          </nav>
          <p className={styles.state}>
            <span>{profile.enabled ? "巡回中" : "已暂停"}</span>
            <span data-silent={!profile.notifyEmail && !profile.notifyFeishu}>{pushState(profile)}</span>
            <Link href={`/watches/${encodeURIComponent(profile.id)}` as Route}>档案设置<ArrowUpRight size={11} aria-hidden="true" /></Link>
          </p>
          <div className={styles.views} role="tablist" aria-label="看哪一栏">
            {(Object.keys(viewCopy) as View[]).map((entry) => (
              <button key={entry} type="button" role="tab" aria-selected={entry === view} onClick={() => setView(entry)}>
                {viewCopy[entry]}{counts[entry] && <span>{counts[entry]}</span>}
              </button>
            ))}
          </div>
          {saveError && <p className={styles.error} role="alert">{saveError}</p>}
          {loadError && <p className={styles.error} role="alert">{loadError}</p>}
        </div>
      </section>

      <section className={`paper-panel ${styles.list}`} aria-live="polite">
        {view === "digest" && (
          <>
            <p className={styles.caption}>
              最近 {data.digestWindowDays} 天日报里逐件列过的商品，同一件只出一次。不想再看到这类的点「不想看」；没点的就当可以留。
              想要的点「盯住」（现在盯着 {data.watches.length} / {data.watchLimit} 件）。
            </p>
            {digest.length === 0
              ? <p className={styles.empty}>最近 {data.digestWindowDays} 天这个档案没有推过新商品。</p>
              : groupByDay(digest, (item) => item.digestAt).map(([day, items]) => (
                <DayGroup key={day} label={dayLabel(day)} summary={`${items.length} 件 · 没标 ${items.filter((item) => !hidden(item)).length}`}>
                  {items.map((item) => {
                    const watch = watched.get(itemKey(item));
                    const watchBusy = busy.has(`w\u0000${itemKey(item)}`);
                    return (
                      <Row
                        key={digestKey(item)}
                        settled={hidden(item)}
                        title={item.title}
                        url={item.url}
                        imageUrl={item.imageUrl}
                        price={item.price}
                        auction={item.auction}
                        meta={[item.sourceName, `推送 ${tokyoDateTime(item.digestAt)}`, item.listedAt ? `上架 ${tokyoDateTime(item.listedAt)}` : null]}
                        note={watch ? <b data-kind="watching">{interestText(watch)}</b> : undefined}
                        stacked
                      >
                        <Choice tone="alert" active={hidden(item)} busy={busy.has(digestKey(item))} onClick={() => toggleHide(item)}>不想看</Choice>
                        <Choice tone="sky" active={watch !== undefined} busy={watchBusy} onClick={() => toggleWatch(item)}>
                          {watch ? "盯住中" : "盯住"}
                        </Choice>
                      </Row>
                    );
                  })}
                </DayGroup>
              ))}
          </>
        )}

        {view === "ai" && (
          <>
            <p className={styles.caption}>
              平时看不到的那批：AI 拿不准的、AI 拒了但标题里带着这个档案独有的词的、AI 没判出来按规则直接发了的。
              是相关商品点「其实是」，以后降价、售罄照常提醒；不是点「确实不是」，它不会再出现。
            </p>
            {aiEntry === undefined
              ? <p className={styles.empty} role="status">正在整理近 30 天 AI 的判定…（要几秒）</p>
              : "error" in aiEntry
                ? <p className={styles.error} role="alert">{aiEntry.error}</p>
                : aiEntry.queue.length === 0
                  ? <p className={styles.empty}>现在没有需要你看的商品。</p>
                  : groupByDay(aiEntry.queue, (item) => item.observedAt).map(([day, items]) => (
                    <DayGroup key={day} label={dayLabel(day)} summary={`${items.length} 件 · 没判 ${items.filter((item) => !item.judged).length}`}>
                      {items.map((item) => {
                        const key = `a\u0000${aiKey(item)}`;
                        const fallback = item.flag.kind === "rule_fallback";
                        return (
                          <Row
                            key={key}
                            settled={item.judged !== undefined}
                            title={item.title}
                            url={item.url}
                            imageUrl={item.imageUrl}
                            price={item.price}
                            auction={false}
                            meta={[item.sourceName, item.purchasable ? "在售" : "已售出或下架", `看到 ${tokyoDateTime(item.observedAt)}`]}
                            note={<><b data-kind={item.flag.kind}>{aiFlag(item)}</b>{item.aiReason && <span>AI：{item.aiReason}</span>}</>}
                            stacked
                          >
                            <Choice tone="alert" active={item.judged === "ai_correct"} busy={busy.has(key)} onClick={() => judge(item, "ai_correct")}>
                              {fallback ? "不是，撤掉" : "确实不是"}
                            </Choice>
                            <Choice tone="sky" active={item.judged === "ai_wrong"} busy={busy.has(key)} onClick={() => judge(item, "ai_wrong")}>
                              {fallback ? "是，保留" : "其实是"}
                            </Choice>
                          </Row>
                        );
                      })}
                    </DayGroup>
                  ))}
            {aiData && aiData.suggestions.length > 0 && (
              <div className={styles.terms}>
                <h3>建议加进排除词 <span>{aiData.suggestions.length}</span></h3>
                <p>这些词只出现在 AI 拒掉的商品里，已确认商品一件都没有。加进去以后含这个词的商品在 AI 之前就被挡掉，不再花钱判。只加品牌名、别的作品名、人名这类专有词。</p>
                <ol>
                  {aiData.suggestions.map((suggestion) => (
                    <li key={suggestion.term}>
                      <div>
                        <strong>{suggestion.term}</strong>
                        <small>拦下 {suggestion.blockedCount} 件 · 例：{suggestion.examples[0]?.title ?? ""}</small>
                      </div>
                      <button type="button" onClick={() => setPendingTerm(suggestion)}><Plus size={12} aria-hidden="true" />加进排除词</button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}

        {view === "excluded" && (
          <>
            <p className={styles.caption}>
              最近 {data.excludedWindowDays} 天上架、被排除词挡掉没推给你的（还没卖掉的）。不该挡的点「挡错了」，用来收窄那条词。
              标红的是只在说明或店名里命中的，最可能挡错。
            </p>
            {excluded.length === 0
              ? <p className={styles.empty}>最近 {data.excludedWindowDays} 天这个档案没有被排除词挡掉的商品。</p>
              : groupByDay(excluded, (item) => item.listedAt).map(([day, items]) => (
                <DayGroup key={day} label={dayLabel(day)} summary={`${items.length} 件`}>
                  {items.map((item) => {
                    const key = `x\u0000${digestKey(item)}`;
                    return (
                      <Row
                        key={key}
                        settled={item.wanted}
                        title={item.title}
                        url={item.url}
                        imageUrl={item.imageUrl}
                        price={item.price}
                        auction={item.auction}
                        meta={[item.sourceName, `上架 ${tokyoDateTime(item.listedAt)}`]}
                        note={<b data-kind={item.inTitle ? "term_title" : "term_elsewhere"}>被「{item.term}」挡掉{item.inTitle ? "" : "（只在说明或店名里）"}</b>}
                      >
                        <Choice tone="sky" active={item.wanted} busy={busy.has(key)} onClick={() => toggleWanted(item)}>挡错了</Choice>
                      </Row>
                    );
                  })}
                </DayGroup>
              ))}
          </>
        )}
      </section>

      <ConfirmDialog
        open={pendingTerm !== null}
        eyebrow="EXCLUSION RULE"
        title={`把「${pendingTerm?.term ?? ""}」加进排除词？`}
        description={`从下一轮起，标题或描述里含「${pendingTerm?.term ?? ""}」的商品会在 AI 之前直接被挡掉，你不会再看到它们（之后在「排除词挡掉的」里还能翻到）。过去 ${aiData?.windowDays ?? 30} 天里它会拦下 ${pendingTerm?.blockedCount ?? 0} 件 AI 拒掉的商品，没有误伤任何已确认商品。想撤回，到档案里删掉这个词即可。`}
        confirmLabel="加进排除词"
        cancelLabel="先不加"
        busyLabel="正在保存…"
        errorFallback="排除词保存失败，请稍后再试。"
        onCancel={() => setPendingTerm(null)}
        onConfirm={() => pendingTerm ? addExcludeTerm(pendingTerm) : Promise.resolve()}
      />
    </div>
  );
}

function DayGroup({ label, summary, children }: { label: string; summary: string; children: ReactNode }) {
  return (
    <div className={styles.day}>
      <h3>{label}<span>{summary}</span></h3>
      <ol>{children}</ol>
    </div>
  );
}

function Row({ settled, title, url, imageUrl, price, auction, meta, note, stacked = false, children }: {
  settled: boolean;
  title: string;
  url: string | null;
  imageUrl: string | null;
  price: number | null;
  auction: boolean;
  meta: (string | null)[];
  note?: ReactNode;
  /** 两个按钮的行：窄屏时按钮挪到下面一整行。 */
  stacked?: boolean;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className={styles.thumb}>
        {imageUrl ? <Image src={imageUrl} alt="" width={128} height={128} /> : null}
      </span>
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        <span className={styles.price}>
          {auction && <small>拍 </small>}{price === null ? "价格待确认" : formatJpy(price)}
        </span>
        <span className={styles.meta}>{meta.filter(Boolean).join(" · ")}</span>
      </span>
    </>
  );
  return (
    <li className={styles.row} data-settled={settled} data-stacked={stacked}>
      {url
        ? <a className={styles.item} href={url} target="_blank" rel="noopener noreferrer">{body}</a>
        : <div className={styles.item}>{body}</div>}
      {note && <p className={styles.note}>{note}</p>}
      <div className={styles.actions}>{children}</div>
    </li>
  );
}

function Choice({ tone, active, busy, onClick, children }: {
  tone: "alert" | "sky";
  active: boolean;
  busy: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={styles.choice} data-tone={tone} aria-pressed={active} disabled={busy} onClick={onClick}>
      {children}
    </button>
  );
}
