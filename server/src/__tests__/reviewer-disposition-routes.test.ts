import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issues,
  reviewerDispositionRoleSettings,
  reviewerDispositions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reviewer-disposition route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function agentActor(agentId: string, companyId: string, runId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use("/api", approvalRoutes(db));
  app.use(errorHandler);
  return app;
}

async function seedFixture(db: Db) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db
    .insert(companies)
    .values({ name: `RD ${nonce}`, issuePrefix: `RD${nonce.slice(0, 4).toUpperCase()}` })
    .returning();

  const makeAgent = async (name: string, role: string) => {
    const [row] = await db
      .insert(agents)
      .values({ companyId: company!.id, name, role, adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company!.id, agentId: row!.id, status: "running" })
      .returning();
    return { agent: row!, runId: run!.id };
  };

  const nexisMaintainer = await makeAgent("NexisMaintainer", "engineer");
  const generalCoder = await makeAgent("GeneralCoder", "engineer");
  const cto = await makeAgent("CTO", "cto");

  const makeIssue = async (title: string, assigneeAgentId: string) => {
    const [row] = await db
      .insert(issues)
      .values({
        companyId: company!.id,
        title,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId,
      })
      .returning();
    return row!;
  };

  const nmIssue = await makeIssue("NexisMaintainer task", nexisMaintainer.agent.id);
  const gcIssue = await makeIssue("GeneralCoder task", generalCoder.agent.id);
  const ctoIssue = await makeIssue("CTO task", cto.agent.id);
  const unaffectedIssue = await makeIssue("Unaffected task", nexisMaintainer.agent.id);

  return { company: company!, agents: { nexisMaintainer, generalCoder, cto }, issues: { nmIssue, gcIssue, ctoIssue, unaffectedIssue } };
}

