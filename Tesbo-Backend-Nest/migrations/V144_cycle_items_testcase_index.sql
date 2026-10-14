-- Reports (coverage by suite, untested P1, suite health, the traceability matrix) all ask "what runs and
-- executions does THIS test case have", i.e. cycle_items by testcase_id. The only cycle_items indexes lead
-- with cycle_id, so each of those lookups scanned the whole table (~700k rows on the largest tenant) once
-- per test case and tripped the statement timeout. Additive; no data touched.
CREATE INDEX IF NOT EXISTS idx_cycle_items_testcase ON cycle_items (testcase_id);
