import { readFileSync, statSync } from "node:fs";
import { resolveHomeAwarePath } from "../home-paths.js";

export type SecretSource = "file" | "env" | "unset";

export interface ResolvedSecret {
  value: string | undefined;
  source: SecretSource;
}

/**
 * Thrown when a `<NAME>_FILE` env var is set but the file it points at is
 * missing, unreadable, empty, or group/world-permissioned. This is always a
 * hard failure -- resolveFileBackedSecret never falls back to the plain
 * `<NAME>` var in this case. A silent fallback here would let an unusable
 * root-of-trust secret quietly hand signing authority to a weaker fallback
 * signer with no error.
 */
export class SecretFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretFileError";
  }
}

/**
 * Resolve a root-of-trust secret from `<envVarName>_FILE` (preferred, 0600
 * file read once and held in memory) or the plain `<envVarName>` var
 * (fallback, existing behavior). Mirrors the PAPERCLIP_SECRETS_MASTER_KEY_FILE
 * idiom in config.ts/local-encrypted-provider.ts: same naming convention,
 * same home-aware path resolution.
 *
 * Precedence: `_FILE` wins over the plain variable when both are set. If
 * `_FILE` is set, its file must exist, be owner-only-readable (mode & 0o077
 * === 0), and contain a non-empty value -- otherwise this throws
 * SecretFileError rather than silently falling back to the plain variable.
 */
export function resolveFileBackedSecret(
  envVarName: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedSecret {
  const fileEnvVarName = `${envVarName}_FILE`;
  const filePathRaw = env[fileEnvVarName]?.trim();
  if (filePathRaw) {
    const filePath = resolveHomeAwarePath(filePathRaw);

    let mode: number;
    try {
      mode = statSync(filePath).mode & 0o777;
    } catch (err) {
      throw new SecretFileError(
        `${fileEnvVarName} is set to "${filePath}" but the file could not be accessed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if ((mode & 0o077) !== 0) {
      throw new SecretFileError(
        `${fileEnvVarName} points at "${filePath}", which is readable by group or others ` +
          `(mode ${mode.toString(8).padStart(3, "0")}). Refusing to load it -- run \`chmod 600 ${filePath}\`.`,
      );
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      throw new SecretFileError(
        `${fileEnvVarName} is set to "${filePath}" but the file could not be read: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const value = raw.trim();
    if (!value) {
      throw new SecretFileError(`${fileEnvVarName} is set to "${filePath}" but the file is empty.`);
    }
    return { value, source: "file" };
  }

  const envValue = env[envVarName]?.trim();
  if (envValue) {
    return { value: envValue, source: "env" };
  }

  return { value: undefined, source: "unset" };
}

const ROOT_OF_TRUST_SECRET_ENV_VARS = [
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
] as const;

/**
 * Startup guard: eagerly validates every configured `<NAME>_FILE` root-of-
 * trust secret so a bad file fails the boot instead of surfacing lazily on
 * first use. Each secret's own resolver still decides whether the secret is
 * required at all -- a `<NAME>_FILE` that is simply unset is not an error
 * here, only one that is set but unusable. Call once at process start,
 * alongside ensureDecisionSigningSecret().
 */
export function ensureRootOfTrustSecretFiles(env: Record<string, string | undefined> = process.env): void {
  for (const envVarName of ROOT_OF_TRUST_SECRET_ENV_VARS) {
    const fileEnvVarName = `${envVarName}_FILE`;
    if (!env[fileEnvVarName]?.trim()) continue;
    resolveFileBackedSecret(envVarName, env);
  }
}
