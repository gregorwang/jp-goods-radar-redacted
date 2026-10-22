/**
 * 飞书这一路的全部状态和动作，挂在 PushHub（唯一的 DO 实例）里，和 App 共用同一份消息。
 *
 * 流程：collector → /publish → PushHub 存消息、推 App → 同时进 feishu_queue
 *   → DO alarm：最后一条进来后安静 QUIET_MS、或第一条已等 MAX_WAIT_MS，就把队列里的合成卡片发出去
 *     （4 个 IP 每小时差不多同一分钟跑完，这样一小时只发一条）。
 * 每条推送第一次发完就记结果（feishu_outcomes）：至少一个群或自用私聊收到 = delivered，一个都没收到 = failed。
 * collector 每分钟来问（/outcomes），只开飞书的档案拿到 failed 就改发邮件（2026-10-14，档案决定发到哪）。
 * 一个都没收到的不再重试（邮件接手了，再发就重复）；群收到了、私聊没收到的，私聊留在队列里 RETRY_MS 后再试，
 * 超过 GIVE_UP_MS 放弃（只记日志）。
 *
 * 内容：每小时日报（hourly_digest）攒起来合成一张；精确同款上新（exact_match）、商品变化（listing_change）一条一张卡。
 *
 * 额度：免费版每月 1 万次（北京时间自然月）。到 IMAGE_STOP_AT 不再传图（卡片照发、只有文字），
 * 到 SEND_STOP_AT 什么都不发。只在 spend() 里记账，所有计数调用都经过 FeishuClient。
 *
 * 收件人：第一个在私聊里给机器人发消息的人（open_id）就是接收人，之后别人发的一概不理。
 *
 * 群（2026-10-13 起）：feishu_groups 表里每个群一行，各有开关和要收的 IP（档案），在主站「推送」页管。
 * 群和自用私聊互不牵连：私聊暂停只停私聊（fs_enabled），群照发；反过来也一样。
 */
import { FeishuClient, FeishuError, sendWebhookCard, type FeishuRecipient } from "./api";
import { FEISHU_KINDS, planCards, type StoredPush } from "./batch";
import { buildDigestCard, buildGroupTestCard, buildStatusCard, shortProfileName, type DigestCardModel, type StatusCardModel } from "./card";
import { GRID_LAYOUT_VERSION, renderGrid } from "./grid-image";

const QUIET_MS = 90_000;
const MAX_WAIT_MS = 6 * 60_000;
const RETRY_MS = 5 * 60_000;
const GIVE_UP_MS = 3 * 60 * 60_000;
/** 失败最多再试这么多次：每次重试都可能花额度（图片有缓存，发消息没有）。 */
const MAX_ATTEMPTS = 3;
const IMAGE_CACHE_MS = 7 * 24 * 60 * 60_000;
const CARD_KEEP_MS = 14 * 24 * 60 * 60_000;
const EVENT_KEEP_MS = 24 * 60 * 60_000;
/** 发送结果留 7 天，和 messages 一样长：collector 只问一天以内的。 */
const OUTCOME_KEEP_MS = 7 * 24 * 60 * 60_000;
const NO_RECIPIENT = "没有群收这个档案，飞书私聊也没开";
export const QUOTA_LIMIT = 10_000;
export const IMAGE_STOP_AT = 8_000;
export const SEND_STOP_AT = 9_600;
/** 回调要 3 秒内回，转给主站写标注 / 等降价留 2.2 秒。 */
const WEB_TIMEOUT_MS = 2_200;
/** 卡片 JSON 上限 30 KB，留点余量。 */
const MAX_CARD_BYTES = 28 * 1024;

export interface DeskHost {
  sql: SqlStorage;
  env: Env;
  storage: DurableObjectStorage;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  rounds(): Promise<Record<string, unknown>[]>;
}

type CardActionValue = { k?: unknown; c?: unknown; s?: unknown; i?: unknown };

type GroupRow = {
  id: string;
  name: string;
  webhook_url: string;
  secret: string | null;
  enabled: number;
  /** JSON 数组；NULL = 全部 IP（以后新加的也收）。 */
  profile_ids: string | null;
  created_at: number;
  last_at: number | null;
  last_ok: number | null;
  last_error: string | null;
};

export interface GroupView {
  id: string;
  name: string;
  /** 只给看尾巴：整串地址就是往这个群发消息的钥匙。 */
  webhookTail: string;
  signed: boolean;
  enabled: boolean;
  profileIds: string[] | null;
  createdAt: string;
  last: { at: string; ok: boolean; error: string | null } | null;
}

export interface GroupInput {
  name?: unknown;
  webhookUrl?: unknown;
  secret?: unknown;
  enabled?: unknown;
  profileIds?: unknown;
}

const WEBHOOK_PREFIXES = ["https://open.feishu.cn/open-apis/bot/v2/hook/", "https://open.larksuite.com/open-apis/bot/v2/hook/"];
const MAX_GROUPS = 50;

/** 主站填错了（地址不对、名字空着）：入口回 400，把这句话原样给页面看。 */
export class GroupInputError extends Error {}

