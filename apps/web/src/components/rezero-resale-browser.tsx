"use client";

import { ArrowUpRight, Check, Copy, Search, Share2, X } from "lucide-react";
import { type CSSProperties, useDeferredValue, useMemo, useState } from "react";
import styles from "./rezero-resale-browser.module.css";

interface RezeroEvent {
  month: string;
  teika: number | null;
  kind: string;
  order_end: string | null;
  label_kinds: string[];
}

interface RezeroComparison {
  from: number;
  to: number;
  pct: number;
  ex_tax_pct: number;
  tax_changed: boolean;
  gap_months: number;
  direction: "up" | "down" | "flat";
}

interface RezeroItem {
  fid: string;
  title: string;
  url: string;
  image: string;
  maker: string;
  l2_cn: string;
  l3_cn: string;
  group: string;
  chars: string[];
  sources: string[];
  events: RezeroEvent[];
  first_month: string;
  first_teika: number | null;
  confidence: "high" | "label_only" | "medium";
  resale_times: number;
  cmp: RezeroComparison | null;
  label_kinds: string[];
  search: string;
  sprite_x: number;
  sprite_y: number;
  sprite_size: number;
  sprite_cols: number;
}

export interface RezeroData {
  summary: { n_families: number; n_confirmed: number; max_times: number };
  items: RezeroItem[];
}

type SortKey = "recent" | "resales" | "rise" | "oldest";
const PAGE_SIZE = 24;

function formatJpy(value: number | null | undefined) {
  return value == null ? "价格未记录" : `¥${new Intl.NumberFormat("ja-JP").format(value)}`;
}

function monthLabel(month: string) {
  const [year, value] = month.split("-");
  return `${year}.${value}`;
}

function spritePath(item: RezeroItem) {
  const filename = item.image.split("/").pop() ?? "sprite-0.webp";
  return `/reports/rezero/assets/${filename}`;
}

function latestEvent(item: RezeroItem) {
  return item.events[item.events.length - 1];
}

function copyFallback(value: string) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

