import Image from "next/image";
import { formatJpy } from "@jpgr/core";
import { RakutenCredit } from "@/components/rakuten-credit";

export interface PublicListing {
  sourceId: "rakuten_ichiba" | "rakuten_books";
  sourceItemId: string;
  canonicalUrl: string;
  title: string;
  imageUrl?: string;
  shopName?: string;
  currency: string;
  currentPrice?: number;
  condition: string;
  availability: string;
}

export interface PublicGroup {
  sourceId: "rakuten_ichiba" | "rakuten_books";
  status: "success" | "failed";
  listings: PublicListing[];
  coverage?: string;
  error?: string;
}

/**
 * 服务端渲染。这是一个公开只读页，数据在服务端取好随 HTML 一起返回，
 * 才能真正命中边缘缓存；此前用 useEffect 取数据意味着每个匿名访客都要
 * 唤醒 Worker 两次，且首屏无内容可供检索收录。
 */
export function PublicRakutenResults({ groups, error }: { groups: PublicGroup[]; error: string }) {
  if (error) return <div className="empty-state"><p>{error}</p></div>;

  return <div className="public-source-stack">{groups.map((group) => <section className="source-result-group" key={group.sourceId}>
    <div className="source-result-heading"><div><p className="eyebrow">{group.sourceId}</p><h2>{group.sourceId === "rakuten_ichiba" ? "楽天市場" : "楽天ブックス"}</h2></div><span className={`status-pill ${group.status === "success" ? "good" : "warn"}`}>{group.status === "success" ? `${group.listings.length} ITEMS` : "UNAVAILABLE"}</span></div>
    {group.status === "success" && group.listings.length > 0 ? <>
      <RakutenCredit />
      <div className="product-grid">{group.listings.map((item) => <article className="product-card" key={item.sourceItemId}>
        <a href={item.canonicalUrl} target="_blank" rel="noreferrer">
          {item.imageUrl ? <Image className="product-image" src={item.imageUrl} alt="" width={800} height={600}/> : <div className="product-image"/>}
          <span className="product-source">{item.shopName || item.sourceId} · {item.availability}</span>
          <h3 className="product-title">{item.title}</h3>
          <strong className="product-price">{formatJpy(item.currentPrice)}</strong>
        </a>
      </article>)}</div>
    </> : <p className="muted-copy">{group.error || "当前没有公开结果。"}</p>}
  </section>)}</div>;
}
