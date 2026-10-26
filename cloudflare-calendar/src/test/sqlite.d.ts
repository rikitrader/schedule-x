// Minimal typing for Node's built-in SQLite, used only by the test D1 shim.
declare module 'node:sqlite' {
  type Value = string | number | bigint | null | Uint8Array
  export class StatementSync { get(...params: Value[]): Record<string, unknown> | undefined; all(...params: Value[]): Record<string, unknown>[]; run(...params: Value[]): { changes: number | bigint } }
  export class DatabaseSync { constructor(path: string); exec(sql: string): void; prepare(sql: string): StatementSync }
}
