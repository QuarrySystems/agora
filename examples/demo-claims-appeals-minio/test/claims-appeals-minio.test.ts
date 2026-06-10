// CI smoke test for demo-claims-appeals-minio.
//
// CI cannot run the real demo (MinIO Object Lock + Docker + a real LLM + API key),
// so it checks the two things that ARE deterministic AND example-specific:
//   1. plan.json fan-out shape (here) — 3 per-claim-locked appeals gating one verify.
//   2. the tamper mechanic — forgeOneByte() makes verification fail
//      (test/recording-bundle.test.ts).
// The live MinIO / Object-Lock / tamper-evident path is exercised MANUALLY (see README),
// not in CI. A fake-executor "drive the plan to terminal" test was intentionally NOT
// included: it would re-test orchestrator plumbing (already covered by the orchestrator
// package's own tests), not anything specific to this demo.

import { describe, it, expect } from 'vitest';
import plan from '../plan.json' with { type: 'json' };

describe('demo-claims-appeals-minio example', () => {
  it('plan.json has 3 per-output-locked appeals gating one verify', () => {
    const appeals = plan.items.filter((i) => i.id.startsWith('appeal-'));
    expect(appeals).toHaveLength(3);
    appeals.forEach((a) => expect(a.resourceLocks).toHaveLength(1));
    const verify = plan.items.find((i) => i.id === 'verify');
    expect(verify!.depends_on).toEqual(['appeal-001', 'appeal-002', 'appeal-003']);
  });
});
