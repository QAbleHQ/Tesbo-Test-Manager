-- Removing the "minimum" (1-3) Zyra testcase-range tier. Existing projects that had it
-- explicitly selected move to "1-10", the nearest surviving tier -- not to the new "30-50"
-- default, since that default only applies to projects that never set this at all.
UPDATE projects
SET settings = jsonb_set(settings, '{zyraAgent,testcaseRange}', '"1-10"')
WHERE settings->'zyraAgent'->>'testcaseRange' = 'minimum';
