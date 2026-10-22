import { unauthorized } from "@/lib/api-auth";
import { denyMutation } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

function collectorResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
  });
}

export async function GET(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const jobId = new URL(request.url).searchParams.get("jobId")?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/iu.test(jobId)) return Response.json({ error: "invalid_job_id" }, { status: 400 });
  const response = await getEnv().COLLECTOR.fetch(
    `http://collector/internal/ai/jobs/listing/${encodeURIComponent(jobId)}`,
  );
  return collectorResponse(response);
}

export async function POST(request: Request) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  let body: string;
  try {
    body = JSON.stringify(await request.json());
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const response = await getEnv().COLLECTOR.fetch("http://collector/internal/ai/jobs/listing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return collectorResponse(response);
}
