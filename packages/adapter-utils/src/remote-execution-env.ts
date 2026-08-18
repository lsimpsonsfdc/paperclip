// Root-of-trust signer secrets that must never reach a spawned run's
// environment. PAPERCLIP_AGENT_JWT_SECRET mints agent-identity JWTs for any
// seat; BETTER_AUTH_SECRET is its fallback signer path; and
// PAPERCLIP_TOOL_ACTION_SIGNING_SECRET signs tool-action approvals. A run
// only ever needs its own harness-minted PAPERCLIP_API_KEY, never the keys
// that sign everyone's. See SSO-23089. Lives here (the leaf-level env-hygiene
// module) so both the local-spawn path (sanitizeInheritedPaperclipEnv) and
// the remote-spawn path (sanitizeRemoteExecutionEnv) share one list without a
// circular import between this module and server-utils.ts.
export const ROOT_OF_TRUST_ENV_DENYLIST = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "BETTER_AUTH_SECRET",
] as const;

const REMOTE_EXECUTION_ENV_IDENTITY_KEYS = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "NVM_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);

function readEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string") return direct;
  const upper = key.toUpperCase();
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (candidateKey.toUpperCase() === upper && typeof candidateValue === "string") {
      return candidateValue;
    }
  }
  return undefined;
}

export function sanitizeRemoteExecutionEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // Root-of-trust signer secrets are stripped unconditionally, independent
    // of the identity-key redundancy check below: an install/probe command
    // shelled out on a remote SSH host or sandbox lease must never carry
    // these regardless of which caller assembled `env` (a caller upstream of
    // this function may have merged `process.env` in wholesale, e.g. to
    // build a "runtimeEnv" for command-resolvability checks).
    if ((ROOT_OF_TRUST_ENV_DENYLIST as readonly string[]).includes(key)) continue;
    const normalizedKey = key.toUpperCase();
    if (!REMOTE_EXECUTION_ENV_IDENTITY_KEYS.has(normalizedKey)) {
      sanitized[key] = value;
      continue;
    }
    const inheritedValue = readEnvValueCaseInsensitive(inheritedEnv, key);
    if (typeof inheritedValue === "string" && inheritedValue === value) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
