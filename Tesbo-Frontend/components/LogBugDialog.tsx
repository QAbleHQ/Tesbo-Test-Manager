"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createBug,
  addBugLink,
  listBugs,
  getJiraStatus,
  getLinearStatus,
  uploadBugAttachments,
  type ExecutionItem,
  type BugItem,
  type BugSeverity,
  type BugPriority,
  type IssueSearchResult,
} from "@/lib/api";
import { Button, Input, Textarea, Select } from "@/components/ui";
import Modal from "@/components/ui/Modal";
import IssuePickerModal from "@/components/IssuePickerModal";
import TrackingDestinationField, { type TrackingDestination } from "@/components/TrackingDestinationField";
import SelfLoggedTrackerField, { type SelfLoggedSystem } from "@/components/SelfLoggedTrackerField";
import BugEvidenceField, { type EvidenceMode } from "@/components/BugEvidenceField";

/*
 * Basecamp 10226268634 ("The Log Bug UI should be consistent across both Test Run → Log Bug and Bug
 * Page → Log Bug"). This modal collected only a title, a description and evidence, so every bug
 * filed from a run landed on the severity column's 'Medium' default with no way to say otherwise —
 * while the same action from the Bugs page asked for severity (and now priority). Same fields, same
 * order, same wording as projects/[id]/bugs/page.tsx.
 */
const BUG_SEVERITIES: BugSeverity[] = ["Critical", "High", "Medium", "Low"];
const BUG_PRIORITIES: BugPriority[] = ["P0", "P1", "P2", "P3"];

