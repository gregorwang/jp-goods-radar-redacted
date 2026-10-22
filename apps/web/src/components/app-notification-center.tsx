"use client";

import Link from "next/link";
import type { Route } from "next";
import {
  CheckCircle2,
  CircleAlert,
  RefreshCw,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch } from "@/lib/client-api";
import { tokyoDateTime } from "@/lib/format-time";

export interface DashboardSummary {
  activeWatches: number;
  activeSources: number;
  todaySearches: number;
  todayNewListings: number;
  todayPriceDrops: number;
  todayEmails: number;
  failingSources: number;
  emailProtectionTriggered: boolean;
}

export interface DashboardEvent {
  id: string;
  type: string;
  title: string;
  meta: string;
  createdAt: string;
  status: string;
}

export interface DashboardPayload {
  summary: DashboardSummary;
  recentEvents: DashboardEvent[];
}

type RadarLoadState = "loading" | "loaded" | "error";

interface RadarStatusContextValue {
  data: DashboardPayload;
  loadState: RadarLoadState;
  refreshing: boolean;
  error: string;
  lastUpdatedAt: Date | null;
  newEvents: DashboardEvent[];
  unreadCount: number;
  refresh: () => Promise<void>;
  markNotificationsRead: () => void;
}

const emptyData: DashboardPayload = {
  summary: {
    activeWatches: 0,
    activeSources: 0,
    todaySearches: 0,
    todayNewListings: 0,
    todayPriceDrops: 0,
    todayEmails: 0,
    failingSources: 0,
    emailProtectionTriggered: false,
  },
  recentEvents: [],
};

const RadarStatusContext = createContext<RadarStatusContextValue | null>(null);
const POLL_INTERVAL_MS = 60_000;
const LAST_SEEN_EVENT_KEY = "jpgr:last-seen-notification-event";

export function dashboardEventLabel(type: string): string {
  const labels: Record<string, string> = {
    new_listing: "新上架",
    price_drop: "降价",
    price_rise: "涨价",
    target_price: "到达目标价",
    restock: "重新到货",
    sold_out: "售罄",
    source_error: "来源异常",
    daily_digest: "每日摘要",
    watch_completed: "监控完成",
    morning_digest: "早间摘要",
    weekly_market_digest: "每周市场总结",
  };
  return labels[type] ?? "状态变化";
}

export function RadarStatusProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DashboardPayload>(emptyData);
  const [loadState, setLoadState] = useState<RadarLoadState>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [newEvents, setNewEvents] = useState<DashboardEvent[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const knownEventIds = useRef<Set<string> | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const loadedOnce = useRef(false);

  const refresh = useCallback(async () => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    if (loadedOnce.current) setRefreshing(true);
    else setLoadState("loading");
    setError("");

    try {
      const body = await apiFetch<DashboardPayload>("/api/dashboard", { signal: controller.signal });
      if (controller.signal.aborted) return;
      const previousIds = knownEventIds.current;
      const lastSeenEventId = window.localStorage.getItem(LAST_SEEN_EVENT_KEY);
      const lastSeenIndex = lastSeenEventId
        ? body.recentEvents.findIndex((event) => event.id === lastSeenEventId)
        : -1;
      const arrivals = previousIds
        ? body.recentEvents.filter((event) => !previousIds.has(event.id))
        : lastSeenEventId && lastSeenIndex >= 0
          ? body.recentEvents.slice(0, lastSeenIndex)
          : body.recentEvents;
      if (arrivals.length > 0) {
        setNewEvents((current) => [
          ...arrivals,
          ...current.filter((event) => !arrivals.some((arrival) => arrival.id === event.id)),
        ].slice(0, 8));
        setUnreadCount((current) => Math.min(99, current + arrivals.length));
      }
      knownEventIds.current = new Set(body.recentEvents.map((event) => event.id));
      loadedOnce.current = true;
      setData(body);
      setLastUpdatedAt(new Date());
      setLoadState("loaded");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "暂时无法读取最新数据");
      setLoadState("error");
    } finally {
      if (activeController.current === controller) {
        activeController.current = null;
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
      activeController.current?.abort();
    };
  }, [refresh]);

  const value = useMemo<RadarStatusContextValue>(() => ({
    data,
    loadState,
    refreshing,
    error,
    lastUpdatedAt,
    newEvents,
    unreadCount,
    refresh,
    markNotificationsRead: () => {
      const latestEventId = data.recentEvents[0]?.id;
      if (latestEventId) window.localStorage.setItem(LAST_SEEN_EVENT_KEY, latestEventId);
      setUnreadCount(0);
      setNewEvents([]);
    },
  }), [data, error, lastUpdatedAt, loadState, newEvents, refresh, refreshing, unreadCount]);

  return <RadarStatusContext.Provider value={value}>{children}</RadarStatusContext.Provider>;
}

export function useRadarStatus(): RadarStatusContextValue {
  const value = useContext(RadarStatusContext);
  if (!value) throw new Error("RadarStatusProvider is missing");
  return value;
}

const notificationTime = tokyoDateTime;

