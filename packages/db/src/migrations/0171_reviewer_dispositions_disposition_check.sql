DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reviewer_dispositions_disposition_check'
  ) THEN
    ALTER TABLE "reviewer_dispositions"
      ADD CONSTRAINT "reviewer_dispositions_disposition_check"
      CHECK ("disposition" in ('block_done', 'advisory'));
  END IF;
END $$;