function ExistingBugPickerModal({
  projectId,
  testcaseId,
  cycleId,
  open,
  onClose,
  selectedBugs,
  onConfirm,
}: {
  projectId: string;
  /** Identify the (testcase, cycle) this dialog is linking against — the same pair bug_links'
   *  unique constraint dedupes on, so it's what decides whether a bug is "already linked here"
   *  (not executionId, which a link row can carry as null even when it is otherwise a duplicate). */
  testcaseId: string | null;
  cycleId: string | null;
  open: boolean;
  onClose: () => void;
  /** Bugs already picked in a prior open of this same "Report a Bug" dialog — seeds the checkbox
   *  state so re-opening the picker to add one more bug doesn't lose the ones already chosen. */
  selectedBugs: BugItem[];
  onConfirm: (bugs: BugItem[]) => void;
}) {
  const [bugs, setBugs] = useState<BugItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Map<string, BugItem>>(new Map());

  // Seed `picked` from the parent's current selection by adjusting state during render (React's
  // documented pattern for "reset state when a prop changes"), not in a useEffect. An effect only
  // runs AFTER the reopened picker's first paint, so there was a render — the one the DOM actually
  // shows first — where `picked` still held whatever it was before the transition; doing this
  // during render instead means the very first paint after reopening already reflects the seed,
  // with no intermediate frame for a stale/empty value to be what's on screen.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setPicked(new Map(selectedBugs.map((bug) => [bug.id, bug])));
      setSearch("");
    }
  }

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listBugs(projectId)
      .then(setBugs)
      .finally(() => setLoading(false));
  }, [open, projectId]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    // A bug already linked to this testcase+cycle can't be linked again here (the backend link
    // insert is a no-op for it — see bug_links' unique constraint) — hide it so the list only
    // ever offers bugs actually pickable.
    const pickable = bugs.filter(
      (bug) => !testcaseId || !bug.links.some((l) => l.testcaseId === testcaseId && l.cycleId === cycleId),
    );
    if (!term) return pickable;
    return pickable.filter((bug) => bug.title.toLowerCase().includes(term));
  }, [bugs, search, testcaseId, cycleId]);

  function toggle(bug: BugItem) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(bug.id)) next.delete(bug.id);
      else next.set(bug.id, bug);
      return next;
    });
  }

  function handleConfirm() {
    onConfirm(Array.from(picked.values()));
    onClose();
  }

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} title="Link existing bugs" className="max-w-[520px]">
      {/* Scoped so tests (and any future nested-modal styling) can address this picker's own rows
          without colliding with the same bug titles rendered as chips in the Report a Bug modal
          still open underneath it. */}
      <div data-testid="existing-bug-picker" className="space-y-3">
        <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search bugs by title…" />
        <div className="max-h-[320px] overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border)]">
          {loading ? (
            <p className="p-3 text-[13px] text-[var(--muted)]">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-[13px] text-[var(--muted)]">No bugs found.</p>
          ) : (
            filtered.map((bug) => {
              const checked = picked.has(bug.id);
              return (
                // A <label> wrapping the checkbox, not a <button> around it — a checkbox nested
                // inside a button is invalid HTML (interactive content inside interactive content)
                // and unreliable to click; the label lets clicking anywhere in the row toggle it.
                <label
                  key={bug.id}
                  className="flex w-full items-start gap-2 border-b border-[var(--border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--surface-secondary)] cursor-pointer"
                >
                  <input type="checkbox" checked={checked} onChange={() => toggle(bug)} className="mt-1" />
                  <div className="flex flex-col items-start gap-0.5">
                    <span className="text-[13px] font-medium text-[var(--foreground)]">{bug.title}</span>
                    <span className="text-[12px] text-[var(--muted)]">{bug.status}</span>
                  </div>
                </label>
              );
            })
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          {/* Not disabled at zero: unchecking every previously-picked bug and confirming is how
              a working selection gets cleared back down to none through this picker. */}
          <Button type="button" onClick={handleConfirm}>
            {picked.size > 0 ? `Add Selected (${picked.size})` : "Add Selected"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Everything needed to log (or link) a bug against a test-case execution — state, handlers and the
 * three modals involved (Report a Bug, the Jira/Linear ticket picker, the existing-Tesbo-bug picker).
 *
 * Extracted so the run drawer (cycles/[cycleId]/page.tsx) and the full execution page
 * (cycles/[cycleId]/execute/[executionId]/page.tsx) share one implementation instead of each having
 * their own — the two used to drift, so the drawer had "Log bug" and the full page did not.
 *
 * `onLogged` fires after a bug is successfully filed or linked, so each caller can refresh whatever
 * it displays (the drawer refreshes its execution list; the full page has nothing that changes and
 * can omit it).
 */
export function useLogBugDialog(params: { projectId: string; cycleId: string; onLogged?: () => void }) {
  const { projectId, cycleId, onLogged } = params;

  /* issue tracker connection status (gates the ticket-related dialog choices) */
  const [jiraConnected, setJiraConnected] = useState(false);
  const [linearConnected, setLinearConnected] = useState(false);

  /* bug report dialog state */
  const [showBugDialog, setShowBugDialog] = useState(false);
  const [bugExecution, setBugExecution] = useState<ExecutionItem | null>(null);
  const [bugTitle, setBugTitle] = useState("");
  const [bugSeverity, setBugSeverity] = useState<BugSeverity>("Medium");
  const [bugPriority, setBugPriority] = useState<BugPriority | "">("");
  const [bugDesc, setBugDesc] = useState("");
  const [bugAlreadyLogged, setBugAlreadyLogged] = useState(false);
  const [bugExistingChoice, setBugExistingChoice] = useState<"JIRA" | "LINEAR" | "TESBO">("TESBO");
  const [bugDestination, setBugDestination] = useState<TrackingDestination>("TESBO");
  const [bugSelfSystem, setBugSelfSystem] = useState<SelfLoggedSystem>("OTHER");
  const [bugUrl, setBugUrl] = useState("");
  const [selectedIssues, setSelectedIssues] = useState<IssueSearchResult[]>([]);
  const [showBugIssuePicker, setShowBugIssuePicker] = useState(false);
  const [selectedExistingBugs, setSelectedExistingBugs] = useState<BugItem[]>([]);
  const [showExistingBugPicker, setShowExistingBugPicker] = useState(false);
  const [bugEvidenceMode, setBugEvidenceMode] = useState<EvidenceMode>("FILES");
  const [bugStagedFiles, setBugStagedFiles] = useState<File[]>([]);
  const [bugBetterbugsUrl, setBugBetterbugsUrl] = useState("");
  const [bugSaving, setBugSaving] = useState(false);
  // Basecamp: createBug() could succeed and the (unbatched) uploadBugAttachments() that followed
  // it could then fail — with no catch here, that was an unhandled rejection: the dialog looked
  // like it silently did nothing, which invited a retry that called createBug() again and produced
  // a duplicate bug. bugCreatedIdRef remembers the bug from the in-flight/most recent attempt so a
  // retry only resumes the attachment upload; resetBugDialog()/prepareBugDialog() clear it.
  const [bugSaveError, setBugSaveError] = useState<string | null>(null);
  const bugCreatedIdRef = useRef<string | null>(null);

  useEffect(() => {
    getJiraStatus(projectId).then((s) => setJiraConnected(s.connected)).catch(() => setJiraConnected(false));
    getLinearStatus(projectId).then((s) => setLinearConnected(s.connected)).catch(() => setLinearConnected(false));
  }, [projectId]);

  /* ───── Prefill + open the bug dialog for a given execution ───── */
  function prepareBugDialog(exec: ExecutionItem, titlePrefix: string) {
    bugCreatedIdRef.current = null;
    setBugSaveError(null);
    setBugExecution(exec);
    setBugTitle(`${titlePrefix}: ${exec.title || exec.snapshotTitle || "Untitled test case"}`);
    setBugDesc("");
    setBugSeverity("Medium");
    setBugPriority("");
    setBugAlreadyLogged(false);
    setBugExistingChoice(jiraConnected ? "JIRA" : linearConnected ? "LINEAR" : "TESBO");
    setBugDestination("TESBO");
    setBugSelfSystem(jiraConnected ? "JIRA" : linearConnected ? "LINEAR" : "OTHER");
    setBugUrl("");
    setSelectedIssues([]);
    setSelectedExistingBugs([]);
    setBugEvidenceMode("FILES");
    setBugStagedFiles([]);
    setBugBetterbugsUrl("");
    setShowBugDialog(true);
  }

  /* ───── Public entry point — the row action defaults to "Bug", a status change to Failed passes "Failed" ───── */
  function openBugDialogFor(exec: ExecutionItem, titlePrefix: string = "Bug") {
    prepareBugDialog(exec, titlePrefix);
  }

  /* ───── Reset & close the bug dialog ───── */
  function resetBugDialog() {
    bugCreatedIdRef.current = null;
    setBugSaveError(null);
    setShowBugDialog(false);
    setBugExecution(null);
    setBugTitle("");
    setBugSeverity("Medium");
    setBugPriority("");
    setBugDesc("");
    setBugAlreadyLogged(false);
    setBugExistingChoice(jiraConnected ? "JIRA" : linearConnected ? "LINEAR" : "TESBO");
    setBugDestination("TESBO");
    setBugSelfSystem(jiraConnected ? "JIRA" : linearConnected ? "LINEAR" : "OTHER");
    setBugUrl("");
    setSelectedIssues([]);
    setSelectedExistingBugs([]);
    setBugEvidenceMode("FILES");
    setBugStagedFiles([]);
    setBugBetterbugsUrl("");
  }

  /* ───── Submit bug from dialog ("No, log a new one" — optionally noting where it's tracked
   * elsewhere via the self-logged fields). "Yes, link existing" never reaches this: it goes
   * through handleLinkExisting below regardless of which tab (Tesbo/Jira/Linear) is active. ───── */
  async function handleBugSubmit() {
    if (!bugExecution || !bugTitle.trim() || !bugSeverity) return;
    // Belt-and-suspenders alongside the button's `disabled={bugSaving}`: guards a re-entrant call
    // that lands before the disabled state has re-rendered.
    if (bugSaving) return;
    const selfLogged = (jiraConnected || linearConnected) && bugDestination === "SELF";
    setBugSaving(true);
    setBugSaveError(null);
    try {
      // A retry after a failed attachment upload must not create a second bug: reuse the bug
      // created by the previous attempt (if any) instead of calling createBug() again.
      let bugId = bugCreatedIdRef.current;
      if (!bugId) {
        const bug = await createBug(projectId, {
          title: bugTitle.trim(),
          description: bugDesc.trim(),
          severity: bugSeverity,
          priority: bugPriority || null,
          externalUrl: selfLogged ? bugUrl.trim() : undefined,
          integrationProvider: selfLogged && bugSelfSystem !== "OTHER" ? bugSelfSystem : null,
          integrationIssueKey: null,
          betterbugsUrl: bugEvidenceMode === "BETTERBUGS" ? bugBetterbugsUrl.trim() : undefined,
          links: [{ testcaseId: bugExecution.testcaseId, cycleId, executionId: bugExecution.id }],
        });
        bugId = bug.id;
        bugCreatedIdRef.current = bugId;
      }
      if (bugEvidenceMode === "FILES" && bugStagedFiles.length) {
        // Drop each batch from the staged list as it lands, so a retry after a later batch fails
        // only resends the files that never made it, not ones already attached to the bug.
        await uploadBugAttachments(projectId, bugId, bugStagedFiles, (batch) => {
          setBugStagedFiles((prev) => prev.slice(batch.length));
        });
      }
      resetBugDialog();
      onLogged?.();
    } catch (err) {
      // The bug itself may already have been created — the evidence upload is the step that
      // failed. Keep the dialog open with the error shown rather than losing that state, matching
      // projects/[id]/bugs/page.tsx's create-bug error handling.
      setBugSaveError(err instanceof Error ? err.message : "Something went wrong while reporting this bug.");
    } finally {
      setBugSaving(false);
    }
  }

  /* ───── Link this failing execution to everything currently selected — existing Tesbo bugs
   * (via addBugLink) and/or Jira/Linear tickets (via createBug) — in one action, regardless of
   * which tab (bugExistingChoice) happens to be active when "Link Bug" is clicked. The two kinds
   * of selection live in separate arrays (selectedExistingBugs / selectedIssues) precisely so
   * switching tabs never has to clear one to show the other.
   *
   * addBugLink is idempotent (INSERT ... ON CONFLICT DO NOTHING on bug_links), so a retry safely
   * resends the whole selectedExistingBugs list. createBug is NOT idempotent — each call always
   * inserts a new bug row — so a naive retry after a partial failure would recreate bugs for
   * tickets that already succeeded; remainingIssues keeps only the ones that still need a bug
   * created, so a retry (clicking the button again after an error) only re-attempts those. */
  async function handleLinkExisting() {
    if (!bugExecution) return;
    if (selectedExistingBugs.length === 0 && selectedIssues.length === 0) return;
    if (bugSaving) return;
    setBugSaving(true);
    setBugSaveError(null);
    const link = { testcaseId: bugExecution.testcaseId, cycleId, executionId: bugExecution.id };
    let firstError: unknown = null;

    if (selectedExistingBugs.length) {
      try {
        await Promise.all(selectedExistingBugs.map((bug) => addBugLink(bug.id, link)));
      } catch (err) {
        firstError = firstError ?? err;
      }
    }

    const remainingIssues: IssueSearchResult[] = [];
    for (const issue of selectedIssues) {
      try {
        await createBug(projectId, {
          title: bugTitle.trim(),
          description: bugDesc.trim(),
          severity: bugSeverity,
          priority: bugPriority || null,
          externalUrl: issue.url,
          integrationProvider: issue.provider,
          integrationIssueKey: issue.key,
          links: [link],
        });
      } catch (err) {
        firstError = firstError ?? err;
        remainingIssues.push(issue);
      }
    }
    setSelectedIssues(remainingIssues);

    if (firstError) {
      setBugSaveError(firstError instanceof Error ? firstError.message : "Something went wrong while linking these items.");
    } else {
      resetBugDialog();
      onLogged?.();
    }
    setBugSaving(false);
  }

  function handleBugSkip() {
    resetBugDialog();
  }

  // Which tracker the "Yes, link existing" tabs currently have active, and how many things are
  // in the combined working selection across all three sources — used by both the chip list and
  // the footer's single "Link Bug" action so the count/label always reflect everything selected,
  // not just whichever tab happens to be open right now.
  const activeProvider: "JIRA" | "LINEAR" = bugExistingChoice === "LINEAR" ? "LINEAR" : "JIRA";
  const activeProviderLabel = activeProvider === "JIRA" ? "Jira" : "Linear";
  const totalSelected = selectedExistingBugs.length + selectedIssues.length;

  const dialog = (
    <>
      {/* ───── Bug Report Modal (triggered on Failed, or opened directly) ───── */}
      <Modal
        open={showBugDialog}
        onClose={handleBugSkip}
        title="Report a Bug"
      >
        <div className="space-y-4">
          {bugSaveError && (
            <p
              data-testid="log-bug-error"
              className="rounded-[var(--radius-control)] border border-[var(--error)] bg-[var(--error)]/10 px-3 py-2 text-[13px] text-[var(--error-foreground)]"
            >
              {bugSaveError}
            </p>
          )}
          {/* Themed rather than the literal red-50/red-200 these carried: in dark mode that pale
              block stayed light while its text followed the theme, which is the same mismatch the
              danger Button variant was fixed for. */}
          <div className="flex items-start gap-2 rounded-lg border border-[var(--error-border)] bg-[var(--error-soft)] p-3">
            <svg className="w-5 h-5 text-[var(--status-fail-text)] mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-[var(--status-fail-text)]">Test case marked as Failed</p>
              <p className="text-xs text-[var(--status-fail-text)] opacity-80 mt-0.5">
                {bugExecution?.externalId && <span className="font-mono mr-1">{bugExecution.externalId}</span>}
                {bugExecution?.title || bugExecution?.snapshotTitle || "Untitled test case"}
              </p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--muted)] mb-1">
              Is this defect already logged?
            </label>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={!bugAlreadyLogged ? "primary" : "secondary"}
                onClick={() => setBugAlreadyLogged(false)}
              >
                No, log a new one
              </Button>
              <Button
                type="button"
                size="sm"
                variant={bugAlreadyLogged ? "primary" : "secondary"}
                onClick={() => setBugAlreadyLogged(true)}
              >
                Yes, link existing
              </Button>
            </div>
          </div>

          {bugAlreadyLogged && (
            <div className="flex flex-wrap gap-2">
              {jiraConnected && (
                <Button
                  type="button"
                  size="sm"
                  variant={bugExistingChoice === "JIRA" ? "primary" : "secondary"}
                  onClick={() => setBugExistingChoice("JIRA")}
                >
                  Jira ticket
                </Button>
              )}
              {linearConnected && (
                <Button
                  type="button"
                  size="sm"
                  variant={bugExistingChoice === "LINEAR" ? "primary" : "secondary"}
                  onClick={() => setBugExistingChoice("LINEAR")}
                >
                  Linear ticket
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant={bugExistingChoice === "TESBO" ? "primary" : "secondary"}
                onClick={() => setBugExistingChoice("TESBO")}
              >
                Existing Tesbo bug
              </Button>
            </div>
          )}

          {bugAlreadyLogged ? (
            // Linking real Jira/Linear tickets or existing Tesbo bugs needs nothing else — each
            // already carries its own title/description/status. Bug Title/Description/Severity/
            // Priority/Evidence only apply to a bug being newly described here, so they stay
            // hidden. The chip list below is the COMBINED working selection across all three
            // sources (Tesbo bugs + Jira tickets + Linear tickets) so switching tabs to add from
            // another source never hides what's already picked from this one.
            <div>
              <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                {totalSelected > 1 ? "Selected items" : "Selected item"}
              </label>
              <div className="space-y-1.5">
                {selectedExistingBugs.map((bug) => (
                  <div
                    key={`tesbo-${bug.id}`}
                    className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1.5 text-[13px]"
                  >
                    <span className="font-medium text-[var(--foreground)]">{bug.title}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedExistingBugs((prev) => prev.filter((b) => b.id !== bug.id))}
                      className="text-[var(--muted)] hover:text-[var(--error-foreground)]"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {selectedIssues.map((issue) => (
                  <div
                    key={`${issue.provider}-${issue.key}`}
                    className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1.5 text-[13px]"
                  >
                    <span className="font-medium text-[var(--foreground)]">{issue.key} — {issue.summary}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedIssues((prev) => prev.filter((i) => !(i.provider === issue.provider && i.key === issue.key)))}
                      className="text-[var(--muted)] hover:text-[var(--error-foreground)]"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {bugExistingChoice === "TESBO" ? (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setShowExistingBugPicker(true)}>
                    {selectedExistingBugs.length ? "Add another bug…" : "Choose an existing bug…"}
                  </Button>
                ) : (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setShowBugIssuePicker(true)}>
                    {selectedIssues.some((i) => i.provider === activeProvider)
                      ? `Add another ${activeProviderLabel} ticket…`
                      : `Search ${activeProviderLabel} tickets…`}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                  Bug Title <span className="text-[var(--error-foreground)]">*</span>
                </label>
                <Input
                  type="text"
                  value={bugTitle}
                  onChange={(e) => setBugTitle(e.target.value)}
                  placeholder="Brief summary of the bug…"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                  Description
                </label>
                <Textarea
                  value={bugDesc}
                  onChange={(e) => setBugDesc(e.target.value)}
                  rows={3}
                  placeholder="Steps to reproduce, expected vs actual behavior…"
                />
              </div>
              {/*
                * Severity carries dev's required marker (48363ea/10226268634 — the run's modal used
                * to collect no severity at all, so every bug filed from a run took the column
                * default), paired with Priority from 10226247009. Evidence keeps its own full-width
                * row below rather than sharing the grid with Severity: three controls do not fit two
                * columns, and the file list needs the width.
                */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                    Severity <span className="text-[var(--error-foreground)]">*</span>
                  </label>
                  <Select
                    value={bugSeverity}
                    onChange={(e) => setBugSeverity(e.target.value as BugSeverity)}
                    aria-label="Severity"
                  >
                    {BUG_SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {severity}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--muted)] mb-1">Priority</label>
                  <Select
                    value={bugPriority}
                    onChange={(e) => setBugPriority(e.target.value as BugPriority | "")}
                    aria-label="Bug priority"
                  >
                    <option value="">Not set</option>
                    {BUG_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <BugEvidenceField
                mode={bugEvidenceMode}
                onModeChange={setBugEvidenceMode}
                stagedFiles={bugStagedFiles}
                onStagedFilesChange={setBugStagedFiles}
                betterbugsUrl={bugBetterbugsUrl}
                onBetterbugsUrlChange={setBugBetterbugsUrl}
              />
              {(jiraConnected || linearConnected) && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                      Where should this be tracked?
                    </label>
                    <TrackingDestinationField destination={bugDestination} onChange={setBugDestination} />
                  </div>
                  {bugDestination === "SELF" && (
                    <SelfLoggedTrackerField
                      jiraConnected={jiraConnected}
                      linearConnected={linearConnected}
                      system={bugSelfSystem}
                      onSystemChange={setBugSelfSystem}
                      url={bugUrl}
                      onUrlChange={setBugUrl}
                    />
                  )}
                </>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={handleBugSkip}>
              Skip
            </Button>
            {bugAlreadyLogged ? (
              <Button
                variant="destructive"
                onClick={handleLinkExisting}
                disabled={bugSaving || totalSelected === 0}
              >
                {bugSaving
                  ? "Linking…"
                  : totalSelected > 1
                    ? `Link ${totalSelected} Bugs`
                    : "Link Bug"}
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={handleBugSubmit}
                disabled={bugSaving || !bugTitle.trim() || !bugSeverity}
              >
                {bugSaving ? (
                  "Filing…"
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    File Bug
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </Modal>

      <IssuePickerModal
        projectId={projectId}
        testcaseId={bugExecution?.testcaseId ?? null}
        cycleId={cycleId}
        provider={activeProvider}
        open={showBugIssuePicker}
        onClose={() => setShowBugIssuePicker(false)}
        // Scoped to the active provider on the way in and merged back the same way on confirm —
        // selectedIssues holds both Jira and Linear tickets together (each tagged by its own
        // .provider), but this picker is locked to one provider and must never see or touch the
        // other's entries, or a Linear ticket picked earlier could get swept into a Jira picker's
        // internal selection state and rendered there by mistake.
        selectedIssues={selectedIssues.filter((issue) => issue.provider === activeProvider)}
        onConfirm={(issues) =>
          setSelectedIssues((prev) => [...prev.filter((issue) => issue.provider !== activeProvider), ...issues])
        }
      />

      <ExistingBugPickerModal
        projectId={projectId}
        testcaseId={bugExecution?.testcaseId ?? null}
        cycleId={cycleId}
        open={showExistingBugPicker}
        onClose={() => setShowExistingBugPicker(false)}
        selectedBugs={selectedExistingBugs}
        onConfirm={(bugs) => setSelectedExistingBugs(bugs)}
      />
    </>
  );

  return { dialog, openBugDialogFor };
}
