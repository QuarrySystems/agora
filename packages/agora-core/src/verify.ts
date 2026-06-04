// @quarry-systems/agora-core — self-verify outcome (Gap A).

/**
 * Outcome of a worker self-verify run: the worker's own (language-agnostic)
 * verify command run over its edit. Crosses the worker → orchestrator boundary
 * via the output sentinel, and is surfaced on the dispatch result + item
 * status. Report-only — it never changes the dispatch outcome.
 *
 * `durationMs` is optional because the orchestrator's read boundary drops it
 * when a sentinel carries a non-numeric value.
 */
export interface VerifyOutcome {
  passed: boolean;
  /** Combined stdout+stderr from the verify command, truncated + secret-redacted. */
  report?: string;
  durationMs?: number;
}
