import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import type { StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { issueService } from "./issues.js";

/**
 * An execution stage whose participant is a user assigns the issue but raises
 * nothing the human can act on. `StalledReviewActions` is the only human review
 * UI in the product, so it has to serve that case too — but a pending stage is
 * by definition never "stalled" (it has a participant), so the stalled gate
 * below admits the pending user participant as a second, equally narrow case.
 *
 * A stage decision always carries a body, so an action with no note gets one.
 */
const PARTICIPANT_DECISION_FALLBACK_NOTE: Record<StalledReviewDecisionAction, string> = {
  approve: "Approved from the review queue.",
  request_changes: "Changes requested from the review queue.",
  send_back: "Sent back to work from the review queue.",
};

export interface StalledReviewDecisionActor {
  userId: string;
  runId?: string | null;
}

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  actor: StalledReviewDecisionActor;
}

export function stalledReviewDecisionService(db: Db) {
  return {
    decide: async (input: DecideStalledReviewInput) => db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const lockedIssue = await tx
        .select()
        .from(issues)
        .where(and(
          eq(issues.id, input.issueId),
          eq(issues.companyId, input.companyId),
          visibleIssueCondition(),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);

      if (!lockedIssue) throw notFound("Issue not found");
      if (lockedIssue.status !== "in_review") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          currentStatus: lockedIssue.status,
        });
      }

      const svc = issueService(txDb);
      const executionState = parseIssueExecutionState(lockedIssue.executionState);
      const pendingParticipant =
        executionState?.status === "pending" ? executionState.currentParticipant : null;
      // Only the named participant of the pending stage — never any other board
      // member — so widening the gate grants no principal new authority.
      const decidingAsParticipant =
        pendingParticipant?.type === "user" && pendingParticipant.userId === input.actor.userId;

      const reviewAttention = await svc
        .listReviewAttention(lockedIssue.companyId, [lockedIssue])
        .then((rows) => rows.get(lockedIssue.id));
      if (reviewAttention?.state !== "stalled" && !decidingAsParticipant) {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          reviewAttentionState: reviewAttention?.state ?? "none",
        });
      }

      // The participant path must go through the stage machine, not write a
      // status directly: that is what advances the gate, records the decision,
      // and keeps `completedStageIds` intact.
      const transition = decidingAsParticipant
        ? applyIssueExecutionPolicyTransition({
            issue: lockedIssue,
            policy: normalizeIssueExecutionPolicy(lockedIssue.executionPolicy ?? null),
            requestedStatus: input.action === "approve" ? "done" : "in_progress",
            requestedAssigneePatch: {},
            actor: { agentId: null, userId: input.actor.userId },
            commentBody: input.note?.trim() || PARTICIPANT_DECISION_FALLBACK_NOTE[input.action],
          })
        : null;
      const decisionId = transition?.decision ? randomUUID() : null;
      if (transition && decisionId) {
        const nextExecutionState = transition.patch.executionState;
        if (!nextExecutionState || typeof nextExecutionState !== "object") {
          throw new Error("Execution policy decision patch is missing executionState");
        }
        transition.patch.executionState = { ...nextExecutionState, lastDecisionId: decisionId };
      }

      const commentBody = decidingAsParticipant
        ? input.note?.trim() || PARTICIPANT_DECISION_FALLBACK_NOTE[input.action]
        : input.note;
      const comment = commentBody
        ? await svc.addComment(
            lockedIssue.id,
            commentBody,
            { userId: input.actor.userId, runId: input.actor.runId ?? null },
            { authorType: "user" },
            tx,
          )
        : null;
      const status = transition
        ? (typeof transition.patch.status === "string"
            ? transition.patch.status
            : input.action === "approve" ? "done" : "in_progress")
        : input.action === "approve" ? "done" : "todo";
      const updated = await svc.update(lockedIssue.id, {
        ...(transition?.patch ?? {}),
        status,
        actorUserId: input.actor.userId,
      }, tx);
      if (!updated) throw notFound("Issue not found");

      if (transition?.decision && decisionId) {
        await tx.insert(issueExecutionDecisions).values({
          id: decisionId,
          companyId: updated.companyId,
          issueId: updated.id,
          stageId: transition.decision.stageId,
          stageType: transition.decision.stageType,
          actorAgentId: null,
          actorUserId: input.actor.userId,
          outcome: transition.decision.outcome,
          body: transition.decision.body,
          createdByRunId: input.actor.runId ?? null,
        });
      }

      if (comment) {
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: "user",
          actorId: input.actor.userId,
          runId: input.actor.runId ?? null,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            commentId: comment.id,
            authorUserId: input.actor.userId,
            source: "stalled_review_decision",
          },
        });
      }
      await logActivity(txDb, {
        companyId: updated.companyId,
        actorType: "user",
        actorId: input.actor.userId,
        runId: input.actor.runId ?? null,
        action: "issue.stalled_review_decided",
        entityType: "issue",
        entityId: updated.id,
        issueId: updated.id,
        details: {
          action: input.action,
          status,
          identifier: updated.identifier,
          commentId: comment?.id ?? null,
          authorUserId: comment ? input.actor.userId : null,
          executionStageDecision: decidingAsParticipant,
          executionDecisionId: decisionId,
          _previous: { status: lockedIssue.status },
        },
      });

      return { issue: updated, comment };
    }),
  };
}
