# offload-minio — Tier-1 MinIO proof

Proves the offload orchestrator running as a remote-style service against free
substitutes (MinIO + local Docker): submit over an S3 inbox with no inbound
networking, multi-executor routing, patch escape → `result_ref`, and a genuinely
tamper-evident (`external-immutable`) audit bundle. Every edit runs the **real**
`claude-code` worker at maximum fidelity; cost is ~pennies of tokens per run and
infra is free.

Design spec:
[`../../docs/superpowers/specs/2026-06-02-agora-offload-tier1-minio-proof-design.md`](../../docs/superpowers/specs/2026-06-02-agora-offload-tier1-minio-proof-design.md)

---

## What this example proves

- **Serve-as-a-remote-service**: `serve` runs as a container with **no published
  port**. The host client reaches it exclusively through the MinIO mailbox — no
  direct socket, no shared process.
- **Multi-executor routing**: `plan.json` carries four edits split across two
  dispatch executors (`dispatch-a`, `dispatch-b`). The orchestrator routes
  per-item to the named executor; both target the local Docker daemon.
- **Resource-lock serialisation**: `edit-shared-1` and `edit-shared-2` both hold
  `resourceLocks: ["shared.ts"]` and therefore serialize — even though they are
  assigned to different executors.
- **Patch escape → `result_ref`**: each edit produces a real `git diff` patch,
  uploaded to content-addressed S3 storage; the `result_ref` URI is surfaced
  through the `OperationsApi` without the patch ever living in the run-state DB.
- **`external-immutable` audit bundle**: `S3ObjectLockAnchor` anchors the Merkle
  root into a MinIO object-lock bucket (`agora-audit`, `COMPLIANCE` mode). The
  audit report reads `intact: true`, `guarantee: 'external-immutable'`, and
  `claim: 'tamper-evident'`.
- **Tamper detection demonstrated**: mutating a persisted audit entry in the
  SQLite store — while the anchored root in MinIO is left untouched (it cannot
  be rewritten before retention expires) — causes `verify()` to return
  `intact: false`. The compliance edge is proven, not just claimed.

The two-bucket split is load-bearing: `agora-audit` holds **only** WORM anchor
roots (object-lock `COMPLIANCE`). `agora-data` is the unlocked bucket for the
mailbox and content-addressed storage, both of which require deletes/overwrites.
Pointing the mailbox at the locked bucket would break inbox consumption.

---

## §0.2 Representativeness boundary

A green Tier-1 run must not be over-read. The table below pins exactly what the
green checkmark does and does not cover.

**Real (production path, nothing faked):**

| What | Detail |
|---|---|
| `claude-code` worker | Every edit invokes the real adapter: `boot → secrets → baseline → RuntimeAdapter.invoke() (real claude CLI) → git diff → patch upload → result_ref` |
| Secret staging | `ANTHROPIC_API_KEY` is staged into the worker container by the executor — the exact path `offload-fanout` proves |
| S3 protocol | The real AWS SDK talks to MinIO over the real S3 wire protocol — a substitute *endpoint*, not a mock |
| Merkle audit + object-lock anchor | Full audit chain sealed and anchored into a real object-lock backend |
| Dispatch engine | Deps, resource locks, retry, fire/reconcile — all real |

**The only substitutions:**

| Tier-1 | Tier-2 (real run) |
|---|---|
| MinIO (S3-compatible, local container) | Real AWS S3 |
| Local Docker (`local-docker` provider) | Fargate (`fargate` provider) |
| `createLocalSigner()` (ed25519) | `KmsSigner` |

**NOT covered by Tier-1:**

- Fargate mechanics: ECS task launch, IAM task roles, EFS volume mount,
  `agora-providers-fargate` compute path.
- Real AWS S3 + real object-lock `COMPLIANCE` enforcement (not MinIO's
  implementation).
- `KmsSigner`.
- Live Anthropic egress from inside a VPC-bound task.

The architectural bet is that every deferred item is a **seam swap** (target
string, endpoint, signer), not new code — so Tier-1 de-risks everything up to
the swap, and Tier-2 validates the AWS implementations behind the seams. See
§0.2 of the design spec linked above.

