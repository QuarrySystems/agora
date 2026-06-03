---
title: agora-cron-scheduling
created: 2026-06-02
---

```mermaid
flowchart TD
    task-schedule-contracts["task-schedule-contracts: scheduling contracts<br/>files: contracts/schedule.ts +3 more"]
    task-cron-scheduler["task-cron-scheduler: cron scheduler<br/>files: scheduling/cron-scheduler.ts +2 more"]
    task-sqlite-schedule-store["task-sqlite-schedule-store: sqlite schedule store<br/>files: runstate/sqlite-schedule-store.ts +1 more"]
    task-serve-wiring["task-serve-wiring: serve loop scheduler block<br/>files: serve/driver.ts +1 more"]
    task-barrel-exports["task-barrel-exports: export scheduling symbols<br/>files: src/index.ts +1 more"]
    task-cli-schedule["task-cli-schedule: orch schedule CLI<br/>files: cmd-orch.ts +1 more"]

    task-schedule-contracts --> task-cron-scheduler
    task-schedule-contracts --> task-sqlite-schedule-store
    task-cron-scheduler --> task-serve-wiring
    task-schedule-contracts --> task-barrel-exports
    task-cron-scheduler --> task-barrel-exports
    task-sqlite-schedule-store --> task-barrel-exports
    task-barrel-exports --> task-cli-schedule

    classDef done fill:#90ee90,stroke:#333
    classDef ready fill:#fffacd,stroke:#333
    classDef running fill:#87ceeb,stroke:#333
    classDef failed fill:#ffb6c1,stroke:#333
    classDef skipped fill:#d3d3d3,stroke:#333,stroke-dasharray: 5 5
```

## Context

Implements the V1.1 cron-scheduling feature designed in
[`2026-06-02-agora-cron-trigger-design.md`](../specs/2026-06-02-agora-cron-trigger-design.md).

Per that spec's **D1**, cron is a Run *producer*, not a `Trigger` extension: a
`CronScheduler` that `serve` polls each tick emits submissions through the
existing `SubmissionTransport.submit()` inbox, after which the unchanged
`pollInbox → submitRun → ManualTrigger → tick` pipeline runs. The `Trigger` seam
and the engine are untouched.

Decomposition notes:
- The contract surface (`Schedule`, `ScheduleStore`) is a root task; the two
  implementations (`CronScheduler`, `SqliteScheduleStore`) depend on it and run
  in parallel (disjoint files).
- `SqliteScheduleStore` owns its own `schedules` table via
  `CREATE TABLE IF NOT EXISTS`, opening its own `better-sqlite3` connection to the
  same DB path as the run-state store (both WAL; separate tables → no contention).
  This keeps the existing `runstate/sqlite.ts` untouched and the migration purely
  additive (spec §5).
- `cron-parser` is introduced as a dependency by `task-cron-scheduler` (only that
  task touches `package.json`); UTC-only per spec §7 keeps the date math simple.
- Catch-up coalescing + deterministic per-slot runId (`<id>@<slotIso>`) live in
  the scheduler; dedup is free via `submitRun`'s existing idempotency guard
  (spec §4).
- Scheduling is an operator action → CLI only, no MCP tool (spec §0.2), so no
  task touches any `mcp` surface and the CI privilege-allowlist check is
  unaffected.

DAG status: 6 tasks · 0 done · 0 failed · 0 skipped · 6 pending

| id | depends_on | status |
|---|---|---|
| task-schedule-contracts | — | · pending |
| task-cron-scheduler | task-schedule-contracts | · pending |
| task-sqlite-schedule-store | task-schedule-contracts | · pending |
| task-serve-wiring | task-cron-scheduler | · pending |
| task-barrel-exports | task-schedule-contracts, task-cron-scheduler, task-sqlite-schedule-store | · pending |
| task-cli-schedule | task-barrel-exports | · pending |

## Tasks

## Task: scheduling contracts

