# Typed-product node→node handoff (the `inputs/`/`outputs/` seam)

**Status:** design approved 2026-06-04 · **Author:** agent:claude-opus-4-8 (with Brett) · **Confidence:** medium

The mechanism by which a dependent task receives an upstream task's output by
content-addressed **reference**, so dependent dev (and, later, data) DAGs actually
run — downstream tasks build on upstream products. This is the load-bearing first
build of the composable execution model.

## 1. Context and locked decisions

This spec implements the handoff that the following vault pages settled. They are
**not** re-litigated here:

- `concept-typed-product-handoff` — handoff = typed, content-addressed ref (dev=patch-ref,
  data=dataset-ref, doc=doc-ref); the pattern's `onTaskDone` routes an upstream output ref
  into a downstream pending item's typed input; the worker stages it via an `inputs/` overlay.
- `idea-agora-bidirectional-artifact-seam` — the half-spec: `inputs/` in + `outputs/` out,
  both content-addressed + in the audit manifest; one spec covers both directions because
  they share storage + overlay/capture machinery + the audit-manifest hook.
- `decision-2026-06-03-pack-architecture-invariants-ship-only` — typed-product handoff LOCKED
  over workspace-mediated; outputs seam = invariant #3; effect-in-evidence = invariant #4.
- `decision-2026-06-04-execution-patterns-are-queue-level` — the pattern routes outputs→inputs;
  "the one genuinely new cross-layer mechanism is the typed-product handoff."
- `synthesis-composable-execution-model` — the 3-axis model (pattern × executor × block-pipeline
  over a fixed seal).
- `concept-audit-seal` — every task still seals; refs go in the manifest, verifiable independently.

### Settled constraints (carried in, not re-opened)

- Handoff is by content-addressed typed **ref**, not a shared workspace (serves dev AND data).
- The pattern's `onTaskDone` routes an upstream output ref into a downstream PENDING item's
  typed input; the worker stages it via an `inputs/` overlay (reuse `overlay-engine`).
- Edge-type compatibility is the only cross-cutting rule; mismatches → adapter blocks.
- Every task ends in `seal`; input-ref + output-ref MUST land in the audit manifest.
- v1 = **static** dependent DAG (whole DAG submitted up front). No `extendRun`/dynamic spawn.

### Two decisions made during this brainstorm

- **Scope: go large — build the FULL bidirectional seam in v1** (`inputs/` injection *and* the
  `outputs/` content-addressed capture), not the input-side-only minimum. Rationale: lay down
  the real composable-model substrate to set the stage for the next blocks/patterns work, per
  the bidirectional-artifact idea's own recommendation to spec both directions together. The
  dev pack will only exercise the input side (its output is already a patch), but the output
  seam ships so the first non-dev pack finds it ready.
