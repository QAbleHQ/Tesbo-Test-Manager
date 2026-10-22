-- NYRA approvals now keep ONE Knowledge Base document per NYRA project (kind = 'product') instead of one
-- per kind. This hash is of the text Tesbo last wrote into it, so a later approval can tell that a person
-- edited the document in the Knowledge Base since, and ask before replacing those edits. NULL on a row
-- from before this column existed, which is treated as "not known to be edited".
ALTER TABLE nyra_kb_documents ADD COLUMN content_hash TEXT;