```yaml
id: task-schedule-contracts
depends_on: []
files:
  - packages/agora-orchestrator/src/contracts/schedule.ts
  - packages/agora-orchestrator/src/contracts/schedule-store.ts
  - packages/agora-orchestrator/src/contracts/index.ts
  - packages/agora-orchestrator/test/schedule-contracts.test.ts
status: pending
```

Define the contract surface for cron scheduling: the `Schedule` shape (cron
expression, Run template, bookkeeping) and the `ScheduleStore` seam (persist /
query / advance). Export both through the existing contracts barrel so they flow
out of the package entry via its `export * from './contracts/index.js'`. Drives
spec §1.2.

## Implementation

```typescript
// packages/agora-orchestrator/src/contracts/schedule.ts
import type { Run } from './types.js';

/** A recurring submission source: a cron expression + a Run template. */
export interface Schedule {
  id: string;            // stable, user-chosen — e.g. "nightly-audit"
  cronExpr: string;      // standard 5-field cron (min hour dom mon dow), UTC
  run: Run;              // template; runId is rewritten per-fire to `${id}@${slotIso}`
  actor: string;         // identity stamped on every emitted submission
  lastFiredAt?: string;  // ISO-8601; undefined until first fire
  nextDueAt: string;     // ISO-8601; persisted for cheap due-checks
}
```

```typescript
// packages/agora-orchestrator/src/contracts/schedule-store.ts
import type { Schedule } from './schedule.js';

/** Persistence seam for schedules. Sole writer at runtime: serve. */
export interface ScheduleStore {
  due(nowMs: number): Schedule[];                                   // nextDueAt <= now
  markFired(id: string, firedAtMs: number, nextDueAt: string): void;
  upsert(s: Schedule): void;
  remove(id: string): void;
  list(): Schedule[];
}
```

Barrel addition (`contracts/index.ts`): append
`export * from './schedule.js';` and `export * from './schedule-store.js';`.

```typescript
// packages/agora-orchestrator/test/schedule-contracts.test.ts
import type { Schedule, ScheduleStore } from '../src/contracts/index.js';

it("ScheduleStore is implementable and Schedule round-trips through it", () => {
  const rows = new Map<string, Schedule>();
  const store: ScheduleStore = {
    due: () => [],
    markFired: () => {},
    upsert: (s) => { rows.set(s.id, s); },
    remove: (id) => { rows.delete(id); },
    list: () => [...rows.values()],
  };
  const s: Schedule = { id: "nightly", cronExpr: "0 2 * * *", run: { id: "r", items: [] } as unknown as Schedule["run"], actor: "human:test", nextDueAt: "2026-06-03T02:00:00Z" };
  store.upsert(s);
  expect(store.list()).toEqual([s]);
});
```

## Acceptance criteria

- `Schedule` and `ScheduleStore` are importable from
  `@quarry-systems/agora-orchestrator` (via the contracts barrel → package entry).
- A minimal in-memory object satisfies `ScheduleStore` and a `Schedule` upserted
  then listed compares equal.
- `tsc` passes with no new type errors; the existing `barrel-surface.test.ts`
  still passes.

Test file: `packages/agora-orchestrator/test/schedule-contracts.test.ts`.

## Task: cron scheduler

```yaml
id: task-cron-scheduler
depends_on: [task-schedule-contracts]
files:
  - packages/agora-orchestrator/src/scheduling/cron-scheduler.ts
  - packages/agora-orchestrator/package.json
  - packages/agora-orchestrator/test/cron-scheduler.test.ts
status: pending
```

Implement the `CronScheduler` (the Run producer `serve` polls) plus a standalone
`nextDueAfter` helper for computing the next slot from a cron expression. Adds
the `cron-parser` dependency to this package's `package.json` (the only task that
touches it; `pnpm-lock.yaml` regenerates as a side effect). Implements the
catch-up coalescing and deterministic per-slot runId of spec §4.

## Implementation