function groupProfiles(row: Pick<GroupRow, "profile_ids">): string[] | null {
  if (row.profile_ids === null) return null;
  try {
    const ids = JSON.parse(row.profile_ids) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function groupView(row: GroupRow): GroupView {
  return {
    id: row.id,
    name: row.name,
    webhookTail: `…${row.webhook_url.slice(-6)}`,
    signed: Boolean(row.secret),
    enabled: row.enabled === 1,
    profileIds: groupProfiles(row),
    createdAt: new Date(row.created_at).toISOString(),
    last: row.last_at === null ? null : { at: new Date(row.last_at).toISOString(), ok: row.last_ok === 1, error: row.last_error },
  };
}

function beijingMonth(now = Date.now()): string {
  const date = new Date(now + 8 * 3_600_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class FeishuDesk {
  constructor(private readonly host: DeskHost) {
    host.sql.exec(`CREATE TABLE IF NOT EXISTS feishu_queue(
      message_id INTEGER PRIMARY KEY,
      queued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    )`);
    host.sql.exec(`CREATE TABLE IF NOT EXISTS feishu_cards(
      card_id TEXT PRIMARY KEY,
      feishu_message_id TEXT,
      created_at INTEGER NOT NULL,
      body TEXT NOT NULL
    )`);
    host.sql.exec("CREATE TABLE IF NOT EXISTS feishu_events(event_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)");
    // 每条推送发到飞书的结果：delivered / failed（+ 原因）。collector 经 /outcomes 来问。
    host.sql.exec(`CREATE TABLE IF NOT EXISTS feishu_outcomes(
      message_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      error TEXT,
      at INTEGER NOT NULL
    )`);
    // 同一张拼图（同样的格子）只传一次：重试、样卡反复点都不再花上传额度。
    host.sql.exec("CREATE TABLE IF NOT EXISTS feishu_images(tiles_hash TEXT PRIMARY KEY, image_key TEXT NOT NULL, created_at INTEGER NOT NULL)");
    host.sql.exec(`CREATE TABLE IF NOT EXISTS feishu_groups(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      profile_ids TEXT,
      created_at INTEGER NOT NULL,
      last_at INTEGER,
      last_ok INTEGER,
      last_error TEXT
    )`);
    // 换了飞书应用（10-13 晚旧应用换凭证被拒 21001，新建了一个）：运营者的 open_id、会话号、token、传过的图都是按应用算的，
    // 旧的一概作废。运营者重新私聊新机器人一句就重新绑上。
    const appId = host.env.FEISHU_APP_ID ?? "";
    if (appId && host.getMeta("fs_app_id") !== appId) {
      for (const key of ["fs_owner_open_id", "fs_owner_chat_id", "fs_owner_last_message_id", "fs_token", "fs_token_expires_at"]) {
        host.sql.exec("DELETE FROM meta WHERE key=?", key);
      }
      host.sql.exec("DELETE FROM feishu_images");
      host.sql.exec("DELETE FROM feishu_cards");
      host.setMeta("fs_app_id", appId);
    }
    // 10-13 上午接的第一个群配在 secret FEISHU_WEBHOOK_URL 里：第一次起来时搬进表，之后只认表。
    if (host.getMeta("fs_groups_migrated") !== "1") {
      if (host.env.FEISHU_WEBHOOK_URL) {
        host.sql.exec(
          "INSERT INTO feishu_groups(id,name,webhook_url,secret,enabled,profile_ids,created_at) VALUES(?,?,?,?,1,NULL,?)",
          crypto.randomUUID(), "第一个群", host.env.FEISHU_WEBHOOK_URL, host.env.FEISHU_WEBHOOK_SECRET ?? null, Date.now(),
        );
      }
      host.setMeta("fs_groups_migrated", "1");
    }
  }

  get configured(): boolean {
    return Boolean(this.host.env.FEISHU_APP_ID && this.host.env.FEISHU_APP_SECRET);
  }

  get ownerOpenId(): string | undefined {
    return this.host.getMeta("fs_owner_open_id");
  }

  /** 发给运营者用的地址：有私聊会话号就用会话号（按 open_id 私发会被拒，见 api.ts）。 */
  get recipient(): FeishuRecipient | undefined {
    const chatId = this.host.getMeta("fs_owner_chat_id");
    if (chatId) return { type: "chat_id", id: chatId };
    const openId = this.ownerOpenId;
    return openId ? { type: "open_id", id: openId } : undefined;
  }

  /** 自用私聊这一路开没开。群各有各的开关，不看这个。 */
  get enabled(): boolean {
    return this.configured && Boolean(this.ownerOpenId) && this.host.getMeta("fs_enabled") !== "0";
  }

  private activeGroups(): GroupRow[] {
    return this.host.sql.exec<GroupRow>("SELECT * FROM feishu_groups WHERE enabled=1 ORDER BY created_at").toArray();
  }

  /** 这个档案有没有地方收：自用私聊开着（私聊收全部档案），或者有开着的群勾了它（勾「全部」的也算）。 */
  private hasRecipient(profileId: string): boolean {
    if (this.enabled) return true;
    return this.activeGroups().some((group) => {
      const wanted = groupProfiles(group);
      return wanted === null || wanted.includes(profileId);
    });
  }

  private recordOutcome(messageId: number, status: "delivered" | "failed", error: string | null): void {
    const now = Date.now();
    this.host.sql.exec("DELETE FROM feishu_outcomes WHERE at<?", now - OUTCOME_KEEP_MS);
    this.host.sql.exec(
      `INSERT INTO feishu_outcomes(message_id,status,error,at) VALUES(?,?,?,?)
       ON CONFLICT(message_id) DO UPDATE SET status=excluded.status,error=excluded.error,at=excluded.at`,
      messageId, status, error === null ? null : error.slice(0, 300), now,
    );
  }

  /**
   * collector 来问一批推送的飞书结果（POST /outcomes）。
   * pending = 还在等着凑卡 / 发送；unknown = 这条没进过飞书（推送服务那时没认这种通知，或已超过 7 天）。
   */
  outcomes(ids: number[]): Array<{ id: number; status: "delivered" | "failed" | "pending" | "unknown"; error?: string }> {
    return ids.map((id) => {
      const row = this.host.sql.exec<{ status: string; error: string | null }>(
        "SELECT status,error FROM feishu_outcomes WHERE message_id=?", id,
      ).toArray()[0];
      if (row) {
        return row.status === "delivered"
          ? { id, status: "delivered" as const }
          : { id, status: "failed" as const, ...(row.error ? { error: row.error } : {}) };
      }
      const queued = this.host.sql.exec<{ n: number }>("SELECT count(*) n FROM feishu_queue WHERE message_id=?", id).one().n > 0;
      return { id, status: queued ? "pending" as const : "unknown" as const };
    });
  }

  quotaUsed(): number {
    return this.host.getMeta("fs_quota_month") === beijingMonth() ? Number(this.host.getMeta("fs_quota_used") ?? "0") : 0;
  }

  /** 记一次计数调用。image 到 IMAGE_STOP_AT 就拒，其他到 SEND_STOP_AT 拒。 */
  private spend(kind: string): boolean {
    const month = beijingMonth();
    let used = this.quotaUsed();
    if (this.host.getMeta("fs_quota_month") !== month) this.host.setMeta("fs_quota_month", month);
    if (used >= (kind === "image" ? IMAGE_STOP_AT : SEND_STOP_AT)) return false;
    used += 1;
    this.host.setMeta("fs_quota_used", String(used));
    return true;
  }

  private client(): FeishuClient {
    return new FeishuClient({
      appId: this.host.env.FEISHU_APP_ID ?? "",
      appSecret: this.host.env.FEISHU_APP_SECRET ?? "",
      spend: (kind) => this.spend(kind),
      loadToken: () => {
        const token = this.host.getMeta("fs_token");
        const expiresAt = Number(this.host.getMeta("fs_token_expires_at") ?? "0");
        return token ? { token, expiresAt } : null;
      },
      saveToken: (token, expiresAt) => {
        this.host.setMeta("fs_token", token);
        this.host.setMeta("fs_token_expires_at", String(expiresAt));
      },
    });
  }

  // ---------- 排队与发送 ----------

  /**
   * PushHub.publish 存好一条推送之后调。没有任何地方收这个档案（私聊没开、没有群勾它）就当场记成没送到，
   * collector 下一分钟就能改发邮件，不用等凑卡。
   */
  async enqueue(messageId: number, kind: unknown, profileId: unknown): Promise<void> {
    if (typeof kind !== "string" || !FEISHU_KINDS.has(kind)) return;
    if (!this.hasRecipient(typeof profileId === "string" ? profileId : "")) {
      this.recordOutcome(messageId, "failed", NO_RECIPIENT);
      return;
    }
    this.host.sql.exec("INSERT OR IGNORE INTO feishu_queue(message_id,queued_at) VALUES(?,?)", messageId, Date.now());
    await this.schedule();
  }

  private async schedule(): Promise<void> {
    const row = this.host.sql.exec<{ first: number | null; last: number | null; attempts: number | null }>(
      "SELECT min(queued_at) first, max(queued_at) last, max(attempts) attempts FROM feishu_queue",
    ).one();
    if (row.first === null || row.last === null) return;
    const target = (row.attempts ?? 0) > 0
      ? Date.now() + RETRY_MS
      : Math.min(row.last + QUIET_MS, row.first + MAX_WAIT_MS);
    const current = await this.host.storage.getAlarm();
    if (current === null || current > target) await this.host.storage.setAlarm(Math.max(target, Date.now() + 1_000));
  }

  /** DO alarm 进来。 */
  async onAlarm(): Promise<void> {
    if (this.host.getMeta("fs_sample_pending") === "1") {
      this.host.setMeta("fs_sample_pending", "0");
      await this.sendSample().catch((error) => console.error(JSON.stringify({ event: "feishu_sample_failed", error: String(error) })));
    }
    const row = this.host.sql.exec<{ first: number | null; last: number | null; attempts: number | null }>(
      "SELECT min(queued_at) first, max(queued_at) last, max(attempts) attempts FROM feishu_queue",
    ).one();
    if (row.first === null || row.last === null) return;
    const now = Date.now();
    if ((row.attempts ?? 0) === 0 && now < row.last + QUIET_MS && now < row.first + MAX_WAIT_MS) {
      await this.host.storage.setAlarm(Math.min(row.last + QUIET_MS, row.first + MAX_WAIT_MS));
      return;
    }
    await this.flush();
  }

  private loadMessages(ids: number[]): StoredPush[] {
    if (ids.length === 0) return [];
    return this.host.sql.exec<{ id: number; body: string }>(
      `SELECT id,body FROM messages WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
      ...ids,
    ).toArray().map((row) => ({ id: row.id, ...(JSON.parse(row.body) as Record<string, unknown>) }));
  }

  private async flush(): Promise<void> {
    const queued = this.host.sql.exec<{ message_id: number; queued_at: number; attempts: number }>(
      "SELECT message_id,queued_at,attempts FROM feishu_queue ORDER BY message_id",
    ).toArray();
    if (queued.length === 0) return;
    const to = this.enabled ? this.recipient : undefined;
    // 群只发第一次进来的那几条：重试是为了补自用私聊，再发一遍群里就重复了。
    // 按条算，不按整队算——以前要求整队都是第一次，私聊有一条在重试，之后几小时的新货群里全收不到（10-14 code review）。
    const fresh = new Set(queued.filter((row) => row.attempts === 0).map((row) => row.message_id));
    const groups = fresh.size > 0 ? this.activeGroups() : [];
    const messages = this.loadMessages(queued.map((row) => row.message_id));
    const found = new Set(messages.map((message) => message.id));
    for (const row of queued) {
      if (found.has(row.message_id)) continue;
      this.host.sql.exec("DELETE FROM feishu_queue WHERE message_id=?", row.message_id);
      if (fresh.has(row.message_id)) this.recordOutcome(row.message_id, "failed", "推送服务里这条已经过期");
    }

    const nextRunAt = this.nextRunAt(await this.host.rounds());
    const delivered = new Set<number>();
    const errors = new Map<number, string[]>();
    const noteError = (ids: Iterable<number>, error: string) => {
      for (const id of ids) errors.set(id, [...(errors.get(id) ?? []), error]);
    };
    // 一个群失败（被踢、签名换了）只记在它那一行上，不挡别的群和私聊。
    const groupMessages = messages.filter((message) => fresh.has(message.id));
    for (const group of groups) {
      const result = await this.sendGroupDigest(group, groupMessages, nextRunAt, false);
      result.delivered.forEach((id) => delivered.add(id));
      if (result.error) noteError(result.failed, `群「${group.name}」：${result.error}`);
    }

    let privateSent: number[] = [];
    if (to) {
      const result = await this.sendDigest(to, messages, false, nextRunAt);
      privateSent = result.sent;
      privateSent.forEach((id) => delivered.add(id));
      if (result.error) noteError(messages.map((message) => message.id).filter((id) => !privateSent.includes(id)), `私聊：${result.error}`);
      console.log(JSON.stringify({ event: "feishu_digest_sent", messages: privateSent.length, quotaUsed: this.quotaUsed() }));
    }

    // 第一次发完就定结果：至少一处收到 = delivered；一处都没收到 = failed，collector 会改发邮件，所以不再重试。
    for (const message of groupMessages) {
      if (delivered.has(message.id)) {
        this.recordOutcome(message.id, "delivered", null);
      } else {
        this.recordOutcome(message.id, "failed", errors.get(message.id)?.join("；") ?? NO_RECIPIENT);
        this.host.sql.exec("DELETE FROM feishu_queue WHERE message_id=?", message.id);
      }
    }
    for (const id of privateSent) this.host.sql.exec("DELETE FROM feishu_queue WHERE message_id=?", id);
    if (!to) {
      this.host.sql.exec("DELETE FROM feishu_queue");
      return;
    }

    // 剩下的是群收到了、私聊没发出去的：私聊过 RETRY_MS 再试。
    const oldest = Date.now() - GIVE_UP_MS;
    const dropped = this.host.sql.exec("DELETE FROM feishu_queue WHERE queued_at<?", oldest).rowsWritten;
    if (dropped > 0) console.error(JSON.stringify({ event: "feishu_digest_dropped", messages: dropped }));
    this.host.sql.exec("UPDATE feishu_queue SET attempts=attempts+1");
    const exhausted = this.host.sql.exec("DELETE FROM feishu_queue WHERE attempts>?", MAX_ATTEMPTS).rowsWritten;
    if (exhausted > 0) console.error(JSON.stringify({ event: "feishu_digest_dropped", messages: exhausted, reason: "max_attempts" }));
    await this.schedule();
  }

  private nextRunAt(rounds: Record<string, unknown>[]): string | undefined {
    const now = Date.now();
    const upcoming = rounds
      .map((round) => (typeof round.nextRunAt === "string" ? Date.parse(round.nextRunAt) : Number.NaN))
      .filter((time) => Number.isFinite(time) && time > now - 5 * 60_000)
      .sort((a, b) => a - b);
    return upcoming[0] !== undefined ? new Date(upcoming[0]).toISOString() : undefined;
  }

  /**
   * 发一批到自用私聊，返回已经完整发出去的推送 id（拆成几张卡时，一个 IP 的几张都发成功才算），
   * 以及最后一次飞书报错（给 collector 退回邮件时写原因）。
   */
  private async sendDigest(
    to: FeishuRecipient,
    messages: StoredPush[],
    sample: boolean,
    nextRunAt: string | undefined,
  ): Promise<{ sent: number[]; error: string | null }> {
    const planned = planCards(messages, { batchAt: new Date().toISOString(), ...(nextRunAt ? { nextRunAt } : {}), sample });
    if (planned.length === 0) return { sent: messages.map((message) => message.id), error: null };
    const client = this.client();
    const failed = new Set<number>();
    let lastError: string | null = null;
    for (const card of planned) {
      try {
        await this.attachImages(client, card.model);
        await this.sendCardModel(client, to, card.model);
      } catch (error) {
        card.messageIds.forEach((id) => failed.add(id));
        lastError = error instanceof Error ? error.message.slice(0, 200) : String(error);
        console.error(JSON.stringify({
          event: "feishu_card_failed",
          cardId: card.model.id,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          code: error instanceof FeishuError ? error.code : null,
        }));
      }
    }
    return { sent: messages.map((message) => message.id).filter((id) => !failed.has(id)), error: lastError };
  }

  private async attachImages(client: FeishuClient, model: DigestCardModel): Promise<void> {
    if (this.quotaUsed() >= IMAGE_STOP_AT) {
      model.textOnly = true;
      return;
    }
    this.host.sql.exec("DELETE FROM feishu_images WHERE created_at<?", Date.now() - IMAGE_CACHE_MS);
    for (const section of model.sections) {
      try {
        const tiles = section.items.map((item) => ({
          ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
          n: item.n,
          price: item.price,
          tone: item.auction ? "auction" as const : item.sales?.verdict === "cheaper" ? "cheaper" as const : "default" as const,
        }));
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ v: GRID_LAYOUT_VERSION, tiles })));
        const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        const cached = this.host.sql.exec<{ image_key: string }>("SELECT image_key FROM feishu_images WHERE tiles_hash=?", hash).toArray()[0];
        if (cached) {
          section.imageKey = cached.image_key;
          continue;
        }
        const png = await renderGrid(tiles);
        if (png) {
          section.imageKey = await client.uploadImage(png);
          this.host.sql.exec(
            "INSERT OR REPLACE INTO feishu_images(tiles_hash,image_key,created_at) VALUES(?,?,?)",
            hash, section.imageKey, Date.now(),
          );
        }
      } catch (error) {
        // 图没传上去这一节就只有文字，卡片照发。
        console.error(JSON.stringify({ event: "feishu_grid_failed", profileId: section.profileId, error: String(error).slice(0, 300) }));
        if (error instanceof FeishuError && this.quotaUsed() >= IMAGE_STOP_AT) model.textOnly = true;
      }
    }
  }

  /**
   * 发一个群：只挑这个群要的档案合成卡片，用群自定义机器人（webhook）发，发消息不花额度。
   * 图和自用私聊共用一份缓存（同一节同一批格子只传一次），所以群再多，额度也只随 IP 数涨。
   * 失败记在这个群那一行上（主站「推送」页能看到）、不重试；一张卡失败后面的照发。FEISHU_WEBHOOK_IMAGES="0" 就是纯标题版。
   * 返回发了几张卡、哪些推送发到了（一条推送的几张卡都发成功才算）、哪些没发到和最后一次报错。不抛错。
   */
  private async sendGroupDigest(
    group: GroupRow,
    messages: StoredPush[],
    nextRunAt: string | undefined,
    sample: boolean,
  ): Promise<{ cards: number; delivered: number[]; failed: number[]; error: string | null }> {
    const wanted = groupProfiles(group);
    const mine = wanted === null
      ? messages
      : messages.filter((message) => typeof message.profileId === "string" && wanted.includes(message.profileId));
    const planned = planCards(mine, { batchAt: new Date().toISOString(), ...(nextRunAt ? { nextRunAt } : {}), sample });
    if (planned.length === 0) return { cards: 0, delivered: [], failed: [], error: null };
    const images = String(this.host.env.FEISHU_WEBHOOK_IMAGES) !== "0";
    const client = this.client();
    const failed = new Set<number>();
    let cards = 0;
    let lastError: string | null = null;
    for (const card of planned) {
      try {
        if (images) await this.attachImages(client, card.model);
        await sendWebhookCard(group.webhook_url, group.secret ?? undefined, buildDigestCard(card.model, { audience: "group", images }));
        cards += 1;
      } catch (error) {
        card.messageIds.forEach((id) => failed.add(id));
        lastError = error instanceof Error ? error.message.slice(0, 300) : String(error);
        console.error(JSON.stringify({ event: "feishu_webhook_failed", group: group.name, error: lastError }));
      }
    }
    this.markGroup(group.id, lastError);
    const attempted = [...new Set(planned.flatMap((card) => card.messageIds))];
    return {
      cards,
      delivered: attempted.filter((id) => !failed.has(id)),
      failed: [...failed],
      error: lastError,
    };
  }

  private markGroup(id: string, error: string | null): void {
    this.host.sql.exec(
      "UPDATE feishu_groups SET last_at=?,last_ok=?,last_error=? WHERE id=?",
      Date.now(), error === null ? 1 : 0, error, id,
    );
  }

  private async sendCardModel(client: FeishuClient, to: FeishuRecipient, model: DigestCardModel): Promise<void> {
    const card = buildDigestCard(model);
    const bytes = new TextEncoder().encode(JSON.stringify(card)).byteLength;
    if (bytes > MAX_CARD_BYTES) console.error(JSON.stringify({ event: "feishu_card_large", bytes, cardId: model.id }));
    const messageId = await client.sendCard(to, card);
    const now = Date.now();
    this.host.sql.exec("DELETE FROM feishu_cards WHERE created_at<?", now - CARD_KEEP_MS);
    this.host.sql.exec(
      "INSERT INTO feishu_cards(card_id,feishu_message_id,created_at,body) VALUES(?,?,?,?)",
      model.id, messageId, now, JSON.stringify(model),
    );
    await this.warnIfQuotaLow(client, to);
  }

  private async warnIfQuotaLow(client: FeishuClient, to: FeishuRecipient): Promise<void> {
    const month = beijingMonth();
    if (this.quotaUsed() < IMAGE_STOP_AT || this.host.getMeta("fs_quota_warned") === month) return;
    this.host.setMeta("fs_quota_warned", month);
    await client.sendText(to, `本月飞书调用已用 ${this.quotaUsed()} 次（上限 ${QUOTA_LIMIT}），从现在到月底推送只发文字、不配图；到 ${SEND_STOP_AT} 次会完全停发，下个月 1 号自动恢复。`)
      .catch(() => undefined);
  }

  /** 样卡：各 IP 最近一条推送拼成一张，立刻发给自用私聊（不进队列）。群的样卡在主站「推送」页逐个「试发」。 */
  private async sendSample(): Promise<void> {
    const to = this.recipient;
    if (!this.configured || !to) return;
    const messages = this.sampleMessages();
    if (messages.length === 0) {
      await this.client().sendText(to, "最近 7 天还没有推送记录，等下一轮有新货就会发过来。");
      return;
    }
    const result = await this.sendDigest(to, messages, true, this.nextRunAt(await this.host.rounds()));
    if (result.error) throw new Error(result.error);
  }

  /** 各 IP 最近一条每小时推送，每条最多 6 件。 */
  private sampleMessages(): StoredPush[] {
    const rows = this.host.sql.exec<{ id: number; body: string }>(
      "SELECT id,body FROM messages WHERE body LIKE '%\"kind\":\"hourly_digest\"%' ORDER BY id DESC LIMIT 60",
    ).toArray();
    const latest = new Map<string, StoredPush>();
    for (const row of rows) {
      const message = { id: row.id, ...(JSON.parse(row.body) as Record<string, unknown>) } as StoredPush;
      const profileId = typeof message.profileId === "string" ? message.profileId : "";
      if (profileId && !latest.has(profileId)) latest.set(profileId, message);
    }
    return [...latest.values()].map((message) => ({
      ...message,
      items: Array.isArray(message.items) ? message.items.slice(0, 6) : [],
    }));
  }

  // ---------- 群（主站「推送」页经 /feishu/groups 管） ----------

  listGroups(): GroupView[] {
    return this.host.sql.exec<GroupRow>("SELECT * FROM feishu_groups ORDER BY created_at").toArray().map(groupView);
  }

  private groupRow(id: string): GroupRow {
    const row = this.host.sql.exec<GroupRow>("SELECT * FROM feishu_groups WHERE id=?", id).toArray()[0];
    if (!row) throw new GroupInputError("找不到这个群，可能已经删了");
    return row;
  }

  private static cleanName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || name.length > 40) throw new GroupInputError("群名要填，40 个字以内");
    return name;
  }

  private static cleanWebhook(value: unknown): string {
    const url = typeof value === "string" ? value.trim() : "";
    if (!WEBHOOK_PREFIXES.some((prefix) => url.startsWith(prefix) && url.length > prefix.length) || url.length > 300) {
      throw new GroupInputError("webhook 地址不对：应该是 https://open.feishu.cn/open-apis/bot/v2/hook/ 开头的那一串（群设置 → 群机器人 → 自定义机器人里复制）");
    }
    return url;
  }

  private static cleanSecret(value: unknown): string | null {
    const secret = typeof value === "string" ? value.trim() : "";
    if (secret.length > 200) throw new GroupInputError("签名密钥太长了，检查一下是不是粘错了");
    return secret || null;
  }

  private static cleanProfiles(value: unknown): string | null {
    if (value === null) return null;
    if (!Array.isArray(value) || value.length > 200 || !value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100)) {
      throw new GroupInputError("要收的 IP 不对");
    }
    return JSON.stringify([...new Set(value as string[])]);
  }

  createGroup(input: GroupInput): GroupView {
    const count = this.host.sql.exec<{ n: number }>("SELECT count(*) n FROM feishu_groups").one().n;
    if (count >= MAX_GROUPS) throw new GroupInputError(`最多 ${MAX_GROUPS} 个群`);
    const row: GroupRow = {
      id: crypto.randomUUID(),
      name: FeishuDesk.cleanName(input.name),
      webhook_url: FeishuDesk.cleanWebhook(input.webhookUrl),
      secret: FeishuDesk.cleanSecret(input.secret),
      enabled: 1,
      profile_ids: input.profileIds === undefined ? null : FeishuDesk.cleanProfiles(input.profileIds),
      created_at: Date.now(),
      last_at: null,
      last_ok: null,
      last_error: null,
    };
    this.host.sql.exec(
      "INSERT INTO feishu_groups(id,name,webhook_url,secret,enabled,profile_ids,created_at) VALUES(?,?,?,?,?,?,?)",
      row.id, row.name, row.webhook_url, row.secret, row.enabled, row.profile_ids, row.created_at,
    );
    return groupView(row);
  }

  /** 只改带了的字段。换 webhook 地址时签名密钥跟着换（没填就是不验签）。 */
  updateGroup(id: string, input: GroupInput): GroupView {
    const row = this.groupRow(id);
    if (input.name !== undefined) row.name = FeishuDesk.cleanName(input.name);
    if (input.webhookUrl !== undefined) {
      row.webhook_url = FeishuDesk.cleanWebhook(input.webhookUrl);
      row.secret = FeishuDesk.cleanSecret(input.secret);
      row.last_at = null;
      row.last_ok = null;
      row.last_error = null;
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw new GroupInputError("开关不对");
      row.enabled = input.enabled ? 1 : 0;
    }
    if (input.profileIds !== undefined) row.profile_ids = FeishuDesk.cleanProfiles(input.profileIds);
    this.host.sql.exec(
      "UPDATE feishu_groups SET name=?,webhook_url=?,secret=?,enabled=?,profile_ids=?,last_at=?,last_ok=?,last_error=? WHERE id=?",
      row.name, row.webhook_url, row.secret, row.enabled, row.profile_ids, row.last_at, row.last_ok, row.last_error, row.id,
    );
    return groupView(row);
  }

  deleteGroup(id: string): void {
    this.groupRow(id);
    this.host.sql.exec("DELETE FROM feishu_groups WHERE id=?", id);
  }

  /**
   * 「试发」：这个群要的 IP 最近一条推送拼成样卡发过去；最近 7 天这些 IP 都没新货，就发一张「接上了」的说明卡。
   * 不看这个群开没开（关着也能先试通再打开）。失败把飞书的报错抛给页面。
   */
  async testGroup(id: string): Promise<{ cards: number }> {
    const row = this.groupRow(id);
    const result = await this.sendGroupDigest(row, this.sampleMessages(), undefined, true);
    if (result.error) throw new Error(result.error);
    if (result.cards > 0) return { cards: result.cards };
    const wanted = groupProfiles(row);
    const names = new Map<string, string>();
    for (const round of await this.host.rounds()) {
      if (typeof round.profileId === "string" && typeof round.profileName === "string") names.set(round.profileId, shortProfileName(round.profileName));
    }
    try {
      await sendWebhookCard(row.webhook_url, row.secret ?? undefined, buildGroupTestCard(row.name, wanted && wanted.map((pid) => names.get(pid) ?? pid)));
      this.markGroup(row.id, null);
    } catch (error) {
      this.markGroup(row.id, error instanceof Error ? error.message.slice(0, 300) : String(error));
      throw error;
    }
    return { cards: 1 };
  }

  /** 主站「推送」页上的私聊开关，和飞书里点「暂停私聊」是同一个。 */
  setOwnerEnabled(on: boolean): void {
    this.host.setMeta("fs_enabled", on ? "1" : "0");
  }

  // ---------- 状态卡 ----------

  private async statusModel(welcome: boolean): Promise<StatusCardModel> {
    const latest = new Map<string, StatusCardModel["rounds"][number]>();
    for (const round of await this.host.rounds()) {
      const profileId = typeof round.profileId === "string" ? round.profileId : "";
      if (!profileId || latest.has(profileId)) continue;
      latest.set(profileId, {
        name: shortProfileName(typeof round.profileName === "string" ? round.profileName : profileId),
        ...(typeof round.finishedAt === "string" ? { finishedAt: round.finishedAt } : {}),
        ...(typeof round.newItems === "number" ? { newItems: round.newItems } : {}),
        ...(typeof round.nextRunAt === "string" ? { nextRunAt: round.nextRunAt } : {}),
      });
    }
    return {
      enabled: this.enabled,
      welcome,
      quotaUsed: this.quotaUsed(),
      quotaLimit: QUOTA_LIMIT,
      imageStopAt: IMAGE_STOP_AT,
      rounds: [...latest.values()].sort((a, b) => a.name.localeCompare(b.name, "zh")),
      groups: this.host.sql.exec<{ on_count: number | null; total: number }>(
        "SELECT sum(enabled) on_count, count(*) total FROM feishu_groups",
      ).toArray().map((row) => ({ on: Number(row.on_count ?? 0), total: row.total }))[0] ?? { on: 0, total: 0 },
    };
  }

  // ---------- 事件（私聊消息、菜单） ----------

  /** 同一个事件飞书可能补推几次，只处理第一次。 */
  private firstSeen(eventId: string | undefined): boolean {
    if (!eventId) return true;
    const now = Date.now();
    this.host.sql.exec("DELETE FROM feishu_events WHERE seen_at<?", now - EVENT_KEEP_MS);
    return this.host.sql.exec("INSERT OR IGNORE INTO feishu_events(event_id,seen_at) VALUES(?,?)", eventId, now).rowsWritten > 0;
  }

  async onMessage(event: Record<string, unknown>, eventId: string | undefined): Promise<void> {
    if (!this.configured || !this.firstSeen(eventId)) return;
    const message = (event.message ?? {}) as { chat_type?: unknown; chat_id?: unknown; message_id?: unknown; message_type?: unknown; content?: unknown };
    const sender = ((event.sender as { sender_id?: { open_id?: unknown } } | undefined)?.sender_id?.open_id);
    if (message.chat_type !== "p2p" || typeof sender !== "string" || !sender) return;
    let welcome = false;
    if (!this.ownerOpenId) {
      this.host.setMeta("fs_owner_open_id", sender);
      this.host.setMeta("fs_enabled", "1");
      welcome = true;
      console.log(JSON.stringify({ event: "feishu_owner_bound" }));
    }
    if (sender !== this.ownerOpenId) return;
    // 和运营者的单聊会话号：按 open_id 私发被飞书拒（230101）时可以改按会话发。
    if (typeof message.chat_id === "string" && message.chat_id) this.host.setMeta("fs_owner_chat_id", message.chat_id);
    if (typeof message.message_id === "string" && message.message_id) this.host.setMeta("fs_owner_last_message_id", message.message_id);
    let text = "";
    if (message.message_type === "text" && typeof message.content === "string") {
      try {
        text = String((JSON.parse(message.content) as { text?: unknown }).text ?? "").trim();
      } catch {
        text = "";
      }
    }
    if (/^(暂停|停|关)/u.test(text)) this.host.setMeta("fs_enabled", "0");
    else if (/^(恢复|开启|开始|开)/u.test(text)) this.host.setMeta("fs_enabled", "1");
    else if (/^(样卡|测试)/u.test(text)) {
      await this.requestSample();
      return;
    }
    await this.client().sendCard(this.recipient ?? { type: "open_id", id: sender }, buildStatusCard(await this.statusModel(welcome)));
  }

  async onMenu(event: Record<string, unknown>, eventId: string | undefined): Promise<void> {
    if (!this.configured || !this.firstSeen(eventId)) return;
    const operator = (event.operator as { operator_id?: { open_id?: unknown } } | undefined)?.operator_id?.open_id;
    if (typeof operator !== "string" || operator !== this.ownerOpenId) return;
    const key = typeof event.event_key === "string" ? event.event_key : "";
    if (key === "sample") {
      await this.requestSample();
      return;
    }
    if (key === "pause") this.host.setMeta("fs_enabled", "0");
    if (key === "resume") this.host.setMeta("fs_enabled", "1");
    await this.client().sendCard(this.recipient ?? { type: "open_id", id: operator }, buildStatusCard(await this.statusModel(false)));
  }

  /** 手动发一张状态卡（验收 / 排查用，/feishu/ping）。返回飞书的 message_id，失败直接抛出飞书的报错。 */
  async ping(): Promise<string> {
    const to = this.recipient;
    if (!this.configured || !to) throw new Error("还没绑定接收人");
    return this.client().sendCard(to, buildStatusCard(await this.statusModel(false)));
  }

  async requestSample(): Promise<void> {
    this.host.setMeta("fs_sample_pending", "1");
    const current = await this.host.storage.getAlarm();
    if (current === null || current > Date.now() + 1_000) await this.host.storage.setAlarm(Date.now() + 500);
  }

  // ---------- 回调（卡片按钮） ----------

  async onCardAction(event: Record<string, unknown>): Promise<Record<string, unknown>> {
    const operator = (event.operator as { open_id?: unknown } | undefined)?.open_id;
    if (typeof operator !== "string" || operator !== this.ownerOpenId) {
      return { toast: { type: "warning", content: "这张卡只有绑定的接收人能操作" } };
    }
    const value = ((event.action as { value?: unknown } | undefined)?.value ?? {}) as CardActionValue;
    if (value.k === "toggle") {
      this.host.setMeta("fs_enabled", this.enabled ? "0" : "1");
      return {
        toast: { type: "success", content: this.enabled ? "私聊推送已恢复" : "私聊推送已暂停（群照发）" },
        card: { type: "raw", data: buildStatusCard(await this.statusModel(false)) },
      };
    }
    if (value.k === "sample") {
      await this.requestSample();
      return { toast: { type: "info", content: "样卡马上发过来" } };
    }
    if ((value.k !== "hide" && value.k !== "watch") || typeof value.c !== "string") {
      return { toast: { type: "error", content: "不认识的按钮" } };
    }
    const row = this.host.sql.exec<{ body: string }>("SELECT body FROM feishu_cards WHERE card_id=?", value.c).toArray()[0];
    if (!row) return { toast: { type: "warning", content: "这张卡超过 14 天，已经不能操作了" } };
    const model = JSON.parse(row.body) as DigestCardModel;
    const item = model.sections[Number(value.s)]?.items[Number(value.i)];
    if (!item?.sourceItemId) return { toast: { type: "error", content: "找不到这件商品" } };

    let toast: string;
    try {
      if (value.k === "hide") {
        if (!item.digestEventId) return { toast: { type: "error", content: "这件缺日报编号，没法标注" } };
        const verdict = item.hidden ? "undo" : "hide";
        await this.callWeb("POST", "/api/device/labels", {
          profileId: item.profileId,
          digestEventId: item.digestEventId,
          sourceId: item.sourceId,
          sourceItemId: item.sourceItemId,
          verdict,
        });
        item.hidden = verdict === "hide";
        toast = item.hidden ? "记下了：不想看" : "已撤销";
      } else {
        const body = { sourceId: item.sourceId, sourceItemId: item.sourceItemId };
        if (item.watching) {
          await this.callWeb("DELETE", "/api/device/watches", body);
          item.watching = false;
          toast = "不等了";
        } else {
          await this.callWeb("POST", "/api/device/watches", body);
          item.watching = true;
          toast = "开始盯降价，降了发邮件";
        }
      }
    } catch (error) {
      return { toast: { type: "error", content: error instanceof Error ? error.message : "没成功，稍后再点一次" } };
    }
    this.host.sql.exec("UPDATE feishu_cards SET body=? WHERE card_id=?", JSON.stringify(model), model.id);
    return { toast: { type: "success", content: toast }, card: { type: "raw", data: buildDigestCard(model) } };
  }

  private async callWeb(method: string, path: string, body: unknown): Promise<void> {
    const web = this.host.env.WEB;
    if (!web || !this.host.env.PUSH_DEVICE_TOKEN) throw new Error("主站没接上");
    let response: Response;
    try {
      response = await web.fetch(`https://web${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.host.env.PUSH_DEVICE_TOKEN}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      });
    } catch {
      throw new Error("主站响应太慢，稍后再点一次");
    }
    if (response.ok) return;
    const text = (await response.text()).slice(0, 300);
    console.error(JSON.stringify({ event: "feishu_web_call_failed", path, status: response.status, body: text }));
    if (text.includes("watch_limit_reached")) throw new Error("在盯降价的已经满 30 件了");
    if (text.includes("watch_profile_completed")) throw new Error("这件已经盯完了（卖掉或下架）");
    if (text.includes("listing_not_found")) throw new Error("库里还没有这件，过一会儿再试");
    throw new Error(`没成功（${response.status}）`);
  }

  // ---------- 给 /feishu/status 看 ----------

  async status(): Promise<Record<string, unknown>> {
    const queue = this.host.sql.exec<{ n: number }>("SELECT count(*) n FROM feishu_queue").one().n;
    return {
      configured: this.configured,
      ownerBound: Boolean(this.ownerOpenId),
      ownerOpenId: this.ownerOpenId ?? null,
      ownerChatId: this.host.getMeta("fs_owner_chat_id") ?? null,
      ownerLastMessageId: this.host.getMeta("fs_owner_last_message_id") ?? null,
      enabled: this.enabled,
      quotaMonth: beijingMonth(),
      quotaUsed: this.quotaUsed(),
      queued: queue,
      groupImages: String(this.host.env.FEISHU_WEBHOOK_IMAGES) !== "0",
      groups: this.listGroups(),
      alarmAt: await this.host.storage.getAlarm(),
    };
  }
}
