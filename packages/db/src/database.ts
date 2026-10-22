export interface OperationalResultMeta {
  changes: number;
  duration?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
}

export interface OperationalResult<Row = unknown> {
  results: Row[];
  success: true;
  meta: OperationalResultMeta;
}

export interface OperationalPreparedStatement {
  bind(...values: unknown[]): OperationalPreparedStatement;
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
  all<Row = Record<string, unknown>>(): Promise<OperationalResult<Row>>;
  run<Row = Record<string, unknown>>(): Promise<OperationalResult<Row>>;
}

/**
 * The deliberately small PostgreSQL surface used by the application.
 *
 * Keeping connection management here lets Workers use Hyperdrive without
 * leaking pg clients or transaction details into business repositories.
 */
export interface OperationalDatabase {
  prepare(query: string): OperationalPreparedStatement;
  batch<Row = unknown>(
    statements: readonly OperationalPreparedStatement[],
  ): Promise<OperationalResult<Row>[]>;
}

export interface OperationalDatabaseBindings {
  PRIMARY_DB?: {
    readonly connectionString: string;
  };
}

export type OperationalRuntimeEnv<Bindings extends OperationalDatabaseBindings> =
  Omit<Bindings, "DB"> & {
    DB: OperationalDatabase;
  };
