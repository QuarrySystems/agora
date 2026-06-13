# Tamper-evident readiness test (the leave-gate)

> **Status:** design, approved 2026-06-13. Implements the vault task
> `task-tamper-evident-readiness-test-prove-verify-bounces-a-tamper-off-the-immutable`
> — THE heaviest seal leave-gate. Converts "I can't tell if it's ready" into a binary
> pass/fail and, on success, promotes the seal's earned claim from `tamper-detecting`
> to `tamper-evident` (at the one tier that earns it: `external-immutable` =
> `S3ObjectLockAnchor`, on a run that verifies end-to-end).

## 1. Why

The seal's whole differentiator is "trust the artifact, not the operator." That only
holds if a forge by someone who controls the run's local state is caught by an
**external immutable** anchor. We have never run that adversarial path against a real
Object Lock store, so the `tamper-evident` claim is asserted, not proven. This closes it.

## 2. Code reality (verified 2026-06-13 — corrects the stale "write a client" framing)

These already ship and are complete; this is **not** "write a client":

- `S3LockClient` interface — `packages/pangolin-core/src/s3-clients.ts` (`putObject(key, body, {retainUntil, mode:'COMPLIANCE'})`, `getObject`).
- `AwsS3LockClient` — `packages/pangolin-storage-s3/src/aws-s3-lock-client.ts` (real AWS-SDK impl; sets `ObjectLockMode`/`ObjectLockRetainUntilDate`).
- `S3ObjectLockAnchor` — `packages/pangolin-orchestrator/src/audit/anchor.ts` (`guarantee = 'external-immutable'`; anchors the root JSON to `audit/roots/<epochId>.json` under COMPLIANCE retention; `fetch` reads it back).
- The `root-mismatch` check — `verify()` (`pangolin-core/src/audit-verify.ts`) compares the recomputed Merkle root to the **anchored** root via `Buffer.compare`.
- An env-gated MinIO test — `packages/pangolin-storage-s3/test/aws-s3-lock-client.test.ts` (`PANGOLIN_S3_ENDPOINT`-gated; creates `pangolin-audit` with `ObjectLockEnabledForBucket: true`; asserts delete-before-retention is rejected).

**Two holes remain** — the two gaps below.

## 3. Scope

**In:** Gap A (the chain-consistent-forge → `root-mismatch` contrast test, pure) and Gap B
(the real-store end-to-end proof against MinIO object-lock). Plus, on a green run: update
the ROADMAP/docs known-gap and the vault task.

**Out (defer — overengineering against a hypothetical, per the task):** cleaner anchor
abstractions, a fourth anchor tier, any `verify`-path refactor. Build only what the
adversarial claim needs.

## 4. Gap A — contrast test (pure code, runs in CI)

**File:** `packages/pangolin-orchestrator/test/audit/tamper-evident-contrast.test.ts`

The existing tamper test mutates an entry's `actor`, which breaks the hash **chain** and
fails via `chain` — it never exercises `root-mismatch`. And `acceptance.int.test.ts`
already covers the **clean-run** tiers (clean `LocalAnchor` → `tamper-detecting`; clean
`S3ObjectLockAnchor` over a fake S3 → `tamper-evident`). Gap A adds the genuinely-missing
**forge** path as a **single contrast test**: one chain-consistent forge, applied once,
then verified against *both* anchors from that same forged state.

### 4.1 The immutable in-memory `S3LockClient` fake (~15 lines, test-local)
A **new, strict** test double — NOT the permissive `fakeS3()` in `anchor.test.ts`, which
silently allows overwrites. Simulates COMPLIANCE: `putObject` **rejects overwriting an
existing key** (throws); a fresh key is accepted. `getObject` returns the
originally-stored bytes. This is the LocalAnchor analogue but *immutable* — the property
the real Object Lock store enforces. Kept test-local (no shared `forge.ts`/fake module —
avoids accidental reuse and the duplication the audit warned against).

### 4.2 The chain-consistent forge
Seal a 2–3 entry run (entries chained: `entryHash = chainHash(canonEntry(e), prevHash)`,
Merkle root anchored). Then forge: rewrite one entry's payload, **recompute that entry's
`entryHash` and relink every subsequent entry's `prevHash`** so the chain re-verifies, and
recompute the Merkle root — a fresh, internally-consistent *local* root that differs from
the anchored one. Build this from the **`seed()` pattern in `verify.test.ts`** (which
already constructs entries via the real `canonEntry`/`chainHash`/`merkleRoot`); the forge
extends that with the relink step, kept test-local so it can't drift from production.

