// @quarry-systems/agora-runtime-claude-code — public barrel
//
// Re-exports the runtime adapter class and factory for consumption by
// the worker's adapter-loader (§5.8). The default export resolves to the
// factory as expected by the loader's `mod.default ?? mod.createAdapter` pattern.

export { ClaudeCodeRuntimeAdapter } from "./adapter.js";
export { default } from "./adapter.js";
