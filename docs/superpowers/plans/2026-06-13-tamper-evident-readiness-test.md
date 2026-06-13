# Tamper-evident readiness test — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a chain-consistent forge is caught as `root-mismatch` against a genuinely-immutable S3 Object Lock anchor — closing the seal's heaviest leave-gate and promoting its earned claim from `tamper-detecting` to `tamper-evident`.

**Architecture:** The crypto already ships (`AwsS3LockClient`, `S3ObjectLockAnchor`, the `root-mismatch` check in `verify`). Two gaps remain: **Gap A** — a pure CONTRAST test that runs the same forge under a mutable `LocalAnchor` (forgery wins) vs an immutable `S3ObjectLockAnchor` (forgery caught as `root-mismatch`); **Gap B** — the real-store proof against a live MinIO object-lock bucket (client-level overwrite-rejection + a full seal→forge→verify round-trip), env-gated on `PANGOLIN_S3_ENDPOINT` and run once for real to clear the gate.

**Tech Stack:** TypeScript (ESM/NodeNext), vitest, `@aws-sdk/client-s3`, MinIO (Docker) for the real run. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-13-tamper-evident-readiness-test-design.md`

**Conventions (verified against the repo):**
- These are TESTS OF EXISTING production behavior, not new features. The "watch it fail" step is replaced by **"run it and read the result"**: a PASS proves the behavior; a FAIL means the original doubt was right and you've found a real bug — STOP and investigate (do not weaken the test).
- Build the forge from the REAL `canonEntry`/`chainHash`/`merkleRoot`/`leavesFromEntryHashes` (never reimplement) so it can't drift from production — the `seed()` helper in `test/audit/verify.test.ts` is the template.
- ESM `.js` import suffixes; eslint forbids `any` (the existing audit tests use `as any` on inline fakes — match that local style, don't expand it).
- Branch: do this on `feat/tamper-evident-readiness` (off `main`). Gap A lands via normal CI; Gap B is `describe.skip` unless `PANGOLIN_S3_ENDPOINT` is set.

---

## File Structure

- **Create** `packages/pangolin-orchestrator/test/audit/tamper-evident-contrast.test.ts` — Gap A. The strict immutable `S3LockClient` fake + chain-consistent forge + the two-anchor contrast. Pure, runs in CI.
- **Modify** `packages/pangolin-storage-s3/test/aws-s3-lock-client.test.ts` — Gap B client level. Add a PUT-overwrite-rejection assertion next to the existing delete-rejection.
- **Create** `test/e2e/tamper-evident-minio.test.ts` — Gap B round-trip. Env-gated full seal→forge→verify against a real `S3ObjectLockAnchor` + `AwsS3LockClient`.
- **Modify** `ROADMAP.md` + `docs-site/src/content/docs/explanation/project-status-roadmap.md` — on a green real run, update the known-gap to name `external-immutable` as proven.

---

## Task 1: Gap A — the chain-consistent-forge contrast test (pure, CI)

**Files:**
- Create: `packages/pangolin-orchestrator/test/audit/tamper-evident-contrast.test.ts`

- [ ] **Step 1: Write the contrast test**

This characterizes EXISTING `verify` behavior — expect it to PASS. The existing `acceptance.int.test.ts` covers the *clean* tiers and a *chain-breaking* tamper; this covers the missing *chain-consistent forge → root-mismatch* path, as a single contrast.

```typescript
import { it, expect } from 'vitest';
import { canonEntry } from '../../src/audit/canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../src/audit/merkle.js';
import { LocalAnchor, S3ObjectLockAnchor, type S3LockClient } from '../../src/audit/anchor.js';
import { verify } from '../../src/audit/verify.js';
import type { AuditEntryRow, AuditStore } from '../../src/contracts/index.js';

// A mutable in-memory AuditStore whose audit_entries array we can forge in place.
function memStore(entries: AuditEntryRow[]) {
  let roots = new Map<string, any>();
  return {
    entries,
    appendAuditEntry: (r: AuditEntryRow) => entries.push(r),
    getAuditEntries: () => entries,
    getAuditChainHead: () => (entries.length ? entries[entries.length - 1]!.entryHash : ''),
    putAuditRoot: (r: any) => roots.set(r.epochId, r),
    getAuditRoot: (id: string) => roots.get(id),
  } as unknown as AuditStore & { entries: AuditEntryRow[] };
}

