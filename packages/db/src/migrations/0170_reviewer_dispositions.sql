CREATE TABLE IF NOT EXISTS "reviewer_dispositions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "agent_name_key" text NOT NULL,
  "disposition" text NOT NULL,
  "failing_check_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "check_kind" text,
  "created_by_agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reviewer_disposition_role_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_name_key" text NOT NULL,
  "phase_b_blocking_enabled" boolean DEFAULT false NOT NULL,
  "updated_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reviewer_dispositions_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "reviewer_dispositions"
      ADD CONSTRAINT "reviewer_dispositions_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reviewer_dispositions_issue_id_issues_id_fk'
  ) THEN
    ALTER TABLE "reviewer_dispositions"
      ADD CONSTRAINT "reviewer_dispositions_issue_id_issues_id_fk"
      FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reviewer_disposition_role_settings_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "reviewer_disposition_role_settings"
      ADD CONSTRAINT "reviewer_disposition_role_settings_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reviewer_dispositions_issue_uq" ON "reviewer_dispositions" USING btree ("issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviewer_dispositions_company_idx" ON "reviewer_dispositions" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reviewer_disposition_role_settings_company_role_uq" ON "reviewer_disposition_role_settings" USING btree ("company_id","agent_name_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviewer_disposition_role_settings_company_idx" ON "reviewer_disposition_role_settings" USING btree ("company_id");
