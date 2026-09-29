-- The per-request Zyra trace (what the request actually gathered, decided and did — see
-- src/legacy/zyra-turn-trace.ts), persisted so a reload, a second tab, the chat history and API
-- callers all see it rather than only the tab whose live progress stream happened to attach. Lives
-- on the user message that asked for it (written step by step while the turn runs), or on an
-- assistant message that answers no user message of its own (a plan batch, a resumed turn).
-- Nullable, no backfill: older messages simply have no trace.
ALTER TABLE zyra_chat_messages
  ADD COLUMN IF NOT EXISTS trace JSONB;

-- Heartbeat for a Continue resume. A resume whose process died left its message 'resuming'
-- forever, with nothing to settle it; a lapsed heartbeat now lets it read as timed_out (and be
-- claimed again). NULL for rows written before this, which are left as they are.
ALTER TABLE zyra_chat_messages
  ADD COLUMN IF NOT EXISTS resuming_since TIMESTAMPTZ;

-- Owner of the session's processing claim. Releases are owner-only, so a turn whose claim was taken
-- over can never clear the claim of the turn that took it.
ALTER TABLE zyra_chat_sessions
  ADD COLUMN IF NOT EXISTS processing_token UUID;
