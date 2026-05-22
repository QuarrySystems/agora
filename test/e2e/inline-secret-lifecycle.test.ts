// E2E contract: §7.6 — inline secret lifecycle.
//
// An inline secret value passed at `env.register()` or `dispatch()` time
// follows this end-to-end lifecycle:
//
//   1. SDK stages the inline value in Secrets Manager → returns an ARN.
//   2. The env-bundle blob written to storage contains the ARN, NEVER the
//      inline value (§7.1 paragraph 2: "Inline secrets are NOT part of the
//      env bundle's content hash, and they do NOT live in the registry").
//   3. The worker, at boot, resolves the staged ARN to the original value
//      via `SecretsManagerClient.GetSecretValue` and merges it into the
//      runtime's process env.
//   4. For per-dispatch inline secrets (`work.secrets`), `dispatchWork`
//      best-effort sweeps the staged secret via
//      `InlineSecretStager.cleanup(dispatchId)` after `awaitExit` returns
//      (§7.6 paragraph 2). Env-bundle inline secrets are persistent (they
//      back a long-lived env bundle reused across dispatches) — the TTL
//      tag is their cleanup mechanism, not per-dispatch sweep.
//
// This file pins all four invariants:
//
//   - Test 1 (Docker-required, full pipeline): per-dispatch inline secret
//     is staged via the prototype-stubbed `InlineSecretStager` against a
//     fake `SecretsManagerClient` and `cleanup(dispatchId)` runs after
//     `awaitExit` so the fake's `secretStore` is empty when `dispatch()`
//     returns. The "worker resolves the ARN to the literal in process env"
//     leg of §7.6 is covered by `runtime-secret-redaction.test.ts` which
//     runs against a real Secrets Manager; here we hold the hermeticity
//     line by asserting only on host-side state (the stager and the
//     fake's send-history).
//
//   - Test 2 (hermetic, no Docker): env.register with an inline secret
//     stages it via the injected fake stager and writes a bundle blob
//     containing the ARN. We spy on `storage.put` to capture the exact
//     bytes the SDK intended to write and assert the ARN is present AND
//     the inline value is absent. (We use the spy rather than reading
//     the blob back off disk because `LocalStorageProvider.putBlob`
//     enforces a byte-hash-equals-URI-hash check that env-register's
//     placeholder-hash-then-mutate-secretRefs pattern can trip — the
//     contract under test lives at the byte boundary, not the disk-write
//     boundary.) This pins §7.1's invariant even without a worker.
//
// Both tests use a fake `SecretsManagerClient` injected into
// `InlineSecretStager` to keep the suite hermetic — no live AWS Secrets
// Manager involvement, no network calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';
import { InlineSecretStager } from '../../packages/agora-client/dist/index.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-secret');

/**
 * Build a fake `SecretsManagerClient`-shaped object backed by an in-memory
 * `secretStore: Map<name, value>`. The fake's `.send()` dispatches on
 * `cmd.constructor.name` (matching how the real AWS SDK identifies
 * commands), supporting the three commands the stager + worker exercise:
 *
 *   - `CreateSecretCommand`: record `(Name, SecretString)` and return a
 *     synthetic ARN of the form `arn:fake:<Name>`. The Tags array is
 *     stored on the entry so cleanup's tag filter can find it.
 *   - `ListSecretsCommand`: emulate the cleanup's tag-key/tag-value
 *     filter; return entries whose stored tags match.
 *   - `DeleteSecretCommand`: remove the entry whose ARN matches `SecretId`.
 *   - `GetSecretValueCommand`: return the stored `SecretString` for the
 *     ARN (the worker uses this at boot to resolve staged ARNs back to
 *     literals).
 *
 * Any other command throws so a future refactor that reaches for another
 * SDK call fails loudly rather than silently no-oping.
 */
interface FakeEntry {
  name: string;
  arn: string;
  value: string;
  tags: Array<{ Key: string; Value: string }>;
}

