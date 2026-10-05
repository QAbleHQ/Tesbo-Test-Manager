-- Replies to bug comments, one level deep — the same shape knowledge_document_comments has had
-- since V73.
--
-- NULL is a top-level comment, which is what every existing row already is, so nothing is
-- backfilled. Two rules a CHECK cannot express (it can't see the parent row) are enforced in
-- createBugComment instead: the parent must be a live comment on the same bug, and it must itself
-- be top-level, so a thread never nests deeper than one reply.
--
-- Deleting is a soft delete (is_deleted), and deleteBugComment soft-deletes a thread's replies with
-- it, as the knowledge base does. ON DELETE CASCADE only covers a physical delete — the bug or
-- project going away, or createBugComment removing a comment whose files failed to store — so no
-- reply is ever left pointing at a row that no longer exists.
ALTER TABLE bug_comments
  ADD COLUMN parent_comment_id UUID REFERENCES bug_comments(id) ON DELETE CASCADE;

-- Replies are the minority of rows; the per-bug read already uses idx_bug_comments_bug, so this
-- only serves "the replies of this comment" (the delete cascade).
CREATE INDEX idx_bug_comments_parent ON bug_comments(parent_comment_id) WHERE parent_comment_id IS NOT NULL;
