-- Per-test-case citations: which knowledge-base doc/file, Jira ticket, existing test case, or bug
-- actually informed a Zyra-generated test case. Additive and backward compatible — every existing
-- row (and every non-Zyra creation path: import, bulk create, manual UI create) defaults to an
-- empty array and is never required to populate it.
ALTER TABLE testcases ADD COLUMN IF NOT EXISTS source_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
