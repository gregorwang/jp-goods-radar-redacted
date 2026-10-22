"use client";

import Link from "next/link";
import type { Route } from "next";
import {
  ArrowUpRight,
  BellRing,
  CircleAlert,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useRadarStatus } from "@/components/app-notification-center";
import { tokyoDateTime } from "@/lib/format-time";

const tokyoDay = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});

const tokyoDateStamp = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function briefingHeadline(newListings: number, failingSources: number, loading: boolean): readonly [string, string?] {
  if (loading) return ["正在汇总，", "今日雷达信号。"];
  if (newListings > 0 && failingSources > 0) {
    return [`今日发现 ${newListings} 件新品，`, `${failingSources} 个来源待检查。`];
  }
  if (newListings > 0) return ["今日新发现，", `${newListings} 件新品。`];
  if (failingSources > 0) return ["今日无新品，", `${failingSources} 个来源待检查。`];
  return ["今日平静，", "雷达仍巡回。"];
}

export function DashboardView() {
  const { data, loadState, error, lastUpdatedAt } = useRadarStatus();
  const loading = loadState === "loading" || (loadState === "error" && !lastUpdatedAt);
  const summary = data.summary;
  const now = new Date();
  const [headlineLead, headlineDetail] = briefingHeadline(
    summary.todayNewListings,
    summary.failingSources,
    loading,
  );
  const dailyLedger = [
    {
      index: "01",
      label: "新商品",
      value: summary.todayNewListings,
      note: "首次进入监控视野",
    },
    {
      index: "02",
      label: "检索执行",
      value: summary.todaySearches,
      note: "手动与定时检索合计",
    },
    {
      index: "03",
      label: "降价 / 到价",
      value: summary.todayPriceDrops,
      note: "满足价格变化条件",
    },
    {
      index: "04",
      label: "邮件送达",
      value: summary.todayEmails,
      note: "今日成功发出的通知",
    },
  ] as const;

  const protectionState = summary.emailProtectionTriggered
    ? "今日已有事件进入合并保护"
    : "今日未触发合并保护";

  return (
    <div className="dashboard-briefing">
      {error && (
        <div className="dashboard-data-warning" role="status">
          <CircleAlert size={17} aria-hidden="true" />
          <p>{error}，页面正在保留上一次成功读取的结果。</p>
        </div>
      )}

      <section className="dashboard-masthead reveal reveal-delay-1" aria-labelledby="dashboard-title">
        <header className="dashboard-masthead-top">
          <p>DAILY INTELLIGENCE / JST</p>
          <time dateTime={tokyoDateStamp.format(now)}>{tokyoDay.format(now)}</time>
        </header>

        <div className="dashboard-masthead-body">
          <div className="dashboard-intro">
            <p className="eyebrow">今日情报</p>
            <h1 id="dashboard-title">
              <span>{headlineLead}</span>
              {headlineDetail && <span>{headlineDetail}</span>}
            </h1>
            <p className="dashboard-intro-note">
              {loading
                ? "正在读取检索、变化与通知记录。"
                : `今天已执行 ${summary.todaySearches} 次检索，成功送达 ${summary.todayEmails} 封通知。`}
            </p>
          </div>

          <div className="dashboard-hero-number" aria-label={`今日新发现 ${loading ? "读取中" : summary.todayNewListings} 件`}>
            <span>NEW / TODAY</span>
            <strong>{loading ? "—" : summary.todayNewListings}</strong>
            <p>件新发现</p>
          </div>
        </div>

        <footer className="dashboard-masthead-actions">
          <Link href={"/changes" as Route}>
            <span>打开商品变化</span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
          <Link href="/search">
            <span>开始跨站检索</span>
            <Search size={16} aria-hidden="true" />
          </Link>
          <p data-state={loadState}>
            <span aria-hidden="true" />
            {lastUpdatedAt ? `${tokyoDateTime(lastUpdatedAt)} 更新` : "等待首次同步"}
          </p>
        </footer>
      </section>

      <section className="dashboard-ledger reveal reveal-delay-2" aria-labelledby="dashboard-ledger-title">
        <header>
          <div>
            <p className="eyebrow">TODAY&apos;S LEDGER</p>
            <h2 id="dashboard-ledger-title">今日信号账本</h2>
          </div>
          <p>全部按东京时间自然日统计</p>
        </header>
        <div className="dashboard-ledger-grid">
          {dailyLedger.map((item) => (
            <article key={item.index}>
              <span>{item.index}</span>
              <p>{item.label}</p>
              <strong>{loading ? "—" : item.value}</strong>
              <small>{item.note}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="dashboard-operations reveal reveal-delay-2" aria-label="雷达运行状态">
        <article className="dashboard-radar-state">
          <header>
            <p className="eyebrow">RADAR STATUS</p>
            <h2>雷达正在怎样工作</h2>
          </header>
          <dl>
            <div>
              <dt>正在关注</dt>
              <dd>{loading ? "—" : summary.activeWatches}</dd>
              <small>个启用的监控档案</small>
            </div>
            <div>
              <dt>启用来源</dt>
              <dd>{loading ? "—" : summary.activeSources}</dd>
              <small>个市场入口参与巡回</small>
            </div>
            <div data-alert={summary.failingSources > 0}>
              <dt>不稳定来源</dt>
              <dd>{loading ? "—" : summary.failingSources}</dd>
              <small>{summary.failingSources > 0 ? "需要到来源页查看" : "当前没有来源告警"}</small>
            </div>
          </dl>
          <div className="dashboard-state-links">
            <Link href="/watches">查看全部监控 <ArrowUpRight size={14} aria-hidden="true" /></Link>
            <Link href="/sources">检查来源状态 <ArrowUpRight size={14} aria-hidden="true" /></Link>
          </div>
        </article>

        <article className="dashboard-automation">
          <header>
            <div>
              <p className="eyebrow">AUTOMATIC GUARDRAILS</p>
              <h2>已经在后台生效的守护</h2>
            </div>
            <ShieldCheck size={24} strokeWidth={1.35} aria-hidden="true" />
          </header>
          <div className="dashboard-automation-list">
            <Link href="/watches" aria-label="在监控页查看自动结束的监控">
              <span className="dashboard-automation-icon"><ShieldCheck size={18} aria-hidden="true" /></span>
              <span>
                <strong>终局商品自动结束</strong>
                <small>一次性挂牌连续 7 天保持终局状态后，保留历史并停止空转。</small>
              </span>
              <em>7 天</em>
              <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
            <Link href="/events" aria-label="在通知中心中查看通知节流保护">
              <span className="dashboard-automation-icon"><BellRing size={18} aria-hidden="true" /></span>
              <span>
                <strong>通知节流保护</strong>
                <small>高频变化会进入合并摘要，避免重复邮件淹没真正重要的信号。</small>
              </span>
              <em data-alert={summary.emailProtectionTriggered}>{loading ? "读取中" : protectionState}</em>
              <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </article>
      </section>
    </div>
  );
}
