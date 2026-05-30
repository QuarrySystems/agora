import { z } from "zod";
import type { EffectTier } from "./types.js";

export interface Capability {
  imageDigest: string;                     // pinned container image
  permissions: Record<string, unknown>;    // capability-scoped policy
  contextShape: string;                    // declarative description of staged context
}

export interface SubagentShape {
  id: string;                              // "<pack>.<name>", e.g. "dev.code-edit"
  effectTier: EffectTier;
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;        // declared now; enforced via .agora/output.json in PR6
  capability: Capability;
}

const ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+$/;  // pack-prefixed

/** Throws on a malformed shape. Used at registry construction (D8). */
export function validateShape(s: SubagentShape): void {
  if (!ID_RE.test(s.id))
    throw new Error(`SubagentShape: id "${s.id}" must be "<pack>.<name>"`);
  if (!["pure", "read-impure", "write-impure"].includes(s.effectTier))
    throw new Error(`SubagentShape ${s.id}: invalid effectTier ${s.effectTier}`);
  if (!s.capability?.imageDigest)
    throw new Error(`SubagentShape ${s.id}: capability.imageDigest required`);
}
