import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Worker integration tests use an isolated PostgreSQL 17 container. No
// production credential or production data is involved.
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_ANALYTICS_DB ??=
  "postgres://jpgr_test:jpgr_test@127.0.0.1:55432/jpgr_test";
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_PRIMARY_DB ??=
  "postgres://jpgr_test:jpgr_test@127.0.0.1:55432/jpgr_test";

export default defineConfig({
  resolve: {
    alias: {
      "@jpgr/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@jpgr/ai": fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
      "@jpgr/analytics": fileURLToPath(new URL("./packages/analytics/src/index.ts", import.meta.url)),
      "@jpgr/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
      "@jpgr/adapters": fileURLToPath(new URL("./packages/adapters/src/index.ts", import.meta.url)),
      "@jpgr/email": fileURLToPath(new URL("./packages/email/src/index.ts", import.meta.url)),
      "@jpgr/notifications": fileURLToPath(new URL("./packages/notifications/src/index.ts", import.meta.url)),
      "@jpgr/validation": fileURLToPath(new URL("./packages/validation/src/index.ts", import.meta.url)),
    },
  },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./apps/collector/wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          YAHOO_CLOUDFLARE_DIRECT_ENABLED: "false",
          SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "false",
          BROWSER_RUN_FALLBACK_ENABLED: "false",
        },
      },
    })),
  ],
  test: {
    include: ["tests/workers/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15_000,
    globalSetup: ["./tests/workers/postgres-global-setup.ts"],
    setupFiles: ["./tests/workers/setup.ts"],
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["pg"],
          rolldownOptions: {
            external: [
              ...builtinModules,
              ...builtinModules.map((moduleName) => `node:${moduleName}`),
            ],
          },
        },
      },
    },
  },
});
