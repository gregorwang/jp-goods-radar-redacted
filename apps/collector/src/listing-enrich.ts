/**
 * 关键词日报的补充信息：发信前把这一封里的商品整批交给 teika-lookup 的 `/enrich`，
 * 拿回「这是什么 / 原价 / 二手行情 / 一句话结论」，原样挂到每件商品上。
 *
 * 口径全部在提供方算（jp-market-databricks/docs/ENRICH_API_FOR_JPGR.md），
 * 这里只做三件事：组请求、调用、把整段结果带回来。不在本侧算定価、行情或结论。
 *
 * 失败绝不能挡住发信：key 没配、接口超时、返回异常，一律返回 failed，
 * 邮件照旧样子发出去。
 */
import { readListingSemanticsByItem } from "@jpgr/analytics";
import { sameProductTitle, verifiedRecentSales, type VerifiedSale } from "./sale-evidence";
import type { RuntimeEnv as Env } from "./runtime-env";

const DEFAULT_ENRICH_URL = "https://teika-lookup.your-subdomain.workers.dev/enrich";
/** 接口单批上限，超过返回 413。 */
const ENRICH_BATCH_LIMIT = 100;
/**
 * 估价模型闲置 60 秒就缩到 0，日报一天一批基本都是冷启动（实测 25–30 秒）。
 * 提供方要求客户端等 120 秒。这段等待发生在任何数据库事务之外——
 * 调用点在 prepareKeywordDigest 的读查询之后、写入 batch 之前，
 * 所以它不和 jpgr_app 的 idle_in_transaction_session_timeout 成对。
 *
 * 它和提供方的 ENRICH_DEADLINE_MS（100 秒，teika-lookup-worker/src/enrich.js）成对：
 * 提供方必须先于这里返回，模型来不及时它只丢估价、其余照给。2026-10-07 提供方内部是
 * 「数据库 45 秒 + 模型 120 秒」，这里先挂断，加藤惠整封日报的定価、行情一起丢光。
 */
const ENRICH_REQUEST_TIMEOUT_MS = 120_000;
/** 提供方数据库暂时不可用（502）时隔 1 分钟重试一次，还失败就不带补充信息发信。 */
const ENRICH_RETRY_DELAY_MS = 60_000;

/**
 * teika-lookup 与本 Worker 同账号：用 workers.dev 网址直接 fetch 会被 Cloudflare 拦成
 * `404 error code: 1042`，所以线上必须走服务绑定 ENRICH_SERVICE。
 * 本地脚本没有绑定，才退回用网址 fetch。
 */
type EnrichEnv = Env & { ENRICH_KEY?: string; ENRICH_URL?: string; ENRICH_SERVICE?: Fetcher };

export interface EnrichInputItem {
  sourceId: string;
  sourceItemId: string;
  title: string;
  url: string;
  price: number | null;
  isAuction: boolean;
}

/** 档案开着哪几样价格参考（packages/core/src/digest-extras.ts 的 digestEnrichPlan）。 */
export interface EnrichOptions {
  /** 让提供方调估价模型。关着时请求带 `estimate: false`，GPU 不会被唤醒。 */
  estimate: boolean;
  /** 要官方定価：关着就不做 AI 短查询补查那一遍。 */
  officialPrice: boolean;
  /** 逐条核对同款成交。 */
  sales: boolean;
}

const ALL_EXTRAS: EnrichOptions = { estimate: true, officialPrice: true, sales: true };

export interface EnrichOutcome {
  status: "ok" | "failed" | "skipped";
  /** 与输入同序；某一件没有返回时为 null。 */
  items: (Record<string, unknown> | null)[];
  /**
   * 与输入同序：逐条核对过标题的同款近期成交（见 sale-evidence.ts）。
   * null = 标题里抽不出能区分款式的词，无从核对。
   */
  verifiedSales: (VerifiedSale[] | null)[];
  dataAsOf?: string;
  modelVersion?: string;
  estimateError?: string;
  error?: string;
}

/**
 * 用 AI 已经抽好的字段拼短查询：作品 + 角色 + 品类 + 版本。
 * 不拼原标题——拼长会让命中从 11.3% 掉到 3.9%（docs/研究/原価锚点接入-交接-20260922.md §3.3）。
 *
 * 它只在原标题查不到定価时补查一次（见 enrichDigestItems）。AI 字段大多是中文
 * （路人女主的养成方法 / 手办 / 加藤惠），对不上日文商品库，还会把 ねんどろいど、ちょこぷに
 * 这种区分款式的词翻没。2026-10-07 用过去 20 天 988 件单件商品离线对比：
 * 只传短查询时确定定価 24 件，原标题优先、查不到再用短查询时 88 件，原来查得到的一件不少。
 */
