import { describe, expect, it, vi } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

import { readClaudeAuthStatus } from "./quota.js";

describe("readClaudeAuthStatus", () => {
  it("never hands the spawned claude CLI the root-of-trust signer secrets", async () => {
    const previousJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const previousToolActionSecret = process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;
    const previousBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "synthetic-jwt-signer-value";
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "synthetic-tool-action-signer-value";
    process.env.BETTER_AUTH_SECRET = "synthetic-better-auth-fallback-value";
    try {
      mockExecFile.mockImplementation((_file, _args, _options, callback) => {
        callback(null, { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" });
      });

      await readClaudeAuthStatus();

      expect(mockExecFile).toHaveBeenCalled();
      const options = mockExecFile.mock.calls[0][2] as { env: Record<string, string> };
      expect(options.env.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
      expect(options.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBeUndefined();
      expect(options.env.BETTER_AUTH_SECRET).toBeUndefined();
    } finally {
      if (previousJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousJwtSecret;
      if (previousToolActionSecret === undefined) delete process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;
      else process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = previousToolActionSecret;
      if (previousBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previousBetterAuthSecret;
    }
  });
});
