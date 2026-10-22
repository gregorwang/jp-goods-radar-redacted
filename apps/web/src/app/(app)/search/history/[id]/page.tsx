import { PageHero } from "@/components/page-hero";
import { SearchRouteNav } from "@/components/search-route-nav";
import { SearchRunDetail } from "@/components/search-run-detail";

export default async function SearchRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="page-wrap">
      <PageHero eyebrow="SEARCH RUN" title="一次运行，" soft="把来源响应说清楚。" copy="本页只展示查询计划、来源状态、分页覆盖和原始响应；商品身份、价格与关注操作仍留在搜索结果页。" note="这是运行证据，不是商品列表。" />
      <SearchRouteNav active="history" />
      <SearchRunDetail id={id} />
    </main>
  );
}
