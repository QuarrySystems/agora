#!/usr/bin/env node
// Container entrypoint for the stock agora-worker OCI image.
//
// The image places this file at /opt/agora/worker/bin/agora-worker-entry.mjs
// so that Node module resolution from this directory finds the deployed
// worker package at /opt/agora/worker/node_modules/. The worker reads its
// configuration from the AGORA_* env vars documented in spec §6.1.
//
// Exit codes match runWorker()'s contract:
//   - 0 on `dispatch.finished` or a valid `dispatch.needs_input` sentinel
//   - the runtime's exit code on a non-zero runtime exit
//   - 1 on any worker-side failure (integrity, fetch, setup, sentinel parse)

import { runWorker } from '../dist/index.js';

runWorker(process.env)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[agora-worker-entry] uncaught:', err);
    process.exit(1);
  });