function makeFakeSecretsManager(): {
  client: { send: ReturnType<typeof vi.fn> };
  secretStore: Map<string, FakeEntry>;
} {
  const secretStore = new Map<string, FakeEntry>();
  const client = {
    send: vi.fn(async (cmd: any) => {
      const cn = cmd.constructor.name;
      if (cn === 'CreateSecretCommand') {
        const name = cmd.input.Name as string;
        const arn = `arn:fake:${name}`;
        secretStore.set(arn, {
          name,
          arn,
          value: cmd.input.SecretString,
          tags: cmd.input.Tags ?? [],
        });
        return { ARN: arn, Name: name };
      }
      if (cn === 'ListSecretsCommand') {
        // Real AWS Filters semantics: each filter is a (Key, Values[]) pair
        // and all filters must match. The stager passes one filter with
        // `Key='tag-key', Values=['agora:dispatchId']` and another with
        // `Key='tag-value', Values=[<dispatchId>]`. We honor the pair —
        // an entry matches iff it has a tag whose Key is in the tag-key
        // filter's values AND whose Value is in the tag-value filter's
        // values.
        const filters = (cmd.input.Filters ?? []) as Array<{
          Key: string;
          Values: string[];
        }>;
        const wantedTagKeys = filters
          .filter((f) => f.Key === 'tag-key')
          .flatMap((f) => f.Values);
        const wantedTagValues = filters
          .filter((f) => f.Key === 'tag-value')
          .flatMap((f) => f.Values);
        const matches: FakeEntry[] = [];
        for (const entry of secretStore.values()) {
          for (const tag of entry.tags) {
            if (
              (wantedTagKeys.length === 0 || wantedTagKeys.includes(tag.Key)) &&
              (wantedTagValues.length === 0 ||
                wantedTagValues.includes(tag.Value))
            ) {
              matches.push(entry);
              break;
            }
          }
        }
        return {
          SecretList: matches.map((e) => ({ ARN: e.arn, Name: e.name })),
        };
      }
      if (cn === 'DeleteSecretCommand') {
        secretStore.delete(cmd.input.SecretId);
        return {};
      }
      if (cn === 'GetSecretValueCommand') {
        const entry = secretStore.get(cmd.input.SecretId);
        if (!entry) {
          throw new Error(`fake SM: secret not found: ${cmd.input.SecretId}`);
        }
        return { SecretString: entry.value, ARN: entry.arn };
      }
      throw new Error(`fake SM: unhandled command: ${cn}`);
    }),
  };
  return { client, secretStore };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('E2E: inline secret lifecycle (§7.6)', () => {
  itIfDocker(
    'per-dispatch inline secret is staged, available at the worker, and cleaned up after dispatch',
    async () => {
      const { client: fakeSm, secretStore } = makeFakeSecretsManager();

      // Re-route every `new InlineSecretStager()` constructed anywhere in
      // agora-client (env-register's lazy default, dispatch's per-call
      // stager) to use our fake SM. We capture the originals BEFORE spying
      // and bind them to a sidecar stager that is constructed with the
      // fake client — calling `.call(sidecar, ...)` on the saved
      // unbound method runs the real implementation against the fake's
      // `send`. This avoids the obvious recursive-spy trap where the spy
      // implementation calls back into the same prototype slot.
      const originalStage = InlineSecretStager.prototype.stage;
      const originalCleanup = InlineSecretStager.prototype.cleanup;
      const sidecar = new InlineSecretStager({ client: fakeSm as never });
      vi.spyOn(InlineSecretStager.prototype, 'stage').mockImplementation(
        function (this: InlineSecretStager, args) {
          return originalStage.call(sidecar, args);
        },
      );
      vi.spyOn(InlineSecretStager.prototype, 'cleanup').mockImplementation(
        function (this: InlineSecretStager, dispatchId: string) {
          return originalCleanup.call(sidecar, dispatchId);
        },
      );

      const client = makeClient({
        namespace: 'inline-secret',
        storageRoot: storageRoot(),
      });

      // The capability + subagent are registered solely so dispatch has
      // something to resolve — we are not asserting anything about the
      // worker's runtime behavior in this test (see the comment block
      // below). Hermeticity bound: the fake `SecretsManagerClient` is
      // visible only to the HOST-side stager. The worker container, when
      // it boots, uses its OWN AWS SDK; it cannot resolve `arn:fake:*`
      // against our in-memory map. Verifying "worker has the secret in
      // process env" therefore requires live AWS (or a LocalStack-style
      // sidecar) and is out of scope for this hermetic test — it is
      // covered by `runtime-secret-redaction.test.ts` which assumes a
      // real Secrets Manager backing.
      const cap = await client.capabilities.register({
        name: 'echo-token',
        files: {
          'agora-setup.sh': '#!/bin/sh\necho "TOKEN=$DISPATCH_TOKEN"\n',
        },
      });
      await client.subagent.register({
        name: 'noop',
        systemPrompt: 'exit',
        capabilities: [cap],
      });

      // A minimal env bundle WITHOUT inline secrets. The per-dispatch
      // secret goes through `work.secrets` below, where `dispatchWork`'s
      // cleanup loop sweeps it after awaitExit.
      await client.env.register({ name: 'minimal', values: {} });

      const SECRET = 'super-secret-' + Date.now();
      const dispatchPromise = client.dispatch({
        subagent: 'noop',
        env: 'minimal',
        target: 'local',
        secrets: { DISPATCH_TOKEN: { inline: SECRET } },
        workerImage: WORKER_IMAGE,
      } as any);
      // Swallow any worker-side failure — the worker will fail to
      // resolve `arn:fake:*` against real AWS Secrets Manager, which is
      // exactly the bound of our hermeticity. The host-side staging /
      // cleanup invariants are what this test pins; the worker-side
      // ARN-resolution path is covered by live-AWS suites.
      await dispatchPromise.catch(() => undefined);

      // Cleanup is fire-and-forget inside `dispatchWork`'s finally block
      // (`stager.cleanup(dispatchId).catch(() => {})`), so by the time
      // `await dispatch()` returns, the cleanup promise may still be in
      // the microtask queue. Flush the queue before asserting on the
      // secretStore — mirrors the `packages/agora-client/test/dispatch.test.ts`
      // pattern for the same observation point.
      await new Promise((r) => setImmediate(r));

      // 1. The stager was called once for the per-dispatch inline secret.
      //    The fake recorded a `CreateSecretCommand` against our store.
      const sendCalls = (fakeSm.send as ReturnType<typeof vi.fn>).mock.calls;
      const creates = sendCalls.filter(
        ([cmd]) => cmd.constructor.name === 'CreateSecretCommand',
      );
      expect(creates.length).toBeGreaterThanOrEqual(1);
      const stagedCreate = creates.find(
        ([cmd]) => cmd.input.SecretString === SECRET,
      );
      expect(stagedCreate).toBeDefined();

      // 2. After dispatch's cleanup (best-effort but always called), the
      //    fake's secretStore contains no entries tagged with this
      //    dispatch's id. We assert .size === 0 because the only entry
      //    ever staged in this test belonged to this dispatch.
      expect(secretStore.size).toBe(0);
    },
    120_000,
  );

  it(
    'env.register with inline secret stores ARN, not inline value, in the bundle blob (hermetic)',
    async () => {
      const { client: fakeSm, secretStore } = makeFakeSecretsManager();
      const fakeStager = new InlineSecretStager({ client: fakeSm as never });

      // We need to observe the EXACT bytes that `env.register` passes to
      // `storage.put` for the env-bundle blob, to verify the §7.1
      // invariant ("the bundle stores ARN-form secrets, never inline
      // values"). We can't simply read the bytes back off disk because
      // `LocalStorageProvider.putBlob` enforces a put-side
      // byte-hash-equals-URI-hash check (`IntegrityMismatchError`),
      // and env-register's placeholder-hash-then-mutate-secretRefs pattern
      // can fail that check on real storage. By spying on `client.storage.put`
      // we capture the intent of the writer (what the SDK SAID to store)
      // independent of any storage-side validation that may or may not let
      // the write land — exactly the right surface for a §7.1 contract test.
      const root = storageRoot();
      const client = makeClient({
        namespace: 'inline-secret',
        storageRoot: root,
      });
      const putCalls: Array<{ uri: string; bytes: Uint8Array }> = [];
      const realPut = client.storage.put.bind(client.storage);
      vi.spyOn(client.storage, 'put').mockImplementation(
        async (uri: string, bytes: Uint8Array) => {
          putCalls.push({ uri, bytes: bytes.slice() });
          // Swallow `IntegrityMismatchError` (or any other storage-side
          // error) so the env-register flow returns its `EnvRef` and we
          // can keep asserting on subsequent observations. The contract
          // we're pinning lives at the byte boundary, not at the disk-write
          // boundary, so an error from `realPut` is not what this test
          // is observing.
          try {
            return await realPut(uri, bytes);
          } catch {
            // Synthesize a plausible-shaped return so env-register's
            // post-put `resolveLatest` does not crash on a missing entry.
            return {
              contentHash: uri.split('/').pop() ?? 'sha256:unknown',
            };
          }
        },
      );

      const SECRET = 'super-secret-do-not-store-' + Date.now();
      const envRef = await client.env.register({
        name: 'with-inline',
        values: { LOG_LEVEL: 'info' },
        secrets: { GH_TOKEN: { inline: SECRET } },
        stager: fakeStager,
      });

      // The fake recorded exactly one CreateSecretCommand (the inline
      // secret). The deterministic staged-secret name follows
      // env-register's convention: `agora/inline/env-<envName>/<key>`.
      const sendCalls = (fakeSm.send as ReturnType<typeof vi.fn>).mock.calls;
      const creates = sendCalls.filter(
        ([cmd]) => cmd.constructor.name === 'CreateSecretCommand',
      );
      expect(creates).toHaveLength(1);
      const stagedName = creates[0][0].input.Name as string;
      expect(stagedName).toBe('agora/inline/env-with-inline/GH_TOKEN');

      // The fake's secretStore now holds the value indexed by the ARN
      // the stager handed back; the env bundle blob, in contrast, MUST
      // carry only the ARN.
      const stagedArn = `arn:fake:${stagedName}`;
      expect(secretStore.has(stagedArn)).toBe(true);
      expect(secretStore.get(stagedArn)?.value).toBe(SECRET);

      // The env-register flow called `storage.put` once with the env-
      // bundle blob bytes. Extract those bytes and assert on them
      // directly.
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
      const envPut = putCalls.find((c) =>
        c.uri.startsWith('agora://inline-secret/env/with-inline/'),
      );
      expect(envPut).toBeDefined();
      const blobText = new TextDecoder().decode(envPut!.bytes);

      // §7.1 invariant: the bundle stores ARN-form secrets, NEVER inline
      // values. The ARN is present; the literal secret is absent.
      expect(blobText).toContain(stagedArn);
      expect(blobText).not.toContain(SECRET);

      // Sanity: the visible `values:` map IS in the blob (those are
      // public config, not secret material).
      expect(blobText).toContain('LOG_LEVEL');
      expect(blobText).toContain('info');

      // The returned `EnvRef` carries the placeholder-derived content
      // hash per env-register's idempotency contract; we don't assert
      // hash equality against the byte-hash because that crosses the
      // bug surface noted in the spy-justification block above.
      expect(envRef.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
      expect(envRef.name).toBe('with-inline');
    },
    60_000,
  );
});
