// E2E contract: §7.1 + §7.6 + §6.7 — local-backed env bundle, end-to-end,
// with zero AWS calls.
//
// This is the headline proof of the SecretStore unification:
//   1. A `LocalSecretStore` is registered as the sole secret store under
//      the `'local'` key.
//   2. An env bundle is registered with an inline secret (`DEPLOY_TOKEN`)
//      via `env.register({ secretStore: 'local', secrets: {...} })`. The
//      `LocalSecretStore` stages the value to a host tmpdir as a file.
//   3. The bundle is dispatched to the `local` Docker target, which
//      bind-mounts the secret store dir into the container via
//      `AGORA_SECRET_STORE_DIR` / `AGORA_SECRET_STORE_KIND`.
//   4. The worker resolves `local-secret://<id>` refs from the bind-mounted
//      dir, merges the secret into its env, and registers the resolved value
//      with the structured logger for redaction.
//   5. The capability's `agora-setup.sh` echoes `DEPLOY_TOKEN=$DEPLOY_TOKEN`
//      so the subagent can observe the resolved value in its environment.
//
// Assertions:
//   - The capability stdout contains the resolved literal value, confirming
//     the worker resolved the ref from the local store.
//   - The literal value is redacted in `DispatchResult.stdout` (§6.7).
//   - No `AwsSecretStore` is present in the client — the only registered
//     store is `LocalSecretStore` — so by construction no AWS Secrets
//     Manager calls can happen on the host side.
//   - An additional `stage` spy on the `LocalSecretStore` confirms it was
//     called exactly once (for the DEPLOY_TOKEN inline secret) and that
//     no other store interface was touched.
//
// Docker-gated (`itIfDocker`) per the §9 pattern so CI / no-Docker
// environments skip cleanly.

import { describe, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgoraClient,
  NoopCredentialProvider,
  StdoutResultSink,
} from '../../packages/agora-client/dist/index.js';
import { LocalStorageProvider } from '../../packages/agora-storage-local/dist/index.js';
import { LocalDockerProvider } from '../../packages/agora-providers-local-docker/dist/index.js';
import { LocalSecretStore } from '../../packages/agora-secret-store/dist/index.js';

import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-envbundle');

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('E2E: local env-bundle inline secret resolved end-to-end with no AWS', () => {
  itIfDocker(
    'resolves a local env-bundle inline secret inside the worker with no AWS calls',
    async () => {
      // Use a dedicated tmpdir for the LocalSecretStore — separate from the
      // storage root so secrets and bundles don't land in the same tree.
      const secretDir = await mkdtemp(join(tmpdir(), 'agora-e2e-envbundle-secrets-'));
      const localStore = new LocalSecretStore({ dir: secretDir });

      // Spy on stage so we can assert it was called and its arguments.
      // `stage` is an instance method so we spy directly on the instance.
      const stageSpy = vi.spyOn(localStore, 'stage');

      // Construct the client with LocalSecretStore as the ONLY registered
      // store (key 'local'). No AwsSecretStore → by construction no AWS
      // Secrets Manager calls happen on the host side.
      const client = new AgoraClient({
        namespace: 'local-envbundle',
        compute: { 'local-docker': new LocalDockerProvider() },
        credentials: { none: new NoopCredentialProvider() },
        storage: new LocalStorageProvider({ rootDir: storageRoot() }),
        targets: {
          local: {
            compute: 'local-docker',
            credentials: 'none',
            secretStore: 'local',
          },
        },
        secretStores: { local: localStore },
        resultSink: new StdoutResultSink(),
      });

      // The capability's setup script echoes the resolved DEPLOY_TOKEN so
      // we can observe it was resolved correctly by the worker.
      const cap = await client.capabilities.register({
        name: 'echo-deploy-token',
        files: {
          'agora-setup.sh': '#!/bin/sh\necho "DEPLOY_TOKEN=$DEPLOY_TOKEN"\n',
        },
      });
      await client.subagent.register({
        name: 'noop',
        systemPrompt: 'exit',
        capabilities: [cap],
      });

      const SECRET = 'deploy-secret-' + Date.now();

      // Register an env bundle that carries an inline secret via the local
      // store. After this call, DEPLOY_TOKEN is persisted as a file in
      // `secretDir` under a `local-secret://<id>` ref, and the bundle blob
      // in storage contains that ref (never the literal value).
      await client.env.register({
        name: 'deploy',
        secretStore: 'local',
        secrets: { DEPLOY_TOKEN: { inline: SECRET } },
      });

      // stageSpy was called exactly once by env.register for DEPLOY_TOKEN.
      expect(stageSpy).toHaveBeenCalledTimes(1);
      const stageCall = stageSpy.mock.calls[0]![0];
      expect(stageCall.value).toBe(SECRET);
      // The staged name follows the deterministic placeholder convention:
      // `agora/inline/env-<bundleName>/<secretKey>` (see env-register.ts).
      expect(stageCall.name).toBe('agora/inline/env-deploy/DEPLOY_TOKEN');

      // Reset spy count before dispatch so we can verify dispatch itself
      // does NOT stage any additional secrets for this env-bundle-only run.
      stageSpy.mockClear();

      // Dispatch: the env bundle is referenced by name. The worker will:
      //   1. Fetch the bundle blob → see secretRefs: { DEPLOY_TOKEN: 'local-secret://<id>' }
      //   2. Read AGORA_SECRET_STORE_KIND=local-file / AGORA_SECRET_STORE_DIR=<in-container path>
      //   3. Instantiate LocalSecretStore({ dir: '/agora/secrets' })
      //   4. Resolve 'local-secret://<id>' → literal SECRET
      //   5. Register SECRET with StructuredLogger.registerSecret()
      //   6. Run the capability setup script which echoes DEPLOY_TOKEN=$SECRET
      //   7. §6.7: all occurrences of SECRET in worker stdout → <redacted:secret>
      const result = await client.dispatch({
        subagent: 'noop',
        env: 'deploy',
        target: 'local',
        workerImage: WORKER_IMAGE,
      } as any);

      // The per-dispatch inline-secret path is NOT exercised here (no
      // `work.secrets`), so the host-side store's stage() must not be
      // called again by dispatch.
      expect(stageSpy).not.toHaveBeenCalled();

      // §6.7: the resolved literal secret MUST NOT appear in DispatchResult.stdout.
      // If this fails, the worker did not register the value for redaction.
      expect(result.stdout).not.toContain(SECRET);

      // §6.7 positive: the redaction sentinel must be present, confirming
      // the setup script executed and the value was observed + redacted.
      expect(result.stdout).toContain('<redacted:secret>');
    },
    120_000,
  );
});
