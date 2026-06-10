// pangolin.config.mjs — operator config for the demo-claims-appeals example.
//
// Exports:
//   default / client  — wired PangolinClient (namespace 'demo-claims-appeals')
//   orch              — OrchContext: { transport, storage, anchor, verifySignature, runService }
//
// IMPORT-SAFE: no throw at load when ANTHROPIC_API_KEY is absent.
// The live-run guard (exit 1 on missing key) lives in src/index.ts, not here.
//
// TAMPER TIER: this config uses LocalAnchor → the bundle reads `tamper-detecting`.
// For the tamper-EVIDENT (external-immutable) recording, swap LocalAnchor for
// S3ObjectLockAnchor here — that is the ONLY change needed.

import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PangolinClient, NoopCredentialProvider, StdoutResultSink } from '@quarry-systems/pangolin-client';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { LocalDockerProvider } from '@quarry-systems/pangolin-providers-local-docker';
import { LocalSecretStore } from '@quarry-systems/pangolin-secret-store';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  DispatchExecutor,
  AuditLog,
  LocalAnchor,
  createLocalSigner,
  verifyEd25519,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  serve,
} from '@quarry-systems/pangolin-orchestrator';

const rootDir = join(tmpdir(), 'pangolin-claims-storage');
const secretDir = join(tmpdir(), 'pangolin-claims-secrets');
const mailboxDir = join(tmpdir(), 'pangolin-claims-mailbox');
const dbPath = join(tmpdir(), `pangolin-claims-${process.pid}.db`);

const workerImage = 'ghcr.io/quarrysystems/pangolin-worker:latest';

export const client = new PangolinClient({
  namespace: 'demo-claims-appeals',
  compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
  storage: new LocalStorageProvider({ rootDir }),
  secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
  credentials: { none: new NoopCredentialProvider() },
  targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
  resultSink: new StdoutResultSink(),
});

export default client;

const store = new SqliteRunStateStore(dbPath);
process.on('exit', () => { try { store.close(); } catch {} });
const signer = createLocalSigner();
const anchor = new LocalAnchor(store);
const auditLog = new AuditLog({ store, signer, anchor });

const orchestrator = new PangolinOrchestrator({
  store,
  executors: {
    dispatch: new DispatchExecutor({
      client,
      target: 'local',
      workerImage,
      secrets: {
        ANTHROPIC_API_KEY: { inline: process.env.ANTHROPIC_API_KEY ?? '' },
      },
    }),
  },
  triggers: { manual: new ManualTrigger() },
  queues: { default: { concurrency: 2 } },
  auditLog,
});

const verifySignature = (root, sig) => verifyEd25519(root, sig, signer.publicKey);

const transport = new MailboxSubmissionTransport(new LocalDirMailbox(mailboxDir));

const runService = (signal) => serve({ orchestrator, transport, signal });

export const orch = {
  transport,
  storage: client.storage,
  anchor,
  verifySignature,
  runService,
};
