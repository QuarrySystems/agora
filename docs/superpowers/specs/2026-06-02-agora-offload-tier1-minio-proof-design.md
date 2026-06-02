---
title: "Agora Offload — Tier-1 MinIO Proof (remote-stack validation for $0)"
date: 2026-06-02
status: draft
authors: [human:Brett, agent:claude-opus-4-8]
builds_on:
  - "[[docs/superpowers/specs/2026-05-28-agora-orchestrator-design.md]]"
  - "[[docs/superpowers/specs/2026-05-29-agora-offload-v1-design.md]]"
---

# Agora Offload — Tier-1 MinIO Proof

> **Goal:** prove the offload orchestrator can run as a remote-style service —
> submit over an S3 inbox with no inbound networking, dispatch across multiple
> named worker locations, escape patches, and produce a **genuinely
> tamper-evident** (`external-immutable`) audit bundle — using only free,
> S3-compatible substitutes (MinIO + local Docker). No AWS spend, near-zero
> Anthropic spend.
>
> This is **Tier 1** of the two-tier plan agreed in the 2026-06-01/02 design
> conversation. Tier 2 (the real Fargate + S3 parity run) becomes a pure
> endpoint/config swap once this passes — it is explicitly out of scope here.

---

## 0. Why this exists

The Offload V1 spec ([2026-05-29](./2026-05-29-agora-offload-v1-design.md))
shipped `serve`, the submission transport, patch escape, and the Merkle/anchor
audit layer — but its one operator-deferred acceptance item is the **Fargate + S3
parity run**, and the V1 `offload-fanout` demo only exercises the *local* stack
(`LocalStorageProvider`, `LocalDirMailbox`, `LocalAnchor` = `tamper-detecting`).

Two things were never validated end-to-end:

1. The **S3 submission/transport model** — submit via an object store, `serve`
   polls it, no inbound networking. (V1 ships **only** `LocalDirMailbox`; there is
   no S3-backed `MailboxStore` yet.)
2. The **`external-immutable` audit tier** — `S3ObjectLockAnchor` exists but has
   never run against a real object-lock backend, nor has the "DB tampered, but the
   anchored root cannot be rewritten → verification fails" claim been demonstrated.

Both can be proven for $0 against MinIO (S3-compatible, supports object lock).
Doing so also *builds the two genuinely-missing production pieces* (an S3 mailbox
and a concrete S3-lock client), so Tier-2 Fargate is a config swap, not new code.

## 0.1 What this proves vs. defers

**Proves (Tier 1):**
- `serve` as a remote-style service: client and service communicate **only**
  through the object-store mailbox (no direct connection).
- Multiple worker locations via **routing-by-executor-name** (two registered
  dispatch executors; per-`WorkItem` selection).
- Patch escape → `result_ref` against S3-backed content-addressed storage.
- `external-immutable` audit tier against MinIO Object Lock, **including the
  DB-tamper-fails-verification** test.
- Zero/near-zero cost: most work runs a no-model adapter; one item runs real Claude.

**Defers (explicitly out of scope):**
- Real AWS (Fargate compute, real S3, EFS volume, KMS signer) — Tier 2.
- Genuine cross-*machine* dispatch (second physical box via `DOCKER_HOST=ssh`).
  Tier-1 routes to two executors that both target the *local* Docker daemon; this
  proves the routing seam. Cross-machine is a target-string change later.
- Containerizing `serve` itself (host Node process is sufficient to prove the
  mailbox decoupling — see §5). Containerization is cosmetic for Tier 1.
- Everything already deferred by the V1 spec (Intent/interpreter, `dev` pack,
  budgets, `cron`, RBAC, BYOK).

---

## 1. New components

Four building blocks, named for their **mechanism**, not the deployment they are
tested against (MinIO-ness lives only in config — see §6):

