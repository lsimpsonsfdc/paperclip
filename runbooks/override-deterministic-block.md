# Runbook: Overriding a Reviewer `block_done` disposition

Tracks issue SSO-13493 (Phase B blocking-gate infrastructure). Linked from SSO-3071 in the operator's issue tracker.

## What this is

Phase B lets a Reviewer's `[deterministic] blocking` FAIL prevent an issue from being marked `done` (`server/src/routes/issues.ts`, `assertNoBlockingReviewerDisposition`). This is enforced server-side on `PATCH /api/issues/:id` — an agent cannot self-mark an issue done while a `block_done` disposition is active and `phase_b_blocking_enabled` is true for that agent identity in that company.

The only sanctioned bypass is an **approved `override_deterministic_block` approval linked to the specific issue**.

## Who may request/grant this

- **Operator-only, never agent-self-service.** An agent cannot create a pending `override_deterministic_block` approval — `POST /api/companies/:companyId/approvals` rejects this approval type with `403` unless the caller is a board (human) actor. See `server/src/routes/approvals.ts`.
- Approving it also requires a board actor (`assertBoard` on `POST /api/approvals/:id/approve`), matching the standard approval-resolution gate already used for every approval type.
- In practice: a human operator (or the CEO/CTO agent acting *as* a board-authorized requester is still not sufficient — the create call itself must come from a board session) decides the FAIL is a false positive or otherwise acceptable to bypass, and creates + approves the override directly.

## How to grant an override

1. Confirm the blocked issue and the failing check. The blocked agent's heartbeat context (`GET /api/issues/:id/heartbeat-context`) includes an `issue.reviewerDisposition` object with `disposition`, `failingCheckIds`, `checkKind`, and `willBlockDoneTransition` — use this to confirm what's actually blocking before overriding it.
2. As a board user, create the approval linked to the issue:
   ```
   POST /api/companies/{companyId}/approvals
   {
     "type": "override_deterministic_block",
     "payload": { "reason": "<why this FAIL is being overridden>" },
     "issueIds": ["<issue-id>"]
   }
   ```
   This will `403` if attempted by an agent actor.
3. Approve it:
   ```
   POST /api/approvals/{approvalId}/approve
   { "decisionNote": "<optional note>" }
   ```
4. The next `PATCH /api/issues/{issueId}` with `status: "done"` from the previously blocked agent succeeds. No further action is needed — the guard checks for an `approved` `override_deterministic_block` approval linked to the issue, decided at or after the disposition's timestamp.

## Kill switch (first 72h post-enable)

If a burst of false-positive blocking FAILs surfaces, the fastest mitigation is **not** per-issue overrides — it's flipping `phase_b_blocking_enabled` back to `false` for the affected agent identity/company via `reviewer_disposition_role_settings` (see `server/src/services/reviewer-dispositions.ts`, `setPhaseBBlockingEnabled`). The guard re-checks this flag live on every PATCH (not the value captured when the disposition was written), so flipping it off immediately unblocks every issue for that agent identity/company without needing individual override approvals. CEO is the designated agent authorized to call this during the initial rollout window.

## Fail-mode note

If the disposition lookup itself errors (DB unavailable, etc.), the guard fails **closed** — it denies the `done` transition rather than silently allowing it. This is scoped narrowly: only issues that already have a `block_done` row for a flagged-on role are affected; every other PATCH on this shared, multi-tenant endpoint is unaffected. See the PR description for the fail-open alternative that was considered and rejected.
