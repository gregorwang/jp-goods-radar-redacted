import * as postgresModule from "pg";
import type {
  Client as PgClient,
  ClientConfig,
  QueryResult,
  QueryResultRow,
} from "pg";
import type {
  OperationalDatabase,
  OperationalDatabaseBindings,
  OperationalPreparedStatement,
  OperationalResult,
  OperationalRuntimeEnv,
} from "./database";
import { numberPostgresParameters } from "./postgres-parameters";
export { numberPostgresParameters } from "./postgres-parameters";

type PgClientFactory = (connectionString: string) => Promise<PgClient>;
type PgClientConstructor = new (config?: ClientConfig) => PgClient;

function isPgClientConstructor(value: unknown): value is PgClientConstructor {
  if (typeof value !== "function") return false;
  try {
    Reflect.construct(Object, [], value);
    return true;
  } catch {
    return false;
  }
}

function postgresClientConstructor(): PgClientConstructor {
  const moduleNamespace = postgresModule as unknown as {
    Client?: unknown;
    default?: unknown;
  };
  const defaultExport = moduleNamespace.default;
  if (
    typeof defaultExport === "object"
    && defaultExport !== null
    && "Client" in defaultExport
    && isPgClientConstructor(defaultExport.Client)
  ) {
    return defaultExport.Client;
  }
  if (isPgClientConstructor(moduleNamespace.Client)) {
    return moduleNamespace.Client;
  }
  if (isPgClientConstructor(defaultExport)) return defaultExport;
  throw new Error("postgres_client_constructor_unavailable");
}

const INTEGER_OIDS = new Set([20, 21, 23]);
const NUMERIC_OID = 1700;

function normalizeRows<Row extends QueryResultRow>(result: QueryResult<Row>): Row[] {
  const integerColumns = new Set(
    result.fields.filter((field) => INTEGER_OIDS.has(field.dataTypeID)).map((field) => field.name),
  );
  const numericColumns = new Set(
    result.fields.filter((field) => field.dataTypeID === NUMERIC_OID).map((field) => field.name),
  );
  if (integerColumns.size === 0 && numericColumns.size === 0) return result.rows;

  return result.rows.map((row) => {
    const normalized = { ...row } as Record<string, unknown>;
    for (const column of integerColumns) {
      const value = normalized[column];
      if (typeof value !== "string" || !/^-?\d+$/u.test(value)) continue;
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) normalized[column] = parsed;
    }
    for (const column of numericColumns) {
      const value = normalized[column];
      if (typeof value !== "string" || !/^-?(?:\d+|\d+\.\d+)$/u.test(value)) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed) && (!Number.isInteger(parsed) || Number.isSafeInteger(parsed))) {
        normalized[column] = parsed;
      }
    }
    return normalized as Row;
  });
}

async function defaultClientFactory(connectionString: string): Promise<PgClient> {
  const PostgresClient = postgresClientConstructor();
  const client = new PostgresClient({
    connectionString,
    application_name: "jp-goods-radar-worker",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
  try {
    await client.connect();
    await client.query("SET ROLE radar_core_runtime");
    await client.query("SET search_path TO radar_core, public");
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

class PostgresPreparedStatement implements OperationalPreparedStatement {
  constructor(
    private readonly database: PostgresOperationalDatabase,
    readonly query: string,
    readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): OperationalPreparedStatement {
    return new PostgresPreparedStatement(this.database, this.query, values);
  }

  async first<Row = Record<string, unknown>>(): Promise<Row | null> {
    const result = await this.database.execute<Row>(this.query, this.values);
    return result.results[0] ?? null;
  }

  all<Row = Record<string, unknown>>(): Promise<OperationalResult<Row>> {
    return this.database.execute<Row>(this.query, this.values);
  }

  run<Row = Record<string, unknown>>(): Promise<OperationalResult<Row>> {
    return this.database.execute<Row>(this.query, this.values);
  }
}

export class PostgresOperationalDatabase implements OperationalDatabase {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly connectionString: string,
    private readonly sharedClient?: PgClient,
    private readonly clientFactory: PgClientFactory = defaultClientFactory,
  ) {}

  static async scoped(
    connectionString: string,
    clientFactory: PgClientFactory = defaultClientFactory,
  ): Promise<PostgresOperationalDatabase> {
    const client = await clientFactory(connectionString);
    return new PostgresOperationalDatabase(connectionString, client, clientFactory);
  }

  prepare(query: string): OperationalPreparedStatement {
    return new PostgresPreparedStatement(this, query);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operationTail.then(operation, operation);
    this.operationTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private async withClient<T>(operation: (client: PgClient) => Promise<T>): Promise<T> {
    if (this.sharedClient) return this.serialize(() => operation(this.sharedClient!));
    const client = await this.clientFactory(this.connectionString);
    try {
      return await operation(client);
    } finally {
      await client.end();
    }
  }

  async execute<Row = Record<string, unknown>>(
    query: string,
    values: readonly unknown[],
  ): Promise<OperationalResult<Row>> {
    return this.withClient(async (client) => {
      const startedAt = performance.now();
      const result = await client.query<QueryResultRow>(
        numberPostgresParameters(query.trim()),
        values.map((value) => value === undefined ? null : value),
      );
      return {
        results: normalizeRows(result) as Row[],
        success: true,
        meta: {
          changes: result.rowCount ?? 0,
          duration: performance.now() - startedAt,
          rows_read: result.command === "SELECT" ? result.rowCount ?? 0 : 0,
          rows_written: result.command === "SELECT" ? 0 : result.rowCount ?? 0,
        },
      };
    });
  }

  async batch<Row = unknown>(
    statements: readonly OperationalPreparedStatement[],
  ): Promise<OperationalResult<Row>[]> {
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const results: OperationalResult<Row>[] = [];
        for (const statement of statements) {
          if (!(statement instanceof PostgresPreparedStatement)) {
            throw new Error("postgres_batch_received_foreign_statement");
          }
          const startedAt = performance.now();
          const result = await client.query<QueryResultRow>(
            numberPostgresParameters(statement.query.trim()),
            statement.values.map((value) => value === undefined ? null : value),
          );
          results.push({
            results: normalizeRows(result) as Row[],
            success: true,
            meta: {
              changes: result.rowCount ?? 0,
              duration: performance.now() - startedAt,
              rows_read: result.command === "SELECT" ? result.rowCount ?? 0 : 0,
              rows_written: result.command === "SELECT" ? 0 : result.rowCount ?? 0,
            },
          });
        }
        await client.query("COMMIT");
        return results;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.operationTail;
    if (this.sharedClient) await this.sharedClient.end();
  }
}

export function bindPostgresDatabase<Bindings extends OperationalDatabaseBindings>(
  bindings: Bindings,
): OperationalRuntimeEnv<Bindings> {
  if (!bindings.PRIMARY_DB?.connectionString) throw new Error("primary_hyperdrive_binding_missing");
  return {
    ...bindings,
    DB: new PostgresOperationalDatabase(bindings.PRIMARY_DB.connectionString),
  };
}

export async function withPostgresDatabase<
  Bindings extends OperationalDatabaseBindings,
  Result,
>(
  bindings: Bindings,
  operation: (env: OperationalRuntimeEnv<Bindings>) => Promise<Result>,
): Promise<Result> {
  if (!bindings.PRIMARY_DB?.connectionString) throw new Error("primary_hyperdrive_binding_missing");
  const database = await PostgresOperationalDatabase.scoped(bindings.PRIMARY_DB.connectionString);
  try {
    return await operation({
      ...bindings,
      DB: database,
    });
  } finally {
    await database.close();
  }
}
