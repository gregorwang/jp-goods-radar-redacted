"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { AppNotificationCenter, RadarStatusProvider } from "@/components/app-notification-center";
import { GoinnhellirEmblem } from "@/components/goinnhellir-emblem";
import { NavigationSymbol, type NavigationSymbolName } from "@/components/navigation-symbol";
import styles from "@/components/app-shell-brand.module.css";

const navigation = [
  { href: "/dashboard", label: "今日情报", caption: "Overview", slogan: "今日信号与巡回概览", icon: "overview" },
  { href: "/search", label: "跨站搜索", caption: "Search", slogan: "多平台统一即时检索", icon: "search" },
  { href: "/watches", label: "关注档案", caption: "Watches", slogan: "关注不是囤积，管理自动化监控与提醒", icon: "watches" },
  { href: "/listings", label: "商品库", caption: "Archive", slogan: "找到正在等待的商品，再去管理监控。", icon: "archive" },
  { href: "/changes", label: "商品变化", caption: "Changes", slogan: "先选关注档案，再看商品变化事实", icon: "changes" },
  { href: "/inbox", label: "收件箱", caption: "Inbox", slogan: "推给我的、AI 拦下的、排除词挡掉的，一页看完、点一下就标", icon: "labels" },
  { href: "/push", label: "推送", caption: "Push", slogan: "飞书私聊和每个群：开关、各收哪些档案", icon: "push" },
  { href: "/events", label: "通知中心", caption: "Notices", slogan: "规则命中通知与系统异常审计", icon: "signals" },
  { href: "/sources", label: "来源控制台", caption: "Sources", slogan: "平台采集器与接口运行状态", icon: "sources" },
] as const satisfies ReadonlyArray<{
  href: `/${string}`;
  label: string;
  caption: string;
  slogan: string;
  icon: NavigationSymbolName;
}>;

interface AppShellProps {
  children: React.ReactNode;
  initialRailCollapsed?: boolean;
}

export function AppShell({ children, initialRailCollapsed = false }: AppShellProps) {
  const pathname = usePathname();
  const [railCollapsed, setRailCollapsed] = useState(initialRailCollapsed);
  const current = navigation.find((item) => pathname.startsWith(item.href)) ?? navigation[0];

  function toggleRail() {
    const next = !railCollapsed;
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    setRailCollapsed(next);
    document.cookie = `jpgr-rail=${next ? "compact" : "expanded"}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }

  return (
    <RadarStatusProvider>
      <div className="app-shell" data-rail-collapsed={railCollapsed}>
      <aside className="side-rail" id="app-side-rail">
        <Link href="/dashboard" className="rail-brand" aria-label="格银西里尔首页">
          <span className={`rail-brand-mark ${styles.brandMark}`}><GoinnhellirEmblem /></span>
          <span className={`rail-brand-copy ${styles.brandCopy}`}>
            <strong className={styles.brandName}>格银西里尔</strong>
          </span>
        </Link>
        <nav id="app-primary-navigation" className="rail-nav" aria-label="主导航">
          {navigation.map(({ href, label, caption, icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link key={href} href={href as Route} className="rail-link" data-active={active} data-tooltip={label} aria-current={active ? "page" : undefined}>
                <span className="rail-icon"><NavigationSymbol name={icon} /></span>
                <span className="rail-label"><strong>{label}</strong><small>{caption}</small></span>
              </Link>
            );
          })}
        </nav>
        <div className="rail-foot">
          <span className="live-dot" aria-hidden="true" />
          <span className="rail-foot-copy"><strong>Radar online</strong><small>按档案频率更新</small></span>
        </div>
      </aside>
      <button
        type="button"
        className="rail-collapse"
        aria-controls="app-side-rail"
        aria-expanded={!railCollapsed}
        aria-label={railCollapsed ? "展开侧边栏" : "收起侧边栏"}
        title={railCollapsed ? "展开侧边栏" : "收起侧边栏"}
        onClick={toggleRail}
      >
        <PanelLeftClose className="rail-collapse-expanded-icon" aria-hidden="true" size={17} strokeWidth={1.4} />
        <PanelLeftOpen className="rail-collapse-compact-icon" aria-hidden="true" size={17} strokeWidth={1.4} />
      </button>
        <div className="app-main">
          <header className="topline">
            <div className="topline-left">
              <p className="topline-route"><span>{current.caption}</span> / {current.label}</p>
              {current.slogan && <span className="topline-slogan">{current.slogan}</span>}
            </div>
            <div className="topline-actions">
              <AppNotificationCenter />
            </div>
          </header>
          {children}
        </div>
      </div>
    </RadarStatusProvider>
  );
}
