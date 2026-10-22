import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { bindPostgresDatabase } from "@jpgr/db";

export function getEnv() {
  return bindPostgresDatabase(getCloudflareContext().env);
}
