// 飞书的 secret 不放进 wrangler.jsonc 的 secrets.required：没配齐时飞书这一路不动，App 照常部署和运行。
interface Env {
  FEISHU_APP_SECRET?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
  FEISHU_ENCRYPT_KEY?: string;
  /** 群自定义机器人地址和签名密钥（secret）。没配就不发群。 */
  FEISHU_WEBHOOK_URL?: string;
  FEISHU_WEBHOOK_SECRET?: string;
}
