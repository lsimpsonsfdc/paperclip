import { and, eq, desc, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  reviewerDispositions,
  reviewerDispositionRoleSettings,
  approvals,
  issueApprovals,
} from "@paperclipai/db";
import {
  mapReviewerDisposition,
  resolveDefaultPhaseBBlockingEnabled,
  type ReviewerDisposition,
} from "@paperclipai/shared";

/**
 * Resolve the effective phase_b_blocking_enabled flag for an agent identity
 * within a company: an explicit company-scoped override row wins, otherwise
 * fall back to the hardcoded rollout default (see DEFAULT_PHASE_B_BLOCKING_ENABLED).
 */
async function resolvePhaseBBlockingEnabled(db: Db, companyId: string, agentNameKey: string): Promise<boolean> {
  const [row] = await db
    .select({ phaseBBlockingEnabled: reviewerDispositionRoleSettings.phaseBBlockingEnabled })
    .from(reviewerDispositionRoleSettings)
    .where(
      and(
        eq(reviewerDispositionRoleSettings.companyId, companyId),
        eq(reviewerDispositionRoleSettings.agentNameKey, agentNameKey),
      ),
    )
    .limit(1);
  if (row) return row.phaseBBlockingEnabled;
  return resolveDefaultPhaseBBlockingEnabled(agentNameKey);
}

export function reviewerDispositionService(db: Db) {
  return {
    resolvePhaseBBlockingEnabled: (companyId: string, agentNameKey: string) =>
      resolvePhaseBBlockingEnabled(db, companyId, agentNameKey),

    setPhaseBBlockingEnabled: async (input: {
      companyId: string;
      agentNameKey: string;
      phaseBBlockingEnabled: boolean;
      updatedByUserId: string | null;
    }) => {
      const now = new Date();
      const [row] = await db
        .insert(reviewerDispositionRoleSettings)
        .values({
          companyId: input.companyId,
          agentNameKey: input.agentNameKey,
          phaseBBlockingEnabled: input.phaseBBlockingEnabled,
          updatedByUserId: input.updatedByUserId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [reviewerDispositionRoleSettings.companyId, reviewerDispositionRoleSettings.agentNameKey],
          set: {
            phaseBBlockingEnabled: input.phaseBBlockingEnabled,
            updatedByUserId: input.updatedByUserId,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    /**
     * Single indexed lookup by issueId (unique index reviewer_dispositions_issue_uq).
     * Used by the PATCH /issues/:id guard on the hot, shared status->done path.
     */
    getLatestForIssue: async (issueId: string) =>
      db
        .select()
        .from(reviewerDispositions)
        .where(eq(reviewerDispositions.issueId, issueId))
        .limit(1)
        .then((rows) => rows[0] ?? null),

    /**
     * Compute the disposition via the eval-spec mapper and upsert the single
     * latest-disposition row for the issue (one row per issue).
     */
    recordDisposition: async (input: {
      companyId: string;
      issueId: string;
      agentNameKey: string;
      agentRole: string | null;
      verdict: "pass" | "fail";
      blocking: boolean;
      failingCheckIds: string[];
      checkKind: string | null;
      createdByAgentId: string | null;
    }): Promise<{ disposition: ReviewerDisposition; row: typeof reviewerDispositions.$inferSelect }> => {
      // Executive roles are never gated (mapReviewerDisposition ignores the flag for
      // them regardless), so skip the flag lookup entirely for that case.
      const isExemptRole = input.agentRole === "ceo" || input.agentRole === "cto";
      const phaseBBlockingEnabled = isExemptRole
        ? false
        : await resolvePhaseBBlockingEnabled(db, input.companyId, input.agentNameKey);

      const disposition = mapReviewerDisposition({
        agentRole: input.agentRole,
        verdict: input.verdict,
        blocking: input.blocking,
        phaseBBlockingEnabled,
      });

      const now = new Date();
      const [row] = await db
        .insert(reviewerDispositions)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          agentNameKey: input.agentNameKey,
          disposition,
          failingCheckIds: input.failingCheckIds,
          checkKind: input.checkKind,
          createdByAgentId: input.createdByAgentId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [reviewerDispositions.issueId],
          set: {
            agentNameKey: input.agentNameKey,
            disposition,
            failingCheckIds: input.failingCheckIds,
            checkKind: input.checkKind,
            createdByAgentId: input.createdByAgentId,
            updatedAt: now,
          },
        })
        .returning();

      return { disposition, row };
    },

    /**
     * True when an *approved* override_deterministic_block approval linked to
     * this issue was decided at/after the disposition's timestamp — i.e. the
     * override was granted to clear this specific block, not a stale earlier one.
     */
    hasActiveOverrideApproval: async (issueId: string, sinceDecidedAtOrAfter: Date): Promise<boolean> => {
      const [row] = await db
        .select({ id: approvals.id })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.issueId, issueId),
            eq(approvals.type, "override_deterministic_block"),
            eq(approvals.status, "approved"),
            gte(approvals.decidedAt, sinceDecidedAtOrAfter),
          ),
        )
        .orderBy(desc(approvals.decidedAt))
        .limit(1);
      if (!row) return false;
      return true;
    },
  };
}

export type ReviewerDispositionService = ReturnType<typeof reviewerDispositionService>;
