import { describe, it, expect } from 'vitest';
import { validateShape } from '../src/contracts/subagent-shape.js';
import { makeShape } from './support/make-shape.js';

describe('validateShape', () => {
  it('accepts a well-formed shape', () => {
    expect(() => validateShape(makeShape())).not.toThrow();
  });

  it('rejects an unprefixed id', () => {
    expect(() => validateShape(makeShape({ id: 'noprefix' }))).toThrow(/<pack>\.<name>/);
  });

  it('rejects an id with too many dots', () => {
    expect(() => validateShape(makeShape({ id: 'dev.code.edit' }))).toThrow(/<pack>\.<name>/);
  });

  it('rejects an invalid effectTier', () => {
    expect(() =>
      validateShape(makeShape({ effectTier: 'network-impure' as never }))
    ).toThrow(/effectTier/);
  });

  it('requires capability.imageDigest', () => {
    expect(() =>
      validateShape(
        makeShape({ capability: { imageDigest: '', permissions: {}, contextShape: '' } })
      )
    ).toThrow(/imageDigest/);
  });
});