export function RezeroResaleBrowser({ data }: { data: RezeroData }) {
  const [query, setQuery] = useState("");
  const [confidence, setConfidence] = useState("all");
  const [source, setSource] = useState("all");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [copiedId, setCopiedId] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());

  const categories = useMemo(
    () => Array.from(new Set(data.items.map((item) => item.group))).sort((a, b) => a.localeCompare(b, "zh-CN")),
    [data.items],
  );

  const filtered = useMemo(() => {
    const items = data.items.filter((item) => {
      if (deferredQuery && !item.search.toLocaleLowerCase().includes(deferredQuery)) return false;
      if (confidence !== "all" && item.confidence !== confidence) return false;
      if (source !== "all" && !item.sources.includes(source)) return false;
      return category === "all" || item.group === category;
    });

    return items.sort((a, b) => {
      if (sort === "resales") return b.resale_times - a.resale_times || latestEvent(b).month.localeCompare(latestEvent(a).month);
      if (sort === "rise") return (b.cmp?.pct ?? -Infinity) - (a.cmp?.pct ?? -Infinity);
      if (sort === "oldest") return a.first_month.localeCompare(b.first_month);
      return latestEvent(b).month.localeCompare(latestEvent(a).month);
    });
  }, [category, confidence, data.items, deferredQuery, sort, source]);

  function resetPage() { setVisible(PAGE_SIZE); }

  async function copyUrl(item: RezeroItem) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(item.url);
      else if (!copyFallback(item.url)) throw new Error("copy failed");
      setCopiedId(item.fid);
      window.setTimeout(() => setCopiedId((current) => current === item.fid ? "" : current), 1800);
    } catch {
      window.prompt("复制这个商品链接", item.url);
    }
  }

  async function shareItem(item: RezeroItem) {
    if (!navigator.share) {
      await copyUrl(item);
      return;
    }
    try {
      await navigator.share({ title: item.title, text: `${item.title}｜Re:Zero 再贩档案`, url: item.url });
    } catch {
      // 用户主动取消系统分享面板时无需提示。
    }
  }

  return (
    <section className={styles.browser} aria-label="商品检索">
      <div className={styles.toolbar}>
        <label className={styles.searchBox}>
          <Search aria-hidden="true" size={18} />
          <span className="sr-only">搜索商品</span>
          <input value={query} onChange={(event) => { setQuery(event.target.value); resetPage(); }} placeholder="搜索角色、商品名、厂商、编号…" type="search" />
          {query && <button type="button" onClick={() => { setQuery(""); resetPage(); }} aria-label="清空搜索"><X size={17} /></button>}
        </label>

        <div className={styles.selectGrid}>
          <label><span>证据等级</span><select value={confidence} onChange={(event) => { setConfidence(event.target.value); resetPage(); }}><option value="all">全部证据</option><option value="high">多源 / 强证据</option><option value="label_only">明确再贩标记</option><option value="medium">重复上架</option></select></label>
          <label><span>商品来源</span><select value={source} onChange={(event) => { setSource(event.target.value); resetPage(); }}><option value="all">全部来源</option><option value="amiami">AmiAmi</option><option value="kadokawa">KADOKAWA</option></select></label>
          <label><span>商品品类</span><select value={category} onChange={(event) => { setCategory(event.target.value); resetPage(); }}><option value="all">全部品类</option>{categories.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>排序方式</span><select value={sort} onChange={(event) => { setSort(event.target.value as SortKey); resetPage(); }}><option value="recent">最近出现</option><option value="resales">重复次数</option><option value="rise">涨幅最高</option><option value="oldest">最早首发</option></select></label>
        </div>
      </div>

      <div className={styles.resultBar} aria-live="polite">
        <p><strong>{filtered.length}</strong> 件符合条件</p>
        <p>已显示 {Math.min(visible, filtered.length)} / {filtered.length}</p>
      </div>

      {filtered.length > 0 ? (
        <div className={styles.grid}>
          {filtered.slice(0, visible).map((item, index) => {
            const latest = latestEvent(item);
            const spriteStyle = {
              "--sprite-image": `url(\"${spritePath(item)}\")`,
              "--sprite-col": item.sprite_x / item.sprite_size,
              "--sprite-row": item.sprite_y / item.sprite_size,
              "--sprite-cols": item.sprite_cols,
            } as CSSProperties;

            return (
              <article className={styles.card} key={item.fid}>
                <div className={styles.sequence}>{String(index + 1).padStart(3, "0")}</div>
                <div className={styles.productImage} style={spriteStyle} role="img" aria-label={`${item.title} 商品图`} />
                <div className={styles.cardInfo}>
                  <div className={styles.kicker}><span>{item.group}</span><span className={item.confidence === "medium" ? styles.observed : styles.confirmed}>{item.confidence === "high" ? "多源 / 强证据" : item.confidence === "label_only" ? "明确再贩标记" : "重复上架"}</span></div>
                  <h2>{item.title}</h2>
                  <p className={styles.maker}>{item.maker || "厂商未记录"} · {item.fid}</p>
                  {item.chars.length > 0 && <p className={styles.characters}>{item.chars.join(" / ")}</p>}
                </div>
                <dl className={styles.metrics}>
                    <div><dt>最近记录</dt><dd>{monthLabel(latest.month)}</dd></div>
                    <div><dt>最近定价</dt><dd>{formatJpy(latest.teika)}</dd></div>
                    <div><dt>重复发行</dt><dd>{item.resale_times} 次</dd></div>
                    <div><dt>首发后变动</dt><dd className={item.cmp?.direction === "up" ? styles.rise : undefined}>{item.cmp ? `${item.cmp.pct > 0 ? "+" : ""}${item.cmp.pct.toFixed(1)}%` : "—"}</dd></div>
                </dl>
                <details className={styles.timeline}>
                    <summary>查看 {item.events.length} 条发行记录</summary>
                    <ol>{item.events.map((event, eventIndex) => <li key={`${event.month}-${eventIndex}`}><time>{monthLabel(event.month)}</time><span>{event.kind}</span><strong>{formatJpy(event.teika)}</strong>{event.order_end && <small>受注截止 {event.order_end}</small>}</li>)}</ol>
                </details>
                <div className={styles.actions}>
                    <a href={item.url} target="_blank" rel="noopener noreferrer">打开商品页 <ArrowUpRight size={16} aria-hidden="true" /></a>
                    <button type="button" onClick={() => copyUrl(item)}>{copiedId === item.fid ? <Check size={16} /> : <Copy size={16} />} {copiedId === item.fid ? "已复制" : "复制链接"}</button>
                    <button type="button" onClick={() => shareItem(item)}><Share2 size={16} /> 分享</button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className={styles.empty}><p>没有找到对应商品。</p><button type="button" onClick={() => { setQuery(""); setConfidence("all"); setSource("all"); setCategory("all"); resetPage(); }}>清除筛选</button></div>
      )}
      {visible < filtered.length && <button className={styles.loadMore} type="button" onClick={() => setVisible((value) => value + PAGE_SIZE)}>继续加载 <span>+{Math.min(PAGE_SIZE, filtered.length - visible)}</span></button>}
    </section>
  );
}
