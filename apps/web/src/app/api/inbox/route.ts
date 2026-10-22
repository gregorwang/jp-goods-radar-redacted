import { unauthorized } from "@/lib/api-auth";
import { privateJson } from "@/lib/api-response";
import { getEnv } from "@/lib/cloudflare";
import { DIGEST_WINDOW_DAYS, EXCLUDED_WINDOW_DAYS, recentDigestItems, recentExcludedItems } from "@/lib/inbox-feed";
import { ACTIVE_ITEM_WATCH_LIMIT } from "@/lib/listing-watch";

/**
 * 主站「收件箱」（2026-10-16 用户要的：日报标注、AI 复核、被筛掉的合成一页，像手机 App 那样一行一件、点一下就存）。
 * 一次返回全部关键词档案的「推给我的」和「排除词挡掉的」，档案栏上的件数前端自己数；
 * 「AI 拦下的」切过去时才按档案读 /api/watch-profiles/[id]/ai-review（那份要把近 30 天重算一遍）。
 */
const MAX_DIGEST_ROWS = 3000;
const MAX_EXCLUDED_ROWS = 1500;

interface ProfileRow {
  id: string;
  name: string;
  enabled: number | string | boolean;
  notify_email: number | string | boolean;
  notify_feishu: number | string | boolean;
}

interface WatchRow {
  source_id: string;
  source_item_id: string;
  like_count: number | string | null;
  comment_count: number | string | null;
}

function count(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

/** 正在盯的单品（「盯住」按钮的亮灭），带最近一次记下的点赞 / 评论数。 */
async function activeWatches() {
  const rows = await getEnv().DB.prepare(
    `SELECT b.source_id,b.source_item_id,i.like_count,i.comment_count
     FROM watch_bindings b JOIN watch_profiles p ON p.id=b.watch_profile_id
     LEFT JOIN listings l ON l.source_id=b.source_id AND l.source_item_id=b.source_item_id
     LEFT JOIN LATERAL (
       SELECT o.like_count,o.comment_count FROM listing_interest_observations o
       WHERE o.listing_id=l.id ORDER BY o.observed_at DESC LIMIT 1
     ) i ON true
     WHERE b.kind='item' AND b.enabled=1 AND p.enabled=1 AND b.source_item_id IS NOT NULL`,
  ).all<WatchRow>();
  return rows.results.map((row) => ({
    sourceId: row.source_id,
    sourceItemId: row.source_item_id,
    likeCount: count(row.like_count),
    commentCount: count(row.comment_count),
  }));
}

function flag(value: number | string | boolean): boolean {
  return value === true || Number(value) === 1;
}

export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;
  const profiles = await getEnv().DB.prepare(
    `SELECT id,name,enabled,notify_email,notify_feishu FROM watch_profiles
     WHERE dossier_kind='keyword' ORDER BY enabled DESC,name`,
  ).all<ProfileRow>();
  const ids = profiles.results.map((row) => row.id);
  const [digest, excluded, watches] = await Promise.all([
    recentDigestItems(ids, MAX_DIGEST_ROWS),
    recentExcludedItems(ids, MAX_EXCLUDED_ROWS),
    activeWatches(),
  ]);
  return privateJson({
    digestWindowDays: DIGEST_WINDOW_DAYS,
    excludedWindowDays: EXCLUDED_WINDOW_DAYS,
    profiles: profiles.results.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: flag(row.enabled),
      notifyEmail: flag(row.notify_email),
      notifyFeishu: flag(row.notify_feishu),
    })),
    digest,
    excluded,
    watchLimit: ACTIVE_ITEM_WATCH_LIMIT,
    watches,
  });
}
