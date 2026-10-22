import { PostgresOperationalDatabase } from "../packages/db/src/postgres";

interface ProbeEnv {
  PRIMARY_DB: {
    readonly connectionString: string;
  };
  PROBE_TOKEN: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
    },
  });
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (request.headers.get("Authorization") !== `Bearer ${env.PROBE_TOKEN}`) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    let database: PostgresOperationalDatabase | undefined;
    try {
      database = await PostgresOperationalDatabase.scoped(env.PRIMARY_DB.connectionString);
      const health = await database.prepare(
        `SELECT
           (SELECT COUNT(*) FROM source_registry) source_count,
           (SELECT COUNT(*) FROM watch_profiles) watch_profile_count`,
      ).first();
      return json({ ok: true, backend: "postgres", ...health });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({
        ok: false,
        backend: "postgres",
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: message
          .replace(/postgres(?:ql)?:\/\/[^@\s]+@/giu, "postgresql://[redacted]@")
          .slice(0, 500),
      }, 503);
    } finally {
      await database?.close().catch(() => undefined);
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
