import { describe, it, expect } from 'vitest';
import { renderEvidenceLine } from '../src/cmd-orch.js';

describe('renderEvidenceLine', () => {
  it('shows the item id and the pinned model', () => {
    const line = renderEvidenceLine('appeal-001', 'claude-haiku-4-5-20251001');
    expect(line).toMatch(/appeal-001/);
    expect(line).toMatch(/model: claude-haiku-4-5-20251001/);
  });

  it('shows "model: -" when the model is an empty string (e.g. the verify gate)', () => {
    const line = renderEvidenceLine('verify', '');
    expect(line).toMatch(/verify/);
    expect(line).toMatch(/model: -/);
  });

  it('shows "model: -" when the model is undefined', () => {
    const line = renderEvidenceLine('appeal-002', undefined);
    expect(line).toMatch(/appeal-002/);
    expect(line).toMatch(/model: -/);
    expect(typeof line).toBe('string');
  });
});
