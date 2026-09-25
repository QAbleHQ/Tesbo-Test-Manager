-- Tracks how many times, in a row, a resume of the SAME logical Zyra chat turn has itself timed
-- out or failed. continueZyraChatMessage uses this to stop silently offering an identical-size
-- Continue forever and instead surface a narrowed-batch suggestion after repeated failures.
ALTER TABLE zyra_chat_messages ADD COLUMN resume_attempt INTEGER NOT NULL DEFAULT 0;
