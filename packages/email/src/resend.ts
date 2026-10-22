import { readBoundedResponseText } from "@jpgr/core";

const MAX_RESEND_RESPONSE_BYTES = 4 * 1024;

export interface SendEmailInput {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  idempotencyKey: string;
  attachments?: Array<{
    filename: string;
    content: string;
  }>;
}

export async function sendResendEmail(input: SendEmailInput, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
      attachments: input.attachments,
    }),
    // 挂起的 Resend 连接会吃掉整个 Worker 调用预算，正文也必须与其他传输一样有上限。
    signal: AbortSignal.timeout(10_000),
  });
  const text = await readBoundedResponseText(
    response,
    MAX_RESEND_RESPONSE_BYTES,
    "Resend 响应超过 4 KiB 安全上限",
  );
  if (!response.ok) throw new Error(`Resend 请求失败 (${response.status})`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string") {
    throw new Error("Resend 响应缺少邮件 ID");
  }
  return body.id;
}