```typescript
// packages/agora-orchestrator/src/scheduling/cron-scheduler.ts
import parser from 'cron-parser';
import type { Schedule, ScheduleStore } from '../contracts/index.js';
import type { SubmissionEnvelope } from '../contracts/index.js';

/** Next scheduled slot strictly after `afterMs`, as an ISO-8601 string (UTC). */
export function nextDueAfter(cronExpr: string, afterMs: number): string {
  const it = parser.parseExpression(cronExpr, { currentDate: new Date(afterMs), tz: 'UTC' });
  return it.next().toDate().toISOString();
}

export class CronScheduler {
  constructor(private readonly store: ScheduleStore, private readonly now: () => number) {}

  /** For each due schedule: emit ONE envelope for the most-recent missed slot,
   *  then advance bookkeeping. Coalesces backlog → single catch-up (spec §4.2). */
  dueSubmissions(): SubmissionEnvelope[] {
    const nowMs = this.now();
    const out: SubmissionEnvelope[] = [];
    for (const s of this.store.due(nowMs)) {
      const slotIso = this.mostRecentSlotAtOrBefore(s.cronExpr, nowMs);  // <= now
      out.push({
        run: { ...s.run, id: `${s.id}@${slotIso}` },   // deterministic runId → free dedup
        actor: s.actor,
        submittedAt: new Date(nowMs).toISOString(),
      });
      this.store.markFired(s.id, nowMs, nextDueAfter(s.cronExpr, nowMs));
    }
    return out;
  }

  private mostRecentSlotAtOrBefore(cronExpr: string, nowMs: number): string {
    const it = parser.parseExpression(cronExpr, { currentDate: new Date(nowMs), tz: 'UTC' });
    return it.prev().toDate().toISOString();
  }
}
```

`package.json`: add `"cron-parser": "^4"` to `dependencies` so the import above
resolves.

```typescript
// packages/agora-orchestrator/test/cron-scheduler.test.ts
import { CronScheduler, nextDueAfter } from '../src/scheduling/cron-scheduler.js';
import type { Schedule, ScheduleStore } from '../src/contracts/index.js';

it("coalesces a multi-slot backlog into ONE envelope for the most recent missed slot", () => {
  // hourly schedule; 'now' is 04:01 after downtime across 02:00 and 03:00
  const due: Schedule[] = [{ id: "nightly", cronExpr: "0 * * * *", run: { id: "tmpl", items: [] } as unknown as Schedule["run"], actor: "human:test", nextDueAt: "2026-06-03T02:00:00Z" }];
  const fired: Array<[string, string]> = [];
  const store: ScheduleStore = { due: () => due, markFired: (id, _at, next) => fired.push([id, next]), upsert: () => {}, remove: () => {}, list: () => due };
  const now = Date.parse("2026-06-03T04:01:00Z");
  const envs = new CronScheduler(store, () => now).dueSubmissions();

  expect(envs).toHaveLength(1);
  expect(envs[0].run.id).toBe("nightly@2026-06-03T04:00:00.000Z");   // most recent slot, deterministic id
  expect(fired[0][1]).toBe("2026-06-03T05:00:00.000Z");              // next future slot
});
```

## Acceptance criteria

- `nextDueAfter("0 2 * * *", Date.parse("2026-06-03T03:00:00Z"))` returns the
  next 02:00 UTC slot (`2026-06-04T02:00:00.000Z`).
- A due schedule whose slots were missed across downtime produces exactly **one**
  envelope, for the most-recent slot at-or-before `now`.
- The emitted `run.id` is deterministic: `${schedule.id}@${slotIso}` (so a
  re-emit of the same slot is byte-identical).
- `markFired` is called once per due schedule with `nextDueAt` = the next future
  slot.
