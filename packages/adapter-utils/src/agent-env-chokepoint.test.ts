import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_ENV_DENY_LIST,
  buildInheritedAgentEnv,
  buildInheritedAgentEnvRecord,
  REVIEWED_INHERITED_SENSITIVE_ENV_KEYS,
  runChildProcess,
  SENSITIVE_ENV_KEY,
} from "./server-utils.js";

// SSO-22654. Two kinds of assertion live here:
//   1. behavioural — the chokepoint denies the platform signing secrets;
//   2. drift — the source tree keeps routing through the chokepoint, and any new
//      sensitive-shaped key that reaches a child env has been explicitly
//      reviewed. The runtime deliberately stays a deny-list; this file is what
//      makes that safe over time.

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(srcDir, "../..");
const adapterUtilsSrc = srcDir;
const adaptersDir = path.join(packagesDir, "adapters");

const PLATFORM_SECRETS = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
];

/**
 * `...process.env` merges that are intentionally not routed through
 * buildInheritedAgentEnv(), with the reason. Anything else fails the scan.
 */
const ACCOUNTED_FOR_RAW_INHERIT_SITES = new Map<string, string>([
  [
    "adapter-utils/src/local-process-sandbox.ts",
    "Generated in-sandbox bridge script: it is spawned by runChildProcess() with an env " +
      "already built by buildInheritedAgentEnv(), and cannot import adapter-utils.",
  ],
  [
    "adapter-utils/src/execution-target.ts",
    "Generated remote process-session script: embeds a mirror of AGENT_ENV_DENY_LIST " +
      "(asserted below) because it runs on the remote host without adapter-utils.",
  ],
  [
    "adapter-utils/src/server-utils.ts",
    "The chokepoint itself, plus its explanatory comment.",
  ],
]);

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      // Vitest specs may hand-roll envs freely; they never spawn agent runs.
      if (entry.endsWith(".test.ts")) continue;
      if (full.includes(`${path.sep}test-support${path.sep}`)) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

function allAdapterSources(): string[] {
  const adapterFiles = readdirSync(adaptersDir)
    .map((name) => path.join(adaptersDir, name, "src"))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap((dir) => listSourceFiles(dir));
  return [...listSourceFiles(adapterUtilsSrc), ...adapterFiles];
}

function repoRelative(file: string): string {
  return path.relative(packagesDir, file).split(path.sep).join("/");
}

