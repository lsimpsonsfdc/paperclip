import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// SSO-22654 regression: every local-adapter child environment is built by
// buildInheritedAgentEnv(), so the platform signing secrets in the Paperclip
// server env never reach the agent process — while a real run still completes.

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "opencode"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "step_start", sessionID: "session_123" }),
      JSON.stringify({ type: "text", sessionID: "session_123", part: { text: "hello" } }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: { cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

describe("opencode_local platform signing secret containment", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps platform signing secrets out of the child env while the run still completes", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-"));
    cleanupDirs.push(cwd);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "jwt-signing-secret");
    vi.stubEnv("BETTER_AUTH_SECRET", "web-session-secret");
    vi.stubEnv("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "tool-action-secret");
    vi.stubEnv("OPENROUTER_API_KEY", "provider-credential");

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd, model: "opencode/gpt-5-nano", env: { OPENCODE_ALLOW_ALL_MODELS: "true" } },
      context: {},
      onLog: async () => {},
    } as never);

    // Half one: the run completes. A secure-but-broken adapter is not a pass.
    expect(result.exitCode).toBe(0);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalled();

    // Half two: the merged child environment this adapter builds carries none of
    // the platform signing secrets.
    const resolveCalls = ensureAdapterExecutionTargetCommandResolvable.mock.calls as unknown as unknown[][];
    const childEnv = resolveCalls.at(-1)?.[3] as Record<string, string>;
    expect(childEnv.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
    expect(childEnv.BETTER_AUTH_SECRET).toBeUndefined();
    expect(childEnv.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBeUndefined();
    // Deny-list polarity: provider credentials are still inherited.
    expect(childEnv.OPENROUTER_API_KEY).toBe("provider-credential");
  });
});