- `cron-parser` resolves (declared in this package's `package.json`); `tsc` and
  the suite pass.

Test file: `packages/agora-orchestrator/test/cron-scheduler.test.ts`.

## Task: sqlite schedule store

```yaml
id: task-sqlite-schedule-store
depends_on: [task-schedule-contracts]
files:
  - packages/agora-orchestrator/src/runstate/sqlite-schedule-store.ts
  - packages/agora-orchestrator/test/runstate-schedule-store.test.ts
status: pending
```

Implement `SqliteScheduleStore implements ScheduleStore`, backed by a new
`schedules` table created with `CREATE TABLE IF NOT EXISTS` (additive migration,
spec §5). Mirrors the existing `SqliteRunStateStore` constructor pattern
(`path = ':memory:'`, WAL pragma) and uses the already-declared `better-sqlite3`
dependency. Independent of the scheduler task (disjoint files) → runs in parallel.

## Implementation

```typescript
// packages/agora-orchestrator/src/runstate/sqlite-schedule-store.ts
import Database from 'better-sqlite3';
import type { Schedule, ScheduleStore } from '../contracts/index.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  cron_expr     TEXT NOT NULL,
  run_template  TEXT NOT NULL,   -- JSON Run
  actor         TEXT NOT NULL,
  last_fired_at TEXT,
  next_due_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(next_due_at);`;

export class SqliteScheduleStore implements ScheduleStore {
  private db: Database.Database;
  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }
  upsert(s: Schedule): void {
    this.db.prepare(
      `INSERT INTO schedules(id,cron_expr,run_template,actor,last_fired_at,next_due_at)
       VALUES(@id,@cron,@run,@actor,@last,@next)
       ON CONFLICT(id) DO UPDATE SET cron_expr=@cron,run_template=@run,actor=@actor,next_due_at=@next`,
    ).run({ id: s.id, cron: s.cronExpr, run: JSON.stringify(s.run), actor: s.actor, last: s.lastFiredAt ?? null, next: s.nextDueAt });
  }
  due(nowMs: number): Schedule[] {
    const iso = new Date(nowMs).toISOString();
    return (this.db.prepare('SELECT * FROM schedules WHERE next_due_at <= ?').all(iso) as any[]).map(this.row);
  }
  markFired(id: string, firedAtMs: number, nextDueAt: string): void {
    this.db.prepare('UPDATE schedules SET last_fired_at=?, next_due_at=? WHERE id=?')
      .run(new Date(firedAtMs).toISOString(), nextDueAt, id);
  }
  remove(id: string): void { this.db.prepare('DELETE FROM schedules WHERE id=?').run(id); }
  list(): Schedule[] { return (this.db.prepare('SELECT * FROM schedules ORDER BY id').all() as any[]).map(this.row); }
  private row = (r: any): Schedule => ({ id: r.id, cronExpr: r.cron_expr, run: JSON.parse(r.run_template), actor: r.actor, lastFiredAt: r.last_fired_at ?? undefined, nextDueAt: r.next_due_at });
}
```

```typescript
// packages/agora-orchestrator/test/runstate-schedule-store.test.ts
import { SqliteScheduleStore } from '../src/runstate/sqlite-schedule-store.js';
import type { Schedule } from '../src/contracts/index.js';

const mk = (id: string, next: string): Schedule => ({ id, cronExpr: "0 2 * * *", run: { id, items: [] } as unknown as Schedule["run"], actor: "human:test", nextDueAt: next });

it("returns only schedules whose next_due_at is at or before now", () => {
  const store = new SqliteScheduleStore();
  store.upsert(mk("past", "2026-06-03T01:00:00.000Z"));
  store.upsert(mk("future", "2026-06-03T09:00:00.000Z"));
  const due = store.due(Date.parse("2026-06-03T02:00:00Z")).map((s) => s.id);
  expect(due).toEqual(["past"]);
});
```

## Acceptance criteria

- A fresh `SqliteScheduleStore(':memory:')` creates the `schedules` table
  idempotently (constructing twice against the same file does not error).
- `upsert` then `list` round-trips a `Schedule` including a deserialized `run`
  template; re-`upsert` of the same id updates rather than duplicates.
- `due(nowMs)` returns exactly the schedules with `next_due_at <= now`.
- `markFired` updates `last_fired_at` and `next_due_at`; `remove` deletes by id
  and is a no-op when absent.

Test file: `packages/agora-orchestrator/test/runstate-schedule-store.test.ts`.

## Task: serve loop scheduler block

```yaml
id: task-serve-wiring
depends_on: [task-cron-scheduler]
files:
  - packages/agora-orchestrator/src/serve/driver.ts
  - packages/agora-orchestrator/test/serve-scheduler.test.ts
