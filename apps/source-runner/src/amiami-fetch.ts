import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AdapterError } from "@jpgr/adapters";
import { requireAllowedSourceRunnerUrl } from "./source-policy";

const SCRIPT = fileURLToPath(new URL("../python/amiami_fetch.py", import.meta.url));

export const fetchAmiamiWithChrome = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  if (request.method !== "GET") throw new AdapterError("AmiAmi 只允许查询", "source_runner_method_rejected");
  const url = requireAllowedSourceRunnerUrl("amiami", request.url);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(24_000)]);
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.env.AMIAMI_PYTHON ?? "python3", [SCRIPT], {
      signal, timeout: 24_000, maxBuffer: 2_500_000, windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        let reason = "transport_failed";
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
            && /^[A-Za-z_]{1,60}$/u.test(parsed.error)) reason = parsed.error;
        } catch { /* Never include process stderr or environment values. */ }
        reject(new AdapterError(`AmiAmi 网络传输失败：${reason}`, signal.aborted ? "request_timeout" : "amiami_transport_error", undefined, reason !== "response_too_large"));
      } else resolve(stdout);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify({ url: url.href }));
  });
  let result: { status: number; headers: Record<string, string>; body: string };
  try { result = JSON.parse(output); } catch { throw new AdapterError("AmiAmi 传输返回格式异常", "amiami_transport_invalid_response"); }
  if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.body !== "string") {
    throw new AdapterError("AmiAmi 传输返回状态异常", "amiami_transport_invalid_response");
  }
  const body = Buffer.from(result.body, "base64");
  if (body.byteLength > 1_700_000) throw new AdapterError("AmiAmi 响应超过上限", "response_too_large");
  const headers = new Headers(result.headers);
  headers.set("x-jpgr-source-runner-transport", "curl_cffi");
  const response = new Response([204, 205, 304].includes(result.status) ? null : body, { status: result.status, headers });
  Object.defineProperty(response, "url", { value: url.href });
  return response;
}) as typeof fetch;
