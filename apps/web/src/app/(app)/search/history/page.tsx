import { SearchHistoryBrowser } from "@/components/search-history-browser";
import { SearchRouteNav } from "@/components/search-route-nav";

export default function SearchHistoryPage() {
  return (
    <main className="page-wrap search-history-page">
      <SearchRouteNav active="history" />
      <SearchHistoryBrowser />
    </main>
  );
}