status: pending
```

Wire the scheduler into the `serve` loop: add an optional `scheduler` field to
`ServeOptions` and, each iteration before `tick()`, drain
`scheduler.dueSubmissions()` into `transport.submit()`. Mirrors the existing
cancel-control block at `driver.ts:53`. When `scheduler` is omitted, behaviour is
identical to V1 (spec §3).

## Implementation

```typescript
// packages/agora-orchestrator/src/serve/driver.ts — ServeOptions gains:
import type { CronScheduler } from '../scheduling/cron-scheduler.js';
export interface ServeOptions {
  // ...existing fields...
  scheduler?: CronScheduler;   // omit → V1 behaviour, no scheduling
}

// ...inside the while(!opts.signal?.aborted) loop body, before opts.orchestrator.tick(queue):
if (opts.scheduler) {
  for (const env of opts.scheduler.dueSubmissions()) {
    try { await opts.transport.submit(env); }   // same method a client uses
    catch (err) { opts.onError?.(err); }
  }
}
```

```typescript
// packages/agora-orchestrator/test/serve-scheduler.test.ts
import { serve } from '../src/serve/driver.js';

it("submits each due envelope through the transport once per tick", async () => {
  const env = { run: { id: "nightly@slot", items: [] }, actor: "human:test", submittedAt: "2026-06-03T04:00:00.000Z" };
  let calls = 0;
  const scheduler = { dueSubmissions: () => (calls++ === 0 ? [env] : []) } as any;  // due on first tick only
  const submitted: string[] = [];
  const transport = makeFakeTransport({ onSubmit: (e: any) => submitted.push(e.run.id) }); // pollInbox/ack/publish no-ops
  const ac = new AbortController();
  const run = serve({ orchestrator: makeFakeOrchestrator(), transport, scheduler, signal: ac.signal, tickIntervalMs: 1 });
  await tickOnce(); ac.abort(); await run;
  expect(submitted).toContain("nightly@slot");
});
```

## Acceptance criteria

- With a `scheduler` returning one envelope, `serve` calls `transport.submit`
  with that envelope exactly once for that due tick.
- A `scheduler.dueSubmissions()` that throws is caught via `onError` and does not
  crash the loop (matches the existing control-block error posture).
- Omitting `scheduler` leaves V1 behaviour unchanged: existing
  `serve-driver.test.ts` and `serve-control.test.ts` still pass.

Test file: `packages/agora-orchestrator/test/serve-scheduler.test.ts`.

## Task: export scheduling symbols

```yaml
id: task-barrel-exports
depends_on: [task-schedule-contracts, task-cron-scheduler, task-sqlite-schedule-store]
files:
  - packages/agora-orchestrator/src/index.ts
  - packages/agora-orchestrator/test/barrel-schedule-surface.test.ts
status: pending
is_wiring_task: true
```

Expose the new runtime symbols from the package entry so downstream packages (the
CLI) can import them. The contracts already flow out via the existing
`export * from './contracts/index.js'`; this task adds the two classes and the
helper. Pure registration — no new logic.

```typescript
// packages/agora-orchestrator/src/index.ts — append:
export { CronScheduler, nextDueAfter } from './scheduling/cron-scheduler.js';
export { SqliteScheduleStore } from './runstate/sqlite-schedule-store.js';
```

## Acceptance criteria

- `CronScheduler`, `nextDueAfter`, and `SqliteScheduleStore` are importable from
  `@quarry-systems/agora-orchestrator` (package entry).
- `Schedule` and `ScheduleStore` types remain importable from the same entry
  (via the contracts re-export).
- `tsc` passes; a surface test asserts the three new symbols are defined on the
  package entry.

Test file: `packages/agora-orchestrator/test/barrel-schedule-surface.test.ts`.

## Task: orch schedule CLI

```yaml
id: task-cli-schedule
depends_on: [task-barrel-exports]
files:
  - packages/agora-cli/src/cmd-orch.ts
  - packages/agora-cli/test/cmd-orch-schedule.test.ts
