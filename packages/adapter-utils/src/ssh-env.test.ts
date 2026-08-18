import { describe, expect, it } from "vitest";
import { ROOT_OF_TRUST_ENV_DENYLIST } from "./remote-execution-env.js";
import { sanitizedLocalSpawnEnv } from "./ssh.js";

describe("sanitizedLocalSpawnEnv", () => {
  it("strips root-of-trust signer secrets from the local-spawn env used by git/tar/ssh/ssh-keygen calls", () => {
    const previousJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const previousToolActionSecret = process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;
    const previousBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "synthetic-jwt-signer-value";
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "synthetic-tool-action-signer-value";
    process.env.BETTER_AUTH_SECRET = "synthetic-better-auth-fallback-value";

    try {
      const env = sanitizedLocalSpawnEnv();
      for (const key of ROOT_OF_TRUST_ENV_DENYLIST) {
        expect(env).not.toHaveProperty(key);
      }
    } finally {
      if (previousJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousJwtSecret;
      if (previousToolActionSecret === undefined) delete process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;
      else process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = previousToolActionSecret;
      if (previousBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previousBetterAuthSecret;
    }
  });

  it("keeps extra overrides (e.g. COPYFILE_DISABLE) alongside the sanitized base", () => {
    const env = sanitizedLocalSpawnEnv({ COPYFILE_DISABLE: "1" });
    expect(env.COPYFILE_DISABLE).toBe("1");
  });
});
