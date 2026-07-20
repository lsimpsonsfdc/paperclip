import { logger } from "../middleware/logger.js";

// Defense-in-depth for the workspace provisioning window: serializes
// concurrent provisioning attempts for the same key (e.g. companyId:projectId)
// so two runs can't race on fs.mkdir/git clone into the same managed
// workspace directory. Mirrors the agent-start-lock.ts pattern (SSO-13618/
// SSO-13621) — it cannot protect against destructive git commands issued
// mid-run by the agent's own shell, only the initial provisioning step.
const WORKSPACE_PROVISION_LOCK_STALE_MS = 30_000;
const provisionLocksByKey = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForWorkspaceProvisionLock(
  key: string,
  lock: { promise: Promise<void>; startedAtMs: number },
) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = WORKSPACE_PROVISION_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ key, staleMs: elapsedMs }, "workspace provision lock stale; continuing provisioning");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn(
      { key, staleMs: WORKSPACE_PROVISION_LOCK_STALE_MS },
      "workspace provision lock timed out; continuing provisioning",
    );
  }
}

export async function withWorkspaceProvisionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = provisionLocksByKey.get(key);
  const waitForPrevious = previous ? waitForWorkspaceProvisionLock(key, previous) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  provisionLocksByKey.set(key, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (provisionLocksByKey.get(key)?.promise === marker) {
      provisionLocksByKey.delete(key);
    }
  }
}
