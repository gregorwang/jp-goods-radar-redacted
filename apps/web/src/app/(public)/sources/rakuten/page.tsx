import type { Metadata } from "next";
import Link from "next/link";
import { PublicRakutenResults, type PublicGroup } from "@/components/public-rakuten-results";
import { getEnv } from "@/lib/cloudflare";

export const metadata: Metadata = {
  title: "Rakuten 公开检索｜格银西里尔",
  description: "由格银西里尔独立运行的 Rakuten Web Service 公开只读检索页。",
};

// 该页的边缘缓存由响应头 `public, s-maxage=3600`（见 next.config.ts）与 Worker 的
// cache.enabled 共同提供，Collector 侧另有一小时缓存。这里不用 ISR：OpenNext 未配置
// incrementalCache，`revalidate` 会是空操作，写了反而误导。
async function loadGroups(): Promise<{ groups: PublicGroup[]; error: string }> {
  try {
    const response = await getEnv().COLLECTOR.fetch("http://collector/internal/public-rakuten-preview");
    if (!response.ok) return { groups: [], error: "Rakuten 公开数据暂时不可用" };
    const body = await response.json() as { groups?: PublicGroup[] };
    return { groups: body.groups ?? [], error: "" };
  } catch {
    return { groups: [], error: "Rakuten 公开数据暂时不可用" };
  }
}

export default async function PublicRakutenPage() {
  const { groups, error } = await loadGroups();
  return <main className="public-source-page">
    <header className="public-source-hero"><p className="eyebrow">PUBLIC SOURCE / RAKUTEN</p><h1>楽天の公開検索。</h1><p>本页由“格银西里尔”独立开发与运营，并非 Rakuten 官方网站、合作伙伴声明或客服渠道。商品信息与链接来自 Rakuten Web Service，结果按来源独立展示。</p><Link className="ghost-button button-link" href="/">返回管理站</Link></header>
    <PublicRakutenResults groups={groups} error={error} />
    <footer className="public-source-foot">固定关键词的只读展示每小时最多刷新一次；不开放任意查询，以控制 API 配额与滥用风险。商品详情、价格与库存以 Rakuten 页面为准。</footer>
  </main>;
}
