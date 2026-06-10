# demo-claims-appeals — GTM Mode-A demo

A domain-flavored reskin of [`offload-fanout`](../offload-fanout/) for the
go-to-market demo: a **batch of denied insurance claims** fans out to parallel
agents that each **draft an appeal**, each **self-verifies** before its patch
escapes, and the run produces a **tamper-detecting audit bundle** — ending on
the "forge one byte → verification fails" beat.

> Maps to the sharpest-8 batch cohort (claims/filings/reconciliation). Swap the
> fixtures + the `claim-appeal` prompt to reskin for legal filings, reconciliation,
> procurement, etc. The proof beats are identical across domains.

## What it shows

- **Safe fan-out**: three `claim-appeal` items fire concurrently (concurrency 2),
  each under a per-output `resourceLock` so they never collide.
- **Patch escape**: each agent's drafted appeal is the workspace diff, surfaced as
  the item's content-addressed `resultRef` — never stored in the run-state DB.
- **Self-verify (Gap A)**: each `claim-appeal` runs a language-agnostic shell check
  over its own edit before sealing; pass/fail is sealed with the patch.
- **Tamper-detecting audit bundle**: after all items are terminal the orchestrator
  seals the epoch (Merkle hash chain + `LocalAnchor`) and `OperationsApi.audit` /
  `pangolin verify` assemble a verifiable `AuditBundle` (`claim: tamper-detecting`,
  `intact: true` on a clean run).

The default tier is **tamper-detecting** (LocalAnchor stores the root in SQLite).
For the **tamper-evident** (`external-immutable`) recording, swap `LocalAnchor` for
`S3ObjectLockAnchor` in `pangolin.config.mjs` / `src/index.ts` — the only change
needed. Never describe LocalAnchor as "tamper-evident" or "compliant".

## Live demo (requires Docker + Anthropic API key)

```sh
# From repo root — reads ../../.env for ANTHROPIC_API_KEY
pnpm --filter demo-claims-appeals-example start:env
```

The demo: submits `plan.json` (3 parallel appeals + 1 verify gate) → the `serve`
driver ticks to completion → prints each appeal's `resultRef` → assembles and
prints the audit bundle (`intact`, `claim`, `anchorId`, `guarantee`).

### CLI flow (when the `pangolin` CLI is available)

```sh
pangolin orch serve &
pangolin orch submit plan.json
pangolin orch watch <run-id>
pangolin orch audit <run-id> --out bundle.json
pangolin verify bundle.json --full          # all rows ✓, intact: true
#  --- the headline: edit one byte of bundle.json, then ---
pangolin verify bundle.json --full          # a row goes RED, intact: false, exit 1
```

## CI smoke test (no Docker / no API key)

```sh
pnpm --filter demo-claims-appeals-example test
```

`test/claims-appeals.test.ts` uses a fake executor (no containers, no LLM) and
verifies: `plan.json` has the correct fan-out shape (3 per-output-locked appeals
+ a verify gating all three); a real `PangolinOrchestrator` drives it to
completion; every appeal reaches `done` with a `resultRef`; and
`bundle.report.intact === true` with `claim === 'tamper-detecting'`.

## Fixtures

`fixture/claim-00{1,2,3}.json` — **synthetic** denied claims (no real PHI). Each
has `claimId`, `claimant`, `service`, `denialReason`, `policySection`,
`supportingFacts`. The `claim-appeal` subagent reads one and drafts
`appeals/<claimId>.md`.
