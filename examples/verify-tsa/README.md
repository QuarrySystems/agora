# verify-tsa — offline TSA-attested verify (the capstone proof)

> **Trust the artifact, verify it yourself, you don't need us.**

This example is the end-to-end proof of the wedge promise: a run is sealed with a
trusted-timestamp token, and an **auditor** re-verifies it — reaching the
`tsa-attested` time tier — using **nothing but the `@quarry-systems/pangolin-verify`
package and two JSON files**. No orchestrator. No network. No vendor.

The seal carries a real RFC 3161 timestamp minted by an **offline local CA**
(`LocalCaTimestampAuthority`), so the whole demo runs fully offline — no TSA egress.

## The two-command motion

```bash
# 1. PRODUCE (sealer side — uses the full orchestrator to seal a run + timestamp it)
node src/produce.mjs            # writes out/bundle.json + out/verify-context.json

# 2. VERIFY (auditor side — imports ONLY @quarry-systems/pangolin-verify)
node src/verify.mjs out/bundle.json out/verify-context.json
```

`produce.mjs` prints the exact `verify` command (with absolute paths) when it finishes.

Expected verifier output:

```
  pangolin-verify  ·  verify-tsa-demo-run                  ✓ TAMPER-DETECTING
  ✓ chain        2 entries, hash-linked, no gaps
  ✓ root         merkle = anchored root
  ✓ signature    true
  ✓ anchor       offline  (detect)
  ✓ handoff      no handoff edges
  ✓ time         time tier: tsa-attested

timeTier: tsa-attested   time check: true
```

## What proves what

| File | Role | Imports |
|---|---|---|
| `src/produce.mjs` | **Sealer.** Builds an `AuditLog` over a `SqliteRunStateStore` with a local ed25519 signer, a `LocalAnchor`, and `timestamper: new LocalCaTimestampAuthority()`. Appends two audit entries, `sealEpoch(runId)`, assembles the `AuditBundle`, and writes `bundle.json` (binary fields base64-encoded) + `verify-context.json` (signer SPKI-DER pubkey, offline anchor mode, the local-CA trust root). | `@quarry-systems/pangolin-orchestrator`, `@quarry-systems/pangolin-verify` (for the timestamper) |
| `src/verify.mjs` | **Auditor.** Loads both files, builds the offline anchor, and runs `verifyBundle` with the package's `makeVerifySignature` / `makeVerifyTimestamp` callbacks. | **ONLY** `@quarry-systems/pangolin-verify` + node stdlib |

The verify side **never imports the orchestrator** — that separation is the entire
point. The RFC 3161 token rides on the bundle's anchored root; the local-CA cert in the
verify-context is the trust anchor `verifyTimestamp` chains to, which is what lifts the
report to `timeTier: tsa-attested`.

## CI proof

`test/proof.test.ts` runs the full motion in-process (produce → verify) and asserts:

- `report.intact === true`
- `report.timeTier === 'tsa-attested'`
- `report.checks.time.ok === true`

```bash
pnpm --filter verify-tsa-example test
```
