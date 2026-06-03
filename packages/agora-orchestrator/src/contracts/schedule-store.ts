import type { Schedule } from './schedule.js';

/** Persistence seam for schedules. Sole writer at runtime: serve. */
export interface ScheduleStore {
  due(nowMs: number): Schedule[];                                   // nextDueAt <= now
  markFired(id: string, firedAtMs: number, nextDueAt: string): void;
  upsert(s: Schedule): void;
  remove(id: string): void;
  list(): Schedule[];
}
