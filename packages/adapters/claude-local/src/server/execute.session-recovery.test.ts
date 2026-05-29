import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const POISONED_RESUME_RESULT = {
  type: "result",
  is_error: true,
  api_error_status: 400,
  session_id: "poisoned-session",
  result:
    "API Error: 400 messages.1.content.2: 'thinking' or 'redacted_thinking' blocks in the latest assistant message cannot be modified.",
};

function freshResultStdout() {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "fresh-session", model: "claude-sonnet" }),
    JSON.stringify({
      type: "assistant",
      session_id: "fresh-session",
      message: { content: [{ type: "text", text: "recovered" }] },
    }),
    JSON.stringify({
      type: "result",
      session_id: "fresh-session",
      result: "recovered",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    }),
  ].join("\n");
}

function healthyResumeStdout() {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "poisoned-session", model: "claude-sonnet" }),
    JSON.stringify({
      type: "assistant",
      session_id: "poisoned-session",
      message: { content: [{ type: "text", text: "still here" }] },
    }),
    JSON.stringify({
      type: "result",
      session_id: "poisoned-session",
      result: "still here",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    }),
  ].join("\n");
}

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

function makeProc(stdout: string, pid: number) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid,
    startedAt: new Date().toISOString(),
  };
}

describe("claude local corrupted-session recovery", () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    runChildProcess.mockReset();
    ensureCommandResolvable.mockClear();
    resolveCommandForLogs.mockClear();
  });

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeWorkspace(prefix: string) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  it("retries with a fresh session when a resumed session returns the corrupted-resume 400", async () => {
    const workspaceDir = await makeWorkspace("paperclip-claude-recovery-");
    runChildProcess.mockImplementation(async (_runId: string, _command: string, args: string[]) => {
      if (Array.isArray(args) && args.includes("--resume")) {
        return makeProc(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "poisoned-session", model: "claude-sonnet" }),
            JSON.stringify(POISONED_RESUME_RESULT),
          ].join("\n"),
          101,
        );
      }
      return makeProc(freshResultStdout(), 102);
    });

    const result = await execute({
      runId: "run-recovery",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "poisoned-session",
        sessionParams: {
          sessionId: "poisoned-session",
          cwd: workspaceDir,
        },
        sessionDisplayId: "poisoned-session",
        taskKey: null,
      },
      config: {
        command: "claude",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    const firstArgs = runChildProcess.mock.calls[0]?.[2] as string[];
    const secondArgs = runChildProcess.mock.calls[1]?.[2] as string[];
    expect(firstArgs).toContain("--resume");
    expect(firstArgs).toContain("poisoned-session");
    expect(secondArgs).not.toContain("--resume");

    expect(result.sessionId).toBe("fresh-session");
    expect(result.sessionDisplayId).toBe("fresh-session");
    expect(result.errorMessage ?? null).toBeNull();
  });

  it("does not retry when a resumed session succeeds", async () => {
    const workspaceDir = await makeWorkspace("paperclip-claude-healthy-resume-");
    runChildProcess.mockImplementation(async () => makeProc(healthyResumeStdout(), 201));

    const result = await execute({
      runId: "run-healthy-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "poisoned-session",
        sessionParams: {
          sessionId: "poisoned-session",
          cwd: workspaceDir,
        },
        sessionDisplayId: "poisoned-session",
        taskKey: null,
      },
      config: {
        command: "claude",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const firstArgs = runChildProcess.mock.calls[0]?.[2] as string[];
    expect(firstArgs).toContain("--resume");
    expect(firstArgs).toContain("poisoned-session");
    expect(result.sessionId).toBe("poisoned-session");
    expect(result.errorMessage ?? null).toBeNull();
  });
});
