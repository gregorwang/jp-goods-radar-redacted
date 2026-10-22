import { AdapterError, createDpopSigner, fetchJson, getAdapter } from "@jpgr/adapters";
import type { NormalizedListing, SearchResult, SourceId } from "@jpgr/core";
import { RadarRepository } from "@jpgr/db";
import { createPacedFetch } from "./request-pacer";
import { itemWithConfiguredRoute, searchWithConfiguredRoute, sourceRequestRoute, type RoutedSearchResult } from "./source-execution";

type CheckStatus = "passed" | "failed" | "blocked";

export interface P0CheckResult {
  key: string;
  status: CheckStatus;
  evidence?: Record<string, unknown>;
  error?: string;
}

export interface P0QualificationResult {
  runId: string;
  status: "passed" | "failed" | "blocked";
  checks: P0CheckResult[];
}

const AUTO_RETRY_MS = 6 * 60 * 60 * 1_000;

export function shouldAutoRunP0(input: {
  credentialsReady: boolean;
  allP0ChecksPassed: boolean;
  latestRun?: { status: "running" | "passed" | "failed" | "blocked"; started_at: string } | null;
}, now = Date.now()): boolean {
  if (!input.credentialsReady || input.allP0ChecksPassed) return false;
  if (!input.latestRun) return true;
  if (input.latestRun.status === "running" && now - Date.parse(input.latestRun.started_at) < 15 * 60_000) return false;
  return now - Date.parse(input.latestRun.started_at) >= AUTO_RETRY_MS;
}

export async function maybeRunAutomaticP0(env: Env): Promise<P0QualificationResult | null> {
  const repository = new RadarRepository(env.DB);
  const [checks, latestRun] = await Promise.all([
    repository.verificationChecks("p0"),
    repository.latestP0QualificationRun(),
  ]);
  const automaticChecks = checks.filter((check) => AUTO_P0_KEYS.has(check.check_key));
  const eligible = shouldAutoRunP0({
    credentialsReady: Boolean(env.RAKUTEN_APPLICATION_ID && env.RAKUTEN_ACCESS_KEY),
    allP0ChecksPassed: automaticChecks.length === AUTO_P0_KEYS.size && automaticChecks.every((check) => check.status === "passed"),
    latestRun,
  });
  return eligible ? runP0Qualification(env, "system") : null;
}

const RAKUTEN_ICHIBA_KEYS = [
  "rakuten_ichiba_chitanda", "rakuten_ichiba_emilia", "rakuten_ichiba_30", "rakuten_ichiba_fields", "rakuten_ichiba_429",
] as const;
const RAKUTEN_BOOKS_KEYS = ["rakuten_books_hyouka", "rakuten_books_emilia", "rakuten_books_fields"] as const;
const MERCARI_KEYS = ["mercari_dpop", "mercari_search", "mercari_fields", "mercari_item", "mercari_failure_policy"] as const;
const SURUGAYA_KEYS = ["surugaya_search", "surugaya_fields", "surugaya_marketplace", "surugaya_item", "surugaya_failure_policy"] as const;
const AUTO_P0_KEYS = new Set<string>(["rakuten_app", ...RAKUTEN_ICHIBA_KEYS, ...RAKUTEN_BOOKS_KEYS]);
const QUALIFICATION_P0_KEYS = new Set<string>([...AUTO_P0_KEYS, ...MERCARI_KEYS, ...SURUGAYA_KEYS]);

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知资格验证错误";
  return message.replace(/https?:\/\/[^\s]+/g, (value) => {
    try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "[redacted-url]"; }
  }).slice(0, 500);
}

function assertQualification(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function fieldRate(items: NormalizedListing[], field: "currentPrice" | "imageUrl"): number {
  const present = items.filter((item) => field === "currentPrice"
    ? typeof item.currentPrice === "number" && Number.isFinite(item.currentPrice) && item.currentPrice >= 0
    : typeof item.imageUrl === "string" && item.imageUrl.length > 0).length;
  return ratio(present, items.length);
}

function dateKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : undefined;
}

function descendingBySourceDate(items: NormalizedListing[]): boolean {
  const keys = items.map((item) => dateKey(item.sourceListedAt ?? item.sourceUpdatedAt)).filter((value): value is string => Boolean(value));
  return keys.length >= 2 && keys.every((value, index) => index === 0 || keys[index - 1]! >= value);
}

