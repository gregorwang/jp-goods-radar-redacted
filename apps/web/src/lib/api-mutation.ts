import { unauthorized } from "./api-auth";
import { privateJson } from "./api-response";
import { validOrigin } from "./auth";

export async function denyMutation(request: Request): Promise<Response | null> {
  const denied = await unauthorized();
  if (denied) return denied;
  return validOrigin(request) ? null : privateJson({ error: "invalid_origin" }, { status: 403 });
}

export function apiError(message: string, status = 400): Response {
  return privateJson({ error: message }, { status });
}

export async function readJsonBody(request: Request): Promise<
  { ok: true; value: unknown } | { ok: false; response: Response }
> {
  try {
    return { ok: true, value: await request.json() as unknown };
  } catch {
    return { ok: false, response: apiError("invalid_json") };
  }
}

export async function routeId(context: { params: Promise<{ id: string }> }): Promise<string> {
  return (await context.params).id;
}
