/// <reference path="../../apps/collector/worker-configuration.d.ts" />
import { describe, expect, it } from "vitest";
import { RadarRepository, type WatchBindingRow } from "@jpgr/db";
import { testDatabase } from "./postgres";

describe("strong target-price reminder persistence", () => {
  it("stores 0/20/40 minute emails idempotently and sends only the first to Hermes", async () => {
    const detectedAt = "2026-09-01T09:00:00.000Z";
    await testDatabase.batch([
      testDatabase.prepare(
        `INSERT INTO watch_profiles(id,name,dossier_kind,enabled,created_at,updated_at)
         VALUES('profile-strong','加藤恵 私服Ver','exact_product',1,?,?)`,
      ).bind(detectedAt, detectedAt),
      testDatabase.prepare(
        `INSERT INTO watch_bindings(
           id,watch_profile_id,source_id,kind,query,source_config_json,interval_minutes,
           schedule_interval_minutes,next_run_at,target_price,enabled,created_at,updated_at
         ) VALUES(
           'binding-strong','profile-strong','mercari_jp','keyword','加藤恵 ふわぷち',
           '{}',1440,1440,?,2500,1,?,?
         )`,
      ).bind(detectedAt, detectedAt, detectedAt),
      testDatabase.prepare(
        `INSERT INTO listings(
           id,source_id,source_item_id,identity_scope,canonical_url,title,currency,current_price,
           price_basis,item_condition,availability,state_hash,first_seen_at,last_seen_at,last_changed_at
         ) VALUES(
           'listing-strong','mercari_jp','m-strong','listing','https://jp.mercari.com/item/m-strong',
           '加藤恵 ふわぷち 私服Ver','JPY',2000,'listing_price','used','available','state',?,?,?
         )`,
      ).bind(detectedAt, detectedAt, detectedAt),
    ]);
    const binding = (await testDatabase.prepare(
      "SELECT * FROM watch_bindings WHERE id='binding-strong'",
    ).first<WatchBindingRow>())!;
    const repository = new RadarRepository(testDatabase);

    const input = {
      listingId: "listing-strong",
      currentPrice: 2_000,
      targetPrice: 2_500,
      detectedAt,
      policy: { enabled: true, intervalMinutes: 20, repeatCount: 3 },
    } as const;
    expect(await repository.scheduleStrongTargetPriceReminders(binding, input)).toBe(3);
    expect(await repository.scheduleStrongTargetPriceReminders(binding, input)).toBe(0);

    const events = await testDatabase.prepare(
      `SELECT event_key,delivery_not_before,payload_json FROM events
       WHERE watch_binding_id='binding-strong' ORDER BY event_key`,
    ).all<{ event_key: string; delivery_not_before: string | null; payload_json: string }>();
    expect(events.results.map((event) => event.delivery_not_before)).toEqual([
      null,
      "2026-09-01T09:20:00.000Z",
      "2026-09-01T09:40:00.000Z",
    ]);
    expect(events.results.map((event) => JSON.parse(event.payload_json).strongReminder.sequence)).toEqual([1, 2, 3]);
    expect(await repository.pendingEmails(10)).toHaveLength(3);
    expect(await repository.pendingHermesNotices("1970-01-01T00:00:00.000Z", 10)).toHaveLength(1);

    await testDatabase.prepare("UPDATE watch_bindings SET enabled=0 WHERE id='binding-strong'").run();
    expect((await repository.pendingEmails(10)).every((event) => event.binding_enabled === 0)).toBe(true);
  });
});