status: pending
```

Add the `agora orch schedule add|list|rm` operator verbs (commander) and a
config-owned `scheduleStore` on `OrchContext` (mirroring the existing
`runService`/`transport` wiring). `add` validates the cron expression up front and
computes the first `nextDueAt` via `nextDueAfter`; re-running `add` with the same
id is an idempotent update; `rm` is a no-op when absent (spec §6). CLI only — no
MCP surface.

## Implementation

```typescript
// packages/agora-cli/src/cmd-orch.ts
import { nextDueAfter } from '@quarry-systems/agora-orchestrator';
import type { ScheduleStore, Schedule } from '@quarry-systems/agora-orchestrator';

export interface OrchContext {
  // ...existing fields...
  scheduleStore?: ScheduleStore;   // config-owned; required for `schedule` verbs
}

// inside attachOrchCmd, after the existing verbs:
const sched = o.command('schedule').description('Manage recurring submissions');

sched.command('add').requiredOption('--id <id>').requiredOption('--cron <expr>')
  .requiredOption('--plan <plan.json>').option('--actor <id>')
  .action(async (opts) => {
    const oc = await ctx.getOrchContext();
    if (!oc.scheduleStore) throw new Error('agora orch schedule: agora.config `orch` export provides no scheduleStore');
    const nextDueAt = nextDueAfter(opts.cron, Date.now());   // also validates the expr (throws on bad cron)
    const run = JSON.parse(await readFile(opts.plan, 'utf8'));
    const s: Schedule = { id: opts.id, cronExpr: opts.cron, run, actor: resolveActor(opts.actor), nextDueAt };
    oc.scheduleStore.upsert(s);
    console.log(`schedule '${opts.id}' next due ${nextDueAt}`);
  });

sched.command('list').action(async () => {
  const oc = await ctx.getOrchContext();
  for (const s of oc.scheduleStore?.list() ?? []) console.log(`${s.id}\t${s.cronExpr}\tlast=${s.lastFiredAt ?? '-'}\tnext=${s.nextDueAt}`);
});

sched.command('rm').requiredOption('--id <id>').action(async (opts) => {
  const oc = await ctx.getOrchContext();
  oc.scheduleStore?.remove(opts.id);
  console.log(`schedule '${opts.id}' removed`);
});
```

```typescript
// packages/agora-cli/test/cmd-orch-schedule.test.ts
it("schedule add rejects an invalid cron expression", async () => {
  await expect(runCli(['orch', 'schedule', 'add', '--id', 'x', '--cron', 'not-a-cron', '--plan', planFixture]))
    .rejects.toThrow();
});

it("schedule add upserts with a computed nextDueAt", async () => {
  const store = makeMemoryScheduleStore();
  await runCli(['orch', 'schedule', 'add', '--id', 'nightly', '--cron', '0 2 * * *', '--plan', planFixture], { scheduleStore: store });
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0].nextDueAt).toMatch(/T02:00:00\.000Z$/);
});
```

## Acceptance criteria

- `orch schedule add --id X --cron "<expr>" --plan p.json` upserts a `Schedule`
  with `nextDueAt` computed from the cron expression and the plan loaded as the
  Run template.
- An invalid cron expression makes `add` exit non-zero (validation before any
  store write).
- `orch schedule list` prints id, cron, last-fired, next-due for each schedule.
- `orch schedule rm --id X` removes by id and is a no-op (no error) when X is
  absent.
- A `schedule` verb invoked with no configured `scheduleStore` fails with a clear
  message (matches the `serve`-without-`runService` posture).
- Existing `cmd-orch.test.ts` still passes (additions are purely additive).

Test file: `packages/agora-cli/test/cmd-orch-schedule.test.ts`.
