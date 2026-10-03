"use client";

import { useState } from "react";
import {
  updateBug,
  uploadBugAttachments,
  deleteBugAttachment,
  getBugAttachmentDownloadUrl,
  type BugItem,
  type BugAttachment,
  type BugSeverity,
  type BugPriority,
  type IssueSearchResult,
} from "@/lib/api";
import { Button, Input, Field, FieldLabel, Modal, Textarea, Select } from "@/components/ui";
import { useProjectData } from "@/components/project/ProjectDataProvider";
import TestCaseRunPicker, { type LinkRow } from "@/components/TestCaseRunPicker";
import TrackingDestinationField, { type TrackingDestination } from "@/components/TrackingDestinationField";
import SelfLoggedTrackerField, { type SelfLoggedSystem } from "@/components/SelfLoggedTrackerField";
import IssuePickerModal from "@/components/IssuePickerModal";
import BugEvidenceField, { type EvidenceMode } from "@/components/BugEvidenceField";
import { BUG_PRIORITIES, BUG_SEVERITIES } from "@/components/bugs/BugBadges";

type EditBugModalProps = {
  projectId: string;
  /** The bug being edited. Render with `key={bug.id}` so reopening starts from the bug's values. */
  bug: BugItem;
  jiraConnected: boolean;
  linearConnected: boolean;
  /** Whether the project has any test runs — the link picker is only mandatory when it does. */
  hasTestRuns: boolean;
  /**
   * "modal" (the bugs list) opens Edit Bug as a dialog. "page" (the full-page bug view) renders
   * the same form in place as a titled card with the actions below it, like the Test Run execute
   * page.
   */
  layout?: "modal" | "page";
  onClose: () => void;
  /** Called after any write reached the server, including a save whose attachment upload failed. */
  onChanged: () => void;
};

/*
 * Edit Bug, shared by the bugs list and the full-page bug view. Moved here unchanged from
 * app/(app)/projects/[id]/bugs/page.tsx; the initial state below is what that page's openEdit()
 * used to set.
 */
