import { describe, expect, it } from "vitest";
import { ROOT_OF_TRUST_ENV_DENYLIST, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("strips root-of-trust signer secrets so a spawned run never inherits them", () => {
    const sanitized = sanitizeInheritedPaperclipEnv({
      PAPERCLIP_AGENT_JWT_SECRET: "synthetic-jwt-signer-value",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "synthetic-tool-action-signer-value",
      BETTER_AUTH_SECRET: "synthetic-better-auth-fallback-value",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });

    for (const key of ROOT_OF_TRUST_ENV_DENYLIST) {
      expect(sanitized).not.toHaveProperty(key);
    }
    expect(sanitized).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});
