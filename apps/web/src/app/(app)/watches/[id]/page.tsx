import { WatchDetail } from "@/components/watch-detail";

export default async function WatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="page-wrap watch-detail-page">
      <WatchDetail id={id} />
    </main>
  );
}
