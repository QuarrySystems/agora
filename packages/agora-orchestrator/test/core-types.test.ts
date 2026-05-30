import { describe, it, expect } from "vitest";
import { patchSchema, intentSchema, type Patch } from "../src/contracts/core-types.js";
it("patchSchema is the source of truth and the type is inferred from it", () => {
  const p: Patch = { baseCommit: "abc123", diff: "--- a\n+++ b\n" };
  expect(patchSchema.safeParse(p).success).toBe(true);
  expect(patchSchema.safeParse({ baseCommit: 1, diff: "x" }).success).toBe(false);
  expect(intentSchema.safeParse({ kind: "open-pr", payload: {} }).success).toBe(true);
});
