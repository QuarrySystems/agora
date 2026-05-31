import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tick } from '../src/engine/tick.js';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import type { Executor, ItemState, Run, RunStateStore, TerminalStatus } from '../src/contracts/index.js';
import { PackRegistry } from '../src/packs/registry.js';
import { makeShape } from './support/make-shape.js';

// Inline fake Executor (no real executor in PR2): fires immediately, finishes on next reconcile.
function fakeExecutor(): Executor & { fired: string[] } {
  const fired: string[] = [];
  return {
    id: 'fake', fired,
    async fire(item) { fired.push(item.id); return { dispatchHash: `h-${item.id}` }; },
    async reconcile() { return { status: 'done' as const }; },
  };
}

/**
 * Minimal in-memory RunStateStore for subagentShape tests.
 * Unlike the SQLite store, this properly round-trips all WorkItem fields (including subagentShape).
 * Used only in the subagentShape tests where field persistence matters for tick logic.
 */
function makeMemStore(concurrency = 5): RunStateStore & { items: Map<string, ItemState> } {
  const items = new Map<string, ItemState>();
  const queues = new Map<string, number>();
  const locks = new Map<string, string>(); // key → item_id
  return {
    items,
    ensureQueue(name, c) { queues.set(name, c); },
    saveRun(run: Run) {
      for (const it of run.items) {
        items.set(it.id, { ...it, runId: run.id, queue: run.queue, status: 'pending' });
      }
    },
    markReady(ids: string[]) {
      for (const id of ids) {
        const it = items.get(id);
        if (it && it.status === 'pending') items.set(id, { ...it, status: 'ready' });
      }
    },
    setRunning(id: string, dispatchHash: string) {
      const it = items.get(id);
      if (it) items.set(id, { ...it, status: 'running', dispatchHash });
    },
    setStatus(id: string, status: TerminalStatus) {
      const it = items.get(id);
      if (it) items.set(id, { ...it, status });
    },
    getItems(runId?: string): ItemState[] {
      const all = [...items.values()];
      return runId ? all.filter((i) => i.runId === runId) : all;
    },
    runningCount(queue: string): number {
      return [...items.values()].filter((i) => i.queue === queue && i.status === 'running').length;
    },
    queueConcurrency(queue: string): number { return queues.get(queue) ?? 0; },
    heldLockKeys(): string[] { return [...locks.keys()]; },
    acquireLocks(itemId: string, keys: string[]): boolean {
      if (keys.length === 0) return true;
      if (keys.some((k) => locks.has(k))) return false;
      for (const k of keys) locks.set(k, itemId);
      return true;
    },
    releaseLocks(itemId: string): void {
      for (const [k, v] of locks) { if (v === itemId) locks.delete(k); }
    },
    close() { /* no-op */ },
  };
}

