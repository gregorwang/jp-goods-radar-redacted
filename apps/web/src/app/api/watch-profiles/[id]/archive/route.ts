import { apiError, denyMutation, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const profileId = await routeId(context);
  const env = getEnv();
  const profile = await env.DB.prepare(
    "SELECT id,name FROM watch_profiles WHERE id=?",
  ).bind(profileId).first<{ id: string; name: string }>();
  if (!profile) return apiError("watch_profile_not_found", 404);

  const alreadyArchived = await env.DB.prepare(
    `SELECT id FROM events
     WHERE watch_profile_id=? AND COALESCE(semantic_event_type,event_type)='watch_completed'
       AND payload_json LIKE '%\"kind\":\"user_purchased\"%'
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(profileId).first<{ id: string }>();
  if (alreadyArchived) return Response.json({ archived: true, alreadyArchived: true });

  const now = new Date().toISOString();
  const payload = JSON.stringify({
    kind: "user_purchased",
    reason: "user_purchased",
    profileName: profile.name,
    archivedAt: now,
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events(
         id,event_key,event_type,semantic_event_type,watch_profile_id,payload_json,status,created_at
       ) VALUES(?,?,'daily_digest','watch_completed',?,?,'suppressed',?)
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), `watch_completed:${profileId}:user_purchased`, profileId, payload, now),
    env.DB.prepare(
      `UPDATE watch_bindings SET enabled=0,cooldown_until=NULL,next_run_at=?,updated_at=?
       WHERE watch_profile_id=?`,
    ).bind(now, now, profileId),
    env.DB.prepare("UPDATE watch_profiles SET enabled=0,updated_at=? WHERE id=?").bind(now, profileId),
    env.DB.prepare(
      "UPDATE monitor_rules SET enabled=0 WHERE watch_profile_id=? AND valid_to IS NULL",
    ).bind(profileId),
  ]);
  return Response.json({ archived: true, alreadyArchived: false });
}