// STRICT immutable S3 fake — simulates COMPLIANCE: overwriting an existing key is rejected.
// (NOT the permissive fakeS3() in anchor.test.ts, which silently allows overwrites.)
function immutableFakeS3(): S3LockClient {
  const m = new Map<string, Uint8Array>();
  return {
    async putObject(key, body) {
      if (m.has(key)) throw new Error('COMPLIANCE: object is locked; overwrite rejected');
      m.set(key, body);
    },
    async getObject(key) { return m.get(key); },
  };
}

// Build a 2-entry chained run with the REAL hashing primitives, returning rows + Merkle root.
function buildRun(runId: string): { rows: AuditEntryRow[]; root: Uint8Array } {
  const e0 = { runId, seq: 0, kind: 'run.submitted' as const, actor: 'human:brett', at: 't0' };
  const h0 = chainHash(canonEntry(e0 as any), '');
  const e1 = { runId, seq: 1, kind: 'run.completed' as const, at: 't1' };
  const h1 = chainHash(canonEntry(e1 as any), h0);
  const rows: AuditEntryRow[] = [
    { ...(e0 as any), entryHash: h0, prevHash: '' },
    { ...(e1 as any), entryHash: h1, prevHash: h0 },
  ];
  return { rows, root: merkleRoot(leavesFromEntryHashes([h0, h1])) };
}

// Chain-consistent forge: rewrite entry 0's actor, recompute its hash, and RELINK entry 1
// (prevHash + entryHash) so the chain re-verifies. Returns the fresh local Merkle root.
function forgeInPlace(rows: AuditEntryRow[]): Uint8Array {
  rows[0]!.actor = 'attacker';
  const h0 = chainHash(canonEntry(rows[0]! as any), '');
  rows[0]!.entryHash = h0;
  rows[1]!.prevHash = h0;
  rows[1]!.entryHash = chainHash(canonEntry(rows[1]! as any), h0);
  return merkleRoot(leavesFromEntryHashes([rows[0]!.entryHash, rows[1]!.entryHash]));
}

it('chain-consistent forge: LocalAnchor (mutable) is fooled -> intact:true', async () => {
  const { rows, root } = buildRun('r');
  const store = memStore(rows);
  const anchor = new LocalAnchor(store);
  await anchor.anchor({ epochId: 'r', root });            // seal original root

  const forgedRoot = forgeInPlace(store.entries);          // attacker forges the chain
  await anchor.anchor({ epochId: 'r', root: forgedRoot }); // mutable store: re-anchor SUCCEEDS

  const report = await verify('r', { store, anchor });
  expect(report.checks.chain.ok).toBe(true);               // forge kept the chain consistent
  expect(report.intact).toBe(true);                        // forgery UNDETECTED — "tamper-detecting only"
  expect(report.claim).toBe('tamper-detecting');
});

