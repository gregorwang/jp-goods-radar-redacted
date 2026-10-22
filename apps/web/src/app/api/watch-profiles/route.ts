import { unauthorized } from "@/lib/api-auth";
import { denyMutation, readJsonBody } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { initialNextRunAt, legacyIntervalMinutes, notificationColumns, resolveMonitoringPurpose } from "@/lib/monitoring";
import { watchProfileSchema } from "@jpgr/validation";
import { DEFAULT_DIGEST_EXTRAS, DIGEST_EXTRAS_DEFAULTS_FLAG, digestExtrasFromDefaultsConfig } from "@jpgr/core";
import { sourcePolicy } from "@/lib/source-policy";
import { initialMonitorRuleStatement } from "@/lib/monitor-rules";
import { exactProductSourceConfig } from "@/lib/exact-product-watch";
import { watchLifecycle, type WatchCompletionEventRow } from "@/lib/watch-lifecycle";

export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;
  const env = getEnv();
  const [result, completionResult] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
    `SELECT p.id,p.name,p.description,p.dossier_kind,p.enabled,COUNT(b.id) binding_count,
     SUM(CASE WHEN b.enabled=1 THEN 1 ELSE 0 END) active_binding_count,
     SUM(CASE WHEN b.enabled=1 AND b.last_error_code IS NULL THEN 1 ELSE 0 END) healthy_binding_count,
     SUM(CASE WHEN b.enabled=0 AND b.last_error_code IS NULL THEN 1 ELSE 0 END) paused_binding_count,
     MIN(CASE WHEN b.enabled=1 THEN b.next_run_at END) next_run_at,
     MAX(b.last_success_at) last_success_at,
     string_agg(DISTINCT b.monitoring_purpose, ',') monitoring_purposes,
     SUM(CASE WHEN b.last_error_code IS NOT NULL THEN 1 ELSE 0 END) failing_binding_count
     FROM watch_profiles p LEFT JOIN watch_bindings b ON b.watch_profile_id=p.id
     GROUP BY p.id ORDER BY p.updated_at DESC`,
    ),
    env.DB.prepare(
      `SELECT watch_profile_id,payload_json,created_at FROM (
         SELECT watch_profile_id,payload_json,created_at,
                ROW_NUMBER() OVER (PARTITION BY watch_profile_id ORDER BY created_at DESC,id DESC) lifecycle_rank
         FROM events
         WHERE watch_profile_id IS NOT NULL
           AND COALESCE(semantic_event_type,event_type)='watch_completed'
       ) lifecycle_events WHERE lifecycle_rank=1`,
    ),
  ]);
  const completions = new Map((completionResult?.results ?? []).map((row) => [
    String(row.watch_profile_id),
    row as unknown as WatchCompletionEventRow,
  ]));
  const items = (result?.results ?? []).map((row) => {
    const profile = row as Record<string, unknown>;
    const lifecycle = watchLifecycle({
      enabled: Number(profile.enabled),
      activeBindingCount: Number(profile.active_binding_count ?? 0),
      bindingCount: Number(profile.binding_count ?? 0),
      completion: completions.get(String(profile.id)),
    });
    return { ...profile, lifecycle_status: lifecycle.status, lifecycle_reason: lifecycle.reason };
  });
  return Response.json({ items });
}

