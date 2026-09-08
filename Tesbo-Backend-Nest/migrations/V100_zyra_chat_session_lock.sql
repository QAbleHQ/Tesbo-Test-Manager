-- sendZyraChatMessage has no concurrency control: two overlapping requests for the same session
-- (a double-click on "yes", a client retry after a slow reply, two open tabs) each read the same
-- active_plan/history state independently and each write their own assistant message, racing each
-- other with no serialization. This column lets the start of a turn atomically claim the session
-- (UPDATE ... WHERE processing_since IS NULL ... RETURNING) and the end of the turn release it; a
-- second concurrent request sees 0 rows returned and is rejected with a clear "still processing"
-- error instead of racing the first. The 5-minute staleness window (checked alongside this column,
-- not stored separately) means a request that crashed before releasing the claim self-heals instead
-- of locking the session out permanently.

ALTER TABLE zyra_chat_sessions
  ADD COLUMN IF NOT EXISTS processing_since TIMESTAMPTZ;
