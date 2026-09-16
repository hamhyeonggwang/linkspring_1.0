// Shared by Cloudflare D1 and the desktop SQLite adapter.
export interface PreparedQuery {
  bind(...values: unknown[]): PreparedQuery;
  run(): Promise<unknown>;
}
export interface DatabasePort {
  prepare(sql: string): PreparedQuery;
  batch(queries: PreparedQuery[]): Promise<{ results: unknown[] }[]>;
}
