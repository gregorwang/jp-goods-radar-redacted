import { privateJson } from "./api-response";
import { hasAdminSession } from "./auth";
export async function unauthorized(): Promise<Response | null> { return (await hasAdminSession()) ? null : privateJson({ error: "unauthorized" }, { status: 401 }); }