it('chain-consistent forge: S3ObjectLockAnchor (immutable) catches it -> root-mismatch', async () => {
  const { rows, root } = buildRun('r');
  const store = memStore(rows);
  const anchor = new S3ObjectLockAnchor(immutableFakeS3(), 'bucket');
  await anchor.anchor({ epochId: 'r', root });             // seal original root (immutable)

  const forgedRoot = forgeInPlace(store.entries);
  // attacker tries to re-anchor the forged root — COMPLIANCE rejects the overwrite
  await expect(anchor.anchor({ epochId: 'r', root: forgedRoot })).rejects.toThrow(/COMPLIANCE/);

  const report = await verify('r', { store, anchor });
  expect(report.checks.chain.ok).toBe(true);               // chain still consistent...
  expect(report.checks.root.ok).toBe(false);               // ...but recomputed root != immutable anchored root
  expect(report.failure).toBe('root-mismatch');
  expect(report.intact).toBe(false);
  expect(report.claim).toBe('tamper-detecting');           // the tamper-evident claim correctly collapses
});
```

- [ ] **Step 2: Run it and read the result**

Run: `cd packages/pangolin-orchestrator && npx vitest run test/audit/tamper-evident-contrast.test.ts`
Expected: **PASS** (both tests) — this proves the immutable anchor catches the chain-consistent forge that the mutable one cannot. **If the second test fails** (forge not caught), the original doubt was justified — STOP and investigate `verify`/anchor; do not weaken the assertions.

- [ ] **Step 3: Typecheck + lint + commit**

Run: `cd packages/pangolin-orchestrator && npx tsc --noEmit && npx eslint test/audit/tamper-evident-contrast.test.ts`
Expected: clean.
```bash
git add packages/pangolin-orchestrator/test/audit/tamper-evident-contrast.test.ts
git commit -m "test(audit): chain-consistent-forge contrast — immutable anchor catches root-mismatch (Gap A)"
```

---

## Task 2: Gap B client level — PUT-overwrite-rejection

**Files:**
- Modify: `packages/pangolin-storage-s3/test/aws-s3-lock-client.test.ts`

- [ ] **Step 1: Add the PUT-overwrite-rejection assertion**

Add a second `it` inside the existing env-gated `d(...)` block. It proves the immutability the anchor relies on, at the client boundary, against real MinIO. (Skipped unless `PANGOLIN_S3_ENDPOINT` is set — verified for real in Task 4.)

```typescript
  it('overwriting a key under COMPLIANCE retention is rejected', async () => {
    const client = new S3Client({ endpoint: MINIO, forcePathStyle: true, region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } });
    await client.send(new CreateBucketCommand({ Bucket: 'pangolin-audit', ObjectLockEnabledForBucket: true })).catch(() => {});
    const lock = new AwsS3LockClient({ client, bucket: 'pangolin-audit' });
    const future = new Date(Date.now() + 60_000);
    const key = `audit/roots/overwrite-${Date.now()}.json`;
    await lock.putObject(key, new Uint8Array([1]), { retainUntil: future, mode: 'COMPLIANCE' });
    // A second write to the SAME locked key must be rejected by COMPLIANCE.
    await expect(
      lock.putObject(key, new Uint8Array([2]), { retainUntil: future, mode: 'COMPLIANCE' }),
    ).rejects.toThrow();
    // And the original bytes still stand.
    expect(await lock.getObject(key)).toEqual(new Uint8Array([1]));
  });
