import { SearchRouteNav } from "@/components/search-route-nav";
import { SearchStudio } from "@/components/search-studio";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{
  historyId?: string | string[];
  seedQuery?: string | string[];
  referenceUrl?: string | string[];
}> }) {
  const parameters = await searchParams;
  const initialHistoryId = typeof parameters.historyId === "string" ? parameters.historyId : undefined;
  const initialSeedQuery = typeof parameters.seedQuery === "string" ? parameters.seedQuery.slice(0, 200) : undefined;
  const initialReferenceUrl = typeof parameters.referenceUrl === "string" ? parameters.referenceUrl.slice(0, 2_000) : undefined;
  return (
    <main className="page-wrap search-page">
      <SearchRouteNav active="search" />
      <SearchStudio initialHistoryId={initialHistoryId} initialSeedQuery={initialSeedQuery} initialReferenceUrl={initialReferenceUrl} />
    </main>
  );
}
