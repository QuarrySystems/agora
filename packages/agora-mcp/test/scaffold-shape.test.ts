import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const pkgPath = join(__dirname, "..", "package.json");
const readmePath = join(__dirname, "..", "README.md");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const readme = readFileSync(readmePath, "utf-8");

const FORBIDDEN_PREFIXES = [
  "@stoa-mcp/",
  "@quarry-systems/bedrock-",
  "@rastate/",
  "@quarry-systems/drift-",
];

const ALLOWLISTED_TOOL_NAMES = [
  "agora_dispatch",
  "agora_dispatch_describe",
  "agora_dispatch_cancel",
  "agora_capabilities_list",
  "agora_subagents_list",
  "agora_envs_list",
];

describe("agora-mcp scaffold shape", () => {
  it("package name is @quarry-systems/agora-mcp", () => {
    expect(pkg.name).toBe("@quarry-systems/agora-mcp");
  });

  it("dependencies include @quarry-systems/agora-client at workspace:*", () => {
    expect(pkg.dependencies?.["@quarry-systems/agora-client"]).toBe("workspace:*");
  });

  it("dependencies do NOT include any forbidden prefixes", () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const dep of deps) {
      for (const prefix of FORBIDDEN_PREFIXES) {
        expect(dep.startsWith(prefix), `Found forbidden dep: ${dep}`).toBe(false);
      }
    }
  });

  it("README contains all six allowlisted tool names verbatim", () => {
    for (const toolName of ALLOWLISTED_TOOL_NAMES) {
      expect(readme, `README missing tool name: ${toolName}`).toContain(toolName);
    }
  });
});