function sourceSecrets(env: Env): Partial<Record<string, string>> {
  return {
    RAKUTEN_APPLICATION_ID: env.RAKUTEN_APPLICATION_ID,
    RAKUTEN_ACCESS_KEY: env.RAKUTEN_ACCESS_KEY,
    RAKUTEN_AFFILIATE_ID: env.RAKUTEN_AFFILIATE_ID,
    RAKUTEN_APPLICATION_URL: env.RAKUTEN_APPLICATION_URL,
    RAKUTEN_AFFILIATE_MODE: env.RAKUTEN_AFFILIATE_MODE,
  };
}

export async function runP0Qualification(env: Env, triggeredBy: "admin" | "system" = "admin"): Promise<P0QualificationResult | null> {
  const repository = new RadarRepository(env.DB);
  const runId = await repository.createP0QualificationRun(triggeredBy);
  if (!runId) return null;
  const checks: P0CheckResult[] = [];
  const secrets = sourceSecrets(env);

  const verify = async (key: string, task: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown> | undefined> => {
    try {
      const evidence = { runId, checkedAt: new Date().toISOString(), ...(await task()) };
      await repository.markVerification("p0", key, "passed", evidence);
      checks.push({ key, status: "passed", evidence });
      return evidence;
    } catch (error) {
      const blocked = error instanceof AdapterError && ["credentials_missing", "source_cooldown"].includes(error.code);
      const status: CheckStatus = blocked ? "blocked" : "failed";
      const message = safeMessage(error);
      await repository.markVerification("p0", key, status, { runId, checkedAt: new Date().toISOString(), error: message });
      checks.push({ key, status, error: message });
      return undefined;
    }
  };

  const block = async (keys: readonly string[], message: string): Promise<void> => {
    for (const key of keys) {
      await repository.markVerification("p0", key, "blocked", { runId, checkedAt: new Date().toISOString(), error: message });
      checks.push({ key, status: "blocked", error: message });
    }
  };

  try {
    const rakutenReady = Boolean(env.RAKUTEN_APPLICATION_ID && env.RAKUTEN_ACCESS_KEY);
    if (rakutenReady) {
      const rakutenFetch = createPacedFetch(fetch);
      const storedChecks = await repository.verificationChecks("p0");
      const storedStatuses = new Map(storedChecks.map((check) => [check.check_key, check.status]));
      const shouldCheckIchiba = triggeredBy === "admin"
        || !RAKUTEN_ICHIBA_KEYS.every((key) => storedStatuses.get(key) === "passed");
      const shouldCheckBooks = triggeredBy === "admin"
        || !RAKUTEN_BOOKS_KEYS.every((key) => storedStatuses.get(key) === "passed");
      const tasks: Promise<void>[] = [];
      if (shouldCheckIchiba) tasks.push(qualifyRakutenIchiba(env, secrets, verify, rakutenFetch));
      if (shouldCheckBooks) tasks.push(qualifyRakutenBooks(env, secrets, verify, rakutenFetch));
      await Promise.all(tasks);
      const current = await repository.verificationChecks("p0");
      const lookup = new Map(current.map((check) => [check.check_key, check.status]));
      await verify("rakuten_app", async () => {
        const authenticatedSources = [
          RAKUTEN_ICHIBA_KEYS.some((key) => lookup.get(key) === "passed") ? "rakuten_ichiba" : undefined,
          RAKUTEN_BOOKS_KEYS.some((key) => lookup.get(key) === "passed") ? "rakuten_books" : undefined,
        ].filter((source): source is "rakuten_ichiba" | "rakuten_books" => Boolean(source));
        assertQualification(authenticatedSources.length > 0, "Rakuten 凭据尚未通过任何实际 API 请求认证");
        return { credentialsAuthenticated: true, authenticatedSources };
      });
    } else {
      await block(["rakuten_app", ...RAKUTEN_ICHIBA_KEYS, ...RAKUTEN_BOOKS_KEYS], "Rakuten 生产凭据未配置");
    }

    if (triggeredBy === "admin") {
      await qualifyMercari(env, secrets, verify);
      await qualifySurugaya(env, secrets, verify);
    }

    const p0Checks = await repository.verificationChecks("p0");
    const statuses = new Map(p0Checks.map((check) => [check.check_key, check.status]));
    await updateFinalSourceGate(repository, "rakuten_ichiba", ["rakuten_app", ...RAKUTEN_ICHIBA_KEYS], statuses, runId);
    await updateFinalSourceGate(repository, "rakuten_books", ["rakuten_app", ...RAKUTEN_BOOKS_KEYS], statuses, runId);
    await updateSourceHealth(env, "rakuten_ichiba", ["rakuten_app", ...RAKUTEN_ICHIBA_KEYS], statuses, runId);
    await updateSourceHealth(env, "rakuten_books", ["rakuten_app", ...RAKUTEN_BOOKS_KEYS], statuses, runId);
    if (triggeredBy === "admin") {
      await updateExperimentalSourceHealth(env, "mercari_jp", MERCARI_KEYS, statuses, runId);
      await updateExperimentalSourceHealth(env, "surugaya", SURUGAYA_KEYS, statuses, runId);
    }
    await repository.markHtmlIsolationIfProven();

    const refreshed = await repository.verificationChecks("p0");
    const relevantChecks = triggeredBy === "system"
      ? refreshed.filter((check) => AUTO_P0_KEYS.has(check.check_key))
      : refreshed.filter((check) => QUALIFICATION_P0_KEYS.has(check.check_key));
    const status = relevantChecks.every((check) => check.status === "passed")
      ? "passed"
      : relevantChecks.some((check) => check.status === "failed") ? "failed" : "blocked";
    await repository.finishP0QualificationRun(runId, status, checks);
    return { runId, status, checks };
  } catch (error) {
    const message = safeMessage(error);
    await repository.finishP0QualificationRun(runId, "failed", checks, message);
    return { runId, status: "failed", checks: [...checks, { key: "qualification_runtime", status: "failed", error: message }] };
  }
}

async function qualifyRakutenIchiba(
  env: Env,
  secrets: Partial<Record<string, string>>,
  verify: (key: string, task: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown> | undefined>,
  fetcher: typeof fetch,
): Promise<void> {
  const adapter = getAdapter("rakuten_ichiba")!;
  let chitanda: SearchResult | undefined;
  let emilia: SearchResult | undefined;
  await verify("rakuten_ichiba_chitanda", async () => {
    chitanda = await adapter.search({ query: "千反田える", filters: { page: 1, pageSize: 30, sort: "newest" } }, { fetch: fetcher, secrets });
    assertQualification(chitanda.listings.length > 0, "Rakuten Ichiba「千反田える」无结果");
    return { query: "千反田える", resultCount: chitanda.listings.length, coverage: chitanda.coverage };
  });
  await verify("rakuten_ichiba_emilia", async () => {
    emilia = await adapter.search({ query: "Re:ゼロ エミリア", filters: { page: 1, pageSize: 30, sort: "newest" } }, { fetch: fetcher, secrets });
    assertQualification(emilia.listings.length > 0, "Rakuten Ichiba「Re:ゼロ エミリア」无结果");
    return { query: "Re:ゼロ エミリア", resultCount: emilia.listings.length, coverage: emilia.coverage };
  });
  await verify("rakuten_ichiba_30", async () => {
    assertQualification(chitanda && emilia, "Rakuten Ichiba 查询结果不完整");
    const maximum = Math.max(chitanda.listings.length, emilia.listings.length);
    assertQualification(maximum >= 30, `Rakuten Ichiba 最大解析数量仅 ${maximum} 条`);
    return { parsedCount: maximum };
  });
  await verify("rakuten_ichiba_fields", async () => {
    assertQualification(chitanda && emilia, "Rakuten Ichiba 查询结果不完整");
    const items = [...chitanda.listings, ...emilia.listings];
    const idsUnique = [chitanda.listings, emilia.listings]
      .every((group) => new Set(group.map((item) => item.sourceItemId)).size === group.length);
    const priceCompleteness = fieldRate(items, "currentPrice");
    const imageCompleteness = fieldRate(items, "imageUrl");
    assertQualification(idsUnique && items.every((item) => item.sourceItemId.includes(":")), "Rakuten itemCode 不稳定或重复");
    assertQualification(priceCompleteness >= 0.98, "Rakuten Ichiba 价格完整率低于 98%");
    assertQualification(imageCompleteness >= 0.98, "Rakuten Ichiba 图片完整率低于 98%");
    const first = items[0]!;
    const detail = await adapter.getItem!(first.sourceItemId, { fetch: fetcher, secrets });
    assertQualification(detail.sourceItemId === first.sourceItemId, "Rakuten itemCode 单品回查不一致");
    return { sampleCount: items.length, priceCompleteness, imageCompleteness, itemLookupStable: true };
  });
  await verify("rakuten_ichiba_429", async () => {
    assertQualification(chitanda, "Rakuten Ichiba 尚无成功的实际查询");
    const controlledFetch = (async () => new Response("{}", { status: 429, headers: { "Retry-After": "120" } })) as typeof fetch;
    const error = await fetchJson(controlledFetch, new URL("https://openapi.rakuten.co.jp/controlled-429")).catch((value: unknown) => value);
    assertQualification(error instanceof AdapterError && error.status === 429 && error.retryable && error.retryAfterSeconds === 120,
      "生产适配器未正确解释 429 Retry-After");
    return { controlledRuntimeCheck: true, retryAfterSeconds: 120 };
  });
  void env;
}

async function qualifyRakutenBooks(
  env: Env,
  secrets: Partial<Record<string, string>>,
  verify: (key: string, task: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown> | undefined>,
  fetcher: typeof fetch,
): Promise<void> {
  const adapter = getAdapter("rakuten_books")!;
  const observedSorts: string[] = [];
  const tracedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    observedSorts.push(url.searchParams.get("sort") ?? "");
    return fetcher(input, init);
  }) as typeof fetch;
  let hyouka: SearchResult | undefined;
  let emilia: SearchResult | undefined;
  await verify("rakuten_books_hyouka", async () => {
    hyouka = await adapter.search({ query: "氷菓 Blu-ray", filters: { page: 1, pageSize: 30, sort: "newest" } }, { fetch: tracedFetch, secrets });
    assertQualification(hyouka.listings.length > 0, "Rakuten Books「氷菓 Blu-ray」无结果");
    return { query: "氷菓 Blu-ray", resultCount: hyouka.listings.length };
  });
  await verify("rakuten_books_emilia", async () => {
    emilia = await adapter.search({ query: "Re:ゼロ Blu-ray", filters: { page: 1, pageSize: 30, sort: "newest" } }, { fetch: tracedFetch, secrets });
    assertQualification(emilia.listings.length > 0, "Rakuten Books「Re:ゼロ Blu-ray」无结果");
    return { query: "Re:ゼロ Blu-ray", resultCount: emilia.listings.length };
  });
  await verify("rakuten_books_fields", async () => {
    assertQualification(hyouka && emilia, "Rakuten Books 查询结果不完整");
    const items = [...hyouka.listings, ...emilia.listings];
    const identityRate = ratio(items.filter((item) => /^\d{13}$/.test(item.sourceItemId)).length, items.length);
    assertQualification(identityRate >= 0.98, "Rakuten Books JAN/ISBN 完整率低于 98%");
    assertQualification(observedSorts.length >= 2 && observedSorts.every((value) => value === "-releaseDate"), "Rakuten Books 未请求发售日倒序");
    assertQualification(descendingBySourceDate(hyouka.listings) || descendingBySourceDate(emilia.listings), "Rakuten Books 实际结果未证明发售日倒序");
    const controlledFetch = (async () => Response.json({ items: [{ jan: "9784041064839", itemUrl: "https://books.rakuten.co.jp/rb/1/",
      title: "予約商品", itemPrice: 1, availability: "5", salesDate: "2099-01-01" }] })) as typeof fetch;
    const preorder = await adapter.search({ query: "controlled", filters: {} }, { fetch: controlledFetch, secrets });
    assertQualification(preorder.listings[0]?.availability === "preorder", "Rakuten Books 预约状态映射失败");
    return { sampleCount: items.length, identityRate, releaseDateDescending: true, preorderMapping: true };
  });
  void env;
}

async function qualifyMercari(
  env: Env,
  secrets: Partial<Record<string, string>>,
  verify: (key: string, task: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown> | undefined>,
): Promise<void> {
  const adapter = getAdapter("mercari_jp")!;
  let searchResult: RoutedSearchResult | undefined;
  await verify("mercari_dpop", async () => {
    const proof = await (await createDpopSigner()).createProof("POST", "https://api.mercari.jp/v2/entities:search");
    const parts = proof.split(".");
    assertQualification(parts.length === 3 && parts[2]?.length === 86, "Mercari ES256 DPoP 签名不是 64 字节 JOSE 格式");
    return { algorithm: "ES256", curve: "P-256", joseSignatureBytes: 64 };
  });
  const route = sourceRequestRoute("mercari_jp", env);
  const sourceState = await env.DB.prepare("SELECT cooldown_until,cooldown_route FROM source_registry WHERE id='mercari_jp'")
    .first<{ cooldown_until: string | null; cooldown_route: "direct" | "mercari_service" | null }>();
  if (sourceState?.cooldown_until && Date.parse(sourceState.cooldown_until) > Date.now()
    && (sourceState.cooldown_route ?? "direct") === route) {
    const cooldown = new AdapterError(
      `Mercari 生产来源冷却至 ${sourceState.cooldown_until}，本轮不重复请求上游`,
      "source_cooldown",
      429,
      false,
      Math.max(1, Math.ceil((Date.parse(sourceState.cooldown_until) - Date.now()) / 1_000)),
    );
    for (const key of ["mercari_search", "mercari_fields", "mercari_item"] as const) {
      await verify(key, async () => { throw cooldown; });
    }
    await qualifyMercariFailurePolicy(adapter, secrets, verify);
    return;
  }
  await verify("mercari_search", async () => {
    searchResult = await searchWithConfiguredRoute(env, adapter, { query: "千反田える", filters: { pageSize: 30, inStockOnly: true, sort: "newest" } }, { fetch, secrets });
    assertQualification(searchResult.listings.length > 0, "Mercari「千反田える」无结果");
    assertQualification(searchResult.listings.every((item) => item.availability === "available"), "Mercari 在售过滤返回了非在售商品");
    return { resultCount: searchResult.listings.length, nextCursorPresent: Boolean(searchResult.nextCursor), coverage: searchResult.coverage, requestRoute: searchResult.requestRoute };
  });
  await verify("mercari_fields", async () => {
    assertQualification(searchResult, "Mercari 搜索尚未成功");
    const unique = new Set(searchResult.listings.map((item) => item.sourceItemId));
    const coreComplete = searchResult.listings.filter((item) => item.sourceItemId.startsWith("m") && item.title && item.canonicalUrl && item.imageUrl).length;
    const fieldCompleteness = ratio(coreComplete, searchResult.listings.length);
    assertQualification(unique.size === searchResult.listings.length, "Mercari 商品 ID 重复");
    assertQualification(fieldCompleteness >= 0.98, "Mercari 核心字段解析率低于 98%");
    return { uniqueIds: unique.size, fieldCompleteness, parserVersion: searchResult.parserVersion };
  });
  await verify("mercari_item", async () => {
    assertQualification(searchResult?.listings[0], "Mercari 没有可用于单品回查的商品");
    const expected = searchResult.listings[0];
    const detail = await itemWithConfiguredRoute(env, adapter, expected.sourceItemId, { fetch, secrets });
    assertQualification(detail.sourceItemId === expected.sourceItemId, "Mercari 单品回查 ID 不一致");
    return { sourceItemId: detail.sourceItemId, hasPrice: typeof detail.currentPrice === "number", availability: detail.availability };
  });
  await qualifyMercariFailurePolicy(adapter, secrets, verify);
}

async function qualifyMercariFailurePolicy(
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  secrets: Partial<Record<string, string>>,
  verify: (key: string, task: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown> | undefined>,
): Promise<void> {
  await verify("mercari_failure_policy", async () => {
    const blockedFetch = (async () => Response.json({}, { status: 403 })) as typeof fetch;
    const rateFetch = (async () => Response.json({}, { status: 429, headers: { "Retry-After": "120" } })) as typeof fetch;
    const schemaFetch = (async () => Response.json({ entities: [] })) as typeof fetch;
    const [blocked, limited, changed] = await Promise.all([
      adapter.search({ query: "controlled", filters: {} }, { fetch: blockedFetch, secrets }).catch((error: unknown) => error),
      adapter.search({ query: "controlled", filters: {} }, { fetch: rateFetch, secrets }).catch((error: unknown) => error),
      adapter.search({ query: "controlled", filters: {} }, { fetch: schemaFetch, secrets }).catch((error: unknown) => error),
    ]);
    assertQualification(blocked instanceof AdapterError && blocked.status === 403 && !blocked.retryable, "Mercari 403 未进入 12 小时阻断策略");
    assertQualification(limited instanceof AdapterError && limited.status === 429 && limited.retryAfterSeconds === 120, "Mercari 429 未读取 Retry-After");
    assertQualification(changed instanceof AdapterError && changed.code === "mercari_schema_changed", "Mercari schema 变化未失败关闭");
    return { blocked403: true, retryAfterSeconds: 120, schemaFailClosed: true };
  });
}

async function qualifySurugaya(
  env: Env,
  secrets: Partial<Record<string, string>>,
  verify: (key: string, task: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown> | undefined>,
): Promise<void> {
  const adapter = getAdapter("surugaya")!;
  let searchResult: RoutedSearchResult | undefined;
  const route = sourceRequestRoute("surugaya", env);
  const sourceState = await env.DB.prepare("SELECT cooldown_until,cooldown_route FROM source_registry WHERE id='surugaya'")
    .first<{ cooldown_until: string | null; cooldown_route: "direct" | "mercari_service" | null }>();
  if (sourceState?.cooldown_until && Date.parse(sourceState.cooldown_until) > Date.now()
    && (sourceState.cooldown_route ?? "direct") === route) {
    const cooldown = new AdapterError(
      `骏河屋生产来源冷却至 ${sourceState.cooldown_until}，本轮不重复请求上游`,
      "source_cooldown",
      429,
      false,
      Math.max(1, Math.ceil((Date.parse(sourceState.cooldown_until) - Date.now()) / 1_000)),
    );
    for (const key of ["surugaya_search", "surugaya_fields", "surugaya_marketplace", "surugaya_item"] as const) {
      await verify(key, async () => { throw cooldown; });
    }
    await qualifySurugayaFailurePolicy(adapter, secrets, verify);
    return;
  }
  await verify("surugaya_search", async () => {
    searchResult = await searchWithConfiguredRoute(env, adapter,
      { query: "千反田える", filters: { page: 1, inStockOnly: false, sort: "newest" }, sourceConfig: { pages: 2 } },
      { fetch, secrets });
    assertQualification(searchResult.listings.length > 0, "骏河屋「千反田える」无结果");
    assertQualification(searchResult.routeOutcome.kind === "primary_success", "骏河屋主请求路径失败，结果来自兜底路径");
    return { resultCount: searchResult.listings.length, coverage: searchResult.coverage, warning: searchResult.warnings[0], requestRoute: searchResult.requestRoute };
  });
  await verify("surugaya_fields", async () => {
    assertQualification(searchResult, "骏河屋搜索尚未成功");
    const unique = new Set(searchResult.listings.map((item) => item.sourceItemId));
    const coreComplete = searchResult.listings.filter((item) => item.sourceItemId && item.title && item.canonicalUrl && item.imageUrl).length;
    const fieldCompleteness = ratio(coreComplete, searchResult.listings.length);
    assertQualification(unique.size === searchResult.listings.length, "骏河屋商品 ID 重复");
    assertQualification(fieldCompleteness >= 0.98, "骏河屋核心字段解析率低于 98%");
    return { uniqueIds: unique.size, fieldCompleteness, parserVersion: searchResult.parserVersion };
  });
  await verify("surugaya_marketplace", async () => {
    assertQualification(searchResult, "骏河屋搜索尚未成功");
    const isolated = searchResult.listings.every((item) => item.rawMetadata && Object.hasOwn(item.rawMetadata, "marketplacePrice"));
    assertQualification(isolated, "骏河屋 Marketplace 价格没有独立保存在 metadata");
    return { selfPriceField: "currentPrice", marketplaceField: "rawMetadata.marketplacePrice", isolated: true };
  });
  await verify("surugaya_item", async () => {
    assertQualification(searchResult?.listings[0], "骏河屋没有可用于单品回查的商品");
    const expected = searchResult.listings[0];
    const detail = await itemWithConfiguredRoute(env, adapter, expected.sourceItemId, { fetch, secrets });
    assertQualification(detail.sourceItemId === expected.sourceItemId, "骏河屋单品回查 ID 不一致");
    return { sourceItemId: detail.sourceItemId, availability: detail.availability };
  });
  await qualifySurugayaFailurePolicy(adapter, secrets, verify);
}

async function qualifySurugayaFailurePolicy(
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  secrets: Partial<Record<string, string>>,
  verify: (key: string, task: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown> | undefined>,
): Promise<void> {
  await verify("surugaya_failure_policy", async () => {
    const padding = "x".repeat(9_000);
    const captchaFetch = (async () => new Response(`<html><head><title>確認 | 駿河屋</title></head><body>CAPTCHA ロボットではない${padding}</body></html>`, { status: 200 })) as typeof fetch;
    const schemaFetch = (async () => new Response(`<html><head><title>検索 | 駿河屋</title></head><body><div id="search_result">${padding}</div></body></html>`, { status: 200 })) as typeof fetch;
    const [captcha, changed] = await Promise.all([
      adapter.search({ query: "controlled", filters: {}, sourceConfig: { pages: 1 } }, { fetch: captchaFetch, secrets }).catch((error: unknown) => error),
      adapter.search({ query: "controlled", filters: {}, sourceConfig: { pages: 1 } }, { fetch: schemaFetch, secrets }).catch((error: unknown) => error),
    ]);
    assertQualification(captcha instanceof AdapterError && captcha.code === "captcha", "骏河屋 CAPTCHA 未被识别");
    assertQualification(changed instanceof AdapterError && changed.code === "surugaya_schema_changed", "骏河屋结构变化未失败关闭");
    return { captchaDetected: true, schemaFailClosed: true };
  });
}

async function updateFinalSourceGate(
  repository: RadarRepository,
  finalKey: "rakuten_ichiba" | "rakuten_books" | "mercari_jp" | "surugaya",
  required: readonly string[],
  statuses: Map<string, string>,
  runId: string,
): Promise<void> {
  const passed = required.every((key) => statuses.get(key) === "passed");
  const blocked = !passed && required.every((key) => statuses.get(key) !== "failed");
  await repository.markVerification("final", finalKey, passed ? "passed" : blocked ? "blocked" : "failed", {
    runId,
    checkedAt: new Date().toISOString(),
    requiredChecks: required,
    result: passed ? "all_live_checks_passed" : "p0_checks_incomplete",
  });
}

async function updateExperimentalSourceHealth(
  env: Env,
  sourceId: "mercari_jp" | "surugaya",
  required: readonly string[],
  statuses: Map<string, string>,
  runId: string,
): Promise<void> {
  const passed = required.every((key) => statuses.get(key) === "passed");
  const blocked = required.some((key) => statuses.get(key) === "blocked")
    && required.every((key) => statuses.get(key) !== "failed");
  if (blocked) return;
  const now = new Date().toISOString();
  const route = sourceRequestRoute(sourceId, env);
  await env.DB.prepare(
    `UPDATE source_registry SET credential_status='not_required',health_status=?,last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,
     last_failure_at=CASE WHEN ? THEN last_failure_at ELSE ? END,last_error_code=?,last_error_message=?,request_route=?,
     consecutive_failures=CASE WHEN ? THEN 0 ELSE consecutive_failures END,
     cooldown_until=CASE WHEN ? THEN NULL ELSE cooldown_until END,cooldown_route=CASE WHEN ? THEN NULL ELSE cooldown_route END,
     updated_at=? WHERE id=?`,
  ).bind(passed ? "healthy" : "degraded", passed ? 1 : 0, now, passed ? 1 : 0, now,
    passed ? null : "p0_qualification_failed", passed ? null : `P0 资格验证未通过（${runId}）`, route,
    passed ? 1 : 0, passed ? 1 : 0, passed ? 1 : 0, now, sourceId).run();
}

async function updateSourceHealth(
  env: Env,
  sourceId: SourceId,
  required: readonly string[],
  statuses: Map<string, string>,
  runId: string,
): Promise<void> {
  const passed = required.every((key) => statuses.get(key) === "passed");
  const blocked = required.some((key) => statuses.get(key) === "blocked");
  const credentialsAuthenticated = statuses.get("rakuten_app") === "passed";
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE source_registry SET credential_status=?,health_status=?,last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,
     last_failure_at=CASE WHEN ? THEN last_failure_at ELSE ? END,last_error_code=?,last_error_message=?,updated_at=? WHERE id=?`,
  ).bind(credentialsAuthenticated ? "ready" : blocked ? "missing" : "error", passed ? "healthy" : blocked ? "unknown" : "degraded", passed ? 1 : 0, now,
    passed || blocked ? 1 : 0, now, passed || blocked ? null : "p0_qualification_failed",
    passed || blocked ? null : `P0 资格验证未通过（${runId}）`, now, sourceId).run();
}
import type { RuntimeEnv as Env } from "./runtime-env";
