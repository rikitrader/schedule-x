/// <reference types="vite/client" />
import { DatabaseSync } from 'node:sqlite'

// In-memory D1 stand-in backed by Node's SQLite so tests exercise the real SQL and migrations.
type Value = string | number | null
class Statement {
  constructor(private db: DatabaseSync, private sql: string, private params: Value[] = []) {}
  bind(...params: unknown[]) { return new Statement(this.db, this.sql, params.map((value) => (typeof value === 'boolean' ? Number(value) : (value as Value)))) }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.params) ?? null) as T | null }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.params) as T[] } }
  async run() { const result = this.db.prepare(this.sql).run(...this.params); return { meta: { changes: Number(result.changes) } } }
  runSync() { this.db.prepare(this.sql).run(...this.params) }
}

export function createD1(...scripts: string[]) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const script of scripts) db.exec(script)
  return {
    raw: db,
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) { db.exec('BEGIN'); try { for (const statement of statements) statement.runSync(); db.exec('COMMIT') } catch (caught) { db.exec('ROLLBACK'); throw caught } return [] },
  } as unknown as D1Database & { raw: DatabaseSync }
}

const migrations = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
export const calendarSchema = Object.keys(migrations).sort().map((path) => migrations[path])
