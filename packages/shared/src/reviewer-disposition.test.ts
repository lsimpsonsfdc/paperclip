import { describe, expect, it } from "vitest";
import {
  mapReviewerDisposition,
  resolveDefaultPhaseBBlockingEnabled,
  DEFAULT_PHASE_B_BLOCKING_ENABLED,
} from "./reviewer-disposition.js";

describe("mapReviewerDisposition", () => {
  it("stays advisory for a PASS verdict regardless of role or flag", () => {
    expect(
      mapReviewerDisposition({ agentRole: "engineer", verdict: "pass", blocking: true, phaseBBlockingEnabled: true }),
    ).toBe("advisory");
  });

  it("stays advisory for a non-blocking FAIL regardless of role or flag", () => {
    expect(
      mapReviewerDisposition({ agentRole: "engineer", verdict: "fail", blocking: false, phaseBBlockingEnabled: true }),
    ).toBe("advisory");
  });

  it("maps a blocking FAIL to block_done for a flagged-on engineer role (NexisMaintainer)", () => {
    expect(
      mapReviewerDisposition({ agentRole: "engineer", verdict: "fail", blocking: true, phaseBBlockingEnabled: true }),
    ).toBe("block_done");
  });

  it("keeps a blocking FAIL advisory for an engineer role when the flag is off (GeneralCoder default)", () => {
    expect(
      mapReviewerDisposition({ agentRole: "engineer", verdict: "fail", blocking: true, phaseBBlockingEnabled: false }),
    ).toBe("advisory");
  });

  it.each(["ceo", "cto", "CEO", "CTO"])(
    "never gates role=%s even when phaseBBlockingEnabled is true",
    (agentRole) => {
      expect(
        mapReviewerDisposition({ agentRole, verdict: "fail", blocking: true, phaseBBlockingEnabled: true }),
      ).toBe("advisory");
    },
  );

  it("treats a null/undefined role as non-exempt (falls through to the flag)", () => {
    expect(
      mapReviewerDisposition({ agentRole: null, verdict: "fail", blocking: true, phaseBBlockingEnabled: true }),
    ).toBe("block_done");
    expect(
      mapReviewerDisposition({ agentRole: undefined, verdict: "fail", blocking: true, phaseBBlockingEnabled: false }),
    ).toBe("advisory");
  });
});

describe("resolveDefaultPhaseBBlockingEnabled", () => {
  it("defaults NexisMaintainer to true", () => {
    expect(resolveDefaultPhaseBBlockingEnabled("nexismaintainer")).toBe(true);
    expect(DEFAULT_PHASE_B_BLOCKING_ENABLED.nexismaintainer).toBe(true);
  });

  it("defaults GeneralCoder to false", () => {
    expect(resolveDefaultPhaseBBlockingEnabled("generalcoder")).toBe(false);
  });

  it("defaults every other agent identity to false", () => {
    expect(resolveDefaultPhaseBBlockingEnabled("driftwatcher")).toBe(false);
    expect(resolveDefaultPhaseBBlockingEnabled("some-random-agent")).toBe(false);
    expect(resolveDefaultPhaseBBlockingEnabled("")).toBe(false);
  });
});