export async function POST(request: Request) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = watchProfileSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });

  const env = getEnv();
  let productIdentitySearchHistoryId = parsed.data.productIdentitySearchHistoryId;
  if (parsed.data.productVariantId || parsed.data.productIdentitySearchHistoryId) {
    const projection = parsed.data.productVariantId
      ? await env.DB.prepare(
          `SELECT product_variant_id,search_history_id FROM product_identity_projection_versions
           WHERE product_variant_id=? ORDER BY projected_at DESC LIMIT 1`,
        ).bind(parsed.data.productVariantId).first<{ product_variant_id: string; search_history_id: string }>()
      : await env.DB.prepare(
          `SELECT product_variant_id,search_history_id FROM product_identity_projection_versions
           WHERE search_history_id=? ORDER BY projected_at DESC LIMIT 1`,
        ).bind(parsed.data.productIdentitySearchHistoryId).first<{ product_variant_id: string; search_history_id: string }>();
    if (!projection) return Response.json({ error: "product_identity_projection_not_found" }, { status: 409 });
    if (parsed.data.productVariantId && projection.product_variant_id !== parsed.data.productVariantId) {
      return Response.json({ error: "product_identity_projection_mismatch" }, { status: 409 });
    }
    productIdentitySearchHistoryId = projection.search_history_id;
  }
  // This single-user application does not cap saved or active watches.
  // Collection throughput is controlled independently by the Collector queue.
  const policy = await sourcePolicy();
  const profileId = crypto.randomUUID();
  const now = new Date().toISOString();
  const firstBinding = parsed.data.bindings[0]!;
  const dossierKind = parsed.data.dossierKind
    ?? (firstBinding.kind === "item"
      ? "item"
      : firstBinding.sourceConfig.searchMode === "exact_product"
        ? "exact_product"
        : "keyword");
  const offerTrackingPolicy = dossierKind === "exact_product"
    ? parsed.data.offerTrackingPolicy ?? "all_confirmed_offers"
    : "search_window";
  // 送达门槛默认取最严的一档：新建档案时用户还没想清楚这件商品对自己
  // 多重要，那种状态下少打扰比多打扰安全（AGENTS.md §4）。关键词 / 单品档案
  // 没有「疑似同款」这个概念，列不允许为空，写同一个惰性值。
  const suspectNoticePolicy = dossierKind === "exact_product"
    ? parsed.data.suspectNoticePolicy ?? "confirmed_only"
    : "confirmed_only";
  // 关键词日报附带哪几样价格参考：新建关键词档案按后台存的「新档案默认值」来，
  // 只在这里读一次；之后各档案各管各的（packages/core/src/digest-extras.ts）。
  const digestExtras = dossierKind === "keyword"
    ? digestExtrasFromDefaultsConfig((await env.DB.prepare("SELECT config_json FROM runtime_feature_flags WHERE flag_key=?")
        .bind(DIGEST_EXTRAS_DEFAULTS_FLAG).first<{ config_json: string }>())?.config_json)
    : DEFAULT_DIGEST_EXTRAS;
  const preparedBindings = parsed.data.bindings.map((binding) => ({ binding, id: crypto.randomUUID() }));
  const boundSources = new Set(preparedBindings.map(({ binding }) => binding.source));
  if (parsed.data.knownOffers.some((offer) => !boundSources.has(offer.source))) {
    return Response.json({ error: "known_offer_source_not_bound" }, { status: 400 });
  }
  const knownOfferRows = parsed.data.knownOffers.length > 0
    ? await env.DB.prepare(
        `SELECT id,source_id,source_item_id FROM listings WHERE ${parsed.data.knownOffers
          .map(() => "(source_id=? AND source_item_id=?)").join(" OR ")}`,
      ).bind(...parsed.data.knownOffers.flatMap((offer) => [offer.source, offer.sourceItemId]))
      .all<{ id: string; source_id: string; source_item_id: string }>()
    : { results: [] as Array<{ id: string; source_id: string; source_item_id: string }> };
  if (knownOfferRows.results.length !== parsed.data.knownOffers.length) {
    return Response.json({ error: "known_offer_not_found" }, { status: 409 });
  }
  const bindingStatements = preparedBindings.map(({ binding, id }) => {
    const purpose = resolveMonitoringPurpose(binding.kind, binding.monitoringPurpose);
    const targetOnly = dossierKind === "exact_product" && parsed.data.defaultMaxPrice !== undefined;
    const notifications = targetOnly
      // 设了目标价就是在蹲一个好价：只在降到目标价时提醒，小幅降价不打扰。
      ? { notifyNewListing: 1, notifyPriceDrop: 0, notifyPriceRise: 0, notifyRestock: 0, notifySoldOut: 0 } as const
      : notificationColumns(purpose, {}, {
        exactProduct: dossierKind === "exact_product",
        sourceId: binding.source,
      });
    const itemId = binding.kind === "item" && typeof binding.sourceConfig.itemId === "string"
      ? binding.sourceConfig.itemId
      : null;
    const sourceConfig = dossierKind === "exact_product"
      ? exactProductSourceConfig(binding.sourceConfig)
      : binding.sourceConfig;
    return env.DB.prepare(
      `INSERT INTO watch_bindings(
        id,watch_profile_id,source_id,kind,query,search_url,target_url,source_config_json,source_item_id,
        monitoring_purpose,interval_minutes,schedule_interval_minutes,next_run_at,target_price,notify_initial,notify_new_listing,
        notify_price_drop,notify_price_rise,notify_restock,notify_sold_out,enabled,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, profileId, binding.source, binding.kind, binding.query ?? null, binding.searchUrl ?? null,
      binding.targetUrl ?? null, JSON.stringify(sourceConfig), itemId, purpose,
      legacyIntervalMinutes(binding.intervalMinutes), binding.intervalMinutes, initialNextRunAt(binding.nextRunAt),
      targetOnly ? parsed.data.defaultMaxPrice : null,
      dossierKind === "exact_product" ? 1 : 0,
      notifications.notifyNewListing, notifications.notifyPriceDrop, notifications.notifyPriceRise,
      notifications.notifyRestock,
      notifications.notifySoldOut, policy.get(binding.source)?.monitoringAllowed ? 1 : 0, now, now);
  });
  const statements = [
    env.DB.prepare(
      `INSERT INTO watch_profiles(
        id,name,description,dossier_kind,product_variant_id,product_identity_search_history_id,
        offer_tracking_policy,suspect_notice_policy,default_max_price,include_terms_json,exclude_terms_json,
        digest_price_reference,digest_show_sales,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      profileId,
      parsed.data.name,
      parsed.data.description ?? null,
      dossierKind,
      parsed.data.productVariantId ?? null,
      productIdentitySearchHistoryId ?? null,
      offerTrackingPolicy,
      suspectNoticePolicy,
      parsed.data.defaultMaxPrice ?? null,
      JSON.stringify(parsed.data.includeTerms),
      JSON.stringify(parsed.data.excludeTerms),
      digestExtras.priceReference,
      digestExtras.showSales ? 1 : 0,
      now,
      now,
    ),
    ...bindingStatements,
    ...knownOfferRows.results.flatMap((offer) => preparedBindings
      .filter(({ binding }) => binding.source === offer.source_id)
      .map(({ id: bindingId }) => env.DB.prepare(
        `INSERT INTO watch_listing_matches(
          watch_binding_id,listing_id,first_seen_at,last_seen_at,acceptance_reason,accepted_at,
          tracking_status,tracking_baseline_completed,tracking_ended_at,tracking_terminal_reason
         ) VALUES(?,?,?,?,?,?,'anchor_known',1,?,'known_offer_anchor')
         ON CONFLICT(watch_binding_id,listing_id) DO NOTHING`,
      ).bind(bindingId, offer.id, now, now, "anchor_known", now, now))),
    initialMonitorRuleStatement(env.DB, {
      profileId,
      dossierKind,
      now,
      ...(parsed.data.productVariantId ? { productVariantId: parsed.data.productVariantId } : {}),
      ...(dossierKind === "exact_product" && parsed.data.defaultMaxPrice !== undefined
        ? {
            targetListingPrice: parsed.data.defaultMaxPrice,
            eventTypes: ["product.offer_below_target_listing_price"],
          }
        : {}),
    }),
  ];
  await env.DB.batch(statements);
  return Response.json({ id: profileId, pausedBindings: parsed.data.bindings.filter((binding) => !policy.get(binding.source)?.monitoringAllowed).length }, { status: 201 });
}
