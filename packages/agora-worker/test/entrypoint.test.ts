// Tests for the worker entrypoint — the 14-step lifecycle orchestrator
// from spec §6.2.
//
// These tests exercise the full orchestration with stubs for the runtime
// adapter, storage, and the AWS Secrets Manager client. They cover the
// load-bearing exit-code paths declared in the task acceptance criteria:
// integrity failure, happy path with a clean runtime exit, valid
// needs_input sentinel, and a non-zero runtime exit with no sentinel.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type RunWorkerDeps } from '../src/entrypoint.js';
import {
  computeContentHash,
  type StorageProvider,
  type RuntimeAdapter,
  type RuntimeExit,
  type LifecycleEvent,
} from '@quarry-systems/agora-core';

/**
 * Minimal in-memory storage provider. Keyed by URI; returns the bytes
 * registered via `set()`. The worker only calls `get()` on the storage
 * provider during boot, so the rest of the surface is stubbed.
 */
class FakeStorage implements StorageProvider {
  readonly name = 'fake';
  private blobs = new Map<string, Uint8Array>();

  set(uri: string, bytes: Uint8Array): this {
    this.blobs.set(uri, bytes);
    return this;
  }

  async put(): Promise<{ contentHash: string }> {
    throw new Error('not used in entrypoint tests');
  }

  async get(uri: string): Promise<Uint8Array> {
    const v = this.blobs.get(uri);
    if (!v) throw new Error(`fake storage: missing ${uri}`);
    return v;
  }

  async resolveLatest(): Promise<null> {
    return null;
  }

  async list(): Promise<[]> {
    return [];
  }
}

/**
 * Serialize a capability bundle into the packed format produced by
 * `agora-client.registerCapability` (the worker's `unpackBundle` is its
 * inverse). Kept in sync by convention.
 */
