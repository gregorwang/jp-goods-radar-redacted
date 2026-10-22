import "server-only";
import { cookies } from "next/headers";
import { getEnv } from "./cloudflare";
import {
  decodeSession,
  encodeSession,
  verifyPasswordDigest,
} from "./auth-core";

export { validOrigin } from "./auth-core";

export async function verifyPassword(password: string): Promise<boolean> {
  const env = getEnv();
  return verifyPasswordDigest(env.ADMIN_AUTH_SECRET, env.ADMIN_PASSWORD_DIGEST, password);
}

export async function createAdminSession(): Promise<void> {
  const env = getEnv();
  // 会话是自包含的签名令牌，没有服务端状态可吊销，因此有效期按 7 天封顶以限制
  // Cookie 泄露的暴露窗口。需要立即吊销全部会话时轮换 SESSION_SIGNING_SECRET。
  const maxAge = 7 * 24 * 60 * 60;
  const value = await encodeSession(
    env.SESSION_SIGNING_SECRET,
    { sub: "admin", exp: Date.now() + maxAge * 1000, nonce: crypto.randomUUID() },
  );
  (await cookies()).set(env.SESSION_COOKIE_NAME || "jpgr_session", value, {
    // 生产域名只有 HTTPS；浏览器把 localhost 视为安全上下文，本地开发同样能收到该 Cookie。
    httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge,
  });
}

export async function deleteAdminSession(): Promise<void> {
  const env = getEnv();
  (await cookies()).delete(env.SESSION_COOKIE_NAME || "jpgr_session");
}

export async function hasAdminSession(): Promise<boolean> {
  const env = getEnv();
  const value = (await cookies()).get(env.SESSION_COOKIE_NAME || "jpgr_session")?.value;
  return (await decodeSession(env.SESSION_SIGNING_SECRET, value)) !== null;
}