export default function EditBugModal({
  projectId,
  bug,
  jiraConnected,
  linearConnected,
  hasTestRuns,
  layout = "modal",
  onClose,
  onChanged,
}: EditBugModalProps) {
  const { projectMembers: members } = useProjectData();

  // updateBug/createBug store integrationProvider verbatim — unlike severity/priority, there is
  // no backend normalization — so a value ever written as "jira"/"Jira" instead of "JIRA" (an
  // older client, a hand-crafted API call) has to still be recognized here, or a bug with a
  // perfectly real Jira/Linear link falls through to "Other".
  const normalizedProvider = bug.integrationProvider?.toUpperCase();
  const detectedProvider: SelfLoggedSystem =
    normalizedProvider === "JIRA" || normalizedProvider === "LINEAR" ? normalizedProvider : "OTHER";

  const [editTitle, setEditTitle] = useState(bug.title);
  const [editDesc, setEditDesc] = useState(bug.description);
  const [editPriority, setEditPriority] = useState<BugPriority | "">(bug.priority ?? "");
  const [editSeverity, setEditSeverity] = useState<BugSeverity>(bug.severity);
  const [editLinks, setEditLinks] = useState<LinkRow[]>(() =>
    bug.links.map((link) => ({
      cycleId: link.cycleId || "",
      cycleName: link.cycleName || "",
      testcaseId: link.testcaseId || "",
      testcaseTitle: link.testcaseTitle || "",
      executionId: link.executionId || undefined,
    }))
  );
  const [editDestination, setEditDestination] = useState<TrackingDestination>(bug.externalUrl ? "SELF" : "TESBO");
  const [editSelfSystem, setEditSelfSystem] = useState<SelfLoggedSystem>(detectedProvider);
  const [editUrl, setEditUrl] = useState(bug.externalUrl || "");
  // The Jira/Linear ticket currently linked to the bug being edited, so Edit Bug can offer a
  // searchable picker (reusing IssuePickerModal) instead of a plain URL box for those systems.
  const [editSelectedIssue, setEditSelectedIssue] = useState<IssueSearchResult | null>(
    (detectedProvider === "JIRA" || detectedProvider === "LINEAR") && bug.integrationIssueKey
      ? { provider: detectedProvider, key: bug.integrationIssueKey, summary: "", status: "", url: bug.externalUrl || "" }
      : null
  );
  const [editIssuePickerOpen, setEditIssuePickerOpen] = useState(false);

  // Switching which system (Jira/Linear/Other) is selected has to drop a previously-picked issue
  // that belongs to a different provider — otherwise a Jira key saved while Linear is selected
  // would be submitted under integrationProvider: "LINEAR", and the stale ticket would also leak
  // into the Linear picker's result list (it's kept "selected" there purely by key match failing
  // to exclude it).
  function handleEditSystemChange(system: SelfLoggedSystem) {
    setEditSelfSystem(system);
    setEditSelectedIssue((prev) => {
      if (prev && prev.provider !== system) {
        // The URL field tracked the old provider's ticket — clear it along with the pick so a
        // Jira browse link can't linger under integrationProvider: "LINEAR" (or "OTHER").
        setEditUrl("");
        return null;
      }
      return prev;
    });
  }
  const [editEvidenceMode, setEditEvidenceMode] = useState<EvidenceMode>(bug.betterbugsUrl ? "BETTERBUGS" : "FILES");
  const [editStagedFiles, setEditStagedFiles] = useState<File[]>([]);
  const [editAttachments, setEditAttachments] = useState<BugAttachment[]>(bug.attachments);
  const [editBetterbugsUrl, setEditBetterbugsUrl] = useState(bug.betterbugsUrl || "");
  const [editStatus, setEditStatus] = useState(bug.status);
  const [editAssigneeId, setEditAssigneeId] = useState(bug.assigneeId || "");
  const [saving, setSaving] = useState(false);
  /*
   * Basecamp 10226296533: updateBug succeeded, uploadBugAttachments then threw, and the throw went
   * nowhere — `finally` cleared the spinner but the modal stayed open unchanged with no reason
   * shown, which is what "stuck on Saving" looked like from the outside. The server's message
   * (unsupported type, over the size limit, storage allowance exhausted) is worth showing
   * verbatim: it names the file.
   */
  const [editError, setEditError] = useState<string | null>(null);

  // Requirement: switching Jira <-> Linear (or picking Jira/Linear for the first time) clears the
  // previous pick and must not be saveable again until a ticket from the NEW provider is chosen —
  // otherwise Save would silently persist integrationProvider set with integrationIssueKey null.
  const editIssueRequired =
    (jiraConnected || linearConnected) &&
    editDestination === "SELF" &&
    (editSelfSystem === "JIRA" || editSelfSystem === "LINEAR") &&
    !editSelectedIssue;

  /* remove an already-uploaded attachment from the bug being edited */
  async function handleRemoveEditAttachment(attachmentId: string) {
    await deleteBugAttachment(attachmentId);
    setEditAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  }

  /* save edit */
  async function handleEditSave() {
    if (!editTitle.trim() || (hasTestRuns && !editLinks.length) || editIssueRequired) return;
    const selfLogged = (jiraConnected || linearConnected) && editDestination === "SELF";
    setSaving(true);
    setEditError(null);
    try {
      await updateBug(bug.id, {
        title: editTitle.trim(),
        description: editDesc.trim(),
        status: editStatus,
        severity: editSeverity,
        priority: editPriority || null,
        assigneeId: editAssigneeId || null,
        externalUrl: selfLogged ? editUrl.trim() : undefined,
        integrationProvider: selfLogged && editSelfSystem !== "OTHER" ? editSelfSystem : null,
        integrationIssueKey: selfLogged && editSelfSystem !== "OTHER" ? editSelectedIssue?.key || null : null,
        betterbugsUrl: editEvidenceMode === "BETTERBUGS" ? editBetterbugsUrl.trim() : undefined,
        links: editLinks.map((link) => ({
          testcaseId: link.testcaseId,
          cycleId: link.cycleId,
          executionId: link.executionId,
        })),
      });
      if (editEvidenceMode === "FILES" && editStagedFiles.length) {
        // Drop each batch from the staged list as it lands, so a retry after a later batch fails
        // only resends the files that never made it, not ones already attached to the bug.
        await uploadBugAttachments(projectId, bug.id, editStagedFiles, (batch) => {
          setEditStagedFiles((prev) => prev.slice(batch.length));
        });
      }
      onClose();
      onChanged();
    } catch (err) {
      onChanged();
      setEditError(err instanceof Error ? err.message : "Something went wrong while saving this bug.");
    } finally {
      setSaving(false);
    }
  }

  const saveDisabled = saving || !editTitle.trim() || (hasTestRuns && !editLinks.length) || editIssueRequired;

  const fields = (
    <div className="space-y-4">
      {editError && (
        <p
          data-testid="edit-bug-error"
          className="rounded-[var(--radius-control)] border border-[var(--error)] bg-[var(--error)]/10 px-3 py-2 text-[13px] text-[var(--error-foreground)]"
        >
          {editError}
        </p>
      )}
      <Field>
        <FieldLabel>
          Bug Title <span className="text-[var(--error-foreground)]">*</span>
        </FieldLabel>
        <Input
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel>Description</FieldLabel>
        <Textarea
          value={editDesc}
          onChange={(e) => setEditDesc(e.target.value)}
          rows={3}
        />
      </Field>
      {/* Status is edit-only (Create Bug always starts "Open"), so it has no equivalent slot in
          that form's Severity/Priority/Assign-to row. Kept as its own field right before them
          rather than disrupting that row's order. */}
      <Field>
        <FieldLabel>Status</FieldLabel>
        <Select
          value={editStatus}
          onChange={(e) => setEditStatus(e.target.value)}
        >
          <option value="Open">Open</option>
          <option value="In Progress">In Progress</option>
          <option value="Closed">Closed</option>
          <option value="Reopened">Reopened</option>
        </Select>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field>
          <FieldLabel>Severity</FieldLabel>
          <Select value={editSeverity} onChange={(e) => setEditSeverity(e.target.value as BugSeverity)} aria-label="Severity">
            {BUG_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FieldLabel>Priority</FieldLabel>
          <Select
            value={editPriority}
            onChange={(e) => setEditPriority(e.target.value as BugPriority | "")}
            aria-label="Bug priority"
          >
            <option value="">Not set</option>
            {BUG_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FieldLabel>Assign to</FieldLabel>
          <Select
            value={editAssigneeId}
            onChange={(e) => setEditAssigneeId(e.target.value)}
            aria-label="Assign to"
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name || m.email}
              </option>
            ))}
            {/* Current assignee not among this project's members — an AI agent or a stale row.
                Kept visible as a disabled option so Save doesn't silently clear a real
                assignment nobody touched. */}
            {editAssigneeId && !members.some((m) => m.userId === editAssigneeId) && (
              <option value={editAssigneeId} disabled>
                {bug.assigneeName || "Unknown assignee"} (not a project member)
              </option>
            )}
          </Select>
        </Field>
      </div>
      <BugEvidenceField
        mode={editEvidenceMode}
        onModeChange={setEditEvidenceMode}
        stagedFiles={editStagedFiles}
        onStagedFilesChange={setEditStagedFiles}
        existingAttachments={editAttachments}
        onRemoveExisting={handleRemoveEditAttachment}
        downloadUrl={(attachmentId) => getBugAttachmentDownloadUrl(projectId, attachmentId)}
        betterbugsUrl={editBetterbugsUrl}
        onBetterbugsUrlChange={setEditBetterbugsUrl}
      />
      <Field>
        <FieldLabel>
          Linked Test Case(s) &amp; Run(s) {hasTestRuns && <span className="text-[var(--error-foreground)]">*</span>}
        </FieldLabel>
        <TestCaseRunPicker projectId={projectId} value={editLinks} onChange={setEditLinks} />
        {!hasTestRuns && (
          <p className="text-[13px] text-[var(--muted)]">
            This project has no test runs yet, so this bug will stay unlinked. You can link it once a run exists.
          </p>
        )}
      </Field>
      {(jiraConnected || linearConnected) && (
        <Field>
          <FieldLabel>Where should this be tracked?</FieldLabel>
          <TrackingDestinationField destination={editDestination} onChange={setEditDestination} />
        </Field>
      )}
      {(jiraConnected || linearConnected) && editDestination === "SELF" && (
        <SelfLoggedTrackerField
          jiraConnected={jiraConnected}
          linearConnected={linearConnected}
          system={editSelfSystem}
          onSystemChange={handleEditSystemChange}
          url={editUrl}
          onUrlChange={setEditUrl}
          renderUrlField={(system, defaultField) => {
            if (system === "OTHER") return defaultField;
            return (
              <div className="mt-2 space-y-1">
                <div className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--border)] px-3 py-2 text-[13px]">
                  {editSelectedIssue ? (
                    <a
                      href={editSelectedIssue.url || editUrl || undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-[var(--foreground)] hover:underline"
                    >
                      {editSelectedIssue.key}
                      {editSelectedIssue.summary ? ` — ${editSelectedIssue.summary}` : ""}
                    </a>
                  ) : (
                    <span className="text-[var(--muted)]">No issue selected.</span>
                  )}
                  <Button type="button" size="sm" variant="secondary" onClick={() => setEditIssuePickerOpen(true)}>
                    {editSelectedIssue ? "Change issue" : "Select issue"}
                  </Button>
                </div>
                {editIssueRequired && (
                  <p className="text-[13px] text-[var(--error-foreground)]">
                    Select a {system === "JIRA" ? "Jira" : "Linear"} ticket before saving.
                  </p>
                )}
              </div>
            );
          }}
        />
      )}
      {(editSelfSystem === "JIRA" || editSelfSystem === "LINEAR") && (
        <IssuePickerModal
          projectId={projectId}
          testcaseId={null}
          cycleId={null}
          provider={editSelfSystem}
          open={editIssuePickerOpen}
          onClose={() => setEditIssuePickerOpen(false)}
          selectedIssues={editSelectedIssue ? [editSelectedIssue] : []}
          mode="single"
          onConfirm={(issues) => {
            const issue = issues[0] ?? null;
            setEditSelectedIssue(issue);
            setEditUrl(issue?.url ?? "");
          }}
        />
      )}
    </div>
  );

  const saveButton = (
    <Button variant="primary" onClick={handleEditSave} disabled={saveDisabled}>
      {saving ? "Saving…" : "Save Changes"}
    </Button>
  );
  const cancelButton = (
    <Button variant="secondary" onClick={onClose}>
      Cancel
    </Button>
  );

  if (layout === "page") {
    return (
      <div className="space-y-5">
        <section
          aria-label="Edit bug"
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
        >
          <h2 className="mb-3 text-sm font-semibold text-[var(--foreground)]">Edit Bug</h2>
          {fields}
        </section>
        <div className="flex gap-2">
          {saveButton}
          {cancelButton}
        </div>
      </div>
    );
  }

  return (
    <Modal open onClose={onClose} title="Edit Bug">
      <div className="space-y-4">
        {fields}
        <div className="flex justify-end gap-2 pt-2">
          {cancelButton}
          {saveButton}
        </div>
      </div>
    </Modal>
  );
}
