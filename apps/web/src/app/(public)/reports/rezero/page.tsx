import type { Metadata } from "next";
import { RezeroResaleBrowser, type RezeroData } from "@/components/rezero-resale-browser";
import rezeroData from "@/data/rezero-resale-2026-09-16.json";

export const metadata: Metadata = {
  title: "Re:Zero 再贩档案",
  description: "检索 234 件《Re:从零开始的异世界生活》商品的首发、再贩、再受注与价格变化记录，并直达原始商品页。",
  keywords: ["Re:Zero", "Re:从零开始的异世界生活", "再贩", "手办", "周边", "商品档案"],
  openGraph: {
    title: "Re:Zero 再贩档案",
    description: "234 件商品的首发、再贩、再受注与价格变化记录。",
    type: "website",
  },
};

export default function RezeroResalePage() {
  const data = rezeroData as RezeroData;
  return (
    <main>
      <header className="rezero-report-hero">
        <nav className="rezero-report-nav" aria-label="页面导航">
          <span className="rezero-report-brand">格银西里尔</span>
          <span>RE:ZERO / ARCHIVE</span>
        </nav>
        <div className="rezero-report-hero-copy">
          <p className="eyebrow">PUBLIC RESEARCH / 2026.09.16</p>
          <h1><span>Re:Zero</span> 再贩档案</h1>
          <p>从 4,508 个商品家族中整理出的 234 条重复发行记录。搜索角色、品类、厂商或商品编号，查看每次发行的月份与定价，并直接前往原始商品页。</p>
        </div>
        <dl className="rezero-report-stats">
          <div><dt>收录记录</dt><dd>{data.items.length}</dd></div>
          <div><dt>明确再贩证据</dt><dd>{data.summary.n_confirmed}</dd></div>
          <div><dt>最多重复发行</dt><dd>{data.summary.max_times}<small>次</small></dd></div>
          <div><dt>完整目录基数</dt><dd>{new Intl.NumberFormat("zh-CN").format(data.summary.n_families)}</dd></div>
        </dl>
      </header>
      <RezeroResaleBrowser data={data} />
      <footer className="rezero-report-footer">
        <p>这是研究档案，不是实时库存页。价格为公开页面记录的日元含税定价；库存、售价与商品状态请以跳转后的原始页面为准。</p>
        <p>数据快照：2026-09-16 · 商品链接分别指向 AmiAmi 与 KADOKAWA STORE。</p>
      </footer>
    </main>
  );
}
