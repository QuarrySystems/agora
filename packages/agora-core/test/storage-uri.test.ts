// Tests for `parseStorageUri` — the storage-layer permissive parser.
//
// The general `parseAgoraUri` rejects `type === 'dispatches'` as a write-safety
// guard against client code accidentally constructing capability/subagent/env
// URIs under the reserved prefix (§7.8). Storage providers, however, are the
// layer that legitimately stores dispatch records under that prefix and need
// a permissive parser that accepts BOTH normal types AND `dispatches`.

import { describe, it, expect } from 'vitest';

import { parseStorageUri, parseAgoraUri } from '../src/uri.js';

describe('parseStorageUri', () => {
  it('parses a normal 3-segment URI like parseAgoraUri', () => {
    const parsed = parseStorageUri('agora://my-org/capability/foo');
    expect(parsed.kind).toBe('blob');
    if (parsed.kind === 'blob') {
      expect(parsed.namespace).toBe('my-org');
      expect(parsed.type).toBe('capability');
      expect(parsed.name).toBe('foo');
      expect(parsed.contentHash).toBeUndefined();
    }
  });

  it('parses a normal 4-segment pinned URI like parseAgoraUri', () => {
    const parsed = parseStorageUri(
      'agora://my-org/capability/foo/sha256:abc',
    );
    expect(parsed.kind).toBe('blob');
    if (parsed.kind === 'blob') {
      expect(parsed.namespace).toBe('my-org');
      expect(parsed.type).toBe('capability');
      expect(parsed.name).toBe('foo');
      expect(parsed.contentHash).toBe('sha256:abc');
    }
  });

  it('accepts the reserved dispatches prefix (suffixless)', () => {
    const parsed = parseStorageUri('agora://my-org/dispatches/d-123');
    expect(parsed.kind).toBe('dispatch-record');
    if (parsed.kind === 'dispatch-record') {
      expect(parsed.namespace).toBe('my-org');
      expect(parsed.dispatchId).toBe('d-123');
      expect(parsed.suffix).toBeUndefined();
    }
  });

  it('accepts the reserved dispatches prefix with a single-segment suffix', () => {
    const parsed = parseStorageUri(
      'agora://my-org/dispatches/d-123/record.json',
    );
    expect(parsed.kind).toBe('dispatch-record');
    if (parsed.kind === 'dispatch-record') {
      expect(parsed.namespace).toBe('my-org');
      expect(parsed.dispatchId).toBe('d-123');
      expect(parsed.suffix).toBe('record.json');
    }
  });

  it('accepts the reserved dispatches prefix with a multi-segment suffix', () => {
    const parsed = parseStorageUri(
      'agora://my-org/dispatches/d-123/events/0001.json',
    );
    expect(parsed.kind).toBe('dispatch-record');
    if (parsed.kind === 'dispatch-record') {
      expect(parsed.namespace).toBe('my-org');
      expect(parsed.dispatchId).toBe('d-123');
      expect(parsed.suffix).toBe('events/0001.json');
    }
  });

  it('rejects malformed URIs (missing scheme)', () => {
    expect(() => parseStorageUri('not-a-uri')).toThrow();
  });

  it('rejects empty namespace in dispatches URI', () => {
    expect(() => parseStorageUri('agora:///dispatches/d-123')).toThrow();
  });

  it('rejects empty dispatchId in dispatches URI', () => {
    expect(() => parseStorageUri('agora://my-org/dispatches/')).toThrow();
  });

  it('rejects too-few segments (just scheme + namespace)', () => {
    expect(() => parseStorageUri('agora://my-org')).toThrow();
  });

  it('SAFETY: parseAgoraUri still rejects dispatches (regression guard)', () => {
    // The point of having a separate parseStorageUri is precisely so that
    // the GENERAL parser keeps rejecting dispatches. If this test ever
    // starts failing, the write-safety property of §7.8 is broken.
    expect(() =>
      parseAgoraUri('agora://my-org/dispatches/d-123/record.json'),
    ).toThrow();
  });
});
