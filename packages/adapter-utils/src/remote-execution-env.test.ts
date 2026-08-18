import { describe, expect, it } from "vitest";
import { ROOT_OF_TRUST_ENV_DENYLIST, sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";

describe("sanitizeRemoteExecutionEnv", () => {
  it("drops redundant identity keys that already match the inherited env", () => {
    const sanitized = sanitizeRemoteExecutionEnv(
      { PATH: "/usr/bin", HOME: "/home/agent", CUSTOM: "value" },
      { PATH: "/usr/bin", HOME: "/home/agent" },
    );
    expect(sanitized).toEqual({ CUSTOM: "value" });
  });

  it("strips root-of-trust signer secrets unconditionally, independent of the identity-key check", () => {
    // The denylist strip must fire even when the caller's `env` was assembled by
    // merging the full inherited process.env upstream (e.g. a "runtimeEnv" built
    // for a command-resolvability check) — this function is the last line of
    // defense before a remote SSH/sandbox shell command receives it. See SSO-23089.
    const sanitized = sanitizeRemoteExecutionEnv({
      PAPERCLIP_AGENT_JWT_SECRET: "synthetic-jwt-signer-value",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "synthetic-tool-action-signer-value",
      BETTER_AUTH_SECRET: "synthetic-better-auth-fallback-value",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
    });

    for (const key of ROOT_OF_TRUST_ENV_DENYLIST) {
      expect(sanitized).not.toHaveProperty(key);
    }
    expect(sanitized).toEqual({ PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100" });
  });

  it("strips the denylist even when a value happens to match an identity key's inherited value", () => {
    // Defense in depth: confirm denylist stripping is not accidentally gated
    // behind the identity-key redundancy branch.
    const sanitized = sanitizeRemoteExecutionEnv(
      { BETTER_AUTH_SECRET: "same-value" },
      { BETTER_AUTH_SECRET: "same-value" },
    );
    expect(sanitized).not.toHaveProperty("BETTER_AUTH_SECRET");
  });
});