- **Injection mechanism: resolve-at-fire (inputs stay immutable).** The concept page's "a small
  store op that injects the ref into a not-yet-ready item's `inputs`" is read as *intent*, not a
  schema mandate. The code shows `WorkItem.inputs` is an immutable JSON snapshot under a
  single-writer store with idempotent `saveRun`; mutating pending items would add a write path
  and a retry/idempotency hazard. Resolve-at-fire honors the intent (the ref lands in the
  downstream's *effective* input and in the sealed manifest) without touching those invariants.
- **The seal must be rock-solid (GTM priority).** `verify()` must *prove the handoff chain*, not
  merely record the refs. This is satisfied by the provenance-closure check in §6.

## 2. Audited ground truth (code, 2026-06-04)

The design rides seams that already exist. Key facts:

**Orchestrator**
- `WorkItem = { id, executor, inputs: Record<string,unknown>, depends_on: string[], resourceLocks, subagentShape? }`
  (`packages/agora-orchestrator/src/contracts/types.ts`). `inputs` is persisted as an **immutable**
  `inputs TEXT` JSON column (`runstate/sqlite.ts`); no store op mutates a pending item.
- `tick.ts` lifecycle: `computeNewlyReady` (all deps `done`) → reconcile running (`done` + `resultRef`
  → `setResultRef`, **then the resultRef is never read again**) → validate `shape.inputSchema` +
  `acquireLocks` + `fire` → cascade skipped. The natural injection seam is **after reconcile-done,
  before downstream fire**. `effectTier` is computed then `void`-ed (`tick.ts:96`).
- `Executor.fire(item, ctx) → { dispatchHash, manifestRef? }`; `reconcile(hash) → { status, output?, resultRef? } | null`
  (`contracts/executor.ts`). For dev, `resultRef` IS the patchRef, read from the worker `output.json`
  sentinel (`executors/dispatch.ts` `readPatchRef`).
- `operations-api.submit(run, actor)` does **zero** validation; schema validation is lazy at fire-time.
- `PackRegistry`/`SubagentShape { id, effectTier, inputSchema, outputSchema, capability }`
  (`contracts/subagent-shape.ts`, `packs/dev.ts`: `dev.code-edit`, `dev.verify`). `outputSchema`
  declared, not yet enforced.

**Worker**
- `overlay-engine.overlayCapabilities({ workspaceDir, bundles: { name, files: Record<path,Uint8Array> }[], adapter })`
  is **content-source-agnostic, path-based** — directly reusable by feeding `inputs/...` paths.
- `bundle-fetcher` fetches only `{ subagentDef, capabilities, envs }`; **no input-blob/artifact fetch.**
  `DispatchWork` has **no `inputRefs`/`outputRefs`**; `AGORA_INPUT_JSON` is inline JSON. `resources`
  means `{cpu,memory}` (naming landmine).
- `needs-input.ts` is the **HITL** "agent needs a human answer" sentinel — unrelated to artifact inputs.
- Output today = `computeWorkspacePatch` (plain `git diff`, no `--binary`) → content-addressed
  `patchRef` in `output-sentinel.ts` `OutputSentinel { schemaVersion:1, patchRef?, summary? }`.
  **No `outputs/` dir capture.**
- `entrypoint.ts` Step 6 (~268-288) overlays only `bundles.capabilities`.

**Audit/seal**
- `DispatchManifest { schemaVersion:1, runId, itemId, parent, executor, executorManifest, secretRefs,
  actor, submittedAt?, firedAt, manifestHash, signature? }`; `manifestHash = computeContentHash(base)`.
  The canonicalizer **sorts keys and drops `undefined`** (`agora-core/content-hash.ts`), so adding
  optional fields is **hash-safe by construction**. `canon.ts` `canonEntry` already has a `resultRef` slot.
- `verify()` checks chain hash + merkle root + anchor + signature; it does **not** fetch manifests
  or check cross-task ref linkage (`audit/verify.ts`, `verify-bundle.ts`). `AuditBundle` already
  carries `manifests: DispatchManifest[]`.
- Content-addressing substrate is mature: `computeContentHash → buildAgoraUri → storage.put/get`,
  dedup-by-hash, `verifyContentHash` on read. `capabilities-register.ts` is the pattern to mirror.

## 3. Wiring declaration — `needs` on the WorkItem

```typescript
interface WorkItem {
  id: string;
  executor: string;
  inputs: Record<string, unknown>;        // immutable submitted snapshot (unchanged)
  needs?: Record<string, InputBinding>;    // NEW: input key -> upstream product
  depends_on: string[];
  resourceLocks: string[];
  subagentShape?: string;
}

type InputBinding = {
  from: string;            // upstream item id
  select: OutputSelector;  // WHICH product of the upstream (nodes now emit >1)
};

type OutputSelector =
  | { kind: 'patch' }                 // the dev resultRef (=patchRef) — degenerate dev case
  | { kind: 'output'; path: string }; // a file the upstream wrote to outputs/
```

- The ergonomic `needs: { x: from('A') }` is lib/CLI sugar over this explicit wire form.
- **`needs` auto-contributes to `depends_on`**: at submit-normalization, `needs[*].from` is unioned
  into `depends_on`. The engine's readiness logic (`dep-resolver.computeNewlyReady`) is **untouched**,
  and it is impossible to wire a need without its dependency. `needs` is the only edge representation;
  there is no separate edge list on `Run`.
- Persisted as a `needs TEXT` JSON column alongside `depends_on` in `runstate/sqlite.ts`; round-tripped
  in `rowToItem`.

## 4. Resolve-at-fire — the engine mechanism (no store mutation)

In `tick.ts`, insert resolution in the fire path **immediately before `inputSchema` validation**:

```
const resolvedInputs = { ...it.inputs };
const inputRefs: Record<string,string> = {};
for (const [key, binding] of Object.entries(it.needs ?? {})) {
  const upstream = byId(store.getItems())[binding.from];   // 'done' guaranteed by depends_on
  const ref = selectProductRef(upstream, binding.select);  // upstream.resultRef OR upstream.outputRefs[path]
  resolvedInputs[key] = ref;
  inputRefs[key] = ref;
}
// existing validation, now over the resolved value:
if (it.subagentShape) shape.inputSchema.safeParse(resolvedInputs)  // fail -> setStatus('failed', ...)
if (!store.acquireLocks(it.id, it.resourceLocks)) continue;
await ex.fire(it, { ...ctx, inputRefs });                          // FireContext gains inputRefs
```

- **The store is never mutated for a pending item.** Submitted `inputs` remain the immutable snapshot;
  resolution is a read + merge into the dispatch payload. Single-writer + `saveRun` idempotency untouched.
- **Idempotent under retry by construction**: an upstream is `done` (and a `done` item never re-runs)
  before the downstream becomes ready, so re-resolution after a downstream requeue reads identical refs.
- **Refs are sha256 content hashes**, so "resolved to ref X" *is* "resolved to content X."
- `selectProductRef`:
  - `{ kind: 'patch' }` → `upstream.resultRef` (existing).
  - `{ kind: 'output', path }` → `upstream.outputRefs[path]` (new store field, §5).
  - Missing product → `setStatus(downstream, 'failed', 'unresolved needs <key>')` (defensive; the
    submit-time edge check in §7 should already have caught structural mis-wiring).

**Contract changes**
- `FireContext` gains `inputRefs?: Record<string,string>`. The `Executor` interface signature is unchanged.
- `DispatchExecutor.fire` threads `ctx.inputRefs` into `DispatchWork.inputRefs` (§6).

**One store addition (write-on-completion, consistent with invariants)**
- `RunStateStore.setOutputRefs(itemId, map: Record<string,string>)` + an `output_refs TEXT` JSON column.
  Written by reconcile alongside `setResultRef` — the same write-back path, **not** a pending-item mutation.
- `ItemState` gains `outputRefs?: Record<string,string>`.

## 5. Worker — `inputs/` overlay in, `outputs/` capture out

### Input side (reuse `overlay-engine` verbatim)

- `DispatchWork` gains `inputRefs?: Record<string,string>` (key → content-addressed URI). **Not**
  `resources` (that is `{cpu,memory}`).
- `bundle-fetcher` gains an input fetch: `storage.get(ref)` + `verifyContentHash(bytes, hash)`
  (integrity-on-read for free), returned as a new `FetchedBundles.inputs: FetchedInput[]`
  (`{ key, bytes, contentHash }`).
- `entrypoint.ts` Step 6: after the capability overlay, a **second `overlayCapabilities` pass** with
  bundles shaped `{ name: 'inputs', files: { 'inputs/<key>': bytes } }`. Materializes at
  `workspace/inputs/<key>`. `AGORA_INPUT_JSON` still carries the ref URIs as values so the prompt
  can name them.
- **Consumption ≠ materialization.** The seam *materializes the bytes at `inputs/<key>`*. Whether dev
  then `git apply`s `inputs/patch.diff` is a **pack/setup concern** (`agora-setup.sh`), not the generic
  seam — the "don't over-fit to git" discipline; the seam serves dev and data identically.

### Output side (the "go large" addition)

- After the run, capture everything under `workspace/outputs/`: per file
  `computeContentHash → buildAgoraUri({ type: 'artifact', ... }) → storage.put`, collect `{ path, ref }`.
- Extend `OutputSentinel` **additively**: `{ schemaVersion: 1, patchRef?, summary?, outputs?: Array<{ path, ref }> }`.
  `patchRef` stays for the dev trunk; `outputs[]` is the **distinct** non-patch channel.
- `DispatchExecutor.reconcile` reads `sentinel.outputs` → returns `ExecutionResult.outputRefs:
  Record<path,ref>`; `tick` stores them via `setOutputRefs`.
- `ExecutionResult` gains `outputRefs?: Record<string,string>`.

## 6. Edge-type validation — at submit, fail-fast

`operations-api.submit` validates nothing today (lazy at fire). Add a **submit-time edge check**
(also the `agora pipeline validate` CLI surface) — "before anything runs". Two deliberate layers:

- **(a) submit-time edge-type-tag compatibility.** Each typed product carries an edge-type **tag**
  (`patch-ref`; later `dataset-ref`, `doc-ref`). An edge `A.select → B.needs[key]` is valid iff the
  upstream product's tag matches the downstream's expected-input tag. Fast, whole-DAG, fails the
  submission before any task fires. Also validates: `from` references an existing item; the selected
  product exists on the upstream shape's declared outputs; `needs ⊆ depends_on` (post-normalization).
- **(b) fire-time `inputSchema.safeParse`** on the resolved value — already exists, unchanged; the
  structural check on the actual resolved bytes.

Deep zod *structural* subsetting is intentionally **not** used: it is brittle and is not what lets
heterogeneous pipelines coexist — tag-matching is (it is literally "edge-type compatibility"). Dev v1
is the degenerate `patch-ref → patch-ref` case. A tag mismatch → submission rejected with a clear
`edge A→B: X→Y incompatible; needs an adapter block`. **Building** adapter blocks is deferred; naming
the gap precisely is v1.

Tags are sourced from a lightweight `edgeType` annotation on the shape's declared products (additive
to `SubagentShape`); with only the dev pack, the sole tag is `patch-ref`.

