// packages/agora-orchestrator/src/runstate/sqlite.ts
//
// SINGLE-WRITER INVARIANT (D3): this DB is the orchestrator service's exclusive
// property. Do NOT open it from the CLI, MCP, or any other process — those are
// clients of the running service, not of this file. Concurrent writers from
// separate processes are unsupported and will corrupt run-state.
//
import Database from 'better-sqlite3';
import type { ItemState, Run, RunStateStore, RunStatus, TerminalStatus } from '../contracts/index.js';

/** Shape of a row in the `items` table (column names are snake_case). */
interface ItemRow {
  id: string;
  run_id: string;
  queue: string;
  executor: string;
  inputs: string;
  depends_on: string;
  resource_locks: string;
  status: RunStatus;
  dispatch_hash: string | null;
  actor: string | null;
  attempts: number;
  next_attempt_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queues (name TEXT PRIMARY KEY, concurrency INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, queue TEXT NOT NULL, executor TEXT NOT NULL,
  inputs TEXT NOT NULL, depends_on TEXT NOT NULL, resource_locks TEXT NOT NULL,
  status TEXT NOT NULL, dispatch_hash TEXT,
  actor TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at REAL
);
CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, item_id TEXT NOT NULL);
`;

/** Columns added after initial schema — guarded migration. */
const MIGRATION_COLUMNS = [
  { name: 'actor', ddl: 'ALTER TABLE items ADD COLUMN actor TEXT' },
  { name: 'attempts', ddl: 'ALTER TABLE items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0' },
  { name: 'next_attempt_at', ddl: 'ALTER TABLE items ADD COLUMN next_attempt_at REAL' },
] as const;

export class SqliteRunStateStore implements RunStateStore {
  private db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL'); // no-op for :memory:; applies to file-backed DBs (the production deploy)
    this.db.exec(SCHEMA);
    this.runMigrations();
  }

  private runMigrations(): void {
    const existingCols = (
      this.db.prepare('PRAGMA table_info(items)').all() as { name: string }[]
    ).map((r) => r.name);
    for (const col of MIGRATION_COLUMNS) {
      if (!existingCols.includes(col.name)) {
        this.db.exec(col.ddl);
      }
    }
  }

  ensureQueue(name: string, concurrency: number): void {
    this.db
      .prepare(
        'INSERT INTO queues(name,concurrency) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET concurrency=excluded.concurrency',
      )
      .run(name, concurrency);
  }

  saveRun(run: Run, actor?: string): void {
    const tx = this.db.transaction((r: Run, a: string | undefined) => {
      for (const it of r.items)
        this.db.prepare(
          'INSERT INTO items(id,run_id,queue,executor,inputs,depends_on,resource_locks,status,dispatch_hash,actor,attempts,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,NULL,?,0,NULL)',
        ).run(it.id, r.id, r.queue, it.executor,
              JSON.stringify(it.inputs), JSON.stringify(it.depends_on),
              JSON.stringify(it.resourceLocks), 'pending',
              a ?? null);
    });
    tx(run, actor);
  }

  markReady(itemIds: string[]): void {
    const upd = this.db.prepare("UPDATE items SET status='ready' WHERE id=? AND status='pending'");
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) upd.run(id);
    });
    tx(itemIds);
  }

  setRunning(itemId: string, dispatchHash: string): void {
    this.db
      .prepare("UPDATE items SET status='running', dispatch_hash=? WHERE id=?")
      .run(dispatchHash, itemId);
  }

  setStatus(itemId: string, status: TerminalStatus): void {
    this.db.prepare('UPDATE items SET status=? WHERE id=?').run(status, itemId);
  }

  getItems(runId?: string): ItemState[] {
    const rows = (
      runId
        ? this.db.prepare('SELECT * FROM items WHERE run_id=? ORDER BY rowid').all(runId)
        : this.db.prepare('SELECT * FROM items ORDER BY rowid').all()
    ) as ItemRow[];
    return rows.map(this.rowToItem);
  }

  runningCount(queue: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) c FROM items WHERE queue=? AND status='running'")
        .get(queue) as { c: number }
    ).c;
  }

  queueConcurrency(queue: string): number {
    return (
      (this.db.prepare('SELECT concurrency FROM queues WHERE name=?').get(queue) as
        | { concurrency: number }
        | undefined)?.concurrency ?? 0
    );
  }

  heldLockKeys(): string[] {
    return (this.db.prepare('SELECT key FROM locks').all() as { key: string }[]).map((r) => r.key);
  }

  acquireLocks(itemId: string, keys: string[]): boolean {
    if (keys.length === 0) return true;
    const ins = this.db.prepare('INSERT INTO locks(key,item_id) VALUES(?,?)'); // PK conflict throws → better-sqlite3 rolls back the whole tx, so NO key is acquired (all-or-nothing)
    const tx = this.db.transaction((ks: string[]) => {
      for (const k of ks) ins.run(k, itemId);
    });
    try {
      tx(keys);
      return true;
    } catch {
      return false;
    }
  }

  releaseLocks(itemId: string): void {
    this.db.prepare('DELETE FROM locks WHERE item_id=?').run(itemId);
  }

  getActor(itemId: string): string | undefined {
    const row = this.db.prepare('SELECT actor FROM items WHERE id=?').get(itemId) as
      | { actor: string | null }
      | undefined;
    return row?.actor ?? undefined;
  }

  getAttempts(itemId: string): number {
    const row = this.db.prepare('SELECT attempts FROM items WHERE id=?').get(itemId) as
      | { attempts: number | null }
      | undefined;
    return row?.attempts ?? 0;
  }

  bumpAttempt(itemId: string): void {
    this.db.prepare('UPDATE items SET attempts = COALESCE(attempts, 0) + 1 WHERE id=?').run(itemId);
  }

  requeue(itemId: string, notBeforeMs: number): void {
    this.db
      .prepare("UPDATE items SET status='ready', next_attempt_at=? WHERE id=?")
      .run(notBeforeMs, itemId);
  }

  close(): void {
    this.db.close();
  }

  private rowToItem = (r: ItemRow): ItemState => ({
    id: r.id,
    runId: r.run_id,
    queue: r.queue,
    executor: r.executor,
    inputs: JSON.parse(r.inputs),
    depends_on: JSON.parse(r.depends_on),
    resourceLocks: JSON.parse(r.resource_locks),
    status: r.status,
    dispatchHash: r.dispatch_hash ?? undefined,
    actor: r.actor ?? undefined,
    attempts: r.attempts === 0 ? undefined : r.attempts,
    nextAttemptAt: r.next_attempt_at ?? undefined,
  });
}
