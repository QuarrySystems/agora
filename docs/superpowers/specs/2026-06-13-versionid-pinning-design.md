# VersionId-pinning: sign the pinned S3 version into the seal evidence

> **Status:** design, approved 2026-06-13. Closes the same-second residual left by the
> tamper-evident readiness fix (PR #69): the anchor read the *earliest* object version,
> which a forgery PUT in the same wall-clock second as the seal could sort ahead of (S3
> `LastModified` is second-granular). This pins the verifier to the exact sealed object
> **version**, with the version bound into the signature so trust reduces to *(published
> signer key + WORM bucket)* — the GTM's "verify the artifact, not the vendor" promise.

## 1. Why

The seal is the moat. PR #69 fixed the headline forge (re-PUT in a *later* second → caught
by reading the earliest version) but left a documented residual: a same-second forgery can
sort ahead of the original under a stable ascending sort on second-granular timestamps. The
robust fix is to stop inferring "which version is the original" from timestamps and instead
**pin the exact `VersionId` the seal wrote, and sign it** so the verifier trusts it via the
key it already trusts. After this, an attacker who can write to the audit bucket (or even
holds the key) cannot make the verifier read a forged version.

**Pre-v1: no backward compatibility.** There are no sealed bundles in the wild, so this
**supersedes** #69's interim earliest-version read with a single clean pinned path — no
fallback, no dual-path verifier.

## 2. Trust model (why this is the right-sized rigor, not overkill)

The auditor's only out-of-band root of trust is the **published signer public key**. We make
the pinned version trustworthy via that same key:

- The seal signs over **`root ‖ versionId`** (was: `root` alone).
- The verifier reads the `versionId` from the bundle (which is forgeable) but **verifies the
  signature over `(root, versionId)` with the trusted pubkey** — a forged `(root, versionId)`
  pair cannot carry a valid signature, so the attacker cannot substitute one.
- The verifier then fetches the S3 object **by that exact `versionId`** (the COMPLIANCE-locked,
  undeletable original) and confirms its root equals the recomputed Merkle root.

Trust thus reduces to **pubkey + WORM bucket**, introducing no new trusted artifact. This is
strictly the GTM's "trust the math, not us" framing; the alternative (a `versionId` trusted by
the provenance of a handed-over context file) would add a weaker, off-pitch trust assumption.

## 3. Architecture

### 3.1 Seal flow — anchor, then sign
`AuditLog.sealEpoch` re-orders to **anchor → sign** (today it signs then anchors):

1. `anchor.anchor({ epochId, root })` writes the root to S3 and returns an `AnchorReceipt`
   now carrying **`versionId`** (the S3 version of the just-written object).
2. Sign over **`root ‖ versionId`**: `signer.sign(signedPayload(root, versionId))`.
3. `putAuditRoot({ epochId, root, signature, receipt /* incl. versionId */, timestamp? })`.

`signedPayload(root, versionId)` is a fixed, pinned concatenation — `root` bytes followed by
the UTF-8 `versionId` (documented in VERIFICATION.md so a third party can reproduce it).

### 3.2 What S3 stores vs what the bundle carries
- The **S3 object** stores only the root record (`{ epochId, rootHex, receipt }`). It does
  **not** carry the signature (the signature is computed *after* the write and is not
  re-written — a second PUT would create a new version, defeating the pin).
- The **signature** lives in the bundle's `AnchoredRoot.signature` (where it already travels),
  computed over `root ‖ versionId`.
- The **`versionId`** lives in `AnchorReceipt.versionId`, carried in `AnchoredRoot.receipt`.

### 3.3 Read / verify path
`verify` is unchanged in shape (single algorithm); the read anchor changes:
- The read anchor's `fetch(epochId)` does `getObject(key, versionId)` where `versionId` comes
  from the trusted-via-signature `AnchoredRoot.receipt.versionId`, and returns `AnchoredRoot`
  with that S3 root + the bundle's signature + receipt.
- `verify` recomputes the Merkle root from the entries → must equal the S3-fetched (pinned)
  root; verifies the signature over `root ‖ versionId` with the pubkey.
- In `pangolin-verify`, `buildAnchor` (anchor-checked mode) reads `versionId` from the bundle's
  `AnchoredRoot.receipt` and calls `getObject(key, versionId)`.

## 4. Interface changes (bounded)