| Component | What it is | Home (Tier 1) |
|---|---|---|
| `S3Mailbox` | `MailboxStore` (`put/get/list/delete` over `/`-delimited keys) implemented against an **injected minimal S3 seam** — same injection pattern `S3ObjectLockAnchor` already uses, so `agora-orchestrator` gains **no** AWS-SDK dependency. | `agora-orchestrator/src/mailbox/s3.ts` (reusable logic) |
| `MailboxS3Client` | The tiny injected seam `S3Mailbox` depends on (object put/get/list/delete). Interface only. | `agora-orchestrator/src/contracts/mailbox.ts` |
| `AwsS3MailboxClient` | Concrete `MailboxS3Client` backed by `@aws-sdk/client-s3`; endpoint-configurable (MinIO now, real S3 later). | `examples/offload-minio/` for now |
| `AwsS3LockClient` | Concrete `S3LockClient` (the seam `S3ObjectLockAnchor` already declares): `PutObject` with object-lock `COMPLIANCE` retention + `GetObject`. Endpoint-configurable. | `examples/offload-minio/` for now |
| `no-model` RuntimeAdapter | ~20-line `RuntimeAdapter` (`{name, invoke}`) that deterministically edits a workspace file so diff-capture/escape fires with **zero tokens**. | `examples/offload-minio/adapters/no-model/` → baked into a local worker image |

**Trap-check / promotion (orchestrator spec §11):** the two `Aws*` concrete
clients stay example-local until a **second consumer** (Tier-2 Fargate) pulls
them; at that point they promote to `agora-storage-s3` (which already carries the
AWS SDK). The reusable `S3Mailbox` logic and its seam live in the orchestrator
now because that is where `MailboxStore` lives and the dependency direction stays
downhill (`orchestrator → storage-s3 → core`).

### 1.1 Dependency direction (must stay downhill)

`MailboxStore` and the new `MailboxS3Client` seam live in `agora-orchestrator`.
`S3Mailbox` (orchestrator) depends only on those interfaces. The concrete
`AwsS3MailboxClient` / `AwsS3LockClient` depend on `@aws-sdk/client-s3` and live
in the example, injected at construction — exactly mirroring how the example
already injects `LocalDirMailbox` into `MailboxSubmissionTransport` and how
`S3ObjectLockAnchor` takes an injected `S3LockClient`. No package gains an uphill
edge.

---

## 2. Infrastructure (all local, $0)

- **`examples/offload-minio/docker-compose.yml`** — a MinIO container with **two
  buckets** (the split is load-bearing, not cosmetic — see below):
  - **`agora-audit`** — created **with object lock enabled** (object lock can only
    be set at bucket creation), `COMPLIANCE` mode. Anchor roots **only**.
  - **`agora-data`** — a normal bucket (no lock) holding both the content-addressed
    storage and the mutable mailbox inbox/outbox (under distinct prefixes).
  - root credentials via compose env; surfaced to the example config.

  **Why two buckets:** object lock is a *bucket-level* setting and a `COMPLIANCE`
  bucket **rejects deletes/overwrites** before retention expires. The mailbox needs
  `delete` (consume inbox entries) and storage round-trips fine without lock, so
  both live in `agora-data`; only the WORM anchor roots go in `agora-audit`. Putting
  the mailbox in the locked bucket would break inbox consumption.
- **`serve`** runs as a **host Node process** (`serve({ orchestrator, transport,
  signal })`), exactly as `offload-fanout` does. It is the only DB opener and the
  only `tick()` caller. The client (`OperationsApi`) reaches it **only** through
  the MinIO mailbox — that is what proves the no-inbound-networking model
  regardless of whether `serve` is containerized.
- **Workers** run in **local Docker** via `LocalDockerProvider`. This requires the
  worker image built locally (it is GHCR-private):
  `docker build -t ghcr.io/quarrysystems/agora-worker:latest -f docker/agora-worker/Dockerfile .`
  — see §4 for the no-model adapter addition.

---

## 3. Worker: per-item adapter selection (the zero-token mechanism)

Grounded in the worker code:

- `loadRuntimeAdapter(name)` resolves `<adaptersRoot>/<name>/index.js` (default
  root `/opt/agora/adapters`), constructing the module's default factory.
