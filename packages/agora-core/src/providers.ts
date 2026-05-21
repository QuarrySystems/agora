// Pluggable provider contracts (§5.1 / §5.2).
//
// Integrators implement these interfaces to plug compute backends and
// credential sources into the dispatch path. The agora-client and
// agora-worker packages consume these contracts in DAG 2; the core
// package only owns the signatures.
//
// `CredentialProvider` is a one-shot resolver for the secret material a
// task will need at runtime. `ComputeProvider` is the surface a backend
// (Docker, AWS Batch, a remote runner, etc.) exposes to the runtime to
// start, await, and optionally cancel a task. `cancel` is optional
// because some providers (notably batch queues) cannot abort a running
// task; the runtime treats its absence as "best-effort, not supported."

import type { TelemetryHook } from './telemetry.js';

/**
 * Resolved secret material for a task. The `kind` discriminator names the
 * credential family (e.g. `'aws-sts'`, `'static-bearer'`); additional
 * fields are family-specific and intentionally open.
 */
export interface ResolvedCredentials {
  kind: string;
  [key: string]: unknown;
}

/**
 * A `CredentialProvider` resolves the credential bundle for one task
 * invocation. Implementations are expected to be side-effect-free aside
 * from the secret fetch itself; the runtime calls `resolve` once per
 * dispatch.
 */
export interface CredentialProvider {
  readonly name: string;
  resolve(): Promise<ResolvedCredentials>;
}

/**
 * Declarative description of a task the runtime wants the provider to
 * run. `secretRefs` is a map of env-var name -> secret reference string,
 * resolved out-of-band by the provider against its credential context.
 */
export interface TaskSpec {
  image: string;
  env: Record<string, string>;
  secretRefs: Record<string, string>;
  command?: string[];
  resources?: { cpu?: number; memory?: number };
  dispatchId: string;
}

/**
 * Per-invocation context handed to a `ComputeProvider`. The telemetry
 * hook is optional so providers can run unobserved in tests.
 */
export interface ProviderContext {
  credentials: ResolvedCredentials;
  telemetry?: TelemetryHook;
}

/**
 * Opaque handle the provider returns from `run`. The shape is provider-
 * specific aside from `providerTaskId`, which the runtime echoes into
 * the lifecycle event stream.
 */
export interface TaskHandle {
  providerTaskId: string;
}

/**
 * Terminal result the provider returns from `awaitExit`. `exitCode` is
 * 0 for success; non-zero for application failure. `providerFailureReason`
 * is set when the failure is infrastructural (image pull failed, quota
 * exceeded) rather than an application-level non-zero exit.
 */
export interface TaskExit {
  exitCode: number;
  startedAt: Date;
  finishedAt: Date;
  stdout: string;
  stderr: string;
  providerFailureReason?: string;
}

/**
 * A `ComputeProvider` is the runtime-facing surface of a compute backend.
 * `run` is non-blocking and returns a handle; `awaitExit` blocks until
 * the task reaches a terminal state. `cancel` is optional — providers
 * that cannot abort in-flight tasks simply omit it, and the runtime
 * treats cancellation as best-effort.
 */
export interface ComputeProvider {
  readonly name: string;
  run(spec: TaskSpec, ctx: ProviderContext): Promise<TaskHandle>;
  awaitExit(handle: TaskHandle, ctx: ProviderContext): Promise<TaskExit>;
  cancel?(handle: TaskHandle, ctx: ProviderContext): Promise<void>;
}
