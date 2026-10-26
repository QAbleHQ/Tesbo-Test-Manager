/*
 * A fifth kind of execution evidence: an API call (request + response) captured by an automated
 * test. Until now the only way to attach one was as a `log` .json, which the viewer can only offer
 * as a download. `api` lets the viewer render method, URL, status, headers and body in place.
 */
ALTER TABLE attachments
  DROP CONSTRAINT IF EXISTS attachments_evidence_kind_check;

ALTER TABLE attachments
  ADD CONSTRAINT attachments_evidence_kind_check CHECK (
    evidence_kind IS NULL OR evidence_kind IN ('screenshot', 'video', 'trace', 'log', 'api')
  );
