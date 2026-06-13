// The manifest types moved into @quarry-systems/pangolin-core alongside the audit
// types (AuditBundle references DispatchManifest, and core must not depend on the
// orchestrator). This file is a pure re-export so existing imports keep working.
export type {
  ManifestSignature,
  DispatchManifest,
  DispatchExecutorManifest,
} from '@quarry-systems/pangolin-core';
