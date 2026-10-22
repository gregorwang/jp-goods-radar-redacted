import { DurableObject } from "cloudflare:workers";
import { FeishuDesk, GroupInputError } from "./feishu/desk";

/**
 * 唯一的一个实例（idFromName("owner")）：存最近 7 天的消息，托管手机的 WebSocket 长连接。
 *
 * 用 Hibernation API：连接闲着时实例休眠、不计时长费；手机每 4 分钟发的文本 `ping`
 * 由运行时按 setWebSocketAutoResponse 直接回 `pong`，不唤醒实例。
 *
 * 推给手机的帧（App 端 RelayClient 按 type 分）：
 *   {"type":"hello","latestId":N,"serverTime":"…"}   连上时发一次，App 据此判断要不要补发
 *   {"type":"message","message":{id,eventKey,kind,…}}  新消息
 *   {"type":"round","round":{profileId,scanStartedAt,finishedAt,newItems,nextRunAt,…}}  某个档案跑完一批（没新货也发），不弹通知
 * 手机可回 {"ack":id}，只用来在 /status 里显示"最后送达"。
 *
 * 2026-10-13 起同一份消息还会发到飞书（feishu/desk.ts）：每小时那几条攒成一张带九宫格图的卡片，私聊发给运营者。
 * App 照旧，两路互不影响；飞书这一路用到 DO alarm。
 */

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/** WebSocket 单帧上限 1 MiB；一轮新货特别多时（建档后第一轮能有上百张卡）也要装得下。 */
const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_PAGE = 100;
/** 巡回批次留 12 小时：够跨过夜里停跑的 0–5 点，首页还能显示「上一轮」。 */
const ROUND_KEEP_MS = 12 * 60 * 60 * 1_000;

export interface StoredMessage {
  id: number;
  [key: string]: unknown;
}

export type PublishResult = { id: number; duplicate: boolean; delivered: number };