### 4.3 The contrast (one forge, two anchors)
- **`LocalAnchor`** (mutable store): the forge also overwrites the anchored root (the store
  is mutable) → `verify` → `intact: true`. **Forgery undetected** — the precise meaning of
  "tamper-detecting only."
- **`S3ObjectLockAnchor`** over the immutable fake: the anchored-root overwrite is rejected,
  the original root stands → `verify` → `intact: false`, `failure: 'root-mismatch'`,
  `claim: 'tamper-detecting'` (the claim collapses; the forge is caught).

This closes the missing `root-mismatch` coverage and doubles as the live-tamper demo spine
([[wikis/agora/ideas/idea-lead-the-demo-with-the-live-tamper-not]]).

## 5. Gap B — real-store proof (env-gated; run once for real)

`pangolin-storage-s3` cannot import `pangolin-orchestrator` (the PR #58 dependency cycle),
so the work splits by layer:

### 5.1 Client level — extend the existing storage-s3 test
In `packages/pangolin-storage-s3/test/aws-s3-lock-client.test.ts` (pure client, no
orchestrator), add a **PUT-overwrite-rejection** assertion next to the delete-rejection:
after writing key `K` under COMPLIANCE retention, a second `putObject(K, …)` is rejected.
This is the immutability the anchor relies on, proven at the client boundary.

### 5.2 Full round-trip — new root e2e suite (neutral, cross-package home)
**File:** `test/tamper-evident-minio.e2e.test.ts` (root `test/`, run by the `e2e` workflow).
**Gating:** `const d = process.env.PANGOLIN_S3_ENDPOINT ? describe : describe.skip` —
matching the storage-s3 test's exact idiom and gating on `PANGOLIN_S3_ENDPOINT` **alone**.
Do NOT layer the root suite's `PANGOLIN_E2E_DOCKER` docker-skip helper: that gate is for
the container-backed worker suites; this one needs only a MinIO endpoint. Wires
`AwsS3LockClient` → `S3ObjectLockAnchor` + `AuditLog` + `SqliteRunStateStore` + `verify`:
1. Seal a run → assert `report.claim === 'tamper-evident'` and `report.intact === true`.
2. Forge a chain-consistent local root in the run DB; attempt to overwrite the anchored
   root (rejected by COMPLIANCE).
3. Re-verify → fetches the immutable anchored root from the external S3 object → finds the
   mismatch → `failure: 'root-mismatch'`, `claim` collapses to `tamper-detecting`.

### 5.3 The real run (clears the gate)
Bring up MinIO with object-lock via Docker (mirroring the offload-minio/serve-stack
setup), create the object-lock-enabled bucket, set `PANGOLIN_S3_ENDPOINT` + credentials,
and run §5.1 + §5.2 against it. A green run clears the leave-gate.

## 6. Acceptance (the task's checklist)

- [ ] `claim` field returned `tamper-evident`, not `tamper-detecting` (clean run, §5.2.1).
- [ ] Ran against `S3ObjectLockAnchor` in COMPLIANCE mode, not `LocalAnchor` (§5.3).
- [ ] `verify` fetched the anchored root from the external S3 object, not a local copy.
- [ ] The chain-consistent-forge → `root-mismatch` path is covered by a test (Gap A in CI;
      Gap B against the real store).
- [ ] On green: ROADMAP/docs known-gap updated to name `external-immutable` as proven, and
      the vault task marked done.

**Read the result (per the task):** if §5.2/§5.3 step 3 catches the tamper → READY, ship +
clear the gate. If it *misses* → the original doubt was right; that's the real bug, fix it.

## 7. Testing posture

- **Gap A** runs in normal CI (`pnpm -r test`) — pure, no infra.
- **Gap B** is `describe.skip` unless `PANGOLIN_S3_ENDPOINT` is set (CI hermetic) — both
  the storage-s3 client test and the root e2e gate on that single var, not the root
  suite's `PANGOLIN_E2E_DOCKER`. The real MinIO run is a one-time manual gate-clear,
  reproducible by anyone who sets the env.

## 8. Risks

- **MinIO object-lock setup friction** (bucket must be created object-lock-enabled; only at
  creation). Mitigated by reusing the existing test's `ObjectLockEnabledForBucket: true`
  bucket creation and the offload-minio compose precedent.
- **Forge helper drifting from production hashing.** Mitigated by building the forge from
  the real `canonEntry`/`chainHash`/`merkleRoot` (no reimplementation).