const run: Run = { id: 'r', queue: 'default', items: [
  { id: 'a', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
  { id: 'b', executor: 'fake', inputs: {}, depends_on: ['a'], resourceLocks: [] },
] };

describe('tick', () => {
  it('readies + fires roots, then readies + fires dependents after reconcile, respecting deps', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 5);
    store.saveRun(run);
    store.markReady(['a']); // manual trigger seeded the root

    const ex = fakeExecutor();
    const t1 = await tick(store, { fake: ex }, 'default');
    expect(t1.fired).toBe(1);                       // a fired
    expect(ex.fired).toEqual(['a']);
    expect(store.getItems('r').find((i) => i.id === 'b')!.status).toBe('pending'); // b still blocked

    const t2 = await tick(store, { fake: ex }, 'default');
    expect(t2.reconciled).toBe(1);                  // a -> done
    expect(store.getItems('r').find((i) => i.id === 'a')!.status).toBe('done');
    expect(ex.fired).toContain('b');                // b readied + fired now that a is done
    store.close();
  });

  it('honors the queue concurrency cap', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'r2', queue: 'default', items: [
      { id: 'x', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'y', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
    ] });
    store.markReady(['x', 'y']);
    // reconcile returns null (never finishes) so running items stay running
    const ex: Executor = { id: 'fake', async fire(i) { return { dispatchHash: `h-${i.id}` }; }, async reconcile() { return null; } };
    const t = await tick(store, { fake: ex }, 'default');
    expect(t.fired).toBe(1); // cap=1 → only one of x,y fires this pass
    store.close();
  });

  it('resource-lock serialization: two ready items sharing a lock key, only one fires per tick', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 10); // high concurrency — lock is the bottleneck
    store.saveRun({ id: 'r3', queue: 'default', items: [
      { id: 'p', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['shared-file.ts'] },
      { id: 'q', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['shared-file.ts'] },
    ] });
    store.markReady(['p', 'q']);
    // reconcile returns null so neither item completes — both stay running on second tick
    const ex: Executor = { id: 'fake', async fire(i) { return { dispatchHash: `h-${i.id}` }; }, async reconcile() { return null; } };
    const t = await tick(store, { fake: ex }, 'default');
    // Even though concurrency allows 10, the shared lock means only one can fire
    expect(t.fired).toBe(1);
    store.close();
  });

  it('throws a clear error when executor id is unregistered during fire', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 5);
    store.saveRun({ id: 'r4', queue: 'default', items: [
      { id: 'z', executor: 'nonexistent', inputs: {}, depends_on: [], resourceLocks: [] },
    ] });
    store.markReady(['z']);
    await expect(tick(store, {}, 'default')).rejects.toThrow("tick: no executor registered for 'nonexistent'");
    store.close();
  });

  it('throws a clear error when executor id is unregistered during reconcile', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 5);
    // Manually put an item into running state with an unknown executor
    store.saveRun({ id: 'r5', queue: 'default', items: [
      { id: 'w', executor: 'ghost', inputs: {}, depends_on: [], resourceLocks: [] },
    ] });
    store.markReady(['w']);
    store.setRunning('w', 'h-w');
    await expect(tick(store, {}, 'default')).rejects.toThrow("tick: no executor registered for 'ghost'");
    store.close();
  });

  it('reconcile: released locks allow next item to acquire on next tick', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 10);
    store.saveRun({ id: 'r6', queue: 'default', items: [
      { id: 'm', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['mutex'] },
      { id: 'n', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['mutex'] },
    ] });
    store.markReady(['m', 'n']);

    let reconcileCount = 0;
    const ex: Executor = {
      id: 'fake',
      async fire(i) { return { dispatchHash: `h-${i.id}` }; },
      async reconcile() {
        reconcileCount++;
        return { status: 'done' as const };
      },
    };

    // Tick 1: one of m or n fires (shared lock)
    const t1 = await tick(store, { fake: ex }, 'default');
    expect(t1.fired).toBe(1);

    // Tick 2: the running item is reconciled to done, its lock is released, and the other item fires
    const t2 = await tick(store, { fake: ex }, 'default');
    expect(t2.reconciled).toBe(1);
    expect(t2.fired).toBe(1); // second item fires after lock released
    store.close();
  });

  // --- subagentShape resolution tests ---

  it('subagentShape: unknown shape id marks item failed, tick does not throw, other items still fire', async () => {
    // Uses in-memory store to properly round-trip subagentShape (SqliteRunStateStore is columnar and
    // doesn't persist this optional field; see DONE_WITH_CONCERNS note about sqlite.ts).
    const store = makeMemStore();
    store.ensureQueue('default', 5);
    store.saveRun({ id: 'rs1', queue: 'default', items: [
      { id: 'bad', executor: 'fake', inputs: { n: 1 }, depends_on: [], resourceLocks: [], subagentShape: 'unknown.shape' },
      { id: 'good', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
    ] });
    store.markReady(['bad', 'good']);

    const ex = fakeExecutor();
    const packs = new PackRegistry([makeShape({ id: 'dev.x', inputSchema: z.object({ n: z.number() }) })]);

    // Should not throw even though 'unknown.shape' isn't in packs
    const result = await tick(store, { fake: ex }, 'default', packs);

    // 'bad' item should be failed, not fired
    expect(store.getItems('rs1').find((i) => i.id === 'bad')!.status).toBe('failed');
    // 'good' item (no subagentShape) should still fire normally
    expect(ex.fired).toContain('good');
    expect(result.fired).toBe(1); // only 'good' fired
  });

  it('subagentShape: input failing inputSchema marks item failed, tick does not throw', async () => {
    const store = makeMemStore();
    store.ensureQueue('default', 5);
    store.saveRun({ id: 'rs2', queue: 'default', items: [
      { id: 'badinputs', executor: 'fake', inputs: { n: 'not-a-number' }, depends_on: [], resourceLocks: [], subagentShape: 'dev.x' },
    ] });
    store.markReady(['badinputs']);

    const ex = fakeExecutor();
    const packs = new PackRegistry([makeShape({ id: 'dev.x', inputSchema: z.object({ n: z.number() }) })]);

    await expect(tick(store, { fake: ex }, 'default', packs)).resolves.not.toThrow();
    expect(store.getItems('rs2').find((i) => i.id === 'badinputs')!.status).toBe('failed');
    expect(ex.fired).not.toContain('badinputs');
  });

  it('subagentShape: valid inputs fires normally', async () => {
    const store = makeMemStore();
    store.ensureQueue('default', 5);
    store.saveRun({ id: 'rs3', queue: 'default', items: [
      { id: 'valid', executor: 'fake', inputs: { n: 42 }, depends_on: [], resourceLocks: [], subagentShape: 'dev.x' },
    ] });
    store.markReady(['valid']);

    const ex = fakeExecutor();
    const packs = new PackRegistry([makeShape({ id: 'dev.x', inputSchema: z.object({ n: z.number() }) })]);

    const result = await tick(store, { fake: ex }, 'default', packs);

    expect(ex.fired).toContain('valid');
    expect(result.fired).toBe(1);
  });

  it('subagentShape: no packs passed and item has subagentShape marks item failed (registry unavailable)', async () => {
    const store = makeMemStore();
    store.ensureQueue('default', 5);
    store.saveRun({ id: 'rs4', queue: 'default', items: [
      { id: 'nopacks', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [], subagentShape: 'dev.x' },
    ] });
    store.markReady(['nopacks']);

    const ex = fakeExecutor();

    // No packs passed — shape can't be resolved
    await expect(tick(store, { fake: ex }, 'default')).resolves.not.toThrow();
    expect(store.getItems('rs4').find((i) => i.id === 'nopacks')!.status).toBe('failed');
    expect(ex.fired).not.toContain('nopacks');
  });

  it('subagentShape: no leaked locks when input validation fails — lock-sibling fires on next tick', async () => {
    // selectRunnable pre-filters items sharing a resource lock (only one per lock per tick).
    // So 'waits-for-lock' is not in runnable on tick 1. After 'fail-with-lock' is marked failed
    // (and its lock is released/never held), the next tick should allow 'waits-for-lock' to fire.
    const store = makeMemStore();
    store.ensureQueue('default', 5);
    store.saveRun({ id: 'rs5', queue: 'default', items: [
      { id: 'fail-with-lock', executor: 'fake', inputs: { n: 'bad' }, depends_on: [], resourceLocks: ['res-a'], subagentShape: 'dev.x' },
      { id: 'waits-for-lock', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['res-a'] },
    ] });
    store.markReady(['fail-with-lock', 'waits-for-lock']);

    const ex = fakeExecutor();
    const packs = new PackRegistry([makeShape({ id: 'dev.x', inputSchema: z.object({ n: z.number() }) })]);

    // Tick 1: fail-with-lock is selected; validation fails → status=failed, no lock acquired
    await tick(store, { fake: ex }, 'default', packs);
    expect(store.getItems('rs5').find((i) => i.id === 'fail-with-lock')!.status).toBe('failed');
    // Verify no lock is held (lock was never acquired → no leak)
    expect(store.heldLockKeys()).not.toContain('res-a');

    // Tick 2: waits-for-lock can now acquire res-a and fire
    await tick(store, { fake: ex }, 'default', packs);
    expect(ex.fired).toContain('waits-for-lock');
  });

  it('reconcile: failed status releases locks so the next item can fire', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 10); // high concurrency — lock is the bottleneck
    store.saveRun({ id: 'r7', queue: 'default', items: [
      { id: 'm', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['shared'] },
      { id: 'n', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['shared'] },
    ] });
    store.markReady(['m', 'n']);

    const firedItems: string[] = [];
    const ex: Executor = {
      id: 'fake',
      async fire(i) { firedItems.push(i.id); return { dispatchHash: `h-${i.id}` }; },
      async reconcile() { return { status: 'failed' as const }; },
    };

    // Tick 1: m fires (acquires 'shared'), n is held by the lock
    const t1 = await tick(store, { fake: ex }, 'default');
    expect(t1.fired).toBe(1); // only one fires — lock blocks the second
    const firstFired = firedItems[0]; // either m or n (whichever was selected)

    // Tick 2: the running item reconciles → 'failed', lock released; the other item fires
    const t2 = await tick(store, { fake: ex }, 'default');
    expect(t2.reconciled).toBe(1);
    const firstItem = store.getItems('r7').find((i) => i.id === firstFired)!;
    expect(firstItem.status).toBe('failed'); // failed status set
    expect(t2.fired).toBe(1); // the other item fires now that lock is released
    expect(firedItems).toHaveLength(2); // both items have fired across the two ticks

    store.close();
  });
});
