import { it, expect } from 'vitest';
import { canonEntry } from '../../src/audit/canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../src/audit/merkle.js';
import { LocalAnchor, S3ObjectLockAnchor, type S3LockClient } from '../../src/audit/anchor.js';
import { verify } from '../../src/audit/verify.js';
import type { AuditEntryRow, AuditStore } from '../../src/contracts/index.js';

// A mutable in-memory AuditStore whose audit_entries array we can forge in place.
function memStore(entries: AuditEntryRow[]) {
  const roots = new Map<string, any>();
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
