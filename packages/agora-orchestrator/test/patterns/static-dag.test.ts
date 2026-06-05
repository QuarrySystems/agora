import { it, expect } from 'vitest';
import { staticDag } from '../../src/patterns/static-dag.js';

it('plan is identity (same reference) and onTaskDone never spawns', () => {
  const run = { id: 'r', queue: 'q', items: [] };
  expect(staticDag.plan(run)).toBe(run);
  expect(staticDag.onTaskDone({ status: 'done' } as never, { runItems: [] })).toBeNull();
});
