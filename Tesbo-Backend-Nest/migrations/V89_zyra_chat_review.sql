-- Zyra Chat today writes create/update/archive operations straight into `testcases`, synchronously,
-- inside the same request that produces the assistant's reply — there is no review step before a
-- generated/modified test case lands in the repository. Task-board generation already stages drafts
-- in `ai_generation_requests.generated_payload` and only commits them on an explicit Save; this links
-- chat sessions/messages into the same table instead of building a parallel staging mechanism.

ALTER TABLE ai_generation_requests
  ADD COLUMN IF NOT EXISTS chat_session_id UUID REFERENCES zyra_chat_sessions(id) ON DELETE CASCADE;

-- Points from the message to its review request (not the reverse), so the request row can be created
-- first, while drafts are staged, and its id attached to the assistant message afterward. Deleting a
-- stale/orphaned generation request must never cascade into deleting chat history.
ALTER TABLE zyra_chat_messages
  ADD COLUMN IF NOT EXISTS review_request_id UUID REFERENCES ai_generation_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_generation_requests_chat_session
  ON ai_generation_requests(chat_session_id, created_at DESC);
