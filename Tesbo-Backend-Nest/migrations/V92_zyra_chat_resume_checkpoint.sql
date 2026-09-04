-- No outbound AI-provider call in the Zyra chat flow carried a timeout, so a stalled provider left
-- the request open indefinitely — no reply, no error, the chat's "thinking" state stuck forever.
-- That is indistinguishable from "Zyra doesn't respond" as reported. A bounded timeout now exists
-- (see ZYRA_ROUTER_TIMEOUT_MS / ZYRA_GENERATE_TIMEOUT_MS in legacy.service.ts), and this column is
-- what lets a timed-out turn be resumed instead of just failed: it carries the minimum state needed
-- to pick the SAME turn back up — skipping whatever already succeeded (e.g. the routing decision) —
-- rather than asking the user to repeat themselves or silently re-running the whole thing.
--
-- Read/written only by sendZyraChatMessage / continueZyraChatMessage; never returned by
-- GET .../chat/sessions/:id (see zyraChatSession's explicit column list) since the frontend only
-- ever needs the message's `status` to know whether to offer Continue.
ALTER TABLE zyra_chat_messages
  ADD COLUMN IF NOT EXISTS resume_checkpoint JSONB;
