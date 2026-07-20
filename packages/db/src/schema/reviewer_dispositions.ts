import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

// One row per issue: the latest Reviewer disposition computed by the eval-spec
// mapper (see packages/shared/src/reviewer-disposition.ts). Rows are upserted
// (never accumulated) so the PATCH /issues/:id guard can resolve the current
// state with a single indexed lookup by issueId.
export const reviewerDispositions = pgTable(
  "reviewer_dispositions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    // Normalized agent name key (see packages/shared/src/agent-url-key.ts) of the
    // agent whose work was reviewed, e.g. "nexismaintainer", "generalcoder", "cto".
    agentNameKey: text("agent_name_key").notNull(),
    disposition: text("disposition").notNull(),
    failingCheckIds: jsonb("failing_check_ids").$type<string[]>().notNull().default([]),
    checkKind: text("check_kind"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueUq: uniqueIndex("reviewer_dispositions_issue_uq").on(table.issueId),
    companyIdx: index("reviewer_dispositions_company_idx").on(table.companyId),
    dispositionCheck: check(
      "reviewer_dispositions_disposition_check",
      sql`${table.disposition} in ('block_done', 'advisory')`,
    ),
  }),
);