function packBundle(
  name: string,
  files: Record<string, Uint8Array>,
): Uint8Array {
  const paths = Object.keys(files).sort();
  const entries = paths.map((path) => ({ path, size: files[path]!.byteLength }));
  const headerBytes = new TextEncoder().encode(
    JSON.stringify({ name, entries }) + '\n',
  );
  const total =
    headerBytes.byteLength +
    paths.reduce((acc, p) => acc + files[p]!.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(headerBytes, 0);
  offset += headerBytes.byteLength;
  for (const p of paths) {
    out.set(files[p]!, offset);
    offset += files[p]!.byteLength;
  }
  return out;
}

function asJsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

interface Harness {
  workDir: string;
  adaptersRoot: string;
  storage: FakeStorage;
  env: Record<string, string>;
  events: LifecycleEvent[];
  adapter: RuntimeAdapter;
  invokeCalls: number;
  setRuntimeExit(exit: RuntimeExit): void;
}

async function setupHarness(opts?: {
  capabilityFiles?: Record<string, Uint8Array>;
  capabilityHashCorrect?: boolean; // default true
}): Promise<Harness> {
  const workDir = await mkdtemp(join(tmpdir(), 'entrypoint-work-'));
  const adaptersRoot = await mkdtemp(join(tmpdir(), 'entrypoint-adapters-'));

  // Write a stub runtime adapter on disk so the adapter-loader can find it
  // by name. The actual invoke() behavior is replaced via the injected
  // `adapter:` field on RunWorkerDeps — but adapter-loader is still part of
  // the 14-step flow, so we exercise its discovery code path.
  const adapterDir = join(adaptersRoot, 'claude-code');
  await mkdir(adapterDir, { recursive: true });
  await writeFile(
    join(adapterDir, 'index.js'),
    `export default function () {
       return {
         name: "claude-code",
         reservedPaths: [],
         invoke: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
       };
     };\n`,
    'utf-8',
  );

  const subagentDef = { name: 'alpha', systemPrompt: 'do work' };
  const subagentUri = 'agora://ns/subagent/alpha/sha256:s';
  const subagentHash = computeContentHash(subagentDef);

  const capFiles = opts?.capabilityFiles ?? {
    'README.md': new TextEncoder().encode('hello\n'),
  };
  const capBytes = packBundle('cap-a', capFiles);
  const capUri = 'agora://ns/capability/cap-a/sha256:c';
  const correctCapHash = computeContentHash(capBytes);

  const storage = new FakeStorage();
  storage.set(subagentUri, asJsonBytes(subagentDef));
  storage.set(capUri, capBytes);

  const bundleRefs = {
    subagent: { uri: subagentUri, contentHash: subagentHash },
    capabilities: [
      {
        uri: capUri,
        contentHash:
          opts?.capabilityHashCorrect === false
            ? 'sha256:wrong'
            : correctCapHash,
      },
    ],
    env: [],
  };

  const env: Record<string, string> = {
    AGORA_DISPATCH_ID: 'd-1',
    AGORA_NAMESPACE: 'ns',
    AGORA_STORAGE_URI: 'file:///fake', // overridden by storage injection
    AGORA_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
    AGORA_INPUT_JSON: JSON.stringify({ greeting: 'hi' }),
    AGORA_RUNTIME_ADAPTER: 'claude-code',
  };

  const events: LifecycleEvent[] = [];

  let runtimeExit: RuntimeExit = { exitCode: 0, stdout: '', stderr: '' };
  let invokeCalls = 0;
  const adapter: RuntimeAdapter = {
    name: 'claude-code',
    reservedPaths: [],
    invoke: async () => {
      invokeCalls++;
      return runtimeExit;
    },
  };

  return {
    workDir,
    adaptersRoot,
    storage,
    env,
    events,
    adapter,
    get invokeCalls() {
      return invokeCalls;
    },
    setRuntimeExit(exit: RuntimeExit) {
      runtimeExit = exit;
    },
  };
}

function makeDeps(h: Harness): RunWorkerDeps {
  return {
    storage: h.storage,
    adapter: h.adapter,
    adaptersRoot: h.adaptersRoot,
    workspaceDir: h.workDir,
    secretsManagerClient: {
      send: async () => ({ SecretString: 'unused' }),
    } as never,
    onLifecycleEvent: (e) => {
      h.events.push(e);
    },
  };
}

describe('runWorker', () => {
  let cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const d of cleanupDirs) {
      await rm(d, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  it('fails with integrity-failed when a capability hash mismatches', async () => {
    const h = await setupHarness({ capabilityHashCorrect: false });
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe(
      'integrity-failed',
    );
    // The adapter must NOT have been invoked once integrity failed.
    expect(h.invokeCalls).toBe(0);
  });

  it('runs the happy path: overlays bundles, invokes the adapter, emits started+finished, returns 0', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: 'done', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).toBe(0);
    expect(h.invokeCalls).toBe(1);

    // Bundle file was overlaid to workspace
    const overlay = await readFile(join(h.workDir, 'README.md'), 'utf-8');
    expect(overlay).toBe('hello\n');

    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.started');
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');
    expect(kinds).not.toContain('dispatch.needs_input');
  });

  it('emits dispatch.needs_input and exits 0 when sentinel is valid', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    // Pre-stage a valid sentinel in the workspace and tell the adapter to
    // report its path on exit.
    const sentinelPath = join(h.workDir, 'needs_input.json');
    await writeFile(
      sentinelPath,
      JSON.stringify({ question: 'pick one', options: ['a', 'b'] }),
      'utf-8',
    );
    h.setRuntimeExit({
      exitCode: 0,
      stdout: '',
      stderr: '',
      needsInputSentinelPath: sentinelPath,
    });

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.needs_input');
    expect(kinds).not.toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');
  });

  it('emits dispatch.failed (worker-failed) when sentinel is malformed', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    const sentinelPath = join(h.workDir, 'needs_input.json');
    await writeFile(sentinelPath, '{not valid json', 'utf-8');
    h.setRuntimeExit({
      exitCode: 0,
      stdout: '',
      stderr: '',
      needsInputSentinelPath: sentinelPath,
    });

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe(
      'worker-failed',
    );
  });

  it('emits dispatch.failed with runtime exit code when adapter exits non-zero without sentinel', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 7, stdout: '', stderr: 'broken' });

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).toBe(7);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
  });

  it('emits dispatch.finished with the adapter exit code on clean success', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    await runWorker(h.env, makeDeps(h));

    const finished = h.events.find((e) => e.kind === 'dispatch.finished');
    expect(finished).toBeDefined();
    expect(finished && 'exitCode' in finished && finished.exitCode).toBe(0);
  });
});
