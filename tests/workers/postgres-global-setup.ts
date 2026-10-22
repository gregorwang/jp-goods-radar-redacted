import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = resolve(repositoryRoot, "docker-compose.postgres-test.yml");
const connectionString =
  "postgres://jpgr_test:jpgr_test@127.0.0.1:55432/jpgr_test";

function compose(...args: string[]): void {
  execFileSync("docker", [
    "compose",
    "-p",
    "jpgr-postgres-tests",
    "-f",
    composeFile,
    ...args,
  ], {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true,
  });
}

export default async function setup() {
  compose("up", "-d", "--wait");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS radar_core CASCADE");
    await client.query("DROP SCHEMA IF EXISTS radar_analytics CASCADE");
    await client.query(readFileSync(resolve(repositoryRoot, "postgres/schema.sql"), "utf8"));
    await client.query(readFileSync(resolve(repositoryRoot, "postgres/test-seed.sql"), "utf8"));
  } finally {
    await client.end();
  }

  return () => {
    compose("down", "--volumes");
  };
}