describeEmbeddedPostgres("reviewer disposition PATCH guard + override approval", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reviewer-disposition-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(reviewerDispositions);
    await db.delete(reviewerDispositionRoleSettings);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function submitDisposition(
    fixture: Fixture,
    issueId: string,
    body: { checkId: string; checkKind?: string; verdict: "pass" | "fail"; blocking: boolean },
  ) {
    const app = createApp(db, agentActor(fixture.agents.nexisMaintainer.agent.id, fixture.company.id, fixture.agents.nexisMaintainer.runId));
    return request(app).post(`/api/issues/${issueId}/reviewer-dispositions`).send(body);
  }

  it("maps a blocking FAIL to block_done for NexisMaintainer and blocks the done transition", async () => {
    const fixture = await seedFixture(db);
    const submit = await submitDisposition(fixture, fixture.issues.nmIssue.id, {
      checkId: "check-1",
      checkKind: "[deterministic] blocking",
      verdict: "fail",
      blocking: true,
    });
    expect(submit.status, JSON.stringify(submit.body)).toBe(201);
    expect(submit.body.disposition).toBe("block_done");

    const app = createApp(db, agentActor(fixture.agents.nexisMaintainer.agent.id, fixture.company.id, fixture.agents.nexisMaintainer.runId));
    const patch = await request(app)
      .patch(`/api/issues/${fixture.issues.nmIssue.id}`)
      .send({ status: "done" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(403);
    expect(patch.body.failingCheckId).toEqual(["check-1"]);
  });

  it("clears the block once an approved override_deterministic_block approval is linked", async () => {
    const fixture = await seedFixture(db);
    await submitDisposition(fixture, fixture.issues.nmIssue.id, {
      checkId: "check-2",
      checkKind: "[deterministic] blocking",
      verdict: "fail",
      blocking: true,
    });

    const boardApp = createApp(db, boardActor(fixture.company.id));
    const createApproval = await request(boardApp)
      .post(`/api/companies/${fixture.company.id}/approvals`)
      .send({ type: "override_deterministic_block", payload: { reason: "operator override" }, issueIds: [fixture.issues.nmIssue.id] });
    expect(createApproval.status, JSON.stringify(createApproval.body)).toBe(201);

    const approveRes = await request(boardApp)
      .post(`/api/approvals/${createApproval.body.id}/approve`)
      .send({});
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);

    const agentApp = createApp(db, agentActor(fixture.agents.nexisMaintainer.agent.id, fixture.company.id, fixture.agents.nexisMaintainer.runId));
    const patch = await request(agentApp)
      .patch(`/api/issues/${fixture.issues.nmIssue.id}`)
      .send({ status: "done" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.status).toBe("done");
  });

  it("rejects agent-created override_deterministic_block approvals (board-only)", async () => {
    const fixture = await seedFixture(db);
    const agentApp = createApp(db, agentActor(fixture.agents.nexisMaintainer.agent.id, fixture.company.id, fixture.agents.nexisMaintainer.runId));
    const res = await request(agentApp)
      .post(`/api/companies/${fixture.company.id}/approvals`)
      .send({ type: "override_deterministic_block", payload: {}, issueIds: [fixture.issues.nmIssue.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("keeps CEO/CTO dispositions advisory and never blocks their done transition", async () => {
    const fixture = await seedFixture(db);
    const submit = await submitDisposition(fixture, fixture.issues.ctoIssue.id, {
      checkId: "check-3",
      checkKind: "[deterministic] blocking",
      verdict: "fail",
      blocking: true,
    });
    expect(submit.body.disposition).toBe("advisory");

    const app = createApp(db, agentActor(fixture.agents.cto.agent.id, fixture.company.id, fixture.agents.cto.runId));
    const patch = await request(app).patch(`/api/issues/${fixture.issues.ctoIssue.id}`).send({ status: "done" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
  });

  it("keeps GeneralCoder advisory by default (flag off) and does not block done", async () => {
    const fixture = await seedFixture(db);
    const submit = await submitDisposition(fixture, fixture.issues.gcIssue.id, {
      checkId: "check-4",
      checkKind: "[deterministic] blocking",
      verdict: "fail",
      blocking: true,
    });
    expect(submit.body.disposition).toBe("advisory");

    const app = createApp(db, agentActor(fixture.agents.generalCoder.agent.id, fixture.company.id, fixture.agents.generalCoder.runId));
    const patch = await request(app).patch(`/api/issues/${fixture.issues.gcIssue.id}`).send({ status: "done" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
  });

  it("a CEO-callable kill-switch flip (flag off) unblocks an existing block_done issue without an override approval", async () => {
    const fixture = await seedFixture(db);
    await submitDisposition(fixture, fixture.issues.nmIssue.id, {
      checkId: "check-5",
      checkKind: "[deterministic] blocking",
      verdict: "fail",
      blocking: true,
    });

    const app = createApp(db, agentActor(fixture.agents.nexisMaintainer.agent.id, fixture.company.id, fixture.agents.nexisMaintainer.runId));
    const blockedPatch = await request(app).patch(`/api/issues/${fixture.issues.nmIssue.id}`).send({ status: "done" });
    expect(blockedPatch.status).toBe(403);

    await db.insert(reviewerDispositionRoleSettings).values({
      companyId: fixture.company.id,
      agentNameKey: "nexismaintainer",
      phaseBBlockingEnabled: false,
      updatedByUserId: "board-user",
    });

    const patchAfterKillSwitch = await request(app).patch(`/api/issues/${fixture.issues.nmIssue.id}`).send({ status: "done" });
    expect(patchAfterKillSwitch.status, JSON.stringify(patchAfterKillSwitch.body)).toBe(200);
  });

  it("regression: an issue with no reviewer_dispositions row is unaffected by the guard", async () => {
    const fixture = await seedFixture(db);
    const app = createApp(db, agentActor(fixture.agents.nexisMaintainer.agent.id, fixture.company.id, fixture.agents.nexisMaintainer.runId));
    const patch = await request(app).patch(`/api/issues/${fixture.issues.unaffectedIssue.id}`).send({ status: "done" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.status).toBe("done");
  });

  it("surfaces the blocking disposition in heartbeat-context so a blocked agent can escalate", async () => {
    const fixture = await seedFixture(db);
    await submitDisposition(fixture, fixture.issues.nmIssue.id, {
      checkId: "check-6",
      checkKind: "[deterministic] blocking",
      verdict: "fail",
      blocking: true,
    });

    const app = createApp(db, agentActor(fixture.agents.nexisMaintainer.agent.id, fixture.company.id, fixture.agents.nexisMaintainer.runId));
    const ctx = await request(app).get(`/api/issues/${fixture.issues.nmIssue.id}/heartbeat-context`);
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200);
    expect(ctx.body.issue.reviewerDisposition).toMatchObject({
      disposition: "block_done",
      failingCheckIds: ["check-6"],
      willBlockDoneTransition: true,
    });
  });
});
