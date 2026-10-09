// 用 Node 內建的 SQLite 模擬 D1，讓核心邏輯可以在本機測試
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class Stmt {
  params: unknown[] = [];
  constructor(private db: DatabaseSync, readonly sql: string) {}
  bind(...params: unknown[]) {
    this.params = params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
    return this;
  }
  private prepared() {
    return this.db.prepare(this.sql);
  }
  async first<T>() {
    return (this.prepared().all(...(this.params as never[]))[0] as T) ?? null;
  }
  async all<T>() {
    return { results: this.prepared().all(...(this.params as never[])) as T[], success: true, meta: {} };
  }
  async run() {
    const r = this.prepared().run(...(this.params as never[]));
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
  exec() {
    const p = this.prepared();
    if (/returning/i.test(this.sql)) {
      const rows = p.all(...(this.params as never[]));
      return { results: rows, success: true, meta: { changes: rows.length } };
    }
    const r = p.run(...(this.params as never[]));
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
}

export function createTestDb(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}