---

## Prerequisites

- Docker Desktop (or Docker Engine on Linux) with the `docker` CLI on `PATH`
- `pnpm` (workspace install already done at repo root)
- An Anthropic API key (`sk-ant-…`)

---

## Build and run (exact ordered sequence)

### Step 1 — Build the worker image locally

The stock worker image is GHCR-private. Build it once from the repo root before
starting the compose stack; the build must include the `AGORA_S3_ENDPOINT` +
`AWS_*` env handling introduced for this proof:

```sh
# From repo root
docker build -t ghcr.io/quarrysystems/agora-worker:latest \
             -f docker/agora-worker/Dockerfile .
```

### Step 2 — Put the Anthropic key in the repo-root `.env`

The `serve` container reads `ANTHROPIC_API_KEY` from the compose `env_file`
(`../../.env` relative to this directory). The host driver does **not** need it.

```sh
# repo root .env
ANTHROPIC_API_KEY=sk-ant-...
```

An `.env.example` at the repo root shows the expected format.

### Step 3 — (Linux without Docker Desktop) set `DOCKER_GID`

On Linux hosts where the Docker socket group id differs from `999`, set:

```sh
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
```

The compose `group_add` uses `${DOCKER_GID:-999}` so the non-root `agora` user
(`uid 1000`) in the `serve` container can write to `/var/run/docker.sock`.

### Step 4 — Start the compose stack

From the **repo root** (or any directory — compose resolves paths relative to
the file):

```sh
docker compose -f examples/offload-minio/docker-compose.yml up
```

This starts:

- **`minio`** — MinIO S3-compatible store, published on host ports 9000 (API)
  and 9001 (console).
- **`minio-init`** — one-shot bucket creation: `agora-audit` (with object lock)
  and `agora-data` (unlocked). Runs after MinIO is healthy, then exits.
- **`serve-data-init`** — one-shot chown of the SQLite volume so uid 1000 can
  write. Runs before `serve`.
- **`serve`** — the `agora-orchestrator` serve container. Mounts the host Docker
  socket to launch sibling worker containers. **No published port** — reachable
  only through the MinIO mailbox.

Wait until you see MinIO healthy and `serve` log lines before running the
driver.

### Step 5 — Run the host driver

From the `examples/offload-minio` directory:

```sh
AGORA_S3_ENDPOINT=http://localhost:9000 \
AGORA_S3_ACCESS_KEY=minioadmin \
AGORA_S3_SECRET_KEY=minioadmin \
pnpm start
```

The driver (no API key needed):

1. Registers the `code-edit` / `verify` subagents and the fixture capability
   into shared MinIO storage.
2. Submits `plan.json` via `OperationsApi` over the S3 mailbox (non-blocking).
3. Watches item status to terminal (3 s poll).
4. Prints each item's `result_ref`.
5. Assembles and prints the audit bundle (`intact`, `claim`, `anchorId`,
   `guarantee`).
6. Exits non-zero if any item failed, `report.intact === false`, or
   `report.guarantee !== 'external-immutable'`.

---

## §2.1 Endpoint duality

There are **two endpoints for the same MinIO**, and confusing them is the most
common wiring mistake:

| Caller | MinIO endpoint |
|---|---|
| Host client (`submit` / `watch` / `audit` via `OperationsApi`) | `http://localhost:9000` |
| In-container `serve` + sibling worker containers (default bridge network) | `http://host.docker.internal:9000` |

`LocalDockerProvider` sets no `NetworkMode`, so sibling worker containers land
on the **default bridge**, not the compose network. MinIO is published on the
host, so both `serve` and its sibling workers must use
`http://host.docker.internal:9000`. On Linux without Docker Desktop this name is
resolved via the `extra_hosts: host.docker.internal:host-gateway` entry in
`docker-compose.yml`.