- `S3LockClient` (`pangolin-core`): `putObject(...)` → returns `{ versionId?: string }`;
  `getObject(key: string, versionId: string)` — **versionId required** (pure pinning; the
  #69 earliest-version inference is removed).
- `AwsS3LockClient` (`pangolin-storage-s3`): `putObject` returns `r.VersionId`; `getObject`
  becomes a plain `GetObjectCommand({ Bucket, Key, VersionId })` — the `ListObjectVersions`
  earliest-version logic from #69 is **deleted** (superseded).
- `AnchorReceipt` (`pangolin-core`): add `versionId?: string`.
- `S3ObjectLockAnchor` (`pangolin-orchestrator`): `anchor` captures the `versionId` into the
  receipt; `fetch` reads `getObject(key, receipt.versionId)`. The anchored S3 JSON drops the
  signature field.
- `verify` (`pangolin-core`): the injected signature check is over `root ‖ versionId`.
  Concretely the `verifySignature` callback becomes
  `(root: Uint8Array, versionId: string | undefined, sig: Signature) => boolean`, and callers
  build the payload via the shared `signedPayload` helper so seal and verify cannot drift.
- `pangolin-verify` `verify-context.ts`: `buildAnchor` fetches by the bundle's
  `receipt.versionId`; `makeVerifySignature` verifies over `root ‖ versionId`.

## 5. The signed-payload helper (single source — DRY)

A single exported `signedPayload(root: Uint8Array, versionId: string | undefined): Uint8Array`
in `pangolin-core` (beside the audit primitives). Seal (`AuditLog.sealEpoch`) and every
verifier use it, so the bytes-signed can never diverge. When `versionId` is absent (e.g. the
`LocalAnchor` detect tier, which has no S3 version), the payload is just `root` — i.e. the
detect tier signs the root as today; only the external-immutable tier binds a versionId.

## 6. Detect tier (LocalAnchor) is unaffected

`LocalAnchor` (the `detect` tier) has no object versions; it keeps signing `root` alone
(`signedPayload(root, undefined) === root`) and its mutable store is, by definition,
tamper-detecting not tamper-evident. Version-pinning is an external-immutable-tier property.

## 7. TDD (genuine red-green — new capability)

This is a NEW guarantee (not characterizing existing behavior), so real red-green applies:

- **Deterministic unit test (the closer):** a versioned fake S3 where the forged version is
  timestamped **≤** the original (simulating same-second-sorts-first). Assert: a non-pinned
  earliest/timestamp read would select the forgery (the residual), but the pinned
  `getObject(key, sealedVersionId)` selects the original → recomputed forged root ≠ pinned
  original root → `root-mismatch`. The fake controls version order, so the same-second case is
  reproduced deterministically (no real-clock flakiness).
- **Signature-binding test:** a forged `(root, versionId)` fails signature verification (the
  signature is over `root ‖ versionId`); swapping either the root or the versionId breaks it.
- **Gap A contrast (updated):** the chain-consistent forge under the version-pinned
  `S3ObjectLockAnchor` is caught regardless of the forged version's timestamp.
- **MinIO e2e (updated):** seal → capture the sealed `versionId` (trusted) → forge + attacker
  re-anchors a new version (any timestamp) → verify by the pinned versionId → `root-mismatch`.
- **Detect tier:** `LocalAnchor` clean run still `intact: true`, `tamper-detecting`.

## 8. Scope (YAGNI)

**In:** version capture + the `root ‖ versionId` signature binding + the pinned read + the
removal of the earliest-version interim + the `signedPayload` helper. **Out:** a new anchor
tier, KMS key custody (#5), authz-in-evidence (#2), retention/access-log (#3/#4), and any
re-write of the signature into S3. Pre-v1 → no back-compat shims.

## 9. Risks

- **Seal re-order touches the most security-critical path.** Mitigated by the `signedPayload`
  single-source helper (seal/verify can't drift) and the full audit suite as the regression net.
- **The signature leaves the S3 object.** Intentional: the signature is computed after the
  write and lives in the bundle, verified against the out-of-band pubkey. The S3 object is the
  immutable *root* witness; authorship lives with the key. Documented in VERIFICATION.md.
- **`getObject` now requires a versionId** — any caller without one is a compile error (good,
  pre-v1); confirms no hidden latest-version read survives.
