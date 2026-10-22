import Link from "next/link";
import type { Route } from "next";

export function SearchRouteNav({ active }: { active: "search" | "history" }) {
  return (
    <nav className="search-route-nav" aria-label="跨站搜索页面">
      <Link href="/search" aria-current={active === "search" ? "page" : undefined} data-active={active === "search"}>
        <span>01</span><strong>新搜索</strong><small>Search</small>
      </Link>
      <Link href={"/search/history" as Route} aria-current={active === "history" ? "page" : undefined} data-active={active === "history"}>
        <span>02</span><strong>搜索记录</strong><small>Runs & evidence</small>
      </Link>
    </nav>
  );
}