describe("buildInheritedAgentEnv", () => {
  it("drops every platform signing secret present in the inherited env", () => {
    const env = buildInheritedAgentEnv({}, {
      baseEnv: {
        PATH: "/usr/bin",
        PAPERCLIP_AGENT_JWT_SECRET: "jwt",
        BETTER_AUTH_SECRET: "web",
        PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "tool",
        ANTHROPIC_API_KEY: "provider",
      },
    });
    for (const key of PLATFORM_SECRETS) expect(env[key]).toBeUndefined();
    // Deny-list polarity: provider credentials must still be inherited, or every
    // local adapter loses its authentication on day one.
    expect(env.ANTHROPIC_API_KEY).toBe("provider");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("cannot be re-armed by adapter or user config env", () => {
    const env = buildInheritedAgentEnv(
      { BETTER_AUTH_SECRET: "smuggled-back-in" },
      { baseEnv: { PATH: "/usr/bin" } },
    );
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it("is case-insensitive on the deny list (Windows env semantics)", () => {
    const env = buildInheritedAgentEnv({}, { baseEnv: { better_auth_secret: "web" } });
    expect(env.better_auth_secret).toBeUndefined();
  });

  it("supplies a default PATH only when asked", () => {
    expect(buildInheritedAgentEnv({}, { baseEnv: {} }).PATH).toBeUndefined();
    expect(
      buildInheritedAgentEnv({}, { baseEnv: {}, ensurePath: true }).PATH,
    ).toBeTruthy();
  });

  it("record variant drops non-string values and the deny list", () => {
    const env = buildInheritedAgentEnvRecord({ KEEP: "yes", DROP: undefined }, {
      baseEnv: { BETTER_AUTH_SECRET: "web" },
    });
    expect(env).toEqual({ KEEP: "yes" });
  });

  it("deny list holds exactly the three secrets this change scopes", () => {
    expect([...AGENT_ENV_DENY_LIST].sort()).toEqual([...PLATFORM_SECRETS].sort());
  });
});

describe("agent env chokepoint drift guards", () => {
  it("has no hand-rolled `...process.env` agent-env merges outside the chokepoint", () => {
    const offenders = allAdapterSources()
      .filter((file) => readFileSync(file, "utf8").includes("...process.env"))
      .map(repoRelative)
      .filter((rel) => !ACCOUNTED_FOR_RAW_INHERIT_SITES.has(rel));
    expect(
      offenders,
      "Build child agent environments with buildInheritedAgentEnv()/buildInheritedAgentEnvRecord() " +
        "from server-utils.ts. If a site genuinely must inherit raw, add it to " +
        "ACCOUNTED_FOR_RAW_INHERIT_SITES with the reason.",
    ).toEqual([]);
  });

  it("derives the embedded remote-script deny list from AGENT_ENV_DENY_LIST instead of copying it", () => {
    const source = readFileSync(path.join(adapterUtilsSrc, "execution-target.ts"), "utf8");
    // The remote process-session script is a template literal, so the list must
    // be interpolated from the exported constant — a hardcoded copy would drift.
    expect(source).toContain(
      "const AGENT_ENV_DENY_LIST = ${JSON.stringify([...AGENT_ENV_DENY_LIST])};",
    );
    expect(source).toContain("if (AGENT_ENV_DENY_LIST.includes(key.toUpperCase())) delete merged[key];");
  });

  it("every sensitive-shaped env key reaching a child env is on the reviewed inheritance list", () => {
    // Collect the sensitive-shaped env keys the adapter sources actually touch:
    // `process.env.X` / `env.X` member access, `env["X"]`, and quoted key
    // literals. A new provider credential or secret shows up here the moment it
    // is referenced.
    const candidates = new Set<string>();
    const patterns = [
      /(?:process\.env|env|mergedEnv|runtimeEnv|effectiveEnv)\.([A-Z][A-Z0-9_]{2,})/g,
      /(?:process\.env|env)\["([A-Z][A-Z0-9_]{2,})"\]/g,
      /"([A-Z][A-Z0-9_]{2,}_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|COOKIE))"/g,
    ];
    for (const file of allAdapterSources()) {
      const source = readFileSync(file, "utf8");
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          const key = match[1];
          if (SENSITIVE_ENV_KEY.test(key)) candidates.add(key);
        }
      }
    }
    expect(candidates.size).toBeGreaterThan(5);

    // Feed every candidate plus the deny list through the chokepoint and see
    // what survives into the child env.
    const baseEnv: NodeJS.ProcessEnv = {};
    for (const key of [...candidates, ...AGENT_ENV_DENY_LIST]) baseEnv[key] = `value-of-${key}`;
    const childEnv = buildInheritedAgentEnv({}, { baseEnv });

    const reviewed = new Set(REVIEWED_INHERITED_SENSITIVE_ENV_KEYS);
    const unreviewed = Object.keys(childEnv)
      .filter((key) => SENSITIVE_ENV_KEY.test(key))
      .filter((key) => !reviewed.has(key))
      .sort();

    expect(
      unreviewed,
      "A sensitive-shaped env key reaches the agent child process without review. Either add it to " +
        "AGENT_ENV_DENY_LIST (it is a platform secret) or to REVIEWED_INHERITED_SENSITIVE_ENV_KEYS with " +
        "a comment saying why the agent needs it.",
    ).toEqual([]);

    for (const key of PLATFORM_SECRETS) expect(childEnv[key]).toBeUndefined();
  });

  // End-to-end proof for the local spawn path every adapter funnels through:
  // inspect the environment of a genuinely spawned child process.
  it("a really spawned child process cannot see the platform signing secrets", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "jwt-signing-secret");
    vi.stubEnv("BETTER_AUTH_SECRET", "web-session-secret");
    vi.stubEnv("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "tool-action-secret");
    vi.stubEnv("OPENROUTER_API_KEY", "provider-credential");
    try {
      const result = await runChildProcess(
        "run-agent-env-probe",
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 30,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      expect(result.exitCode).toBe(0);
      const childEnv = JSON.parse(result.stdout) as Record<string, string>;
      for (const key of PLATFORM_SECRETS) expect(childEnv[key]).toBeUndefined();
      expect(childEnv.OPENROUTER_API_KEY).toBe("provider-credential");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never lists a denied key as a reviewed inheritance", () => {
    const denied = new Set(AGENT_ENV_DENY_LIST);
    expect(REVIEWED_INHERITED_SENSITIVE_ENV_KEYS.filter((key) => denied.has(key))).toEqual([]);
  });
});