function SpiritDeerBeacon({ isRunning, unreadCount, state }: { isRunning: boolean; unreadCount: number; state: RadarLoadState }) {
  return (
    <div className={`deer-beacon ${isRunning || unreadCount > 0 ? "is-running" : ""}`}>
      <svg
        className="deer-svg"
        viewBox="0 0 32 32"
        width="24"
        height="24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* 雄伟分叉鹿角 */}
        <path d="M12 5.5c-1.8-2.5-4.2-3.5-7-3m5 2.2c-1.6-.8-3.2-.8-4.8.6m7.8 1.2c1.8-2.5 4.2-3.5 7-3m-5 2.2c1.6-.8 3.2-.8 4.8.6" strokeWidth="1.6" />
        {/* 鹿头与鹿耳 */}
        <path d="M13.8 7.5c-.8 0-1.5.8-1.5 1.8 0 1.2.6 2.2 1.5 2.7l-.8 3.5c1.6 1 3.4 1 5 0l-.8-3.5c.9-.5 1.5-1.5 1.5-2.7 0-1-.7-1.8-1.5-1.8h-3.4z" fill="currentColor" strokeWidth="0.6" />
        {/* 飞跃身躯与前后四肢 */}
        <path className="deer-body" d="M15 15.5c3.6 1.6 8.2 1 11.2-1.5 1.4-1.2 1.8-2.8 1.4-4.5" strokeWidth="1.8" />
        <path className="deer-leg-front" d="M14 16.5l-3.5 7.5m-1.5-2.5l3.5 3" strokeWidth="1.8" />
        <path className="deer-leg-back" d="M23 15l4 8.5m1.5-3l-3.5 3.5" strokeWidth="1.8" />
        {/* 额间神光 */}
        <circle cx="15.5" cy="10" r="0.75" fill="var(--paper-bright)" stroke="none" />
      </svg>
      {unreadCount > 0 && <span className="deer-badge">{unreadCount}</span>}
      {state === "error" && <span className="deer-dot-error" aria-label="雷达数据读取失败" />}
    </div>
  );
}

export function AppNotificationCenter() {
  const {
    data,
    loadState,
    refreshing,
    error,
    lastUpdatedAt,
    newEvents,
    unreadCount,
    refresh,
    markNotificationsRead,
  } = useRadarStatus();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.removeAttribute("open");
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !detailsRef.current?.open) return;
      detailsRef.current.removeAttribute("open");
      summaryRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const firstLoad = loadState === "loading" && !lastUpdatedAt;
  const statusTitle = firstLoad
    ? "正在同步"
    : loadState === "error"
      ? "数据待重试"
      : unreadCount > 0
        ? `${unreadCount} 条新变化`
        : "雷达动态";
  const events = newEvents.length > 0 ? newEvents : data.recentEvents.slice(0, 5);

  return (
    <details
      ref={detailsRef}
      className="app-notification-center"
    >
      <summary
        ref={summaryRef}
        className="notification-center-summary deer-summary-round"
        data-state={loadState}
        data-unread={unreadCount > 0}
        aria-label={`信息通知：${statusTitle}`}
        title={`雷达动态通知${unreadCount > 0 ? ` (${unreadCount} 条新变化)` : ""}`}
      >
        <SpiritDeerBeacon isRunning={refreshing || unreadCount > 0} unreadCount={unreadCount} state={loadState} />
      </summary>

      <div className="notification-center-panel">
        <header>
          <div><p>信息通知</p><h2>雷达动态</h2></div>
          {unreadCount > 0
            ? <button type="button" onClick={markNotificationsRead}>{unreadCount} 条未读 · 标记已读</button>
            : <span>已同步</span>}
        </header>

        <div className="notification-center-state" data-state={loadState}>
          {firstLoad
            ? <RefreshCw className="notification-center-spinner" size={18} aria-hidden="true" />
            : loadState === "error"
              ? <CircleAlert size={18} aria-hidden="true" />
              : <CheckCircle2 size={18} aria-hidden="true" />}
          <div>
            <strong>{statusTitle}</strong>
            <p>{firstLoad
              ? "正在读取今日统计和最近变化，完成后首页会使用同一份结果。"
              : loadState === "error"
                ? error
                : `今日新发现 ${data.summary.todayNewListings} 件，价格变化 ${data.summary.todayPriceDrops} 次，通知送达 ${data.summary.todayEmails} 封。`}</p>
          </div>
          {loadState === "error" && <button type="button" onClick={() => void refresh()}><RefreshCw size={13} aria-hidden="true" />重新读取</button>}
        </div>

        <section className="notification-center-events" aria-labelledby="notification-events-heading">
          <div><h3 id="notification-events-heading">{newEvents.length > 0 ? "本次新变化" : "最近变化"}</h3><span>{events.length}</span></div>
          {events.length > 0 ? (
            <ol>
              {events.map((event) => (
                <li key={event.id}>
                  <span data-type={event.type}>{dashboardEventLabel(event.type)}</span>
                  <div><strong>{event.title}</strong><small>{event.meta} · {notificationTime(event.createdAt)}</small></div>
                </li>
              ))}
            </ol>
          ) : <p className="notification-center-empty">当前没有新的商品变化。</p>}
        </section>

        <footer>
          <Link href={"/changes" as Route} onClick={() => detailsRef.current?.removeAttribute("open")}>打开商品变化</Link>
        </footer>
      </div>
    </details>
  );
}
