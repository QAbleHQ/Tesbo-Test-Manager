-- Severity becomes optional, the same as priority (V83).
--
-- "Priority and Severity Should Display 'Select' by Default When Logging a New Bug": severity was
-- NOT NULL DEFAULT 'Medium', so a bug filed without anyone choosing a severity was stored as Medium
-- and then shown as Medium everywhere — indistinguishable from a reporter who actually judged it so.
-- NULL now means "not selected", exactly as it already does for priority.
--
-- Existing rows keep the severity they have; there is no way to tell a chosen Medium from a defaulted
-- one after the fact, so nothing is rewritten. bugs_severity_check (V67) still holds: a CHECK passes
-- on NULL, so it only ever constrains a value that is present.
ALTER TABLE bugs ALTER COLUMN severity DROP DEFAULT;
ALTER TABLE bugs ALTER COLUMN severity DROP NOT NULL;
