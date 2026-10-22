-- Bug due date ("[Bug] Need due date field for Bugs"): an optional calendar date a bug should be
-- resolved by. A DATE, not a timestamp — a due date is a day, and storing a time of day would make
-- "overdue" depend on whichever timezone wrote it. NULL = no due date (every existing bug).

ALTER TABLE bugs ADD COLUMN IF NOT EXISTS due_date DATE;
