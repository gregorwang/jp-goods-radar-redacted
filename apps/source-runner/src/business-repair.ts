import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { EmbeddedUpstreamResponseCapture } from "@jpgr/core";
import type { CreateJobBody } from "./schemas";
import type { RunnerExecutionOutcome, RunnerJobError } from "./execution";

const INCIDENT_CAPTURE_BUDGET_BYTES = 112_000;
const MAX_GATE_BYTES = 32_000;
const DEFAULT_RETRY_AFTER_SECONDS = 120;
const NON_REPAIRABLE_CODES = new Set([
  "captcha",
  "item_lookup_unsupported",
  "login_required",
  "request_replayed",
  "response_too_large",
  "source_cooldown",
  "source_runner_repair_pending",
  "surugaya_exact_query_not_found",
  "yahoo_auctions_local_rate_limited",
]);

type RepairGate = {
  schema: 1;
  sourceId: CreateJobBody["sourceId"];
  status: "pending" | "repairing" | "exhausted";
  incidentId: string;
  failureFingerprint?: string;
  originalCode?: string;
  operation?: CreateJobBody["operation"];
  suppressUntil?: string;
};

type BusinessFailureIncident = {
  schema: 1;
  kind: "source_runner_business_failure";
  target: "jpgr-source-runner.service";
  incidentId: string;
  createdAt: string;
  sourceId: CreateJobBody["sourceId"];
  operation: CreateJobBody["operation"];
  failureFingerprint: string;
  task: CreateJobBody;
  error: RunnerJobError;
  captures: readonly EmbeddedUpstreamResponseCapture[];
  policy: {
    repairScope: "vps_source_runner_only";
    cloudflareEditsAllowed: false;
    animateEditsAllowed: false;
    productionResultMustBeReplayed: true;
  };
};

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function normalizedFailureMessage(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/giu, "<id>")
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/gu, "<time>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 360);
}

export function businessFailureFingerprint(task: CreateJobBody, error: RunnerJobError): string {
  return createHash("sha256")
    .update(JSON.stringify({
      sourceId: task.sourceId,
      operation: task.operation,
      code: error.code,
      status: error.upstreamStatus,
      message: normalizedFailureMessage(error.message),
    }))
    .digest("hex");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  return new TextDecoder().decode(encoded.slice(0, maximumBytes));
}

export function boundedIncidentCaptures(
  captures: readonly EmbeddedUpstreamResponseCapture[],
  maximumBytes = INCIDENT_CAPTURE_BUDGET_BYTES,
): readonly EmbeddedUpstreamResponseCapture[] {
  const selected: EmbeddedUpstreamResponseCapture[] = [];
  let remaining = Math.max(0, maximumBytes);
  for (const capture of captures.slice(-4)) {
    if (remaining <= 0) break;
    const payload = capture.rawPayload
      ? truncateUtf8(capture.rawPayload, Math.min(remaining, 64_000))
      : undefined;
    if (payload !== undefined) remaining -= new TextEncoder().encode(payload).byteLength;
    selected.push({
      ...capture,
      ...(payload === undefined ? { rawPayload: undefined } : { rawPayload: payload }),
      truncated: capture.truncated || payload !== capture.rawPayload,
    });
  }
  return selected;
}

function eligibleForAutomaticRepair(error: RunnerJobError, task: CreateJobBody): boolean {
  // Newly integrated sources enter this runner through an observed migration. Keep their
  // first failures visible without allowing the VPS repair controller to edit
  // the adapter before a dedicated golden suite has been provisioned.
  if (task.sourceId === "mercari_jp" || task.sourceId === "amiami") return false;
  if (NON_REPAIRABLE_CODES.has(error.code)) return false;
  // Historical marketplaces routinely return 404 after a listing detail is
  // removed. That is item-level business state, not evidence that the shared
  // source parser is broken; opening a source-wide repair gate here blocks
  // every remaining search and sale candidate.
  if (error.code.endsWith("_item_not_found")) return false;
  if (error.code.endsWith("_rate_limited")) return false;
  if (task.operation === "item" && (error.upstreamStatus === 404 || error.upstreamStatus === 410)) return false;
  if (error.upstreamStatus === 403 || error.upstreamStatus === 429) return false;
  return true;
}

function pendingOutcome(
  original: RunnerJobError,
  incidentId: string,
  status: "pending" | "repairing",
): RunnerExecutionOutcome {
  return {
    ok: false,
    error: {
      ...original,
      retryable: true,
      retryAfterSeconds: Math.max(
        DEFAULT_RETRY_AFTER_SECONDS,
        original.retryAfterSeconds ?? 0,
      ),
      repairStatus: status,
      repairIncidentId: incidentId,
      repairOriginalCode: original.repairOriginalCode ?? original.code,
    },
    captures: [],
  };
}

export class BusinessRepairStore {
  readonly #root?: string;

  constructor(root: string | undefined) {
    const configured = root?.trim();
    this.#root = configured ? resolve(configured) : undefined;
  }

  get enabled(): boolean {
    return this.#root !== undefined;
  }

  async activeRepair(task: CreateJobBody): Promise<RunnerExecutionOutcome | undefined> {
    const gate = await this.#readGate(task.sourceId);
    if (!gate || (gate.status !== "pending" && gate.status !== "repairing")) return undefined;
    // Gates written by older versions did not record the failed operation.
    // A generic HTTP 404 gate without an explicit search operation is the
    // legacy item-not-found bug fixed below; ignore it so it cannot continue
    // blocking healthy searches after this version is deployed.
    if (gate.originalCode === "http_404" && gate.operation !== "search") return undefined;
    return pendingOutcome({
      code: "source_runner_repair_pending",
      message: `来源 ${task.sourceId} 的业务故障正在由自动修复 Agent 处理`,
      upstreamStatus: 503,
      retryable: true,
      retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
      repairOriginalCode: gate.originalCode ?? "source_runner_repair_pending",
    }, gate.incidentId, gate.status);
  }

