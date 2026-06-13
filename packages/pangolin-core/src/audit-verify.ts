import type { AuditStore, AuditAnchor, VerificationReport, Signature } from './audit.js';
import { GUARANTEE_RANK } from './audit.js';
import type { Guarantee } from './audit.js';
import { canonEntry } from './audit-canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from './audit-merkle.js';

/** DRY claim rule (spec §7): tamper-evident only when guarantee >= external-immutable AND intact. */
export function claimFor(intact: boolean, guarantee: Guarantee): 'tamper-evident' | 'tamper-detecting' {
  return intact && GUARANTEE_RANK[guarantee] >= GUARANTEE_RANK['external-immutable']
    ? 'tamper-evident'
    : 'tamper-detecting';
}

export async function verify(
  runId: string,
  deps: {
    store: AuditStore;
    anchor: AuditAnchor;
    verifySignature?: (root: Uint8Array, sig: Signature) => boolean;
  },
): Promise<VerificationReport> {
  const g = deps.anchor.guarantee;
  const entries = deps.store.getAuditEntries(runId);

  // 1. Recompute the chain: per-entry hash, chain linkage, AND seq contiguity.
  //    verify() never returns early — the anchor is still fetched below even if the
  //    chain fails (collect-all at the function level); the loop stops at the first
  //    broken link since later links are meaningless once the chain is cut.
  //    The seq check enforces the spec's "completeness / no-gaps" requirement: it
  //    catches a deleted entry whose chain was re-linked to look self-consistent
  //    (the one tamper a mutable 'detect' anchor + valid linkage would otherwise hide).
  let prev = '', chainOk = true, chainDetail: string | undefined;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i) {
      chainOk = false;
      chainDetail = `non-contiguous seq at index ${i}: expected ${i}, got ${e.seq}`;
      break;
    }
    if (chainHash(canonEntry(e), prev) !== e.entryHash || e.prevHash !== prev) {
      chainOk = false;
      chainDetail = `entry ${e.seq} hash ≠ recomputed`;
      break;
    }
    prev = e.entryHash;
  }

  // 2. Recompute the Merkle root from the entry hashes
  const recomputed = merkleRoot(leavesFromEntryHashes(entries.map((e) => e.entryHash)));

  // 3. Fetch the anchored root — collect-all: fetch even if chain failed
  const anchored = (await deps.anchor.fetch({ epochId: runId }))[0];

  const anchorOk = !!anchored;
  const rootOk: boolean | 'n/a' = anchored
    ? Buffer.compare(Buffer.from(recomputed), Buffer.from(anchored.root)) === 0
    : 'n/a';
  const sigOk: boolean | 'n/a' =
    anchored?.signature && deps.verifySignature
      ? deps.verifySignature(anchored.root, anchored.signature)
      : 'n/a';

  const checks = {
    chain: { ok: chainOk, detail: chainDetail },
    root: { ok: rootOk },
    signature: { ok: sigOk },
    anchor: { ok: anchorOk },
    handoff: { ok: 'n/a' as const },
  };

  const intact = chainOk && anchorOk && rootOk !== false && sigOk !== false;

  const failure =
    !chainOk ? 'chain' as const
    : !anchorOk ? 'anchor-missing' as const
    : rootOk === false ? 'root-mismatch' as const
    : sigOk === false ? 'signature' as const
    : undefined;

  const claim = claimFor(intact, g);

  return { runId, anchorId: deps.anchor.id, guarantee: g, intact, claim, failure, checks };
}