The compose stack wires `AGORA_S3_ENDPOINT=http://host.docker.internal:9000`
into the `serve` service. The host driver passes
`AGORA_S3_ENDPOINT=http://localhost:9000` on its command line. The config
(`agora.config.mjs`) reads the endpoint from `$AGORA_S3_ENDPOINT` at module
load time — the same file serves both roles.

---

## §6 Acceptance criteria — what a green run proves

A passing run satisfies all of the following:

1. **`submit` is non-blocking** — returns a run id immediately; the driver
   continues to `watch`.
2. **Watch advances through waves** driven entirely through the MinIO mailbox
   (no direct client ↔ serve channel).
3. **All four edits run the real `claude-code` worker** and each exposes a
   `result_ref`; fetching it from MinIO yields a reviewable patch.
   `edit-shared-1` and `edit-shared-2` are observed to serialize via their
   shared `shared.ts` resource lock.
4. **`audit <run-id>` bundle** reports `intact: true`,
   `guarantee: 'external-immutable'`, `claim: 'tamper-evident'`, and a non-null
   `anchorId` naming the MinIO object-lock anchor.
5. **Tamper check** — mutating a persisted audit entry in SQLite while the
   MinIO-anchored root is untouched causes `verify()` to return
   `intact: false`. The `e2e.test.ts` suite asserts this as a second test case.
6. **No secret values** appear in the exported bundle (refs only).

---

## Tests

### Offline smoke (no Docker, no MinIO, no API key)

```sh
pnpm --filter offload-minio-example test
```

Runs `test/smoke.test.ts` with vitest. Verifies:

- `plan.json` has the correct shape: 4 real `code-edit` items split across
  `dispatch-a` / `dispatch-b`, two contending on `shared.ts`, `verify` gate
  `depends_on` all four.

The MinIO integration tests (`test/aws-s3-mailbox-client.test.ts`,
`test/aws-s3-lock-client.test.ts`) and the e2e suite (`test/e2e.test.ts`) are
**skipped** unless `AGORA_S3_ENDPOINT` (integration) or `AGORA_RUN_E2E`
(e2e) are set.

### Live e2e (requires full compose stack)

```sh
AGORA_RUN_E2E=1 \
AGORA_S3_ENDPOINT=http://localhost:9000 \
AGORA_S3_ACCESS_KEY=minioadmin \
AGORA_S3_SECRET_KEY=minioadmin \
pnpm --filter offload-minio-example test
```

Runs `test/e2e.test.ts` — two cases:

1. Driver spawned as a child process exits 0 (all items done, intact bundle,
   `external-immutable` guarantee).
2. Tamper detection: append + seal an in-memory audit log → mutate a row →
   `verify()` must return `intact: false`.

---

## Cost posture

**Tier-1 infra is free.** MinIO runs locally in Docker at zero cost. The only
spend is Anthropic token usage: each of the four edits invokes the real
`claude-code` worker on a one-line rename, totalling ~pennies per run.

### Tier-2 swap (real AWS)

Once a paying reason justifies the real run, Tier-2 is a seam swap — no new code:

1. Promote `AwsS3MailboxClient` / `AwsS3LockClient` to `agora-storage-s3`
   (a second consumer now exists).
2. Drop the `AGORA_S3_ENDPOINT` override so the AWS SDK targets real S3. Swap
   `createLocalSigner()` → `KmsSigner`.
3. Move the already-containerized `serve` from compose onto **Fargate** with an
   EFS/EBS volume for SQLite. Change the executor `target` from `'local'` to
   `'fargate'` — that is the only code change.
4. Re-run the same `plan.json`. The §6 criteria hold unchanged — that
   equivalence is the local → prod parity the V1 spec calls for.

**Cost discipline for Tier-2:** set a billing alarm at $1, use **no NAT
gateway** (the #1 surprise-bill trap — use a public subnet or VPC endpoints
instead), and tear down the stack the same day.

---

## Fixture files

`fixture/{alpha,beta,shared}.ts` each export `OLD_NAME`. The `code-edit`
subagent is prompted to rename `OLD_NAME → NEW_NAME` in the specified file
only. The `verify` subagent confirms the workspace contains the fixture files
after all edits complete.