  async recordFailure(
    task: CreateJobBody,
    outcome: RunnerExecutionOutcome,
  ): Promise<RunnerExecutionOutcome> {
    if (!this.#root || outcome.ok || !eligibleForAutomaticRepair(outcome.error, task)) return outcome;
    const fingerprint = businessFailureFingerprint(task, outcome.error);
    const gate = await this.#readGate(task.sourceId);
    if (gate?.status === "pending" || gate?.status === "repairing") {
      return {
        ...pendingOutcome(outcome.error, gate.incidentId, gate.status),
        captures: outcome.captures,
      };
    }
    if (
      gate?.status === "exhausted"
      && gate.failureFingerprint === fingerprint
      && gate.suppressUntil
      && Date.parse(gate.suppressUntil) > Date.now()
    ) {
      return outcome;
    }

    const incoming = join(this.#root, "incoming");
    const path = join(incoming, `${task.sourceId}-${fingerprint}.json`);
    let incidentId = `jpgr-business-${task.sourceId}-${randomUUID()}`;
    const incident: BusinessFailureIncident = {
      schema: 1,
      kind: "source_runner_business_failure",
      target: "jpgr-source-runner.service",
      incidentId,
      createdAt: new Date().toISOString(),
      sourceId: task.sourceId,
      operation: task.operation,
      failureFingerprint: fingerprint,
      task,
      error: outcome.error,
      captures: boundedIncidentCaptures(outcome.captures),
      policy: {
        repairScope: "vps_source_runner_only",
        cloudflareEditsAllowed: false,
        animateEditsAllowed: false,
        productionResultMustBeReplayed: true,
      },
    };
    try {
      await mkdir(incoming, { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(incident), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") {
        console.error(JSON.stringify({
          event: "source_runner_business_incident_write_failed",
          sourceId: task.sourceId,
          errorCode: nodeErrorCode(error) ?? "unknown",
        }));
        return outcome;
      }
      try {
        const existing = JSON.parse(await readFile(path, "utf8")) as { incidentId?: unknown };
        if (typeof existing.incidentId === "string") incidentId = existing.incidentId;
      } catch {
        return outcome;
      }
    }
    await this.#publishInitialGate(
      task.sourceId,
      incidentId,
      fingerprint,
      outcome.error.code,
      task.operation,
    );
    console.warn(JSON.stringify({
      event: "source_runner_business_repair_requested",
      incidentId,
      sourceId: task.sourceId,
      operation: task.operation,
      errorCode: outcome.error.code,
      failureFingerprint: fingerprint,
    }));
    return {
      ...pendingOutcome(outcome.error, incidentId, "pending"),
      captures: outcome.captures,
    };
  }

  assertIncidentPath(path: string): string {
    if (!this.#root) throw new Error("business_repair_disabled");
    const candidate = resolve(path);
    const rel = relative(this.#root, candidate);
    if (!isAbsolute(candidate) || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("business_repair_incident_path_rejected");
    }
    return candidate;
  }

  async readIncidentTask(path: string): Promise<CreateJobBody> {
    const candidate = this.assertIncidentPath(path);
    const info = await stat(candidate);
    if (!info.isFile() || info.size > 512_000) throw new Error("business_repair_incident_invalid");
    const parsed = JSON.parse(await readFile(candidate, "utf8")) as { task?: unknown };
    const { createJobBodySchema } = await import("./schemas");
    return createJobBodySchema.parse(parsed.task);
  }

  async #readGate(sourceId: CreateJobBody["sourceId"]): Promise<RepairGate | undefined> {
    if (!this.#root) return undefined;
    const path = join(this.#root, "gates", `${sourceId}.json`);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_GATE_BYTES) return undefined;
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RepairGate>;
      if (
        parsed.schema !== 1
        || parsed.sourceId !== sourceId
        || typeof parsed.incidentId !== "string"
        || !["pending", "repairing", "exhausted"].includes(String(parsed.status))
      ) return undefined;
      return parsed as RepairGate;
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") {
        console.error(JSON.stringify({
          event: "source_runner_business_gate_read_failed",
          sourceId,
          errorCode: nodeErrorCode(error) ?? "unknown",
        }));
      }
      return undefined;
    }
  }

  async #publishInitialGate(
    sourceId: CreateJobBody["sourceId"],
    incidentId: string,
    failureFingerprint: string,
    originalCode: string,
    operation: CreateJobBody["operation"],
  ): Promise<void> {
    if (!this.#root) return;
    const gates = join(this.#root, "gates");
    const path = join(gates, `${sourceId}.json`);
    try {
      await mkdir(gates, { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify({
        schema: 1,
        sourceId,
        status: "pending",
        incidentId,
        failureFingerprint,
        originalCode,
        operation,
      } satisfies RepairGate), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") {
        console.error(JSON.stringify({
          event: "source_runner_business_gate_write_failed",
          sourceId,
          errorCode: nodeErrorCode(error) ?? "unknown",
        }));
      }
    }
  }
}

export async function executeWithBusinessRepair(
  store: BusinessRepairStore,
  task: CreateJobBody,
  executor: (task: CreateJobBody) => Promise<RunnerExecutionOutcome>,
): Promise<RunnerExecutionOutcome> {
  const active = await store.activeRepair(task);
  if (active) return active;
  const outcome = await executor(task);
  return store.recordFailure(task, outcome);
}
