import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateChild = vi.fn();

vi.mock("./issues.js", () => ({
  issueService: () => ({
    createChild: mockCreateChild,
  }),
}));

type SelectRow = Record<string, unknown>;

function createSelectChain(rows: SelectRow[]) {
  return {
    from() {
      return {
        where() {
          return {
            then(callback: (rows: SelectRow[]) => unknown) {
              return Promise.resolve(callback(rows));
            },
          };
        },
      };
    },
  };
}

function createFakeDb(args: {
  interactionRow: Record<string, unknown>;
  parentRows?: SelectRow[];
}) {
  let interactionRow = { ...args.interactionRow };
  const issueTouches: Array<Record<string, unknown>> = [];
  const interactionUpdates: Array<Record<string, unknown>> = [];
  let selectCallCount = 0;

  const db: any = {
    select: vi.fn(() => {
      selectCallCount += 1;
      return createSelectChain(selectCallCount === 1 ? [interactionRow] : (args.parentRows ?? []));
    }),
    update: vi.fn((table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where() {
            if ("status" in values || "result" in values || "resolvedAt" in values) {
              interactionUpdates.push(values);
              interactionRow = { ...interactionRow, ...values };
              return {
                returning: async () => [interactionRow],
              };
            }
            if ("updatedAt" in values) {
              issueTouches.push(values);
              return Promise.resolve(undefined);
            }
            throw new Error(`Unexpected update target: ${String(table)}`);
          },
        };
      },
    })),
    insert: vi.fn(),
    transaction: async (callback: (tx: typeof db) => Promise<void>) => callback(db),
  };

  return {
    db,
    getInteractionRow: () => interactionRow,
    issueTouches,
    interactionUpdates,
  };
}

describe("issueThreadInteractionService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("create reuses an existing interaction for the same idempotency key", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const existingRow = {
      id: "interaction-1",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "suggest_tasks",
      status: "pending",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "run-1:suggest",
      sourceCommentId: null,
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };

    const db: any = {
      select: vi.fn(() => createSelectChain([existingRow])),
      insert: vi.fn(),
      update: vi.fn(),
    };

    const svc = issueThreadInteractionService(db as never);
    const created = await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "suggest_tasks",
      idempotencyKey: "run-1:suggest",
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    }, {
      agentId: "agent-1",
    });

    expect(created.id).toBe("interaction-1");
    expect(created.idempotencyKey).toBe("run-1:suggest");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("answerQuestions normalizes duplicate option ids and persists answered results", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const interactionRow = {
      id: "interaction-2",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      sourceCommentId: null,
      sourceRunId: null,
      title: null,
      summary: null,
      createdByAgentId: null,
      createdByUserId: "local-board",
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        questions: [
          {
            id: "scope",
            prompt: "Pick one scope",
            selectionMode: "single",
            required: true,
            options: [
              { id: "phase-1", label: "Phase 1" },
              { id: "phase-2", label: "Phase 2" },
            ],
          },
          {
            id: "extras",
            prompt: "Pick extras",
            selectionMode: "multi",
            options: [
              { id: "tests", label: "Tests" },
              { id: "docs", label: "Docs" },
            ],
          },
        ],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);

    const result = await svc.answerQuestions({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, "interaction-2", {
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests", "docs"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    }, {
      userId: "local-board",
    });

    expect(result.status).toBe("answered");
    expect(result.result).toEqual({
      version: 1,
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    });
    expect(state.interactionUpdates).toHaveLength(1);
    expect(state.issueTouches).toHaveLength(1);
  });

  describe("withdrawInteraction", () => {
    const ISSUE = { id: "11111111-1111-4111-8111-111111111111", companyId: "company-1" };
    const CREATOR_AGENT_ID = "33333333-3333-4333-8333-333333333333";
    const PEER_AGENT_ID = "44444444-4444-4444-8444-444444444444";

    function confirmationRow(overrides: Record<string, unknown> = {}) {
      return {
        id: "interaction-9",
        companyId: ISSUE.companyId,
        issueId: ISSUE.id,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: null,
        title: "Ship it?",
        summary: null,
        createdByAgentId: CREATOR_AGENT_ID,
        createdByUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: null,
        payload: { version: 1, prompt: "Ship it?" },
        result: null,
        resolvedAt: null,
        createdAt: new Date("2026-04-20T10:00:00.000Z"),
        updatedAt: new Date("2026-04-20T10:00:00.000Z"),
        ...overrides,
      };
    }

    it("lets the creating agent withdraw its own pending interaction", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({ interactionRow: confirmationRow() });
      const svc = issueThreadInteractionService(state.db as never);

      const result = await svc.withdrawInteraction(ISSUE, "interaction-9", {
        reason: "Superseded by a newer confirmation.",
      }, { agentId: CREATOR_AGENT_ID });

      // Distinct from `cancelled`: a withdrawal must never read back as an
      // operator decision.
      expect(result.status).toBe("withdrawn");
      expect(result.result).toMatchObject({
        outcome: "retired",
        retirement: {
          version: 1,
          kind: "withdrawn_by_creator",
          reason: "Superseded by a newer confirmation.",
          retiredByAgentId: CREATOR_AGENT_ID,
        },
      });
      expect(state.interactionUpdates).toHaveLength(1);
      expect(state.issueTouches).toHaveLength(1);
    });

    it("rejects an agent withdrawing another agent's interaction", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({ interactionRow: confirmationRow() });
      const svc = issueThreadInteractionService(state.db as never);

      await expect(svc.withdrawInteraction(ISSUE, "interaction-9", {
        reason: "Not mine to withdraw.",
      }, { agentId: PEER_AGENT_ID })).rejects.toMatchObject({ status: 403 });

      expect(state.interactionUpdates).toHaveLength(0);
    });

    it("requires a non-empty reason", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({ interactionRow: confirmationRow() });
      const svc = issueThreadInteractionService(state.db as never);

      await expect(svc.withdrawInteraction(ISSUE, "interaction-9", {
        reason: "   ",
      } as never, { agentId: CREATOR_AGENT_ID })).rejects.toThrow();
      expect(state.interactionUpdates).toHaveLength(0);
    });

    it("refuses to withdraw an already-resolved interaction", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({
        interactionRow: confirmationRow({
          status: "accepted",
          result: { version: 1, outcome: "accepted" },
        }),
      });
      const svc = issueThreadInteractionService(state.db as never);

      await expect(svc.withdrawInteraction(ISSUE, "interaction-9", {
        reason: "Too late.",
      }, { agentId: CREATOR_AGENT_ID })).rejects.toMatchObject({ status: 409 });

      expect(state.interactionUpdates).toHaveLength(0);
    });

    it("preserves partial verdicts when retiring an item-verdicts interaction", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const items = [{
        id: "docs",
        verdict: "approve",
        resolvedByUserId: "local-board",
        resolvedAt: "2026-04-20T11:00:00.000Z",
      }];
      const state = createFakeDb({
        interactionRow: confirmationRow({
          kind: "request_item_verdicts",
          payload: {
            version: 1,
            prompt: "Review these",
            items: [{ id: "docs", label: "Docs" }],
          },
          result: { version: 1, outcome: "resolved", complete: false, items },
        }),
      });
      const svc = issueThreadInteractionService(state.db as never);

      const result = await svc.withdrawInteraction(ISSUE, "interaction-9", {
        reason: "No longer needed.",
      }, { agentId: CREATOR_AGENT_ID });

      expect(result.status).toBe("withdrawn");
      expect(result.result).toMatchObject({ outcome: "retired", items });
    });
  });
});
