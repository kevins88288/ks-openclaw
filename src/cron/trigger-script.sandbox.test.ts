import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeModeHeadlessResult } from "../agents/code-mode.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

const sandboxMocks = vi.hoisted(() => ({ resolveSandboxContext: vi.fn() }));
vi.mock("../agents/sandbox.js", () => sandboxMocks);
const toolMocks = vi.hoisted(() => ({ createOpenClawCodingTools: vi.fn(() => []) }));
vi.mock("../agents/agent-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-tools.js")>()),
  ...toolMocks,
}));

type HeadlessParams = Parameters<
  NonNullable<Parameters<typeof createCronScriptRuntime>[0]["runHeadless"]>
>[0];

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let config: OpenClawConfig;

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-cron-sandbox-",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  config = {
    agents: {
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      entries: { main: { workspace: state.workspaceDir } },
    },
    plugins: { slots: { memory: "none" } },
  };
  // Each resolution stands for a container that may be recreated between ticks.
  let generation = 0;
  sandboxMocks.resolveSandboxContext.mockImplementation(async () => ({
    enabled: true,
    workspaceAccess: "ro",
    workspaceDir: `/sandbox/container-${++generation}`,
  }));
});

afterEach(async () => {
  sandboxMocks.resolveSandboxContext.mockReset();
  toolMocks.createOpenClawCodingTools.mockClear();
  await state?.cleanup();
});

describe("cron script sandbox lifetime", () => {
  it.each(["evaluateTrigger", "executePayload"] as const)(
    "re-resolves the sandbox for every %s instead of reusing a cached container",
    async (entry) => {
      const cwds: string[] = [];
      const runtime = createCronScriptRuntime({
        config,
        loadPluginRegistry: () => undefined as never,
        runHeadless: async ({ ctx }: HeadlessParams): Promise<CodeModeHeadlessResult> => {
          cwds.push(String(ctx.cwd));
          return {
            status: "completed",
            value: entry === "evaluateTrigger" ? { fire: false } : { state: null },
            output: [],
            toolCallCount: 0,
          };
        },
      });
      const run = () =>
        runtime[entry]({
          jobId: "monitor",
          agentId: "main",
          toolsAllow: ["exec"],
          script: "return {}",
          state: null,
          timeoutSeconds: 5,
        });

      const kind = entry === "evaluateTrigger" ? "evaluated" : "completed";
      await expect(run()).resolves.toMatchObject({ kind });
      await expect(run()).resolves.toMatchObject({ kind });

      expect(sandboxMocks.resolveSandboxContext).toHaveBeenCalledTimes(2);
      expect(cwds).toEqual(["/sandbox/container-1", "/sandbox/container-2"]);
      // Tool closures (exec) must bind the freshly resolved container, not the first one.
      expect(
        toolMocks.createOpenClawCodingTools.mock.calls.map(
          ([options]) => (options as { sandbox: { workspaceDir: string } }).sandbox.workspaceDir,
        ),
      ).toEqual(["/sandbox/container-1", "/sandbox/container-2"]);
    },
  );

  it("settles on abort while sandbox resolution is still pending", async () => {
    const controller = new AbortController();
    let release!: () => void;
    sandboxMocks.resolveSandboxContext.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ enabled: true, workspaceAccess: "ro", workspaceDir: "/sandbox/late" });
          controller.abort();
        }),
    );
    const runHeadless = vi.fn();
    const runtime = createCronScriptRuntime({
      config,
      loadPluginRegistry: () => undefined as never,
      runHeadless,
    });

    await expect(
      runtime.evaluateTrigger({
        jobId: "monitor",
        agentId: "main",
        toolsAllow: [],
        script: "return {}",
        state: null,
        abortSignal: controller.signal,
      }),
    ).resolves.toMatchObject({ kind: "error", code: "aborted" });
    // A late resolution after the caller settled must not start the script.
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(runHeadless).not.toHaveBeenCalled();
  });
});
