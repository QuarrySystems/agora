// End-to-end capstone proof: a sealed bundle carrying a TSA-attested timestamp
// (minted by an offline local-CA) is re-verified by an auditor that has ONLY the
// @quarry-systems/pangolin-verify package.
//
// The produce side (produce.mjs) uses the full orchestrator to seal a run and writes
// bundle.json + verify-context.json. The verify side (verify.mjs) is the standalone
// auditor: it imports ONLY pangolin-verify (+ node stdlib) and reaches `tsa-attested`
// from nothing but those two JSON files. The split keeps the orchestrator out of the
// verify path — see the README "two commands" motion.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error — plain ESM demo scripts, no .d.ts
import { produce } from '../src/produce.mjs';
// @ts-expect-error — plain ESM demo scripts, no .d.ts
import { verify } from '../src/verify.mjs';
import type { VerificationReport } from '@quarry-systems/pangolin-verify';

describe('offline tsa-attested verify (auditor with only pangolin-verify)', () => {
  let dir: string;
  let report: VerificationReport;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'verify-tsa-'));
    const bundlePath = join(dir, 'bundle.json');
    const contextPath = join(dir, 'verify-context.json');
    await produce({ bundlePath, contextPath });
    report = await verify({ bundlePath, contextPath });
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the auditor re-verifies the sealed bundle as intact', () => {
    expect(report.intact).toBe(true);
  });

  it('the trusted-time tier reaches tsa-attested', () => {
    expect(report.timeTier).toBe('tsa-attested');
  });

  it('the RFC 3161 time check passes', () => {
    expect(report.checks.time.ok).toBe(true);
  });
});
