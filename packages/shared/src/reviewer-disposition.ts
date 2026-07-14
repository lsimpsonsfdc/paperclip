import { REVIEWER_DISPOSITION_EXEMPT_AGENT_ROLES, type ReviewerDisposition } from "./constants.js";

/**
 * Default phase_b_blocking_enabled value used when no company-scoped
 * reviewer_disposition_role_settings row exists for an agentNameKey.
 * Rollout defaults per SSO-13489: NexisMaintainer live, GeneralCoder flagged
 * off pending calibration ([SSO-13490]). Every other agent identity defaults
 * to today's advisory-only behavior.
 */
export const DEFAULT_PHASE_B_BLOCKING_ENABLED: Readonly<Record<string, boolean>> = {
  nexismaintainer: true,
  generalcoder: false,
};

export function resolveDefaultPhaseBBlockingEnabled(agentNameKey: string): boolean {
  return DEFAULT_PHASE_B_BLOCKING_ENABLED[agentNameKey] ?? false;
}

export interface MapReviewerDispositionInput {
  /** agents.role column value for the reviewed agent, e.g. "ceo", "cto", "engineer". */
  agentRole: string | null | undefined;
  verdict: "pass" | "fail";
  /** Whether the check is tagged `[deterministic] blocking` (vs. advisory-only). */
  blocking: boolean;
  /** Resolved phase_b_blocking_enabled for (companyId, agentNameKey) at mapping time. */
  phaseBBlockingEnabled: boolean;
}

/**
 * Eval-spec disposition mapper (SSO-13493). Pure function: no DB/IO.
 *
 * - Non-blocking checks and PASS verdicts are always "advisory".
 * - Executive roles (ceo, cto) are always "advisory", regardless of the flag —
 *   this exemption is role-based and cannot be flipped by phase_b_blocking_enabled.
 * - Every other role maps a blocking FAIL to "block_done" only when
 *   phaseBBlockingEnabled is true for that agent identity.
 */
export function mapReviewerDisposition(input: MapReviewerDispositionInput): ReviewerDisposition {
  if (input.verdict !== "fail" || !input.blocking) return "advisory";

  const role = (input.agentRole ?? "").trim().toLowerCase();
  if ((REVIEWER_DISPOSITION_EXEMPT_AGENT_ROLES as readonly string[]).includes(role)) {
    return "advisory";
  }

  return input.phaseBBlockingEnabled ? "block_done" : "advisory";
}