- The adapter `name` comes from the **`AGORA_RUNTIME_ADAPTER`** env var (default
  `claude-code`).
- `WorkItem.inputs.env` flows straight through `DispatchExecutor.fire` →
  `client.dispatch.fire({ env })` to the worker.

Therefore **per-item adapter selection is just an env var** — no new plumbing:

- No-model items set `env: ["AGORA_RUNTIME_ADAPTER=no-model"]`.
- The one real item omits it (defaults to `claude-code`).

### 3.1 The `no-model` adapter

A `RuntimeAdapter` whose `invoke()` performs a deterministic workspace edit (e.g.
rename `OLD_NAME → NEW_NAME` in a seeded fixture file, mirroring `offload-fanout`'s
prompt-driven edit) and returns success. Because it runs at the adapter step
(after `captureBaseline`, before `computeWorkspacePatch`), its edit produces a
real diff → a patch artifact → a `result_ref`. No model call, no tokens.

### 3.2 Getting the adapter into the container

**Resolved approach:** bake a **second adapter** into a locally-built worker image
alongside `claude-code`, so a single `workerImage` serves both executors and the
no-model/real choice is purely the `AGORA_RUNTIME_ADAPTER` env var. Concretely: a
thin `examples/offload-minio/Dockerfile` that `FROM`s the base worker image and
`COPY`s the compiled `no-model` adapter to `/opt/agora/adapters/no-model/index.js`.

> **Confirm during implementation (plan task 1):** read `docker/agora-worker/Dockerfile`
> to verify the adapters path and base layout, and confirm `LocalDockerProvider`
> does not expose a simpler bind-mount for `adaptersRoot` (if it does, a mount is
> preferable to a derived image). The env-var selection mechanism above is
> confirmed; only the *delivery* mechanism needs this check.

---

## 4. Configuration (`examples/offload-minio/agora.config.mjs`)

Modeled on `examples/offload-fanout/agora.config.mjs`, with these swaps:

- **storage** → `S3StorageProvider` with an injected `S3Client` pointed at MinIO
  (`endpoint: http://localhost:9000`, `forcePathStyle: true`, region/creds from
  compose env), bucket `agora-data` (storage prefix).
- **transport** → `new MailboxSubmissionTransport(new S3Mailbox(new AwsS3MailboxClient({ endpoint, bucket: 'agora-data', prefix: 'mailbox/', ... })))`.
- **anchor** → `new S3ObjectLockAnchor(new AwsS3LockClient({ endpoint, bucket: 'agora-audit', ... }), 'agora-audit')`
  (replaces `LocalAnchor`; the object-lock bucket).
- **executors** → **two** dispatch executors, both `target: 'local'`, same
  `workerImage` (the §3.2 image), keyed `dispatch-a` and `dispatch-b`.
- **signer** → `createLocalSigner()` (ed25519) — unchanged; `KmsSigner` is Tier-2.

All MinIO-specific values (endpoint, bucket names, `forcePathStyle`, credentials)
live here in config — **not** in any class name (§1).

---

## 5. Run shape (`examples/offload-minio/plan.json` + driver)

A single submitted `Run` that exercises every claim at once:

- **N no-model `code-edit` items** (e.g. 3), each with a **per-file
  `resourceLock`**, split across the two executors:
  `executor: "dispatch-a"` vs `"dispatch-b"` — proving routing-by-name. One file
  is shared so its lock forces serialization (disjoint locks fan out).
- **1 real-Claude `code-edit` item** (`executor: "dispatch-a"`, default adapter)
  on its own fixture file — proves the real AI path.
- **1 `verify` gate item** that `depends_on` all edits — proves DAG ordering.

The driver follows `offload-fanout/src/index.ts`: wire client + orchestrator +
`S3Mailbox` transport + `serve`, then `OperationsApi.submit → watch → status →
audit`. A live-run guard checks `ANTHROPIC_API_KEY` only because of the one real
item; the no-model majority needs no key.

---

## 6. Acceptance criteria (the proof passes iff)

