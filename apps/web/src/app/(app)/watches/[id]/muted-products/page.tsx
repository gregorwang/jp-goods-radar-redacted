import { MutedProducts } from "@/components/muted-products";

export default async function MutedProductsPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  /** 从日报邮件「不再推这件」点进来时带着那件商品：`?source=mercari_jp&item=m123…` */
  searchParams: Promise<{ source?: string | string[]; item?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const source = typeof query.source === "string" ? query.source : undefined;
  const item = typeof query.item === "string" ? query.item : undefined;
  return (
    <main className="page-wrap watch-detail-page">
      <MutedProducts profileId={id} sourceId={source} sourceItemId={item} />
    </main>
  );
}
