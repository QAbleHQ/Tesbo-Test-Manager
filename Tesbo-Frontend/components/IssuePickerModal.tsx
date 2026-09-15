"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getJiraStatus,
  getLinearStatus,
  searchJiraIssuesLive,
  searchLinearIssuesLive,
  type IssueSearchResult,
} from "@/lib/api";
import { Button, Field, FieldLabel, Input, Modal } from "@/components/ui";

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onSelect: (issue: IssueSearchResult) => void;
  /**
   * Which tracker to search. The caller already collected this choice ("Jira ticket" vs "Linear
   * ticket" on the Report a Bug form) — this modal must not re-ask it, or a project with both
   * trackers connected could search Jira after the user explicitly chose Linear.
   */
  provider: "JIRA" | "LINEAR";
}

export default function IssuePickerModal({ projectId, open, onClose, onSelect, provider }: Props) {
  const [connected, setConnected] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<IssueSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setResults([]);
    setError(null);
    const getStatus = provider === "JIRA" ? getJiraStatus : getLinearStatus;
    getStatus(projectId).then((s) => setConnected(s.connected)).catch(() => setConnected(false));
  }, [open, projectId, provider]);

  const runSearch = useCallback(async (term: string) => {
    setLoading(true);
    setError(null);
    try {
      const { list } = provider === "JIRA"
        ? await searchJiraIssuesLive(projectId, term)
        : await searchLinearIssuesLive(projectId, term);
      setResults(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }, [provider, projectId]);

  useEffect(() => {
    if (!open || !connected) return;
    const handle = setTimeout(() => runSearch(search), 300);
    return () => clearTimeout(handle);
  }, [open, connected, search, runSearch]);

  if (!open) return null;

  const providerLabel = provider === "JIRA" ? "Jira" : "Linear";

  return (
    <Modal open={open} onClose={onClose} title={`Link a ${providerLabel} ticket`} className="max-w-[520px]">
      {!connected ? (
        <p className="text-[14px] text-[var(--muted)]">
          {providerLabel} is not connected for this project. Connect it in project settings to search tickets here.
        </p>
      ) : (
        <div className="space-y-4">
          <Field>
            <FieldLabel>Search issues</FieldLabel>
            <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by key or summary…" />
          </Field>

          {error ? <p className="text-[13px] text-[var(--error-foreground)]">{error}</p> : null}

          <div className="max-h-[320px] overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border)]">
            {loading ? (
              <p className="p-3 text-[13px] text-[var(--muted)]">Searching…</p>
            ) : results.length === 0 ? (
              <p className="p-3 text-[13px] text-[var(--muted)]">No issues found.</p>
            ) : (
              results.map((issue) => (
                <button
                  key={`${issue.provider}-${issue.key}`}
                  type="button"
                  onClick={() => onSelect(issue)}
                  className="flex w-full flex-col items-start gap-0.5 border-b border-[var(--border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--surface-secondary)]"
                >
                  <span className="text-[13px] font-medium text-[var(--foreground)]">{issue.key} — {issue.summary}</span>
                  <span className="text-[12px] text-[var(--muted)]">{issue.status}</span>
                </button>
              ))
            )}
          </div>

          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
