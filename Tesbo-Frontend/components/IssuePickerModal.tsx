"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getJiraStatus,
  getLinearStatus,
  listBugs,
  searchJiraIssuesLive,
  searchLinearIssuesLive,
  type IssueSearchResult,
} from "@/lib/api";
import { Button, Field, FieldLabel, Input, Modal } from "@/components/ui";

interface Props {
  projectId: string;
  /** Identify the (testcase, cycle) this dialog is linking against, so a ticket already carried by
   *  a bug linked here can be excluded — mirrors ExistingBugPickerModal's own dedupe, since a
   *  Jira/Linear "link" is really just a Tesbo bug row with integrationProvider/IssueKey set. */
  testcaseId: string | null;
  cycleId: string | null;
  open: boolean;
  onClose: () => void;
  /** Tickets already picked in a prior open of this same "Report a Bug" dialog — seeds the
   *  checkbox state so re-opening the picker to add one more ticket doesn't lose earlier picks. */
  selectedIssues: IssueSearchResult[];
  onConfirm: (issues: IssueSearchResult[]) => void;
  /**
   * Which tracker to search. The caller already collected this choice ("Jira ticket" vs "Linear
   * ticket" on the Report a Bug form) — this modal must not re-ask it, or a project with both
   * trackers connected could search Jira after the user explicitly chose Linear.
   */
  provider: "JIRA" | "LINEAR";
}

function issueKey(issue: IssueSearchResult): string {
  return `${issue.provider}-${issue.key}`;
}

export default function IssuePickerModal({ projectId, testcaseId, cycleId, open, onClose, selectedIssues, onConfirm, provider }: Props) {
  const [connected, setConnected] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<IssueSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkedKeys, setLinkedKeys] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Map<string, IssueSearchResult>>(new Map());

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setResults([]);
    setError(null);
    // Seed from the parent's current selection only when the picker opens — not on every parent
    // re-render — so toggling checkboxes while the picker stays open never gets clobbered.
    setPicked(new Map(selectedIssues.map((issue) => [issueKey(issue), issue])));
    const getStatus = provider === "JIRA" ? getJiraStatus : getLinearStatus;
    getStatus(projectId).then((s) => setConnected(s.connected)).catch(() => setConnected(false));
    // A ticket already linked to this exact testcase+cycle (as a bug carrying this provider+key)
    // can't be linked again here — the same duplicate-prevention ExistingBugPickerModal applies.
    if (testcaseId) {
      listBugs(projectId, { testcaseId })
        .then((bugs) => {
          const keys = new Set<string>();
          for (const bug of bugs) {
            if (bug.integrationProvider !== provider || !bug.integrationIssueKey) continue;
            if (bug.links.some((l) => l.testcaseId === testcaseId && l.cycleId === cycleId)) {
              keys.add(`${bug.integrationProvider}-${bug.integrationIssueKey}`);
            }
          }
          setLinkedKeys(keys);
        })
        .catch(() => setLinkedKeys(new Set()));
    } else {
      setLinkedKeys(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, provider, testcaseId, cycleId]);

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

  // The live search only ever returns a subset matching the current term, so a ticket picked
  // under an earlier term (or before the search was re-run on reopen) can fall out of `results`
  // entirely -- that made an already-picked ticket disappear from the list with no way to uncheck
  // it. Union the working picks back in (still excluding ones already persisted) so every ticket
  // currently checked stays visible regardless of what the search box currently contains.
  const pickable = useMemo(() => {
    const merged = new Map<string, IssueSearchResult>();
    for (const issue of picked.values()) {
      if (!linkedKeys.has(issueKey(issue))) merged.set(issueKey(issue), issue);
    }
    for (const issue of results) {
      if (!linkedKeys.has(issueKey(issue))) merged.set(issueKey(issue), issue);
    }
    return Array.from(merged.values());
  }, [results, picked, linkedKeys]);

  function toggle(issue: IssueSearchResult) {
    setPicked((prev) => {
      const next = new Map(prev);
      const key = issueKey(issue);
      if (next.has(key)) next.delete(key);
      else next.set(key, issue);
      return next;
    });
  }

  function handleConfirm() {
    onConfirm(Array.from(picked.values()));
    onClose();
  }

  if (!open) return null;

  const providerLabel = provider === "JIRA" ? "Jira" : "Linear";

  return (
    <Modal open={open} onClose={onClose} title={`Link ${providerLabel} tickets`} className="max-w-[520px]">
      {!connected ? (
        <p className="text-[14px] text-[var(--muted)]">
          {providerLabel} is not connected for this project. Connect it in project settings to search tickets here.
        </p>
      ) : (
        // Scoped so tests (and any future nested-modal styling) can address this picker's own rows
        // without colliding with the same ticket text rendered as chips in the Report a Bug modal
        // still open underneath it.
        <div data-testid="issue-picker" className="space-y-4">
          <Field>
            <FieldLabel>Search issues</FieldLabel>
            <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by key or summary…" />
          </Field>

          {error ? <p className="text-[13px] text-[var(--error-foreground)]">{error}</p> : null}

          <div className="max-h-[320px] overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border)]">
            {loading ? (
              <p className="p-3 text-[13px] text-[var(--muted)]">Searching…</p>
            ) : pickable.length === 0 ? (
              <p className="p-3 text-[13px] text-[var(--muted)]">No issues found.</p>
            ) : (
              pickable.map((issue) => {
                const checked = picked.has(issueKey(issue));
                return (
                  // A <label> wrapping the checkbox, not a <button> around it — a checkbox nested
                  // inside a button is invalid HTML and unreliable to click; the label lets
                  // clicking anywhere in the row toggle it, same pattern as ExistingBugPickerModal.
                  <label
                    key={issueKey(issue)}
                    className="flex w-full items-start gap-2 border-b border-[var(--border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--surface-secondary)] cursor-pointer"
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggle(issue)} className="mt-1" />
                    <div className="flex flex-col items-start gap-0.5">
                      <span className="text-[13px] font-medium text-[var(--foreground)]">{issue.key} — {issue.summary}</span>
                      <span className="text-[12px] text-[var(--muted)]">{issue.status}</span>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            {/* Not disabled at zero: unchecking every previously-picked ticket and confirming is
                how a working selection gets cleared back down to none through this picker. */}
            <Button type="button" onClick={handleConfirm}>
              {picked.size > 0 ? `Add Selected (${picked.size})` : "Add Selected"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
