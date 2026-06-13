// produce.mjs — the SEALER side of the capstone proof.
//
// Uses the full @quarry-systems/pangolin-orchestrator to seal a tiny run with an
// offline local-CA RFC 3161 timestamp, then writes two artifacts an auditor can
// verify with nothing but @quarry-systems/pangolin-verify:
//
//   bundle.json          — the AuditBundle (entries + anchored root incl. the TSA token)
//   verify-context.json  — signer public key (SPKI-DER, b64), anchor mode, TSA CA cert (b64)
//
// All binary fields are base64-encoded on the wire (the verifier re-hydrates them).
//
// Run standalone:  node src/produce.mjs [outDir]
// (writes outDir/bundle.json + outDir/verify-context.json; default ./out)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AuditLog,
  LocalAnchor,
  SqliteRunStateStore,
  assembleBundle,
  createLocalSigner,
} from '@quarry-systems/pangolin-orchestrator';
import { LocalCaTimestampAuthority } from '@quarry-systems/pangolin-verify';

const b64 = (u8) => Buffer.from(u8).toString('base64');

/** A storage shim that holds no blobs — this demo run produces no manifests, so the
 *  bundle's manifests[] is legitimately empty (handoff closure has zero edges). */
const emptyStorage = {
  async get() {
    throw new Error('no blobs in this demo run');
  },
};

/** Re-serialize an AnchoredRoot with all binary fields base64-encoded for JSON transport.
 *  The verifier's buildAnchor() decodes these back to bytes (it accepts base64 strings). */
function encodeAnchoredRoot(root) {
  if (!root) return undefined;
  return {
    ...root,
    root: b64(root.root),
    signature: root.signature
      ? { ...root.signature, bytes: b64(root.signature.bytes) }
      : undefined,
    timestamp: root.timestamp ? { ...root.timestamp, token: b64(root.timestamp.token) } : undefined,
  };
}

/**
 * Seal a tiny run with a trusted-time token and write the two auditor artifacts.
 * @param {{ bundlePath: string, contextPath: string }} paths
 * @returns {Promise<{ bundlePath: string, contextPath: string, runId: string }>}
 */
export async function produce({ bundlePath, contextPath }) {
  const runId = 'verify-tsa-demo-run';

  const store = new SqliteRunStateStore(':memory:');
  const signer = createLocalSigner('demo-signer');
  const anchor = new LocalAnchor(store);
  const localCa = new LocalCaTimestampAuthority();
  const log = new AuditLog({ store, signer, anchor, timestamper: localCa });

  // A couple of audit entries for the run, then seal the epoch (= the run).
  const now = () => new Date().toISOString();
  log.append({ runId, kind: 'run.submitted', actor: 'human:auditor-demo', at: now() });
  log.append({ runId, kind: 'run.completed', actor: 'human:auditor-demo', at: now() });
  await log.sealEpoch(runId);

  // Assemble the bundle from the store (no items/manifests in this minimal run).
  const exp = {
    runId,
    entries: store.getAuditEntries(runId),
    root: store.getAuditRoot(runId),
    items: [],
  };
  const bundle = await assembleBundle(exp, { anchor, storage: emptyStorage });

  // Base64-encode the bundle's binary fields so it round-trips through JSON.
  const bundleJson = { ...bundle, auditLog: { ...bundle.auditLog, root: encodeAnchoredRoot(bundle.auditLog.root) } };

  // The verify-context: signer public key, offline anchor mode, the local-CA trust root.
  const contextJson = {
    signerPublicKeySpkiDer: signer.publicKey.toString('base64'),
    anchor: { mode: 'offline' },
    tsaCaCertsDer: [b64(localCa.caCertDer)],
  };

  await mkdir(dirname(bundlePath), { recursive: true });
  await mkdir(dirname(contextPath), { recursive: true });
  await writeFile(bundlePath, JSON.stringify(bundleJson, null, 2));
  await writeFile(contextPath, JSON.stringify(contextJson, null, 2));

  return { bundlePath, contextPath, runId };
}

// Direct-invocation guard (ESM): when run as `node src/produce.mjs`, write to ./out.
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const outDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
  const bundlePath = join(outDir, 'bundle.json');
  const contextPath = join(outDir, 'verify-context.json');
  produce({ bundlePath, contextPath })
    .then(({ runId }) => {
      console.log(`sealed run ${runId} with local-CA RFC 3161 timestamp`);
      console.log(`  wrote ${bundlePath}`);
      console.log(`  wrote ${contextPath}`);
      console.log(`\nnow verify (orchestrator-free):  node src/verify.mjs ${bundlePath} ${contextPath}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
