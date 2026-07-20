# Runbook: Overriding a Reviewer `block_done` disposition

Tracks issue SSO-13493 (Phase B blocking-gate infrastructure) and SSO-13507 (CISO-review remediation of guard bypasses found in SSO-13493).

## What this is

Phase B lets a Reviewer's `[deterministic] blocking` FAIL prevent an issue from being marked `done`. As of SSO-13507, this is enforced at a single choke point — `checkBlockingDispositionForDoneTransition` in `server/src/services/reviewer-dispositions.ts`, called from `issueService.update()` (`server/src/services/issues.ts`) whenever a patch sets `status: "done"` — instead of only at the `PATCH /api/issues/:id` route call site (`assertNoBlockingReviewerDisposition` in `server/src/routes/issues.ts`, which now formats the route's 403 response on top of the same shared check). This means every write path that can set an issue's status to "done" is covered by construction: the PATCH route, the comment auto-approval branch (`POST /issues/:id/comments`), and the recovery watchdog fold (`server/src/services/recovery/service.ts`) all go through it. An agent cannot self-mark an issue done while a `block_done` disposition is active and `phase_b_blocking_enabled` is true for that agent identity in that company.

The only sanctioned bypass is an **approved `override_deterministic_block` approval linked to the specific issue**.

## Who may request/grant this

- **Operator-only, never agent-self-service.** An agent cannot create a pending `override_deterministic_block` approval — `POST /api/companies/:companyId/approvals` rejects this approval type with `403` unless the caller is a board (human) actor. See `server/src/routes/approvals.ts`.
- Approving it also requires a board actor (`assertBoard` on `POST /api/approvals/:id/approve`), matching the standard approval-resolution gate already used for every approval type.
- **Linking an existing approval to an issue is also board-only for this type** (SSO-13507). The generic `POST /issues/:id/approvals` endpoint otherwise allows any `ceo`-role or `canCreateAgents`-permission agent to link an already-approved approval to a new issue; for `override_deterministic_block` specifically, that would let such an agent satisfy the guard on a *different* blocked issue by reusing an override the board granted for another issue, without a fresh board decision. The route now requires a board actor whenever the approval being linked has `type: "override_deterministic_block"`.
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

If a burst of false-positive blocking FAILs surfaces, the fastest mitigation is **not** per-issue overrides — it's flipping `phase_b_blocking_enabled` back to `false` for the affected agent identity/company. The guard re-checks this flag live on every transition to `done` (not the value captured when the disposition was written), so flipping it off immediately unblocks every issue for that agent identity/company without needing individual override approvals.

As of SSO-13507 this is reachable over HTTP (it previously only existed as a DB-level service function with no route, despite this runbook documenting it as callable):

```
POST /api/companies/{companyId}/reviewer-disposition-settings
{
  "agentNameKey": "<normalized agent name key, e.g. \"nexismaintainer\">",
  "phaseBBlockingEnabled": false
}
```

Gated to board users or an agent with `role: "ceo"` in that company (`assertCanManagePhaseBBlockingKillSwitch` in `server/src/routes/issues.ts`) — matching the original design intent that CEO is the designated agent authorized to call this during the initial rollout window. Any other actor gets `403`.

## Fail-mode note

If the disposition lookup itself errors (DB unavailable, etc.), the guard fails **closed** — it denies the `done` transition rather than silently allowing it. This is scoped narrowly: only issues that already have a `block_done` row for a flagged-on role are affected; every other PATCH on this shared, multi-tenant endpoint is unaffected. See the PR description for the fail-open alternative that was considered and rejected.
