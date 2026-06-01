import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { canonEntry } from '../../src/audit/canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../src/audit/merkle.js';
import { verify } from '../../src/audit/verify.js';

function seed(store: SqliteRunStateStore, runId: string) {
  const mk = (e: any, prev: string) => {
    const eh = chainHash(canonEntry({ ...e, runId }), prev);
    store.appendAuditEntry({ ...e, runId, entryHash: eh, prevHash: prev });
    return eh;
  };
  const h0 = mk({ seq: 0, kind: 'run.submitted', at: 't0' }, '');
  const h1 = mk({ seq: 1, kind: 'run.completed', at: 't1' }, h0);
  return merkleRoot(leavesFromEntryHashes([h0, h1]));
}

const anchorOf = (root: Uint8Array, guarantee = 'detect' as const) => ({
  id: 'fake',
  guarantee,
  async anchor() {
    return { anchorId: 'fake', epochId: 'r', guarantee, at: 0 };
  },
  async fetch() {
    return [{ epochId: 'r', root, receipt: { anchorId: 'fake', epochId: 'r', guarantee, at: 0 } }];
  },
});

it('clean run intact; detect anchor -> tamper-detecting', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r');
  expect(await verify('r', { store, anchor: anchorOf(root) })).toMatchObject({
    intact: true,
    guarantee: 'detect',
    claim: 'tamper-detecting',
  });
});

it('external-immutable anchor on a clean run -> tamper-evident', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r');
  expect((await verify('r', { store, anchor: anchorOf(root, 'external-immutable') })).claim).toBe(
    'tamper-evident',
  );
});

it('mutating a persisted entry fails verification (chain)', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r');
  (store as any).db
    .prepare("UPDATE audit_entries SET actor='attacker' WHERE run_id='r' AND seq=0")
    .run();
  const r = await verify('r', { store, anchor: anchorOf(root) });
  expect(r.intact).toBe(false);
  expect(r.claim).toBe('tamper-detecting');
});

it('root-mismatch when the anchored root differs from the recomputed root', async () => {
  const store = new SqliteRunStateStore();
  seed(store, 'r');
  const r = await verify('r', { store, anchor: anchorOf(new Uint8Array(32).fill(0xab)) });
  expect(r.failure).toBe('root-mismatch');
});

it('bad signature -> failure signature', async () => {
  const store = new SqliteRunStateStore();
  const root = seed(store, 'r');
  const anchor = {
    id: 'fake',
    guarantee: 'external-immutable' as const,
    async anchor() {
      return {} as any;
    },
    async fetch() {
      return [
        {
          epochId: 'r',
          root,
          signature: { alg: 'ed25519', bytes: new Uint8Array([9]) },
          receipt: { anchorId: 'fake', epochId: 'r', guarantee: 'external-immutable' as const, at: 0 },
        },
      ];
    },
  };
  const r = await verify('r', { store, anchor, verifySignature: () => false });
  expect(r.failure).toBe('signature');
});

it('missing anchored root -> anchor-missing', async () => {
  const store = new SqliteRunStateStore();
  seed(store, 'r');
  const empty = {
    id: 'x',
    guarantee: 'detect' as const,
    async anchor() {
      return {} as any;
    },
    async fetch() {
      return [];
    },
  };
  expect((await verify('r', { store, anchor: empty })).failure).toBe('anchor-missing');
});
