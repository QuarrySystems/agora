import { describe, it, expect } from "vitest";

describe("agora-worker index exports", () => {
  it("exports runWorker", async () => {
    const { runWorker } = await import("../src/index.js");
    expect(runWorker).toBeDefined();
    expect(typeof runWorker).toBe("function");
  });

  it("exports parseWorkerEnv and types", async () => {
    const { parseWorkerEnv } = await import("../src/index.js");
    expect(parseWorkerEnv).toBeDefined();
    expect(typeof parseWorkerEnv).toBe("function");
  });

  it("exports LifecycleEmitter", async () => {
    const { LifecycleEmitter } = await import("../src/index.js");
    expect(LifecycleEmitter).toBeDefined();
    expect(typeof LifecycleEmitter).toBe("function");
  });

  it("exports StructuredLogger", async () => {
    const { StructuredLogger } = await import("../src/index.js");
    expect(StructuredLogger).toBeDefined();
    expect(typeof StructuredLogger).toBe("function");
  });

  it("exports SecretResolver and SecretResolutionError", async () => {
    const { SecretResolver, SecretResolutionError } = await import(
      "../src/index.js"
    );
    expect(SecretResolver).toBeDefined();
    expect(SecretResolutionError).toBeDefined();
    expect(typeof SecretResolver).toBe("function");
  });

  it("exports mergeEnv", async () => {
    const { mergeEnv } = await import("../src/index.js");
    expect(mergeEnv).toBeDefined();
    expect(typeof mergeEnv).toBe("function");
  });

  it("exports overlayCapabilities", async () => {
    const { overlayCapabilities } = await import("../src/index.js");
    expect(overlayCapabilities).toBeDefined();
    expect(typeof overlayCapabilities).toBe("function");
  });

  it("exports fetchBundles and constructStorageProvider", async () => {
    const { fetchBundles, constructStorageProvider } = await import(
      "../src/index.js"
    );
    expect(fetchBundles).toBeDefined();
    expect(constructStorageProvider).toBeDefined();
    expect(typeof fetchBundles).toBe("function");
    expect(typeof constructStorageProvider).toBe("function");
  });

  it("exports loadRuntimeAdapter", async () => {
    const { loadRuntimeAdapter } = await import("../src/index.js");
    expect(loadRuntimeAdapter).toBeDefined();
    expect(typeof loadRuntimeAdapter).toBe("function");
  });

  it("exports runSetupScriptIfPresent and SetupScriptError", async () => {
    const { runSetupScriptIfPresent, SetupScriptError } = await import(
      "../src/index.js"
    );
    expect(runSetupScriptIfPresent).toBeDefined();
    expect(SetupScriptError).toBeDefined();
    expect(typeof runSetupScriptIfPresent).toBe("function");
  });

  it("exports loadChannelIfPresent", async () => {
    const { loadChannelIfPresent } = await import("../src/index.js");
    expect(loadChannelIfPresent).toBeDefined();
    expect(typeof loadChannelIfPresent).toBe("function");
  });

  it("exports resolveNeedsInputSentinel", async () => {
    const { resolveNeedsInputSentinel } = await import("../src/index.js");
    expect(resolveNeedsInputSentinel).toBeDefined();
    expect(typeof resolveNeedsInputSentinel).toBe("function");
  });

  it("exports loadCapabilityNotifications and fireNotifications", async () => {
    const { loadCapabilityNotifications, fireNotifications } = await import(
      "../src/index.js"
    );
    expect(loadCapabilityNotifications).toBeDefined();
    expect(fireNotifications).toBeDefined();
    expect(typeof loadCapabilityNotifications).toBe("function");
    expect(typeof fireNotifications).toBe("function");
  });

  it("exports applyMergeRule and MergeTypeConflictError", async () => {
    const { applyMergeRule, MergeTypeConflictError } = await import(
      "../src/index.js"
    );
    expect(applyMergeRule).toBeDefined();
    expect(MergeTypeConflictError).toBeDefined();
    expect(typeof applyMergeRule).toBe("function");
  });

  it("exports types: WorkerConfig, BundleRefs, EnvBundle, CapabilityBundle, ChannelHandle, NeedsInputOutcome, FetchedBundles", async () => {
    // Just verify the module exports without errors
    const module = await import("../src/index.js");
    expect(module).toBeDefined();
  });
});
