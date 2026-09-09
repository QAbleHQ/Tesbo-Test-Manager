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
  open,
  onClose,
  onSelect,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onSelect: (bug: BugItem) => void;
}) {
  const [bugs, setBugs] = useState<BugItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setLoading(true);
    listBugs(projectId)
      .then(setBugs)
      .finally(() => setLoading(false));
  }, [open, projectId]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return bugs;
    return bugs.filter((bug) => bug.title.toLowerCase().includes(term));
  }, [bugs, search]);

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} title="Link an existing bug" className="max-w-[520px]">
      <div className="space-y-3">
        <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search bugs by title…" />
        <div className="max-h-[320px] overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border)]">
          {loading ? (
            <p className="p-3 text-[13px] text-[var(--muted)]">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-[13px] text-[var(--muted)]">No bugs found.</p>
          ) : (
            filtered.map((bug) => (
              <button
                key={bug.id}
                type="button"
                onClick={() => onSelect(bug)}
                className="flex w-full flex-col items-start gap-0.5 border-b border-[var(--border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--surface-secondary)]"
              >
                <span className="text-[13px] font-medium text-[var(--foreground)]">{bug.title}</span>
                <span className="text-[12px] text-[var(--muted)]">{bug.status}</span>
              </button>
            ))
          )}
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
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
  const [bugIssue, setBugIssue] = useState<IssueSearchResult | null>(null);
  const [showBugIssuePicker, setShowBugIssuePicker] = useState(false);
  const [selectedExistingBug, setSelectedExistingBug] = useState<BugItem | null>(null);
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
    setBugIssue(null);
    setSelectedExistingBug(null);
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
    setBugIssue(null);
    setSelectedExistingBug(null);
    setBugEvidenceMode("FILES");
    setBugStagedFiles([]);
    setBugBetterbugsUrl("");
  }

  /* ───── Submit bug from dialog (new bug, optionally noting where it's tracked elsewhere) ───── */
  async function handleBugSubmit() {
    if (!bugExecution || !bugTitle.trim() || !bugSeverity) return;
    // Belt-and-suspenders alongside the button's `disabled={bugSaving}`: guards a re-entrant call
    // that lands before the disabled state has re-rendered.
    if (bugSaving) return;
    const selfLogged = (jiraConnected || linearConnected) && bugDestination === "SELF";
    // "Yes, link existing" + a searched Jira/Linear ticket carries its own real key/url/provider
    // (IssuePickerModal -> bugIssue) — that's the actual source of truth for this bug, not the
    // self-logged fields below, which only apply to the "No, log a new one" branch.
    const pickedIssue = bugAlreadyLogged && (bugExistingChoice === "JIRA" || bugExistingChoice === "LINEAR") ? bugIssue : null;
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
          externalUrl: pickedIssue ? pickedIssue.url : selfLogged ? bugUrl.trim() : undefined,
          integrationProvider: pickedIssue ? pickedIssue.provider : selfLogged && bugSelfSystem !== "OTHER" ? bugSelfSystem : null,
          integrationIssueKey: pickedIssue ? pickedIssue.key : null,
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

  /* ───── Link this failing execution to an already-existing Tesbo bug (backtrace) ───── */
  async function handleLinkExistingBug() {
    if (!bugExecution || !selectedExistingBug) return;
    setBugSaving(true);
    try {
      await addBugLink(selectedExistingBug.id, { testcaseId: bugExecution.testcaseId, cycleId, executionId: bugExecution.id });
      resetBugDialog();
      onLogged?.();
    } finally {
      setBugSaving(false);
    }
  }

  function handleBugSkip() {
    resetBugDialog();
  }

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
                  onClick={() => { setBugExistingChoice("JIRA"); setBugIssue(null); }}
                >
                  Jira ticket
                </Button>
              )}
              {linearConnected && (
                <Button
                  type="button"
                  size="sm"
                  variant={bugExistingChoice === "LINEAR" ? "primary" : "secondary"}
                  onClick={() => { setBugExistingChoice("LINEAR"); setBugIssue(null); }}
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

          {bugAlreadyLogged && bugExistingChoice === "TESBO" ? (
            <div>
              <label className="block text-sm font-medium text-[var(--muted)] mb-1">Bug</label>
              {selectedExistingBug ? (
                <div className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1.5 text-[13px]">
                  <span className="font-medium text-[var(--foreground)]">{selectedExistingBug.title}</span>
                  <button type="button" onClick={() => setSelectedExistingBug(null)} className="text-[var(--muted)] hover:text-[var(--error-foreground)]">
                    ✕
                  </button>
                </div>
              ) : (
                <Button type="button" variant="secondary" size="sm" onClick={() => setShowExistingBugPicker(true)}>
                  Choose an existing bug…
                </Button>
              )}
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
              {bugAlreadyLogged ? (
                <div>
                  <label className="block text-sm font-medium text-[var(--muted)] mb-1">Ticket</label>
                  {bugIssue ? (
                    <div className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1.5 text-[13px]">
                      <span className="font-medium text-[var(--foreground)]">{bugIssue.key} — {bugIssue.summary}</span>
                      <button type="button" onClick={() => setBugIssue(null)} className="text-[var(--muted)] hover:text-[var(--error-foreground)]">
                        ✕
                      </button>
                    </div>
                  ) : (
                    <Button type="button" variant="secondary" size="sm" onClick={() => setShowBugIssuePicker(true)}>
                      Search {bugExistingChoice === "JIRA" ? "Jira" : "Linear"} tickets…
                    </Button>
                  )}
                </div>
              ) : (
                (jiraConnected || linearConnected) && (
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
                )
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={handleBugSkip}>
              Skip
            </Button>
            {bugAlreadyLogged && bugExistingChoice === "TESBO" ? (
              <Button
                variant="destructive"
                onClick={handleLinkExistingBug}
                disabled={bugSaving || !selectedExistingBug}
              >
                {bugSaving ? "Linking…" : "Link Bug"}
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
        open={showBugIssuePicker}
        onClose={() => setShowBugIssuePicker(false)}
        onSelect={(issue) => {
          setBugIssue(issue);
          setShowBugIssuePicker(false);
        }}
      />

      <ExistingBugPickerModal
        projectId={projectId}
        open={showExistingBugPicker}
        onClose={() => setShowExistingBugPicker(false)}
        onSelect={(bug) => {
          setSelectedExistingBug(bug);
          setShowExistingBugPicker(false);
        }}
      />
    </>
  );

  return { dialog, openBugDialogFor };
}
