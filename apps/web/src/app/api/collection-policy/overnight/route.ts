import { denyMutation } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import {
  OVERNIGHT_COLLECTION_OVERRIDE_FLAG,
  nextOvernightCollectionExpiry,
  overnightCollectionPolicy,
} from "@jpgr/core";

export async function POST(request: Request) {
  const denied = await denyMutation(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const enabled = body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).enabled
    : undefined;
  if (typeof enabled !== "boolean") {
    return Response.json({ error: "enabled_boolean_required" }, { status: 400 });
  }

  const env = getEnv();
  const now = new Date();
  const expiresAt = enabled ? nextOvernightCollectionExpiry(now) : null;
  const config = enabled
    ? { schemaVersion: 1, expiresAt, scope: "automatic_collection" }
    : { schemaVersion: 1, disabledAt: now.toISOString(), scope: "automatic_collection" };
  await env.DB.prepare(
    `INSERT INTO runtime_feature_flags(flag_key,enabled,config_json,updated_at)
     VALUES(?,?,?,?)
     ON CONFLICT(flag_key) DO UPDATE SET
       enabled=excluded.enabled,config_json=excluded.config_json,updated_at=excluded.updated_at`,
  ).bind(
    OVERNIGHT_COLLECTION_OVERRIDE_FLAG,
    enabled ? 1 : 0,
    JSON.stringify(config),
    now.toISOString(),
  ).run();

  return Response.json(overnightCollectionPolicy(now, {
    enabled: enabled ? 1 : 0,
    config_json: JSON.stringify(config),
  }));
}