1. `submit` returns a run id and does not block.
2. `watch` shows waves advancing with blocking reasons (lock/dep), driven entirely
   through the **MinIO** mailbox (no direct client↔serve channel).
3. Every edit item — including the real-Claude one — exposes a `result_ref`;
   fetching it from MinIO yields a reviewable patch.
4. `audit <run-id>` produces a bundle whose `report.intact === true` and
   **`report.guarantee === 'external-immutable'`** and `report.claim` reads
   *tamper-evident* (not merely *tamper-detecting*), with `anchorId` naming the
   MinIO object-lock anchor.
5. **DB-tamper test:** mutate a persisted audit entry in the SQLite store, leave
   the MinIO-anchored root untouched, re-run verification → it **fails** (root
   mismatch against the un-rewritable anchored root). This is the compliance edge,
   demonstrated for free.
6. The exported bundle contains **no secret values** (refs only).

## 7. Testing

- **Unit (against the MinIO container):** `S3Mailbox` round-trips
  (put/get/list/delete, prefix-scoped list, absent→null); `AwsS3LockClient`
  writes an object under `COMPLIANCE` retention and a delete/overwrite before
  retention is rejected; `AwsS3MailboxClient` parity with `LocalDirMailbox`
  behavior.
- **e2e (live):** the §5 run, asserting the §6 criteria — green run + a separate
  asserted-failure tamper case.
- **CI smoke (no Docker / no MinIO / no key):** mirror `offload-fanout`'s fake-
  executor test — assert `plan.json` shape (executor routing + locks + verify
  `depends_on`) and that a fake-executor `AgoraOrchestrator` drives it to
  completion. `S3Mailbox` logic unit-tested against an in-memory `MailboxS3Client`
  fake so its logic has coverage without a container.

## 8. Risks & open details

- **Primary risk — no-model adapter delivery into the container** (§3.2). Mitigated
  by the confirmed env-var selection mechanism; only the image-vs-mount delivery
  needs the plan's task-1 check. Fallback if the derived image is awkward: a
  bind-mount of the adapter dir, if `LocalDockerProvider` supports extra mounts.
- **MinIO object-lock semantics** — bucket must be created with object lock
  *enabled* up front; `COMPLIANCE` mode + a short retention for the test. Verify
  the AWS SDK `PutObject` object-lock params (`ObjectLockMode`,
  `ObjectLockRetainUntilDate`) are honored by the MinIO version pinned in compose.
- **`serve` host-process honesty** — the proof's "no inbound networking" claim
  rests on the client using *only* the mailbox. Keep the driver from sharing the
  `orchestrator`/`store` object with the client path; the client must go through
  `OperationsApi` over the transport, exactly as `offload-fanout` already does.
- **Storage vs mailbox vs anchor buckets** — content-addressed artifacts
  (`S3StorageProvider`) and the mutable inbox/outbox (`S3Mailbox`) share the
  unlocked `agora-data` bucket under distinct prefixes; the WORM anchor roots
  (`AwsS3LockClient`) **must** be the separate object-lock `agora-audit` bucket
  (§2). They are distinct seams; do not conflate, and never point the mailbox at a
  locked bucket (deletes would fail).

## 9. Tier-2 handoff (what this buys)

When a paying reason justifies the real run, Tier 2 is:
1. Promote `AwsS3MailboxClient` / `AwsS3LockClient` to `agora-storage-s3`
   (now a second consumer exists).
2. Swap config endpoints MinIO → real S3; swap `createLocalSigner` → `KmsSigner`.
3. Run `serve` in a container on Fargate with an EFS/EBS volume for SQLite (D4).
4. Re-run the same `plan.json`. The §6 criteria should hold unchanged — that
   equivalence *is* the local→prod parity the V1 spec §7 calls for.

Cost discipline for Tier 2 (from the design conversation): billing alarm at $1,
**no NAT gateway** (the #1 surprise-bill trap — use a public subnet or VPC
endpoints), tear down same-day.

---

End of spec.
