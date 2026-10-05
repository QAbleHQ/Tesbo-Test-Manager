"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  deleteBug,
  getBug,
  getJiraStatus,
  getLinearStatus,
  listTestRuns,
  type BugItem,
} from "@/lib/api";
import { Button, Modal, PageLoader } from "@/components/ui";
import { Breadcrumbs } from "@/components/workflows";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";
import { BugStatusBadge } from "@/components/bugs/BugBadges";
import BugActivity from "@/components/bugs/BugActivity";
import BugComments from "@/components/bugs/BugComments";
import BugDetailsBody from "@/components/bugs/BugDetailsBody";
import EditBugModal from "@/components/bugs/EditBugModal";

/*
 * Full-page view of one bug — the "Open full page" target of the Bug Details side panel on the
 * bugs screen, as the execute page is for the Test Run panel. Same fields (BugDetailsBody) and the
 * same Edit / Delete actions as the panel. Edit happens in place (EditBugModal layout="page"),
 * like the execute page, rather than in a dialog; Delete returns to the bugs list.
 */
export default function BugDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const bugId = params.bugId as string;
  const { currentUser } = useAppData();
  const { project } = useProjectData();
  const projectName = String(project.name || "");

  const [bug, setBug] = useState<BugItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  // ?edit=1 is how the Bug Details panel's Edit opens this page straight into the edit form.
  const [editing, setEditing] = useState(searchParams.get("edit") === "1");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Bumped when a comment is posted, so the Activity section re-reads its entries.
  const [commentTick, setCommentTick] = useState(0);

  /* Same gates the bugs list passes to Edit Bug. */
  const [jiraConnected, setJiraConnected] = useState(false);
  const [linearConnected, setLinearConnected] = useState(false);
  const [hasTestRuns, setHasTestRuns] = useState(false);

  const load = useCallback(() => {
    getBug(bugId)
      .then((b) => {
        setBug(b);
        setNotFound(false);
      })
      .catch(() => setNotFound(true));
  }, [bugId]);

  useEffect(() => {
    if (!currentUser) {
      router.replace("/login");
      return;
    }
    load();
  }, [currentUser, router, load]);

  useEffect(() => {
    getJiraStatus(projectId).then((s) => setJiraConnected(s.connected)).catch(() => setJiraConnected(false));
    getLinearStatus(projectId).then((s) => setLinearConnected(s.connected)).catch(() => setLinearConnected(false));
    listTestRuns(projectId).then((runs) => setHasTestRuns(runs.length > 0)).catch(() => setHasTestRuns(false));
  }, [projectId]);

  async function handleDelete() {
    if (!bug || deleting) return;
    setDeleting(true);
    try {
      await deleteBug(bug.id);
      router.push(`/projects/${projectId}/bugs`);
    } catch {
      setDeleting(false);
    }
  }

  const breadcrumbs = (
    <header className="border-b border-[var(--border)] bg-[var(--surface)] px-6 py-3">
      <Breadcrumbs
        items={[
          { label: "Projects", href: "/projects" },
          { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
          { label: "Bugs", href: `/projects/${projectId}/bugs` },
          { label: bug ? bug.integrationIssueKey || bug.externalId : "Bug" },
        ]}
      />
    </header>
  );

  if (notFound) {
    return (
      <div className="min-h-screen bg-[var(--background)]">
        {breadcrumbs}
        <main className="w-full px-6 py-8">
          <p className="text-sm text-[var(--muted)]">This bug could not be found. It may have been deleted.</p>
          <Link
            href={`/projects/${projectId}/bugs`}
            className="mt-3 inline-block text-[12.5px] font-medium hover:underline"
            style={{ color: "var(--accent-light)" }}
          >
            Back to Bugs
          </Link>
        </main>
      </div>
    );
  }

  if (!bug) {
    return <PageLoader variant="screen" />;
  }

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {breadcrumbs}

      <main className="w-full px-6 py-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            {/* Same "Bug Key" fallback as the panel: tracker key, else the bug's own id. */}
            <p className="mb-1 font-mono text-xs text-[var(--muted-soft)]">{bug.integrationIssueKey || bug.externalId}</p>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="break-words text-xl font-bold text-[var(--foreground)]">{bug.title}</h1>
              <BugStatusBadge status={bug.status} />
            </div>
          </div>
          {/* While editing, the form below owns the actions (Save Changes / Cancel), as on the
              Test Run execute page. */}
          {!editing && (
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="primary" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmingDelete(true)}
                className="!bg-transparent !text-[var(--error-foreground)] hover:!bg-[var(--error)]/10 hover:!opacity-100"
              >
                Delete Bug
              </Button>
            </div>
          )}
        </div>

        {editing ? (
          <EditBugModal
            key={bug.id}
            layout="page"
            projectId={projectId}
            bug={bug}
            jiraConnected={jiraConnected}
            linearConnected={linearConnected}
            hasTestRuns={hasTestRuns}
            onClose={() => {
              setEditing(false);
              // Drop ?edit=1 so a refresh shows the bug rather than reopening the form.
              if (searchParams.get("edit")) router.replace(`/projects/${projectId}/bugs/${bugId}`, { scroll: false });
            }}
            onChanged={load}
          />
        ) : (
          <section
            aria-label="Bug details"
            className="space-y-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
          >
            <BugDetailsBody bug={bug} projectId={projectId} onAttachmentDeleted={load} />
            {/* Activity under Comments at every width, as in the side panel: the discussion keeps
                the full width, and the history reads after it. */}
            <BugComments key={bug.id} projectId={projectId} bugId={bug.id} onCommentAdded={() => setCommentTick((n) => n + 1)} />
            <BugActivity
              key={`activity-${bug.id}`}
              projectId={projectId}
              bugId={bug.id}
              refreshKey={`${bug.updatedAt}|${bug.attachments.length}|${commentTick}`}
            />
          </section>
        )}
      </main>

      <Modal open={confirmingDelete} onClose={() => setConfirmingDelete(false)} title="Delete Bug">
        <p className="text-sm text-[var(--muted)] mb-6">
          Are you sure you want to delete this bug? This action cannot be
          undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
