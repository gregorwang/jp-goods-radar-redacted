import { env } from "cloudflare:workers";
import { PostgresOperationalDatabase } from "@jpgr/db";

export const testDatabase = new PostgresOperationalDatabase(
  env.PRIMARY_DB.connectionString,
);

// Direct function tests pass the generated Worker bindings without invoking
// the exported handler, so attach the same PostgreSQL surface the handler adds.
Reflect.set(env, "DB", testDatabase);
