import type { AuditStore, AuditAnchor, VerificationReport, Signature } from '../contracts/index.js';
import { GUARANTEE_RANK } from '../contracts/index.js';
import { canonEntry } from './canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from './merkle.js';

export async function verify(
  runId: string,
  deps: {
    store: AuditStore;
    anchor: AuditAnchor;
    verifySignature?: (root: Uint8Array, sig: Signature) => boolean;
  },
): Promise<VerificationReport> {
  const g = deps.anchor.guarantee;
  const base = { runId, anchorId: deps.anchor.id, guarantee: g };
  const fail = (failure: VerificationReport['failure']): VerificationReport => ({
    ...base,
    intact: false,
    claim: 'tamper-detecting',
    failure,
  });

  const entries = deps.store.getAuditEntries(runId);

  // 1. Recompute the chain and verify each entry's hash and chain linkage
  let prev = '';
  for (const e of entries) {
    const h = chainHash(canonEntry(e), prev);
    if (h !== e.entryHash || e.prevHash !== prev) return fail('chain');
    prev = e.entryHash;
  }

  // 2. Recompute the Merkle root from the entry hashes
  const recomputed = merkleRoot(leavesFromEntryHashes(entries.map((e) => e.entryHash)));

  // 3. Fetch the anchored root — MUST consult the external anchor, NOT a local store copy
  const anchored = (await deps.anchor.fetch({ epochId: runId }))[0];
  if (!anchored) return fail('anchor-missing');

  // 4. Compare recomputed root to the anchored root
  if (Buffer.compare(Buffer.from(recomputed), Buffer.from(anchored.root)) !== 0)
    return fail('root-mismatch');

  // 5. Verify the signature if present and a verifier was supplied
  if (anchored.signature && deps.verifySignature && !deps.verifySignature(anchored.root, anchored.signature))
    return fail('signature');

  // 6. Determine the proven tier: tamper-evident only when guarantee >= external-immutable
  const claim =
    GUARANTEE_RANK[g] >= GUARANTEE_RANK['external-immutable'] ? 'tamper-evident' : 'tamper-detecting';

  return { ...base, intact: true, claim };
}
