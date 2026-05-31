import { it, expect } from "vitest";
import { devPack, devCodeEdit, devVerify } from "../../src/packs/dev.js";
import { PackRegistry } from "../../src/packs/registry.js";
it("dev shapes declare effect tiers and register without collision", () => {
  expect(devCodeEdit.effectTier).toBe("write-impure");
  expect(devVerify.effectTier).toBe("read-impure");
  const r = new PackRegistry(devPack);
  expect(r.get("dev.code-edit")?.inputSchema.safeParse({ baseCommit: "a", instructions: "do x" }).success).toBe(true);
  expect(r.get("dev.code-edit")?.inputSchema.safeParse({ baseCommit: 1 }).success).toBe(false);
});