export class PushHub extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  readonly feishu: FeishuDesk;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      body TEXT NOT NULL
    )`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // 各档案最近几小时每一批巡回的结果：App 首页顶上那行「上一轮几点跑完、几件新货、下一轮几点」。
    // 同一档案一小时里会分好几批开跑（雅虎拍卖比其他来源晚几分钟），按 (档案, 开跑时间) 各存一条，App 再按小时加总。
    // 第一版按档案只留一条（rounds 表），会把同一小时前一批的新货件数盖掉，已弃用。
    this.sql.exec("DROP TABLE IF EXISTS rounds");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS round_batches(
      profile_id TEXT NOT NULL,
      scan_started_at TEXT NOT NULL,
      finished_at INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY(profile_id, scan_started_at)
    )`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.feishu = new FeishuDesk({
      sql: this.sql,
      env,
      storage: ctx.storage,
      getMeta: (key) => this.getMeta(key),
      setMeta: (key, value) => this.setMeta(key, value),
      rounds: () => this.rounds(),
    });
  }

  override async alarm(): Promise<void> {
    await this.feishu.onAlarm();
  }

  async feishuMessage(event: Record<string, unknown>, eventId: string | undefined): Promise<void> {
    await this.feishu.onMessage(event, eventId);
  }

  async feishuMenu(event: Record<string, unknown>, eventId: string | undefined): Promise<void> {
    await this.feishu.onMenu(event, eventId);
  }

  async feishuCardAction(event: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.feishu.onCardAction(event);
  }

  async feishuSample(): Promise<void> {
    await this.feishu.requestSample();
  }

  async feishuPing(): Promise<string> {
    return this.feishu.ping();
  }

  async feishuStatus(): Promise<Record<string, unknown>> {
    return this.feishu.status();
  }

  /** collector 问一批推送发到飞书的结果（见 FeishuDesk.outcomes）。 */
  async feishuOutcomes(ids: number[]): Promise<ReturnType<FeishuDesk["outcomes"]>> {
    return this.feishu.outcomes(ids);
  }

  /**
   * 主站「推送」页：群的增删改、试发、私聊开关。返回 HTTP 状态码和 JSON 正文，入口原样回出去：
   * 填错了 400（GroupInputError 那句话），试发时飞书不收 502。DO 的 RPC 抛自定义错误类型会丢，所以在这里转好。
   */
  async feishuAdmin(
    action: "create" | "update" | "delete" | "test" | "owner",
    id: string | null,
    input: Record<string, unknown>,
  ): Promise<{ status: number; body: string }> {
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
    const fail = (status: number, error: string) => ({ status, body: JSON.stringify({ error }) });
    try {
      switch (action) {
        case "create":
          return ok({ group: this.feishu.createGroup(input) });
        case "update":
          return ok({ group: this.feishu.updateGroup(id ?? "", input) });
        case "delete":
          this.feishu.deleteGroup(id ?? "");
          return ok({ deleted: true });
        case "test":
          return ok(await this.feishu.testGroup(id ?? ""));
        case "owner":
          if (typeof input.enabled !== "boolean") return fail(400, "开关不对");
          this.feishu.setOwnerEnabled(input.enabled);
          return ok({ enabled: this.feishu.enabled });
      }
    } catch (error) {
      if (error instanceof GroupInputError) return fail(400, error.message);
      if (action === "test") return fail(502, `飞书没收：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** WebSocket 升级。鉴权在 Worker 入口做完了才会转到这里。 */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello", latestId: this.latestId(), serverTime: new Date().toISOString() }));
    this.setMeta("last_connect_at", new Date().toISOString());
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    // 自动应答只认完全等于 "ping" 的帧；其余都走这里。
    if (data === "ping") {
      ws.send("pong");
      return;
    }
    try {
      const parsed = JSON.parse(data) as { ack?: unknown };
      if (typeof parsed.ack === "number" && Number.isSafeInteger(parsed.ack)) {
        this.setMeta("last_ack_id", String(parsed.ack));
        this.setMeta("last_ack_at", new Date().toISOString());
      }
    } catch {
      // 不认识的帧直接忽略。
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // 已经关了。
    }
  }

  override async webSocketError(): Promise<void> {
    // 断开由 App 端心跳发现并重连，这里无事可做。
  }

  /** collector 投来的一条消息。按 eventKey 幂等：同一封日报重投不产生第二条、不再推一次。 */
  async publish(message: Record<string, unknown>): Promise<PublishResult> {
    const eventKey = typeof message.eventKey === "string" ? message.eventKey.trim() : "";
    if (!eventKey || eventKey.length > 300) throw new Error("eventKey 缺失或过长");
    const existing = this.sql.exec<{ id: number }>("SELECT id FROM messages WHERE event_key=?", eventKey).toArray()[0];
    if (existing) return { id: existing.id, duplicate: true, delivered: 0 };

    const { id: _ignored, ...rest } = message;
    const createdAt = typeof rest.createdAt === "string" && !Number.isNaN(Date.parse(rest.createdAt))
      ? rest.createdAt
      : new Date().toISOString();
    const body = JSON.stringify({ ...rest, eventKey, createdAt });
    if (new TextEncoder().encode(body).byteLength > MAX_MESSAGE_BYTES) throw new Error("消息超过 64 KiB");

    const now = Date.now();
    this.sql.exec("DELETE FROM messages WHERE created_at<?", now - RETENTION_MS);
    const inserted = this.sql.exec<{ id: number }>(
      "INSERT INTO messages(event_key,created_at,body) VALUES(?,?,?) RETURNING id",
      eventKey, now, body,
    ).one();
    const frame = JSON.stringify({ type: "message", message: { id: inserted.id, ...JSON.parse(body) } });
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(frame);
        delivered += 1;
      } catch {
        // 半开的连接：App 心跳超时后会自己重连并补发。
      }
    }
    this.setMeta("last_publish_at", new Date(now).toISOString());
    try {
      await this.feishu.enqueue(inserted.id, rest.kind, rest.profileId);
    } catch (error) {
      // 飞书这一路出错不能影响 App 和 collector 的投递结果。
      console.error(JSON.stringify({ event: "feishu_enqueue_failed", error: String(error).slice(0, 300) }));
    }
    return { id: inserted.id, duplicate: false, delivered };
  }

  /**
   * collector 每跑完一批就报一次（有没有新货都报）。按 (档案, 开跑时间) 存，推给在线的手机，不弹通知。
   * 同一批重复报（队列重试）以更晚跑完的为准；只留最近 ROUND_KEEP_MS。
   */
  async publishRound(round: Record<string, unknown>): Promise<{ delivered: number }> {
    const profileId = typeof round.profileId === "string" ? round.profileId.trim() : "";
    const scanStartedAt = typeof round.scanStartedAt === "string" ? round.scanStartedAt.trim() : "";
    const finishedAt = typeof round.finishedAt === "string" ? Date.parse(round.finishedAt) : Number.NaN;
    if (!profileId || profileId.length > 100 || !scanStartedAt || scanStartedAt.length > 40 || Number.isNaN(finishedAt)) {
      throw new Error("profileId / scanStartedAt / finishedAt 缺失");
    }
    const body = JSON.stringify(round);
    if (body.length > 8 * 1024) throw new Error("round 过大");
    this.sql.exec(
      `INSERT INTO round_batches(profile_id,scan_started_at,finished_at,body) VALUES(?,?,?,?)
       ON CONFLICT(profile_id,scan_started_at) DO UPDATE SET finished_at=excluded.finished_at,body=excluded.body
       WHERE excluded.finished_at>=round_batches.finished_at`,
      profileId, scanStartedAt, finishedAt, body,
    );
    this.sql.exec("DELETE FROM round_batches WHERE finished_at<?", Date.now() - ROUND_KEEP_MS);
    const frame = JSON.stringify({ type: "round", round });
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(frame);
        delivered += 1;
      } catch {
        // 同 publish。
      }
    }
    return { delivered };
  }

  /** 最近 ROUND_KEEP_MS 里每一批，从新到旧。App 打开和重连时拉一次。 */
  async rounds(): Promise<Record<string, unknown>[]> {
    return this.sql.exec<{ body: string }>(
      "SELECT body FROM round_batches WHERE finished_at>=? ORDER BY finished_at DESC LIMIT 200",
      Date.now() - ROUND_KEEP_MS,
    ).toArray().map((row) => JSON.parse(row.body) as Record<string, unknown>);
  }

  /** after 之后的消息，从旧到新。App 重连补发、首次打开拉历史都用它。 */
  async messagesAfter(after: number, limit: number): Promise<StoredMessage[]> {
    const page = Math.max(1, Math.min(MAX_PAGE, Math.floor(limit)));
    const since = Date.now() - RETENTION_MS;
    return this.sql.exec<{ id: number; body: string }>(
      "SELECT id,body FROM messages WHERE id>? AND created_at>=? ORDER BY id ASC LIMIT ?",
      Math.max(0, Math.floor(after)), since, page,
    ).toArray().map((row) => ({ id: row.id, ...(JSON.parse(row.body) as Record<string, unknown>) }));
  }

  async status(): Promise<Record<string, unknown>> {
    const meta = Object.fromEntries(
      this.sql.exec<{ key: string; value: string }>("SELECT key,value FROM meta").toArray().map((row) => [row.key, row.value]),
    );
    const count = this.sql.exec<{ n: number }>("SELECT count(*) n FROM messages").one().n;
    return {
      connections: this.ctx.getWebSockets().length,
      latestId: this.latestId(),
      storedMessages: count,
      lastConnectAt: meta.last_connect_at ?? null,
      lastPublishAt: meta.last_publish_at ?? null,
      lastAckId: meta.last_ack_id ? Number(meta.last_ack_id) : null,
      lastAckAt: meta.last_ack_at ?? null,
    };
  }

  private latestId(): number {
    return this.sql.exec<{ id: number | null }>("SELECT max(id) id FROM messages").one().id ?? 0;
  }

  private getMeta(key: string): string | undefined {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key=?", key).toArray()[0]?.value;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
  }
}
