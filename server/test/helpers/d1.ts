// 基于 bun:sqlite 的最小 D1 内存实现，仅覆盖本后端用到的 prepare/bind/first/all/run/batch/exec。
import { Database } from 'bun:sqlite';

class ShimStmt {
  private bound: (string | number | null)[] = [];
  constructor(
    private readonly db: Database,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.bound = values.map((v) => (v === undefined ? null : (v as string | number | null)));
    return this;
  }

  run(): { success: boolean; meta: { changes: number; last_row_id: number } } {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.bound);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  all<T>(): { results: T[]; success: boolean } {
    const stmt = this.db.prepare(this.sql);
    return { results: stmt.all(...this.bound) as T[], success: true };
  }

  first<T>(colName?: string): T | null {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.bound) as Record<string, unknown> | null;
    if (!row) return null;
    if (colName !== undefined) return (row[colName] ?? null) as T | null;
    return row as T;
  }

  raw(): unknown {
    return this.all().results;
  }
}

export type ShimStmtLike = ShimStmt;

export class MemoryD1 {
  readonly inner: Database;

  constructor() {
    this.inner = new Database(':memory:');
    this.inner.exec('PRAGMA foreign_keys = ON');
  }

  applySchema(sql: string): void {
    this.inner.exec(sql);
  }

  prepare(sql: string): ShimStmt {
    return new ShimStmt(this.inner, sql);
  }

  async batch<T>(statements: ShimStmt[]): Promise<{ results: T[]; success: boolean }> {
    const results: T[] = [];
    this.inner.exec('BEGIN');
    try {
      for (const s of statements) {
        const r = s.run();
        results.push(r as unknown as T);
      }
      this.inner.exec('COMMIT');
      return { results, success: true };
    } catch (e) {
      this.inner.exec('ROLLBACK');
      throw e;
    }
  }

  async exec(sql: string): Promise<void> {
    this.inner.exec(sql);
  }
}