## 7. Audit — rock-solid seal via provenance closure

### Seal the refs (additive, hash-safe)

`DispatchManifest` gains optional `inputRefs?: Record<string,string>` and
`outputRefs?: Record<string,string>`.
- `inputRefs` are known at fire (where the manifest is already built in `executors/dispatch.ts`);
  added to `BuildManifestInput` and to `base` before `computeContentHash(base)`.
- `outputRefs` are produced at completion; sealed via the worker's already-content-addressed
  `output.json` sentinel and surfaced into the `done` audit entry / item outcome.
- The canonicalizer drops `undefined`, so these additions **cannot perturb existing hashes** — proven
  by the existing additive-safety contract.

### verify() proves the chain — provenance closure (the strong invariant)

> Every `inputRef` consumed by any item must equal a **sealed output product**
> (`resultRef`/`outputRef`) of another item in the same run, whose own manifest is chain-verified.

Because refs are sha256 content hashes, ref-equality *is* byte-equality — so `verify()` proves *every
byte a downstream saw was produced by a verified upstream in this sealed run*, **without re-fetching a
single blob and without trusting the operator.** This is qualitatively stronger than "we logged the refs."

Implementation: `verify()` keeps its chain / merkle / anchor / signature checks and adds a **`handoff`
check** over the bundle's `manifests: DispatchManifest[]` (already carried by `AuditBundle`):
1. Build the set of all sealed product refs across items (`resultRef` ∪ each `outputRefs` value).
2. For each item's `inputRefs`, assert every consumed ref ∈ that set, and that the producing item's
   manifest passed the chain check.
