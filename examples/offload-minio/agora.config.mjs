// agora.config.mjs — operator config for the Tier-1 MinIO proof.
//
// Exports:
//   default / client  — wired AgoraClient (namespace 'offload-minio')
//   orch              — OrchContext: { transport, storage, anchor, verifySignature, createOrchestrator }
//
// IMPORT-SAFE: no throw at load when ANTHROPIC_API_KEY / AGORA_S3_ENDPOINT are absent.
// No SQLite opened at module level — only inside createOrchestrator() (D3 single-writer).

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';

import { S3Client } from '@aws-sdk/client-s3';
import { AgoraClient, NoopCredentialProvider, StdoutResultSink } from '@quarry-systems/agora-client';
import { LocalDockerProvider } from '@quarry-systems/agora-providers-local-docker';
import { LocalSecretStore } from '@quarry-systems/agora-secret-store';
import { S3StorageProvider } from '@quarry-systems/agora-storage-s3';
import {
  AgoraOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  DispatchExecutor,
  AuditLog,
  S3Mailbox,
  S3ObjectLockAnchor,
  MailboxSubmissionTransport,
  createLocalSigner,
  verifyEd25519,
} from '@quarry-systems/agora-orchestrator';

import { AwsS3MailboxClient } from './src/aws-s3-mailbox-client.js';
import { AwsS3LockClient } from './src/aws-s3-lock-client.js';

// ---------------------------------------------------------------------------
// Shared S3 client — built once, reused for storage + mailbox + anchor.
// Safe at module level: no I/O is performed by the SDK constructor.
// ---------------------------------------------------------------------------
const s3 = new S3Client({
  endpoint: process.env.AGORA_S3_ENDPOINT,
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AGORA_S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.AGORA_S3_SECRET_KEY ?? 'minioadmin',
  },
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const secretDir = join(tmpdir(), 'agora-minio-secrets');
const workerImage = 'ghcr.io/quarrysystems/agora-worker:latest';

// ---------------------------------------------------------------------------
// Storage, transport, and anchor — safe at module level (constructors only).
// ---------------------------------------------------------------------------
const storage = new S3StorageProvider({ bucket: 'agora-data', client: s3 });

const transport = new MailboxSubmissionTransport(
  new S3Mailbox(
    new AwsS3MailboxClient({ client: s3, bucket: 'agora-data', prefix: 'mailbox/' }),
  ),
);

const anchor = new S3ObjectLockAnchor(
  new AwsS3LockClient({ client: s3, bucket: 'agora-audit' }),
  'agora-audit',
);

// ---------------------------------------------------------------------------
// Signer — in-memory key generation only, no I/O.
// ---------------------------------------------------------------------------
// Deterministic dev signer. serve (signs the audit root) and the host driver
// (verifies it) are SEPARATE processes — a random per-process keypair
// (createLocalSigner) would never verify cross-process. Derive ONE ed25519
// keypair from a fixed seed shared via this config, so both sides match.
// Override with AGORA_SIGNER_SEED_HEX (64 hex chars). DEV ONLY — for production
// the verifier obtains the signer's public key out-of-band (e.g. KMS / a
// published key), not a shared secret seed.
const _seedHex =
  process.env.AGORA_SIGNER_SEED_HEX ??
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const _pkcs8 = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 ed25519 prefix
  Buffer.from(_seedHex, 'hex'), // 32-byte seed
]);
const _privKey = createPrivateKey({ key: _pkcs8, format: 'der', type: 'pkcs8' });
const _pubDer = createPublicKey(_privKey).export({ type: 'spki', format: 'der' });
const signer = {
  keyRef: 'minio-proof-dev',
  publicKey: _pubDer,
  async sign(root) {
    return { alg: 'ed25519', bytes: new Uint8Array(edSign(null, Buffer.from(root), _privKey)), keyRef: 'minio-proof-dev' };
  },
};

/** Verify an ed25519 signature against the shared dev public key. */
const verifySignature = (root, sig) => verifyEd25519(root, sig, signer.publicKey);

// ---------------------------------------------------------------------------
// Triggers + queues (shared between factory and client)
// ---------------------------------------------------------------------------
const triggers = { manual: new ManualTrigger() };
const queues = { default: { concurrency: 2 } };

// ---------------------------------------------------------------------------
// AgoraClient — lazy: no Docker / network until dispatch fires.
// ---------------------------------------------------------------------------
export const client = new AgoraClient({
  namespace: 'offload-minio',
  compute: {
    'local-docker': new LocalDockerProvider({
      allowUnpinnedImage: true,
      extraEnv: {
        AGORA_S3_ENDPOINT: process.env.AGORA_S3_ENDPOINT ?? '',
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? process.env.AGORA_S3_ACCESS_KEY ?? 'minioadmin',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? process.env.AGORA_S3_SECRET_KEY ?? 'minioadmin',
        AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      },
    }),
  },
  storage,
  secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
  credentials: { none: new NoopCredentialProvider() },
  targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
  resultSink: new StdoutResultSink(),
});

export default client;

// ---------------------------------------------------------------------------
// Executors — constructed lazily inside createOrchestrator so they close
// over the client defined above; still safe at module level since
// DispatchExecutor does no I/O until fire() is called.
// ---------------------------------------------------------------------------
function makeExecutors() {
  // No per-dispatch inline secrets: ANTHROPIC_API_KEY is delivered to workers via
  // an env BUNDLE (registered by the driver, ride-along in content-addressed
  // storage = MinIO). Per-dispatch inline secrets stage to LocalSecretStore on the
  // serve container's local FS, which sibling worker containers (launched on the
  // host daemon) cannot read — bundles travel through storage, so they can.
  // The only worker-boot config (S3 endpoint + AWS creds) rides extraEnv on the
  // LocalDockerProvider above, because it is needed BEFORE bundles can be fetched.
  const opts = { client, target: 'local', workerImage };
  return {
    'dispatch-a': new DispatchExecutor(opts),
    'dispatch-b': new DispatchExecutor(opts),
  };
}

// ---------------------------------------------------------------------------
// CRITICAL (D3 single-writer): SqliteRunStateStore is ONLY opened inside this
// factory. The serve container calls createOrchestrator(); the host driver uses
// orch.transport / orch.anchor / orch.storage / orch.verifySignature directly.
// Importing this module does NOT create or open any .db file.
// ---------------------------------------------------------------------------
function createOrchestrator() {
  const store = new SqliteRunStateStore(
    process.env.AGORA_DB_PATH ?? join(tmpdir(), 'agora-minio.db'),
  );
  const auditLog = new AuditLog({ store, signer, anchor });
  return new AgoraOrchestrator({
    store,
    executors: makeExecutors(),
    triggers,
    queues,
    auditLog,
  });
}

export const orch = {
  transport,
  anchor,
  storage,
  verifySignature,
  createOrchestrator,
};
