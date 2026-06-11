// make-recording-bundle.mjs — GTM recording-bundle helper.
//
// Produces the two committed recording artifacts for the "never depend on a live
// edit" guardrail:
//   bundle.json         — assembled from a completed run via orch.audit (intact).
//   bundle.forged.json  — one byte flipped in the first audit entry's hash (!intact).
//
// The forge is intentionally duplicated from demo-claims-appeals/src/index.ts —
// do NOT extract a shared module (standalone duplication per spec).
//
// IMPORT-SAFE: importing this module does NOT execute the live run. main() is
// guarded behind an `if (process.argv[1] === fileURLToPath(import.meta.url))`
// check so the test harness can import forgeOneByte freely.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { orch } from './pangolin.config.mjs';
import { verifyBundle, OperationsApi } from '@quarry-systems/pangolin-orchestrator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// forgeOneByte — pure, exported for unit testing.
// Flips the first hex character of auditLog.entries[0].entryHash.
// Identical logic to demo-claims-appeals/src/index.ts (intentional duplication).
// ---------------------------------------------------------------------------
export function forgeOneByte(bundle) {
  const f = structuredClone(bundle);
  const e0 = f.auditLog.entries[0];
  e0.entryHash = (e0.entryHash[0] === '0' ? '1' : '0') + e0.entryHash.slice(1);
  return f;
}

// ---------------------------------------------------------------------------
// main — assembles bundle.json + bundle.forged.json from a completed run.
// Requires MinIO + a completed run identified by PANGOLIN_RECORDING_RUN_ID.
// NOT executed when this module is imported (import-safe guard below).
// ---------------------------------------------------------------------------
async function main() {
  const runId = process.env.PANGOLIN_RECORDING_RUN_ID;
  if (!runId) {
    console.error(
      'PANGOLIN_RECORDING_RUN_ID is not set. Export it to the run ID you want to record.',
    );
    process.exit(1);
  }

  const { transport, anchor, storage, verifySignature } = orch;
  const api = new OperationsApi({ transport, anchor, storage, verifySignature });

  console.log(`Assembling audit bundle for run '${runId}'…`);
  let bundle;
  for (let i = 0; i < 15; i++) {
    try {
      bundle = await api.audit(runId);
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i === 14 || !/no audit export/.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!bundle) throw new Error('Audit export never became available for run ' + runId);

  const outDir = join(__dirname, 'recording');
  const bundlePath = join(outDir, 'bundle.json');
  const forgedPath = join(outDir, 'bundle.forged.json');

  await writeFile(bundlePath, JSON.stringify(bundle, null, 2));
  console.log(`  Wrote ${bundlePath}`);

  const forged = forgeOneByte(bundle);
  await writeFile(forgedPath, JSON.stringify(forged, null, 2));
  console.log(`  Wrote ${forgedPath}`);

  const cleanReport = await verifyBundle(bundle, { anchor, verifySignature });
  const forgedReport = await verifyBundle(forged, { anchor, verifySignature });

  console.log(`\n  clean:  intact=${cleanReport.intact}  claim=${cleanReport.claim}`);
  console.log(`  forged: intact=${forgedReport.intact}  failure=${forgedReport.failure ?? '(none)'}`);

  if (cleanReport.intact === true && forgedReport.intact === false) {
    console.log('\n✓ Recording bundle OK — tamper detection verified');
  } else {
    console.error('\n✗ Recording bundle FAILED');
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Import-safe guard: only run main() when executed directly.
// ---------------------------------------------------------------------------
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error('make-recording-bundle crashed:', err);
    process.exit(1);
  });
}
