import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRootOfTrustSecretFiles,
  resolveFileBackedSecret,
  SecretFileError,
} from "../secrets/file-backed-secret.js";

describe("resolveFileBackedSecret", () => {
  let tempDir: string | null = null;

  function writeSecretFile(fileName: string, contents: string, mode = 0o600): string {
    if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), "paperclip-file-backed-secret-test-"));
    const filePath = join(tempDir, fileName);
    writeFileSync(filePath, contents, { mode });
    chmodSync(filePath, mode);
    return filePath;
  }

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("returns unset when neither the file nor plain var is configured", () => {
    expect(resolveFileBackedSecret("EXAMPLE_SECRET", {})).toEqual({ value: undefined, source: "unset" });
  });

  it("reads the plain var when only it is set", () => {
    expect(
      resolveFileBackedSecret("EXAMPLE_SECRET", { EXAMPLE_SECRET: "plain-value" }),
    ).toEqual({ value: "plain-value", source: "env" });
  });

  it("reads and trims the file when only EXAMPLE_SECRET_FILE is set", () => {
    const filePath = writeSecretFile("secret", "  file-value\n");
    expect(
      resolveFileBackedSecret("EXAMPLE_SECRET", { EXAMPLE_SECRET_FILE: filePath }),
    ).toEqual({ value: "file-value", source: "file" });
  });

  it("prefers EXAMPLE_SECRET_FILE over the plain var when both are set", () => {
    const filePath = writeSecretFile("secret", "file-value");
    expect(
      resolveFileBackedSecret("EXAMPLE_SECRET", {
        EXAMPLE_SECRET_FILE: filePath,
        EXAMPLE_SECRET: "plain-value",
      }),
    ).toEqual({ value: "file-value", source: "file" });
  });

  it("throws SecretFileError instead of falling back when the file does not exist", () => {
    const missingPath = join(tmpdir(), "paperclip-file-backed-secret-test-does-not-exist", "secret.key");
    expect(() =>
      resolveFileBackedSecret("EXAMPLE_SECRET", {
        EXAMPLE_SECRET_FILE: missingPath,
        EXAMPLE_SECRET: "plain-value-must-not-be-used",
      }),
    ).toThrow(SecretFileError);
  });

  it("throws SecretFileError instead of falling back when the file is group/world-readable", () => {
    const filePath = writeSecretFile("open-secret", "file-value", 0o644);
    expect(() =>
      resolveFileBackedSecret("EXAMPLE_SECRET", {
        EXAMPLE_SECRET_FILE: filePath,
        EXAMPLE_SECRET: "plain-value-must-not-be-used",
      }),
    ).toThrow(/readable by group or others/);
  });

  it("throws SecretFileError instead of falling back when the file is empty", () => {
    const filePath = writeSecretFile("empty-secret", "   \n");
    expect(() =>
      resolveFileBackedSecret("EXAMPLE_SECRET", {
        EXAMPLE_SECRET_FILE: filePath,
        EXAMPLE_SECRET: "plain-value-must-not-be-used",
      }),
    ).toThrow(SecretFileError);
  });

  it("accepts a 0400 (owner read-only) file", () => {
    const filePath = writeSecretFile("readonly-secret", "file-value", 0o400);
    expect(
      resolveFileBackedSecret("EXAMPLE_SECRET", { EXAMPLE_SECRET_FILE: filePath }),
    ).toEqual({ value: "file-value", source: "file" });
  });
});

describe("ensureRootOfTrustSecretFiles", () => {
  let tempDir: string | null = null;

  function writeSecretFile(fileName: string, contents: string, mode = 0o600): string {
    if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), "paperclip-root-of-trust-secret-test-"));
    const filePath = join(tempDir, fileName);
    writeFileSync(filePath, contents, { mode });
    chmodSync(filePath, mode);
    return filePath;
  }

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("does not throw when no *_FILE var is configured", () => {
    expect(() => ensureRootOfTrustSecretFiles({})).not.toThrow();
  });

  it("does not throw when every configured *_FILE is valid", () => {
    const authFile = writeSecretFile("better-auth-secret", "auth-secret");
    const jwtFile = writeSecretFile("agent-jwt-secret", "jwt-secret");
    expect(() =>
      ensureRootOfTrustSecretFiles({
        BETTER_AUTH_SECRET_FILE: authFile,
        PAPERCLIP_AGENT_JWT_SECRET_FILE: jwtFile,
      }),
    ).not.toThrow();
  });

  it("fails the boot guard when a configured *_FILE is unreadable, even though other secrets are fine", () => {
    const authFile = writeSecretFile("better-auth-secret", "auth-secret");
    expect(() =>
      ensureRootOfTrustSecretFiles({
        BETTER_AUTH_SECRET_FILE: authFile,
        PAPERCLIP_TOOL_ACTION_SIGNING_SECRET_FILE: join(
          tmpdir(),
          "paperclip-root-of-trust-secret-test-missing",
          "secret.key",
        ),
      }),
    ).toThrow(SecretFileError);
  });

  it("fails the boot guard when a configured *_FILE is group/world-readable", () => {
    const openFile = writeSecretFile("too-open", "jwt-secret", 0o644);
    expect(() =>
      ensureRootOfTrustSecretFiles({ PAPERCLIP_AGENT_JWT_SECRET_FILE: openFile }),
    ).toThrow(SecretFileError);
  });
});
