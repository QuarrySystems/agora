import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalStorageProvider } from '../src/index.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'agora-local-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

it('put + get round-trips bytes by content hash', async () => {
  const sp = new LocalStorageProvider({ rootDir });
  const payload = new TextEncoder().encode('hello world');
  const { contentHash } = await sp.put('agora://test/capability/foo', payload);
  const uri = `agora://test/capability/foo/${contentHash}`;
  const retrieved = await sp.get(uri);
  expect(new TextDecoder().decode(retrieved)).toBe('hello world');
});
