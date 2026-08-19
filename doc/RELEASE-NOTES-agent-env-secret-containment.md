# Release Notes — Agent environment secret containment

Source issue: SSO-22654. Parent: SSO-22642.

## BREAKING — `PAPERCLIP_AGENT_JWT_SECRET` is now required where it used to be optional

Paperclip used to sign agent run JWTs with `PAPERCLIP_AGENT_JWT_SECRET` **or**, if that
was unset, fall back to `BETTER_AUTH_SECRET`. That fallback shared one key between two
different trust domains: human web sessions and agent run identity. It is gone.

**Who is affected:** any deployment running in `authenticated` mode that set
`BETTER_AUTH_SECRET` and never set `PAPERCLIP_AGENT_JWT_SECRET`. On upgrade the server
**refuses to boot** with an error naming the variable and the fix.

**Upgrade step:**

```sh
# generate a value distinct from BETTER_AUTH_SECRET
openssl rand -hex 32
# set it in the instance environment, then restart
PAPERCLIP_AGENT_JWT_SECRET=<generated value>
```

Leave `BETTER_AUTH_SECRET` in place — it still signs web sessions. `paperclipai check`
now fails preflight with the same message, so the misconfiguration surfaces before a
restart. Deployments that set neither variable are unchanged: agent-JWT minting stays
disabled and the API-key path keeps working.

Updated deployment recipes: `doc/DOCKER.md`, `.env.example`,
`docker/docker-compose.yml`, `docker/docker-compose.quickstart.yml`,
`docker/ecs-task-definition.json`.

## Platform signing secrets no longer reach agent processes

Every local adapter used to build its child environment by hand
(`{ ...process.env, ...env }` — 26 independent copies), so anything in the Paperclip
server environment landed in every agent process on every run. An `env` or `printenv`
in a transcript was enough to disclose the platform signing secrets.

All of those constructions now route through a single exported chokepoint,
`buildInheritedAgentEnv()` in `packages/adapter-utils/src/server-utils.ts`, which drops:

- `PAPERCLIP_AGENT_JWT_SECRET`
- `BETTER_AUTH_SECRET`
- `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`

Provider credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GEMINI_API_KEY`,
…) are still inherited: the polarity is a reviewed deny-list, not an allowlist, because
local adapters authenticate with those. A regression test per local adapter asserts both
halves — the secrets are absent from the child environment *and* a run still completes —
and a drift test fails the build when a new sensitive-shaped key reaches a child
environment without being added to a reviewed, commented inheritance list.

### What this does not close

This closes the **accidental** propagation path. It does not close the **deliberate**
one: an agent process still shares the host's user and PID namespace, so a reader inside
it can reach `/proc/1/environ` or the host `.env` file and recover all three values. uid
and PID-namespace separation is tracked separately (SSO-22650) and requires a Board
decision. Treat the rotation of these three values as necessary regardless.
