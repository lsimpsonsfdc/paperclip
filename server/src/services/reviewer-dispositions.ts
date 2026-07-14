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

async function getLatestForIssue(db: Db, issueId: string) {
  return db
    .select()
    .from(reviewerDispositions)
    .where(eq(reviewerDispositions.issueId, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * True when an *approved* override_deterministic_block approval linked to
 * this issue was decided at/after the disposition's timestamp — i.e. the
 * override was granted to clear this specific block, not a stale earlier one.
 */
async function hasActiveOverrideApproval(db: Db, issueId: string, sinceDecidedAtOrAfter: Date): Promise<boolean> {
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
}

export type ReviewerDispositionTransitionCheck =
  | { blocked: false }
  | { blocked: true; disposition: typeof reviewerDispositions.$inferSelect };

/**
 * SSO-13507: the choke-point version of the block_done check, extracted so it
 * can be enforced from every write path that can set an issue's status to
 * "done" (PATCH /issues/:id, the comment auto-approval branch, the recovery
 * watchdog fold, etc.) instead of living only at one route call site.
 *
 * Fail-mode: on a disposition-lookup error, this throws (fail-closed) rather
 * than silently allowing the transition — see assertNoBlockingReviewerDisposition
 * in server/src/routes/issues.ts for the full rationale.
 */
export async function checkBlockingDispositionForDoneTransition(
  db: Db,
  issue: { id: string; companyId: string },
): Promise<ReviewerDispositionTransitionCheck> {
  const disposition = await getLatestForIssue(db, issue.id);
  if (!disposition || disposition.disposition !== "block_done") return { blocked: false };

  // Live re-check (not the value captured at write time) so a CEO-callable
  // kill-switch flip immediately unblocks issues without needing a per-issue
  // override approval.
  const stillEnabled = await resolvePhaseBBlockingEnabled(db, issue.companyId, disposition.agentNameKey);
  if (!stillEnabled) return { blocked: false };

  if (await hasActiveOverrideApproval(db, issue.id, disposition.updatedAt)) {
    return { blocked: false };
  }

  return { blocked: true, disposition };
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
    getLatestForIssue: (issueId: string) => getLatestForIssue(db, issueId),

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

    hasActiveOverrideApproval: (issueId: string, sinceDecidedAtOrAfter: Date) =>
      hasActiveOverrideApproval(db, issueId, sinceDecidedAtOrAfter),

    /**
     * SSO-13507 choke-point check — see checkBlockingDispositionForDoneTransition.
     */
    checkBlockingDispositionForDoneTransition: (issue: { id: string; companyId: string }) =>
      checkBlockingDispositionForDoneTransition(db, issue),
  };
}

export type ReviewerDispositionService = ReturnType<typeof reviewerDispositionService>;
