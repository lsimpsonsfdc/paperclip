import { describe, expect, it } from "vitest";
import { withWorkspaceProvisionLock } from "../services/workspace-provision-lock.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("withWorkspaceProvisionLock", () => {
  it("serializes concurrent provisioning attempts for the same key", async () => {
    const key = `company-1:project-${Math.random()}`;
    const events: string[] = [];
    const gate = deferred<void>();

    const first = withWorkspaceProvisionLock(key, async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
      return "first";
    });

    // Give the first call a chance to acquire the lock before the second is issued.
    await Promise.resolve();
    await Promise.resolve();

    const second = withWorkspaceProvisionLock(key, async () => {
      events.push("second:start");
      return "second";
    });

    // The second call must not have started while the first is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("runs provisioning for different keys concurrently, not serialized", async () => {
    const events: string[] = [];
    const gateA = deferred<void>();

    const a = withWorkspaceProvisionLock(`company-1:project-a-${Math.random()}`, async () => {
      events.push("a:start");
      await gateA.promise;
      events.push("a:end");
    });

    await Promise.resolve();
    await Promise.resolve();

    const b = withWorkspaceProvisionLock(`company-1:project-b-${Math.random()}`, async () => {
      events.push("b:start");
      events.push("b:end");
    });

    await b;
    expect(events).toEqual(["a:start", "b:start", "b:end"]);

    gateA.resolve();
    await a;
    expect(events).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });

  it("propagates errors from the wrapped function without poisoning subsequent calls", async () => {
    const key = `company-1:project-error-${Math.random()}`;

    await expect(
      withWorkspaceProvisionLock(key, async () => {
        throw new Error("provisioning failed");
      }),
    ).rejects.toThrow("provisioning failed");

    await expect(withWorkspaceProvisionLock(key, async () => "recovered")).resolves.toBe("recovered");
  });
});
