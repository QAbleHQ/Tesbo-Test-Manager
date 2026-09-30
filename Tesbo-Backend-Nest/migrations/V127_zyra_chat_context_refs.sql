-- Which sources (Jira ticket keys, knowledge-base citations, bug ids) an assistant chat
-- turn resolved, by reference only. Read by the NEXT turn in the same session so a follow-up that
-- names nothing itself ("yes", "generate them") keeps the subject the previous turn identified —
-- every lookup is otherwise keyed on the current message alone, which is how a draft built from a
-- ticket Zyra had just discussed came back with "No specific source cited".
--
-- Nullable with no backfill: rows written before this, and plan progress messages, carry no refs and
-- are simply skipped when looking for the previous turn's context. Never returned to the frontend.
ALTER TABLE zyra_chat_messages
  ADD COLUMN IF NOT EXISTS context_refs JSONB;
