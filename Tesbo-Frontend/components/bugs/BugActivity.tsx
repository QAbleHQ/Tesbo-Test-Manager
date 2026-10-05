"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listActivity, type ActivityLogItem } from "@/lib/api";
import { Button } from "@/components/ui";
import { ActorAvatar, formatAbsolute, safeParseDiff, titleCase } from "@/components/activity/activityShared";

// The feed caps a page at 100 rows; a bug's own history rarely comes close, but it is read to the
// end (up to this many pages) so the section really does run from creation onwards.
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const FIELD_LABELS: Record<string, string> = {
  title: "title",
  description: "description",
  externalUrl: "bug link",
  integrationProvider: "tracker",
  integrationIssueKey: "tracker issue",
  betterbugsUrl: "BetterBugs session",
  links: "linked test cases",
};

function Mention({ name }: { name: string }) {
  return <span className="font-medium text-[var(--accent-light)]">@{name}</span>;
}

function Value({ children }: { children: ReactNode }) {
  return <span className="font-medium text-[var(--foreground)]">{children}</span>;
}

/** What the actor did, as the rest of a sentence that starts with their name. */
function describe(item: ActivityLogItem): ReactNode {
  const diff = safeParseDiff(item.diff) ?? {};
  const text = (v: unknown, empty = "None") => (typeof v === "string" && v ? v : empty);
  const change = (field: string) => (
    <>
      changed {field} from <Value>{text(diff.from)}</Value> to <Value>{text(diff.to)}</Value>
    </>
  );
  switch (item.action) {
    case "bug_created":
    case "created":
      return "created the bug";
    case "updated":
      return "updated the bug";
    case "bug_status_changed":
      return diff.to === "Closed" ? (
        <>
          closed the bug (was <Value>{text(diff.from)}</Value>)
        </>
      ) : (
        change("status")
      );
    case "bug_severity_changed":
      return change("severity");
    case "bug_priority_changed":
      return change("priority");
    case "bug_assignee_changed":
      return typeof diff.toName === "string" && diff.toName ? (
        <>
          assigned the bug to <Mention name={diff.toName} />
        </>
      ) : typeof diff.fromName === "string" && diff.fromName ? (
        <>
          unassigned <Mention name={diff.fromName} />
        </>
      ) : (
        "unassigned the bug"
      );
    case "bug_updated": {
      const fields = Array.isArray(diff.fields) ? (diff.fields as string[]).map((f) => FIELD_LABELS[f] || f) : [];
      return fields.length ? `edited the bug (${fields.join(", ")})` : "edited the bug";
    }
    case "bug_attachment_added":
      return (
        <>
          added attachment <Value>{text(diff.fileName, "a file")}</Value>
        </>
      );
    case "bug_attachment_deleted":
      return (
        <>
          deleted attachment <Value>{text(diff.fileName, "a file")}</Value>
        </>
      );
    case "commented":
      return "added a comment";
    case "replied":
      return "replied to a comment";
    case "comment_edited":
      return diff.parentCommentId ? "edited a reply" : "edited a comment";
    case "comment_deleted": {
      if (diff.parentCommentId) return "deleted a reply";
      const replies = typeof diff.repliesDeleted === "number" ? diff.repliesDeleted : 0;
      return replies ? `deleted a comment and its ${replies} ${replies === 1 ? "reply" : "replies"}` : "deleted a comment";
    }
    case "bug_mentioned":
      return (
        <>
          mentioned <Mention name={text(diff.mentionedName, "someone")} /> in a comment
        </>
      );
    case "bug_deleted":
      return "deleted the bug";
    default:
      return titleCase(item.action).toLowerCase();
  }
}

/**
 * The bug's history, oldest first, in the Activity tab of Bug Details (BugDiscussion). Reads the
 * project activity feed filtered to this bug rather than a bug-specific endpoint — the rows are the same audit_logs rows
 * the Activity stream shows. `refreshKey` changes whenever the caller knows the bug has changed
 * (edited, file removed, comment posted) so the list is re-read.
 */
export default function BugActivity({
  projectId,
  bugId,
  refreshKey,
  onCountChange,
}: {
  projectId: string;
  bugId: string;
  refreshKey?: string | number;
  /** Number of entries, for the tab label; null while loading or after a failed load. */
  onCountChange?: (count: number | null) => void;
}) {
  const [items, setItems] = useState<ActivityLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const all: ActivityLogItem[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await listActivity(projectId, { entityType: "bug", entityId: bugId, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
        all.push(...data.list);
        if (data.list.length < PAGE_SIZE || all.length >= data.total) break;
      }
      setItems(all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load activity.");
    } finally {
      setLoading(false);
    }
  }, [projectId, bugId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const count = loading || loadError ? null : items.length;
  useEffect(() => {
    onCountChange?.(count);
  }, [count, onCountChange]);

  return (
    // Titled by its tab in BugDiscussion, which also shows the count.
    <section aria-label="Activity">
      {loading ? (
        <p className="text-[13px] text-[var(--muted)]">Loading activity…</p>
      ) : loadError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-3 py-2 text-[13px] text-[var(--error-foreground)]"
        >
          <span>Couldn&apos;t load activity: {loadError}</span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-[var(--muted-soft)]">No activity yet.</p>
      ) : (
        <ol className="space-y-3">
          {items.map((item) => {
            const actor = item.actorKind === "agent" ? item.actorName || "Zyra" : item.actorName || item.actorEmail || "System";
            return (
              <li key={item.id} data-testid="bug-activity" data-action={item.action} className="flex items-start gap-2.5">
                <ActorAvatar item={item} />
                <div className="min-w-0 flex-1 pt-0.5">
                  <p className="break-words text-[13px] text-[var(--muted)]">
                    <span data-testid="bug-activity-actor" className="font-semibold text-[var(--foreground)]">
                      {actor}
                    </span>{" "}
                    {describe(item)}
                  </p>
                  <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()} className="text-[11px] text-[var(--muted-soft)]">
                    {formatAbsolute(item.createdAt)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
