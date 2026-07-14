import { pgTable, uuid, text, timestamp, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Company-scoped, per-agent-identity override of the Phase B blocking gate
// (see packages/shared/src/reviewer-disposition.ts DEFAULT_PHASE_B_BLOCKING_ENABLED).
// Modeled after plugin_company_settings.ts: this handler is shared across every
// company on the instance, so the flag must never live in a global/env var.
export const reviewerDispositionRoleSettings = pgTable(
  "reviewer_disposition_role_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentNameKey: text("agent_name_key").notNull(),
    phaseBBlockingEnabled: boolean("phase_b_blocking_enabled").notNull().default(false),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRoleUq: uniqueIndex("reviewer_disposition_role_settings_company_role_uq").on(
      table.companyId,
      table.agentNameKey,
    ),
    companyIdx: index("reviewer_disposition_role_settings_company_idx").on(table.companyId),
  }),
);