export function enrichQueryFromSemantics(output: Record<string, unknown> | undefined): string | undefined {
  if (!output) return undefined;
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const characters = Array.isArray(output.characters) ? output.characters.map(text) : [];
  const parts = [text(output.workTitle), ...characters, text(output.productType), text(output.editionOrModel)]
    .filter(Boolean);
  const unique = [...new Set(parts)];
  return unique.length > 0 ? unique.join(" ").slice(0, 200) : undefined;
}

async function queriesFor(env: Env, items: readonly EnrichInputItem[]): Promise<Map<string, string>> {
  const queries = new Map<string, string>();
  try {
    const rows = await readListingSemanticsByItem(
      env.ANALYTICS_DB.connectionString,
      items.map((item) => ({ sourceId: item.sourceId, sourceItemId: item.sourceItemId })),
    );
    for (const row of rows) {
      const query = enrichQueryFromSemantics(row.output);
      if (query) queries.set(`${row.sourceId}:${row.sourceItemId}`, query);
    }
  } catch (error) {
    // 没有短查询接口照样能用（退回用标题查），不值得为此放弃整批补充信息。
    console.warn(JSON.stringify({
      event: "digest_enrich_query_lookup_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
  }
  return queries;
}

async function postEnrich(service: Fetcher | undefined, url: string, key: string, body: unknown): Promise<Response> {
  return (service ? service.fetch.bind(service) : fetch)(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ENRICH_REQUEST_TIMEOUT_MS),
  });
}

async function enrichBatch(
  service: Fetcher | undefined,
  url: string,
  key: string,
  items: readonly EnrichInputItem[],
  estimate: boolean,
  queries?: Map<string, string>,
): Promise<{ items: (Record<string, unknown> | null)[]; dataAsOf?: string; modelVersion?: string; estimateError?: string }> {
  const body = {
    ...(estimate ? {} : { estimate: false }),
    items: items.map((item, index) => {
      const query = queries?.get(`${item.sourceId}:${item.sourceItemId}`);
      return {
        id: String(index),
        title: item.title,
        // 拍卖的当前出价不是成交价（煤炉拍卖常从起拍价开始）。提供方只认得出雅虎拍卖，
        // 所以拍卖件干脆不传价格：只要参考价，不让它拿出价去算倍数、下贵贱结论。
        ...(item.price === null || item.isAuction ? {} : { price_jpy: item.price }),
        ...(query ? { query } : {}),
        source: item.sourceId,
        listing_id: item.sourceItemId,
        url: item.url,
      };
    }),
  };
  let response = await postEnrich(service, url, key, body);
  if (response.status === 502) {
    await new Promise((resolve) => setTimeout(resolve, ENRICH_RETRY_DELAY_MS));
    response = await postEnrich(service, url, key, body);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`enrich_http_${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const parsed = await response.json() as {
    items?: unknown;
    data_as_of?: unknown;
    model_version?: unknown;
    estimate_error?: unknown;
  };
  const returned = Array.isArray(parsed.items) ? parsed.items : [];
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const value of returned) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const index = typeof record.index === "number" ? record.index : Number(record.id);
    if (Number.isInteger(index)) byIndex.set(index, record);
  }
  return {
    items: items.map((_, index) => byIndex.get(index) ?? null),
    ...(typeof parsed.data_as_of === "string" ? { dataAsOf: parsed.data_as_of } : {}),
    ...(typeof parsed.model_version === "string" ? { modelVersion: parsed.model_version } : {}),
    ...(typeof parsed.estimate_error === "string" && parsed.estimate_error
      ? { estimateError: parsed.estimate_error }
      : {}),
  };
}

type EnrichMeta = Omit<EnrichOutcome, "status" | "items" | "verifiedSales">;

async function enrichAll(
  service: Fetcher | undefined,
  url: string,
  key: string,
  items: readonly EnrichInputItem[],
  estimate: boolean,
  queries?: Map<string, string>,
): Promise<{ results: (Record<string, unknown> | null)[]; meta: EnrichMeta }> {
  const results: (Record<string, unknown> | null)[] = [];
  let meta: EnrichMeta = {};
  for (let offset = 0; offset < items.length; offset += ENRICH_BATCH_LIMIT) {
    const batch = await enrichBatch(service, url, key, items.slice(offset, offset + ENRICH_BATCH_LIMIT), estimate, queries);
    results.push(...batch.items);
    meta = {
      ...meta,
      ...(batch.dataAsOf ? { dataAsOf: batch.dataAsOf } : {}),
      ...(batch.modelVersion ? { modelVersion: batch.modelVersion } : {}),
      ...(batch.estimateError ? { estimateError: batch.estimateError } : {}),
    };
  }
  return { results, meta };
}

const hasTeika = (result: Record<string, unknown> | null | undefined) =>
  !!result?.teika && typeof result.teika === "object";

/**
 * 原标题查不到定価的，再用 AI 短查询补查一次（标题里没写作品名时只有它能补上，
 * 例：`BANDAI SPIRITS ESPRESTO Excite Motions エミリア`）。只取回定価相关的三个字段，
 * 品类判断、估价和行情仍以原标题那一遍为准。补查失败不影响第一遍的结果。
 *
 * 补查只要定価，所以永远不让提供方估价：估价以第一遍为准，补查再估一次是白白再唤醒一次 GPU。
 *
 * 补查结果必须过标题核对（withOfficialMatch 的 verified）才收。短查询是中文、又丢了款式词，
 * 配得很松：2026-10-07 起补查出的 25 件定価里 23 件核对不过——1/7 比例手办配到
 * 1,620 円的场景摆件配件、毛绒配到另一个联名毛绒。没核对过的不如没有：原标题那一遍的估价还在。
 */
async function fillTeikaFromShortQuery(
  env: Env,
  service: Fetcher | undefined,
  url: string,
  key: string,
  items: readonly EnrichInputItem[],
  results: (Record<string, unknown> | null)[],
): Promise<void> {
  try {
    const queries = await queriesFor(env, items);
    const retry = items.flatMap((item, index) =>
      results[index] && !hasTeika(results[index]) && queries.has(`${item.sourceId}:${item.sourceItemId}`) ? [index] : []);
    if (retry.length === 0) return;
    const { results: fallback } = await enrichAll(service, url, key, retry.map((index) => items[index]!), false, queries);
    retry.forEach((index, position) => {
      const base = results[index];
      const found = fallback[position];
      if (!base || !found || !hasTeika(found)) return;
      const merged = { ...base, teika: found.teika, teika_candidates: found.teika_candidates, lookup: found.lookup };
      const check = withOfficialMatch(items[index]?.title ?? "", merged).jpgr_official_match as { verified?: unknown } | undefined;
      if (check?.verified === true) results[index] = merged;
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: "digest_enrich_query_fallback_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * 给定価挂上「对应的是哪一件官方商品」，写进 `jpgr_official_match`（本侧字段，不是提供方返回的）。
 * 取候选里排第一的、带定価的那件；`verified` = 这件商品标题里的身份词、角色、版本都对得上它的标题
 * （与同款成交同一把尺子，见 sale-evidence.ts）。只有核对通过，邮件才拿它的定価算贵了多少；
 * 没通过只写「最接近的官方商品」，让人一眼自己核对。
 */
function withOfficialMatch(title: string, result: Record<string, unknown>): Record<string, unknown> {
  if (!hasTeika(result) || !Array.isArray(result.teika_candidates)) return result;
  const candidate = result.teika_candidates
    .map((value) => (value && typeof value === "object" ? value as Record<string, unknown> : {}))
    .find((value) => typeof value.title === "string" && typeof value.teika_jpy === "number" && typeof value.source_url === "string");
  if (!candidate) return result;
  const characters = Array.isArray(result.characters)
    ? result.characters.filter((name): name is string => typeof name === "string")
    : [];
  return {
    ...result,
    jpgr_official_match: {
      title: candidate.title,
      url: candidate.source_url,
      source: typeof candidate.source === "string" ? candidate.source : "",
      teika_jpy: candidate.teika_jpy,
      verified: sameProductTitle(title, characters, candidate.title as string),
    },
  };
}

export async function enrichDigestItems(
  env: Env,
  items: readonly EnrichInputItem[],
  options: EnrichOptions = ALL_EXTRAS,
): Promise<EnrichOutcome> {
  const enrichEnv = env as EnrichEnv;
  const key = enrichEnv.ENRICH_KEY?.trim();
  if (!key || items.length === 0) {
    return {
      status: "skipped",
      items: items.map(() => null),
      verifiedSales: items.map(() => null),
      ...(key ? {} : { error: "ENRICH_KEY 未配置" }),
    };
  }
  const url = enrichEnv.ENRICH_URL?.trim() || DEFAULT_ENRICH_URL;
  try {
    // 第一遍只传原标题：卖家常照抄官方商品名，原标题最能逐字对上那一件。
    const { results, meta } = await enrichAll(enrichEnv.ENRICH_SERVICE, url, key, items, options.estimate);
    if (options.officialPrice) await fillTeikaFromShortQuery(env, enrichEnv.ENRICH_SERVICE, url, key, items, results);
    const annotated = results.map((result, index) => result ? withOfficialMatch(items[index]?.title ?? "", result) : null);
    return {
      status: "ok",
      items: annotated,
      verifiedSales: options.sales
        ? annotated.map((result, index) => verifiedRecentSales(items[index]?.title ?? "", result))
        : items.map(() => null),
      ...meta,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "digest_enrich_failed", itemCount: items.length, message }));
    return {
      status: "failed",
      items: items.map(() => null),
      verifiedSales: items.map(() => null),
      error: message.slice(0, 300),
    };
  }
}
