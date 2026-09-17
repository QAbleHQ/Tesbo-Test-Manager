-- Soft-delete zyra_chat_sessions. deleteZyraChatSession (legacy.service.ts) issues a real DELETE
-- today, and zyra_chat_messages.session_id / ai_generation_requests.chat_session_id are both
-- ON DELETE CASCADE, so deleting a conversation destroys the user's entire transcript with it plus
-- any staged-but-unsaved review batch, with no audit trail. See
-- "Zyra Workflow Agents/hard-delete-remediation-progress-log.md", Phase 6, for the full audit.

ALTER TABLE zyra_chat_sessions
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

CREATE INDEX idx_zyra_chat_sessions_active ON zyra_chat_sessions(project_id) WHERE deleted_at IS NULL;

-- Hardening, matching V110/V111/V113/V114's treatment of the same CASCADE pattern: once
-- deleteZyraChatSession stops issuing a real DELETE, these constraints never fire on their only
-- reachable application path any more, but left as CASCADE they stay live and dangerous against
-- any future raw `DELETE FROM zyra_chat_sessions`. RESTRICT makes that fail loudly instead of
-- silently destroying a transcript and its staged drafts.
ALTER TABLE zyra_chat_messages DROP CONSTRAINT zyra_chat_messages_session_id_fkey;
ALTER TABLE zyra_chat_messages
  ADD CONSTRAINT zyra_chat_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES zyra_chat_sessions(id) ON DELETE RESTRICT;

ALTER TABLE ai_generation_requests DROP CONSTRAINT ai_generation_requests_chat_session_id_fkey;
ALTER TABLE ai_generation_requests
  ADD CONSTRAINT ai_generation_requests_chat_session_id_fkey FOREIGN KEY (chat_session_id) REFERENCES zyra_chat_sessions(id) ON DELETE RESTRICT;