3. Any unaccounted-for input ref → report as a broken/tampered chain.

`renderVerification` (`audit/render.ts`) gains one more check row (`handoff`). `VerificationReport.checks`
gains a `handoff` entry.

## 8. Scope — v1 vs deferred

**In v1**
- `needs` wiring (+ auto-`depends_on` union) on `WorkItem`, persisted.
- Resolve-at-fire in `tick.ts` (no store mutation); `selectProductRef`.
- `RunStateStore.setOutputRefs` + `output_refs` column; `ItemState.outputRefs`.
- Worker: `DispatchWork.inputRefs`, `bundle-fetcher` input fetch + verify, `inputs/<key>` overlay
  (reuse `overlay-engine`).
- Worker: `outputs/` capture → `OutputSentinel.outputs[]` → `reconcile` → `setOutputRefs`.
- Submit-time edge-type-tag validation (`operations-api` + `agora pipeline validate`); `edgeType` tag
  on shapes.
- Manifest `inputRefs`/`outputRefs` sealed (additive).
- `verify()` provenance-closure `handoff` check + render row.
- **Demonstrated by the dev DAG**: `dev.code-edit → dev.verify` where verify consumes code-edit's patch
  through the seam, green end-to-end, with a passing provenance-closure `verify()`.

**Deferred**
- `dataset-ref` / `doc-ref` packs (the seam is generic; only dev exercises it in v1).
- Dynamic `spawn` / `extendRun` (v1 = static DAG).
- Adapter-block **construction** (v1 rejects mismatches with a precise error).
- Pack-specific consumption such as auto-`git apply` of `inputs/patch.diff` (setup-script concern).
- Seal-edge hardening (trusted time, signing-key custody, retention) — separate spec.

## 9. Risks / open notes

- **`edgeType` tag placement** on `SubagentShape` is additive but is a new product-typing surface; with
  one tag (`patch-ref`) it is trivially exercised. The shape of multi-product output typing (one tag per
  declared output) is forward-looking and unvalidated until a second pack.
- **`OutputSentinel` stays `schemaVersion: 1`** with an additive optional `outputs` field; readers must
  tolerate its absence (they already do via canonical drop-undefined). If a breaking sentinel change is
  ever needed, bump to `2` then.
- **Whole bet is dogfood-unvalidated** until a non-dev pack exercises the output seam — consistent with
  the medium confidence on the parent decisions.