```

- [ ] **Step 2: Confirm it compiles + still skips without the endpoint**

Run: `cd packages/pangolin-storage-s3 && npx tsc --noEmit && npx vitest run test/aws-s3-lock-client.test.ts`
Expected: tsc clean; vitest reports the suite **skipped** (no `PANGOLIN_S3_ENDPOINT` locally yet) — `1 skipped` / `0 failed`.

- [ ] **Step 3: Commit**
```bash
git add packages/pangolin-storage-s3/test/aws-s3-lock-client.test.ts
git commit -m "test(storage-s3): assert COMPLIANCE rejects key overwrite (Gap B, client level)"
```

---

## Task 3: Gap B round-trip — env-gated MinIO e2e

**Files:**
- Create: `test/e2e/tamper-evident-minio.test.ts`

- [ ] **Step 1: Write the env-gated end-to-end round-trip**

Lives in the neutral root e2e suite (run by the `e2e` workflow); imports `AwsS3LockClient` (storage-s3) + orchestrator/core via relative `../../packages/<pkg>/src/...` (matching the existing `test/e2e/*.test.ts` import style). Gated on `PANGOLIN_S3_ENDPOINT` ALONE.

```typescript
import { describe, it, expect } from 'vitest';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { AwsS3LockClient } from '../../packages/pangolin-storage-s3/src/index.js';
import { PangolinOrchestrator } from '../../packages/pangolin-orchestrator/src/orchestrator.js';
import { SqliteRunStateStore } from '../../packages/pangolin-orchestrator/src/runstate/sqlite.js';
import { ManualTrigger } from '../../packages/pangolin-orchestrator/src/triggers/manual.js';
import { AuditLog } from '../../packages/pangolin-orchestrator/src/audit/audit-log.js';
import { createLocalSigner, verifyEd25519 } from '../../packages/pangolin-orchestrator/src/audit/signer.js';
import { S3ObjectLockAnchor } from '../../packages/pangolin-orchestrator/src/audit/anchor.js';
import { verify } from '../../packages/pangolin-orchestrator/src/audit/verify.js';
import { canonEntry } from '../../packages/pangolin-orchestrator/src/audit/canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../packages/pangolin-orchestrator/src/audit/merkle.js';

// Gate the whole suite on PANGOLIN_S3_ENDPOINT alone (the storage-s3 idiom) — NOT the
// root suite's PANGOLIN_E2E_DOCKER docker-skip helper.
const d = process.env.PANGOLIN_S3_ENDPOINT ? describe : describe.skip;
const MINIO = process.env.PANGOLIN_S3_ENDPOINT;

function fakeExec() {
  let fired = false;
  return { id: 'x',
    async fire() { fired = true; return { dispatchHash: 'd' }; },
    async reconcile() { return fired ? { status: 'done' as const } : null; } };
}

d('real S3 Object Lock (tamper-evident readiness)', () => {
 it('clean run -> tamper-evident; chain-consistent forge -> root-mismatch', async () => {
  const client = new S3Client({ endpoint: MINIO, forcePathStyle: true, region: 'us-east-1',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } });
  await client.send(new CreateBucketCommand({ Bucket: 'pangolin-audit', ObjectLockEnabledForBucket: true })).catch(() => {});

  const store = new SqliteRunStateStore();
  const signer = createLocalSigner();
  const anchor = new S3ObjectLockAnchor(new AwsS3LockClient({ client, bucket: 'pangolin-audit' }), 'pangolin-audit');
  const auditLog = new AuditLog({ store, signer, anchor });
  const orch = new PangolinOrchestrator({
    store, executors: { x: fakeExec() },
    triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 1 } }, auditLog,
  });

  const runId = orch.submitRun(
    { id: `tev-${Date.now()}`, queue: 'default', items: [{ id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] },
    'human:brett');
  for (let i = 0; i < 6; i++) await orch.tick('default');
  expect(store.getAuditRoot(runId)).toBeDefined();

  // 1. Clean run against a REAL immutable anchor -> tamper-evident.
  const clean = await verify(runId, { store, anchor, verifySignature: (r, s) => verifyEd25519(r, s, signer.publicKey) });
  expect(clean.intact).toBe(true);
  expect(clean.claim).toBe('tamper-evident');

  // 2. Chain-consistent forge in the run DB (the attacker controls the local DB): rewrite seq 0's
  //    actor, recompute its entry_hash with the REAL primitives, and RELINK seq 1 so the chain
  //    re-verifies. The recomputed Merkle root will differ from the immutable anchored root.
  const db = (store as any).db as { prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown } };
  const rows = store.getAuditEntries(runId); // camelCase rows ordered by seq; >= 2 entries (run.submitted + run.completed)
  const e0 = { ...rows[0]!, actor: 'attacker' };
  const h0 = chainHash(canonEntry(e0), '');
  const e1Hash = chainHash(canonEntry({ ...rows[1]! }), h0); // seq1 content unchanged; only its prevHash relinks
  db.prepare('UPDATE audit_entries SET actor=?, entry_hash=? WHERE run_id=? AND seq=0').run('attacker', h0, runId);
  db.prepare('UPDATE audit_entries SET prev_hash=?, entry_hash=? WHERE run_id=? AND seq=1').run(h0, e1Hash, runId);

  // 3. Attacker tries to overwrite the anchored root in S3 -> COMPLIANCE rejects it (immutable).
  //    Re-anchoring the (now-different) forged root throws; the original anchored root stands.
  const forgedRoot = merkleRoot(leavesFromEntryHashes(store.getAuditEntries(runId).map((e) => e.entryHash)));
  await expect(anchor.anchor({ epochId: runId, root: forgedRoot })).rejects.toThrow();

  // 4. Re-verify -> fetches the immutable anchored root from S3, finds the mismatch.
  const tampered = await verify(runId, { store, anchor });
  expect(tampered.checks.chain.ok).toBe(true);   // chain stayed consistent (relinked)
  expect(tampered.failure).toBe('root-mismatch'); // caught by the external immutable anchor
  expect(tampered.intact).toBe(false);
  expect(tampered.claim).toBe('tamper-detecting');
 });
});
```

> **Note on step 3:** re-anchoring is the explicit "attacker tries to make the external record match the forgery" move; with a real COMPLIANCE bucket the overwrite is rejected (`rejects.toThrow()`), so the original root stays immutable. Step 4 is the load-bearing assertion — `verify` fetches that immutable root from S3 and reports `root-mismatch`. If step 3's overwrite ever SUCCEEDS against the real bucket, the bucket isn't truly object-locked — fix the bucket setup, the test is right.

- [ ] **Step 2: Confirm it compiles + skips without the endpoint**

Run: `pnpm test:e2e 2>&1 | grep -i "tamper-evident\|skip"`
Expected: tsc/build clean; the test is **skipped** locally (no `PANGOLIN_S3_ENDPOINT`).

- [ ] **Step 3: Commit**
```bash
git add test/e2e/tamper-evident-minio.test.ts
git commit -m "test(e2e): real-MinIO tamper-evident round-trip — clean->tamper-evident, forge->root-mismatch (Gap B)"
```

---

## Task 4: The real run — stand up MinIO and clear the gate

**Files:** (none — execution + the roadmap update in Task 5)

- [ ] **Step 1: Start MinIO with object lock**

```bash
docker run -d --name pangolin-minio-objlock -p 9000:9000 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data
```
(Object lock is enabled per-bucket at creation by the tests' `CreateBucketCommand({ ObjectLockEnabledForBucket: true })`, so no extra MinIO flags are needed beyond a fresh server.)

- [ ] **Step 2: Run the client-level test for real**

Run:
```bash
PANGOLIN_S3_ENDPOINT=http://127.0.0.1:9000 \
  pnpm --filter @quarry-systems/pangolin-storage-s3 exec vitest run test/aws-s3-lock-client.test.ts
```
Expected: **2 passed** (delete-rejection + the new overwrite-rejection) — proving real COMPLIANCE immutability.

- [ ] **Step 3: Run the round-trip e2e for real**

Run:
```bash
PANGOLIN_S3_ENDPOINT=http://127.0.0.1:9000 pnpm test:e2e 2>&1 | grep -iE "tamper-evident|passed|failed"
```
Expected: the `tamper-evident-minio` test **passes** — `clean.claim === 'tamper-evident'`, and the forge yields `failure: 'root-mismatch'`, `claim: 'tamper-detecting'`. **Read the result:** pass → gate CLEARED; fail on step "forge caught" → real bug, STOP and investigate.

- [ ] **Step 4: Tear down MinIO**

```bash
docker rm -f pangolin-minio-objlock
```

- [ ] **Step 5: Record the cleared gate**

Note the passing output (the four acceptance boxes). No commit here — the roadmap update is Task 5.

---

## Task 5: Promote the claim — update roadmap + vault (only after a green Task 4)

**Files:**
- Modify: `ROADMAP.md`
- Modify: `docs-site/src/content/docs/explanation/project-status-roadmap.md`

- [ ] **Step 1: Update the known-gap wording**

In both files, change the known-gap from "the external-immutable tamper-evident tier is unproven end-to-end" to "**proven**: a chain-consistent forge is caught as `root-mismatch` against a real S3 Object Lock COMPLIANCE bucket (the readiness test cleared 2026-06-13); the seal earns `tamper-evident` at the `external-immutable` tier." Keep the remaining honest gaps (#2–#5: authz-in-evidence, retention, access-log, key custody) intact. (Read the exact current wording in each file first — match the surrounding voice.)

- [ ] **Step 2: Commit**
```bash
git add ROADMAP.md docs-site/src/content/docs/explanation/project-status-roadmap.md
git commit -m "docs: tamper-evident leave-gate cleared — external-immutable tier proven end-to-end"
```

- [ ] **Step 3: Mark the vault task done (post-merge, via the channel)**

After the PR merges, record the cleared gate on the `agora-dev` channel and mark `task-tamper-evident-readiness-test-…` done (it's the user's vault; note it for them rather than editing directly).

---

## Self-Review notes (author)

- **Spec coverage:** Gap A §4 → Task 1 (single contrast test, strict immutable fake, real-primitive forge). Gap B client §5.1 → Task 2. Gap B round-trip §5.2 → Task 3 (root e2e, `PANGOLIN_S3_ENDPOINT`-gated alone). Real run §5.3 → Task 4. Acceptance §6 + claim promotion → Task 5. Defer list §3 honored (no abstractions/4th tier/verify refactor).
- **Type consistency:** `immutableFakeS3`/`memStore`/`buildRun`/`forgeInPlace` defined in Task 1 and re-used by reference in Task 3's note; `S3LockClient`, `AuditEntryRow`, `AuditStore`, `S3ObjectLockAnchor`, `LocalAnchor`, `verify`, `AuditLog`, `createLocalSigner`/`verifyEd25519` all match the real exports verified in the source.
- **No-placeholder check:** Task 3 step 2's forge is flagged as "write the actual UPDATE statements, don't leave prose" with the column-name verification step — the one place needing implementer care; everything else is complete code.
- **TDD note:** these are characterization/adversarial tests of existing behavior; the "read the result" framing (pass = proven, fail = real bug, never weaken) is stated up front and per-task.
