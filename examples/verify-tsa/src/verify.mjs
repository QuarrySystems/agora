// verify.mjs — the AUDITOR side of the capstone proof.
//
// This file imports ONLY @quarry-systems/pangolin-verify (+ node stdlib). It does NOT
// import @quarry-systems/pangolin-orchestrator — that is the whole point: an auditor
// re-verifies a sealed bundle with nothing but the standalone verifier package and the
// two JSON files produce.mjs wrote. It reaches `tsa-attested` fully offline (the local-CA
// trust root rides in the verify-context; no network / TSA egress).
//
// Run standalone:  node src/verify.mjs <bundle.json> <verify-context.json>

import { pathToFileURL } from 'node:url';
import {
  loadBundle,
  loadVerifyContext,
  buildAnchor,
  makeVerifySignature,
  makeVerifyTimestamp,
  renderVerification,
  verifyBundle,
} from '@quarry-systems/pangolin-verify';

/**
 * Re-verify a sealed bundle as a standalone auditor (orchestrator-free).
 * @param {{ bundlePath: string, contextPath: string }} paths
 * @returns {Promise<import('@quarry-systems/pangolin-verify').VerificationReport>}
 */
export async function verify({ bundlePath, contextPath }) {
  const bundle = await loadBundle(bundlePath);
  const ctx = await loadVerifyContext(contextPath);
  const anchor = buildAnchor(ctx, bundle);
  return verifyBundle(bundle, {
    anchor,
    verifySignature: makeVerifySignature(ctx),
    verifyTimestamp: makeVerifyTimestamp(ctx),
  });
}

// Direct-invocation guard (ESM): when run as `node src/verify.mjs`, print the report.
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const bundlePath = process.argv[2] ?? './out/bundle.json';
  const contextPath = process.argv[3] ?? './out/verify-context.json';
  verify({ bundlePath, contextPath })
    .then(async (report) => {
      const bundle = await loadBundle(bundlePath);
      console.log(renderVerification({ ...bundle, report }, { color: process.stdout.isTTY === true }));
      console.log(`\ntimeTier: ${report.timeTier}   time check: ${String(report.checks.time.ok)}`);
      process.exitCode = report.intact ? 0 : 1;
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
