# `deploy/serve-stack` — always-on `agora orch serve` on the portsandbox host — design

**Date:** 2026-06-07
**Status:** approved (brainstorm session, post #56); amended same day after a code-grounded audit (8 amendments — see §7 changelog)
**Motivation:** seven live runs this weekend, every one manually kicked off and babysat on the laptop; the product claim is "runs while you sleep, hands you a sealed ledger" and the orchestrator currently dies when the laptop lid closes. Kickoff is the loudest felt friction in the demand-pull queue (position synthesis item 2 — deliberately sequenced after self-verify + gates existed; both now do). `examples/offload-minio` already proved every hard sub-problem (serve with no published port, S3 mailbox, two-bucket audit/data split, network secret lane, sibling-worker dispatch, endpoint duality); this is that shape **hardened into a deployment**, not new product code.

## 1. Decisions (locked in brainstorm)

| # | Decision | Choice |
|---|---|---|
| S1 | Host | **WSL2 Ubuntu on the Windows portsandbox box, Docker Engine installed natively inside WSL2** (NOT Docker Desktop — no login-session/update lifecycle in an always-on path; native restart policies; systemd available via `/etc/wsl.conf` `systemd=true`). The WSL2 VM idle-shutdown problem is a first-class runbook item (keep-alive task + boot task), not a footnote. |
| S2 | Reachability | **SSH tunnel only** (matches the existing substrate posture): the laptop's sole channel is the tunneled MinIO mailbox (`ssh -L 9000:localhost:9000` to the Windows host; WSL2 localhost-forwarding bridges Windows→WSL2). Nothing newly exposed. The runbook covers the known WSL2 forwarding flakiness after sleep/resume with two fixes: `networkingMode=mirrored` (`.wslconfig`, Win11) or sshd inside WSL2 as fallback tunnel target. |
| S3 | Stack | **Fresh dedicated stack** at `deploy/serve-stack/` — compose with its own named volumes, `restart: unless-stopped`, tear-downable as a unit. Deployment is a first-class artifact, not an example override (rejected: layering prod duty onto `examples/offload-minio`; rejected: bare systemd units — compose is fewer moving parts). |
| S4 | Worker image | **Pulled from GHCR** (`ghcr.io/quarrysystems/agora-worker:main`, pinned tag) — depends on the user's GHCR-visibility ops fix (in progress); the runbook's update procedure is `docker compose pull && docker compose up -d`. Fallback documented: build-on-host from a clone (the run-2/3 recipe). |
| S5 | Signer | **Persisted keypair, not the example's deterministic dev seed**: generated on first boot into the serve volume; the PUBLIC key exported to a laptop-fetchable file so `agora verify` works remotely (the #55 verify-context shape). Production posture stays KMS (Tier-2, out of scope). |

## 2. Topology

```
LAPTOP                                WINDOWS BOX (portsandbox host)
agora.config.mjs (client kit)         sshd (Windows)  ── localhost fwd ──▶ WSL2 Ubuntu (kept alive)
  submit / watch (live view) ─ SSH -L 9000 ─▶                              Docker Engine
  render / audit / verify                                                   ├─ minio         vols: minio-data
                                                                            ├─ minio-init    (one-shot: agora-audit lock + agora-data)
                                                                            ├─ localstack    (Secrets Manager lane)
                                                                            ├─ serve-data-init (one-shot chown)
                                                                            ├─ serve         vols: serve-data (SQLite + signer key)
                                                                            │   restart: unless-stopped · docker.sock mount · no published port
                                                                            └─ sibling workers (ghcr image, launched per dispatch)
```

The serve container is reachable ONLY through the MinIO mailbox (the offload-minio no-inbound posture, unchanged). The laptop never holds the Anthropic key — it lives in the host's `.env`, staged per-dispatch through the Secrets Manager lane exactly as the example proved (refs-only in the audit).

## 3. `deploy/serve-stack/` contents

| File | What |
|---|---|
| `package.json` + workspace entry | **(Audit #2)** `deploy/serve-stack` becomes a pnpm WORKSPACE MEMBER (`deploy/*` added to `pnpm-workspace.yaml`) with its own `package.json` (workspace deps on orchestrator/client/storage-s3/secret-store) — `Dockerfile.serve` copies only `packages/ examples/`, so a non-workspace deploy config could not resolve `@quarry-systems/*` either on host or in-image. The deploy ships its OWN Dockerfile (offload-minio's `Dockerfile.serve` shape, repo-root context, additionally copying `deploy/`) and its own `serve-entrypoint.mjs` (the container runs the serve loop entrypoint — NOT the `agora orch serve` CLI verb; same as the example). |
| `docker-compose.yml` | The five offload-minio services, hardened: `restart: unless-stopped` on minio/localstack/serve (the example has none on long-lived services — this is the hardening delta); named volumes `minio-data`, `serve-data` (NO localstack volume — community LocalStack has no state persistence; a volume would be misleading); `env_file: .env` (project-local — compose interpolates `DOCKER_GID` from it, replacing the export step); `group_add: ${DOCKER_GID:-999}`; `extra_hosts: host.docker.internal:host-gateway` on serve AND `LocalDockerProvider.extraHosts` in the config for sibling workers (both halves needed — the example does both). Endpoint duality preserved verbatim (in-container `host.docker.internal:9000`, laptop `localhost:9000`). **The worker image is config-level, not compose-level** (`DispatchExecutor.workerImage`): the deploy pins `ghcr.io/quarrysystems/agora-worker:main` — explicitly NOT copying the example's `:latest` (pre-handoff; the dogfood-selftest README warning) — under `allowUnpinnedImage: true` (`:main` is mutable; true digest pinning is the deferred imageDigest item). |
| `agora.config.mjs` | Serve-side operator config, offload-minio shape with deltas: **(S5, audit-pinned mechanism)** `createLocalSigner` is generate-only (no seed param), so the config does what the example's deterministic-keypair block already demonstrates (`agora.config.mjs:77-92`): first boot → `randomBytes(32)` seed persisted to `/data/signer-seed.hex` (0600); every boot → rebuild the PKCS8 DER (`302e020100300506032b657004220420` + seed) via `node:crypto`, implement the `Signer` interface inline. **(Audit #4)** the public key publishes via a raw `PutObjectCommand` to the `agora-data` bucket (`storage.put` rejects arbitrary keys) as `public-key.json` = `{ keyRef, alg: 'ed25519', spkiDer: <base64> }` (`verifyEd25519` consumes SPKI-DER). **(Audit #8)** queues: `default: { concurrency: 2 }` UNCHANGED + a separate **`gated: { concurrency: 2, pattern: pipeline }`** queue — the pipeline pattern auto-chains empty-`depends_on` items and must never sit on `default` (it would silently serialize ordinary fan-out); gated runs select it via `--queue gated` / plan `queue`. S3 mailbox/storage/object-lock anchor + AwsSecretStore lane per the example, importing the PROMOTED adapters (next row). |
| **Adapter promotion (the one product change)** | `AwsS3MailboxClient` + `AwsS3LockClient` move from `examples/offload-minio/src/` into **`packages/agora-storage-s3`** (exported), with the example updated to import them. This is the example README's own named trigger firing verbatim ("promote … a second consumer now exists" — the deploy is that consumer), and it simultaneously solves the tsx trap: the example's adapters are TS sources with no build, un-importable by the plain-node `agora` bin that loads the laptop config. ~30 lines each + their existing integration tests move/extend. |
| `client/agora.config.mjs` | The laptop kit: plain `.mjs`, importing the promoted adapters from `@quarry-systems/agora-storage-s3`; points at `http://localhost:9000` (tunnel; only port 9000 is needed — 4566 is serve/worker-side); NO Anthropic key; exports BOTH a default `client` (registration verbs need it) and `orch` = `{ transport, storage, anchor, verifySignature }` with `verifySignature` reading the fetched `public-key.json` (SPKI-DER). Enables `agora capabilities/subagent register`, `orch submit/watch/render/audit`, and `agora verify` from the laptop. |
| `client/smoke-plan.json` + `client/smoke.mjs` | The health check, audit-pinned flow: register the smoke capability + subagent (CLI verbs or the tiny script), then submit with a **fresh run id per invocation** (`smoke-<epoch>` — `submitRun` is idempotent by id, so a static id health-checks exactly once per DB lifetime), executor name matching the deploy's executors map, then `orch watch` (live view) → `orch audit --out` → `agora verify`. |
| `.env.example` | `ANTHROPIC_API_KEY=`, `DOCKER_GID=` (with the stat one-liner comment; compose reads it from this file directly). |
| `RUNBOOK.md` | The ops half (see §4). |

Product-code surface of this wave: the adapter promotion above (the example's own trigger) + nothing else. The optional `createLocalSigner(seed?)` overload stays deferred — the config-level construction is the example-proven path.

## 4. RUNBOOK.md — the ops half (everything host-side, ordered)

1. **WSL2 prep** (one-time): install Ubuntu; `/etc/wsl.conf` → `[boot] systemd=true`; install Docker Engine inside WSL2 (NOT Desktop); add user to docker group.
2. **Keep-alive** (the WSL2-specific clause): Windows Task Scheduler ON-BOOT task running `wsl.exe -d Ubuntu -- true` + either `.wslconfig` `vmIdleTimeout=-1` (where supported) or a trivial keep-alive session; verification step (`wsl -l -v` shows Running after a fresh boot with no terminal opened).
3. **Networking robustness**: default localhost-forwarding path; if the tunnel breaks after host sleep → `wsl --shutdown` + restart, or adopt `networkingMode=mirrored` (Win11 `.wslconfig`) / sshd-in-WSL2 as the permanent fix. The runbook states how to TEST it (curl MinIO from Windows, then through the laptop tunnel).
4. **First boot**: clone repo in WSL2 → `pnpm install && pnpm -r build` → `cp deploy/serve-stack/.env.example deploy/serve-stack/.env` + key + `DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)` (compose reads it from the project `.env` — no export step) → `docker pull ghcr.io/quarrysystems/agora-worker:main` → `docker compose up -d` → wait healthy.
5. **Laptop setup**: repo clone + `pnpm install && pnpm -r build` (the workspace `agora` bin is the client — the npm-published v0.1.0 packages predate the handoff/view waves; STALE-DIST rule applies on every pull); ssh-config entry with `LocalForward 9000 localhost:9000`; fetch `public-key.json`; smoke run via `client/smoke.mjs` (fresh run id) → `agora orch watch <id>` (live view) → `agora orch audit --out` → `agora verify`.
6. **Crash-recovery drill** (the claim, demonstrated): submit the smoke plan, `docker kill` the serve container mid-run — `restart: unless-stopped` auto-restarts it (the manual `up -d` is unnecessary; the auto-restart IS the demonstration) — observe `recoverStranded` requeue and complete, bundle seals intact. Two honest nuances in the drill text: the killed orchestrator's in-flight sibling worker keeps running orphaned while the requeued item fires a fresh one (expected); recovery consumes one attempt, so with `maxAttempts: 2` a post-recovery failure is terminal.
7. **Update procedure**: `git pull && pnpm install && docker compose pull && docker pull ghcr.io/quarrysystems/agora-worker:main && docker compose up -d --build serve` — the worker image is config-level, NOT in compose; `compose pull` alone does not refresh it (audit #1).
8. **Teardown**: `docker compose down` (volumes preserved) / `down -v` (full reset; the audit bucket's object-locked roots note).
9. **Known warts, stated honestly**: LocalStack community edition has NO persistence — staged-secret loss on a LocalStack restart is absorbed by dispatch retry ONLY when the loss surfaces at reconcile (the retry re-fires and re-stages with a fresh dispatchId — verified); a fire-time staging failure (LocalStack still down at the retry) is a TERMINAL item failure (fire-catch bypasses maxAttempts). Acceptable for this tier; stated, not hidden. WSL2 clock skew after host sleep breaks S3 request signing → `hwclock -s` note. Docker-in-WSL2 disk growth → prune note.

## 5. Acceptance (operational, not unit)

1. Fresh Windows boot, no terminal opened → `serve` is running (keep-alive + restart policies proven).
2. From the laptop through the tunnel: smoke plan submits, the **live run view** tracks it, the bundle verifies (`agora verify`, five rows) with the fetched public key.
3. Crash-recovery drill (§4.6) green: kill mid-run → resumed → sealed intact.
4. Run 4 (the larger gated run) submitted remotely and completed unattended — the actual "runs while you sleep" demonstration. (Run 4 itself is its own plan; this stack is its prerequisite.)

## 6. Out of scope (named triggers)

| Deferred | Trigger |
|---|---|
| Tier-2 AWS (real S3 + Fargate + KMS) | The example's seam-swap table, unchanged — a paying reason |
| Public/cloudflared exposure of the mailbox | A consumer that can't SSH |
| Multi-host / remote-daemon workers | First capacity pull |
| Published serve image on GHCR | Second deployment site |
| Scheduled/cron submission to the always-on serve | First recurring-run need (the cron trigger seam already exists) |
| `createLocalSigner(seed?)` product overload | The third config that hand-builds the PKCS8 construction |

## 7. Audit changelog (2026-06-07, code-grounded audit — 8 amendments)

1. Worker image is config-level (`DispatchExecutor.workerImage`), not compose-level: update procedure gains the explicit `docker pull`; the example's `:latest` pin must NOT be copied (`:main` under `allowUnpinnedImage`).
2. `deploy/serve-stack` becomes a workspace member with its own package.json/Dockerfile/entrypoint — `Dockerfile.serve` copies only `packages/ examples/` and `pnpm-workspace.yaml` lacks `deploy/*`.
3. S5 mechanism pinned: `createLocalSigner` is generate-only; the config persists a `randomBytes(32)` seed and rebuilds the PKCS8/SPKI pair per the example's own deterministic-keypair construction.
4. Public-key publication = raw `PutObjectCommand` to `agora-data` (`storage.put` rejects arbitrary keys); content carries base64 SPKI-DER.
5. **Adapter promotion sanctioned as the one product change**: `AwsS3MailboxClient`/`AwsS3LockClient` → `agora-storage-s3` — the example README's own second-consumer trigger, and it dissolves the tsx trap (TS-source adapters un-importable by the plain-node CLI loading the laptop config). Laptop install path pinned (clone + install + build).
6. Smoke needs per-invocation run ids (`submitRun` idempotent by id) + pre-submit registration via existing CLI verbs.
7. LocalStack wart honesty tightened (reconcile-side loss absorbed; fire-time loss terminal; no community persistence — no localstack volume).
8. `pattern: pipeline` on a dedicated `gated` queue, never `default` (auto-chaining would serialize fan-out plans).
