"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { IconHistory, IconMessage } from "@tabler/icons-react";
import BugComments from "@/components/bugs/BugComments";
import BugActivity from "@/components/bugs/BugActivity";

type Tab = "comments" | "activity";

/**
 * Comments and Activity for one bug, as two tabs at the bottom of Bug Details (side panel and full
 * page). Comments is open by default; render with `key={bugId}` so each bug opens on Comments.
 *
 * Both panels stay mounted and the inactive one is only hidden, so switching tabs never throws away
 * an unsent comment or reply, and the Activity count is ready on its tab before it is opened.
 */
export default function BugDiscussion({
  projectId,
  bugId,
  refreshKey,
}: {
  projectId: string;
  bugId: string;
  /** Changes whenever the caller knows the bug changed (edited, file removed), so Activity re-reads. */
  refreshKey: string;
}) {
  const [tab, setTab] = useState<Tab>("comments");
  // Bumped on every comment change, so Activity picks up the new entry without a reload.
  const [commentTick, setCommentTick] = useState(0);
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const [activityCount, setActivityCount] = useState<number | null>(null);
  const id = useId();
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ comments: null, activity: null });

  const tabs: Array<{ key: Tab; label: string; count: number | null; Icon: typeof IconMessage }> = [
    { key: "comments", label: "Comments", count: commentCount, Icon: IconMessage },
    { key: "activity", label: "Activity", count: activityCount, Icon: IconHistory },
  ];

  // Arrow keys move between the two tabs, as a tablist does.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next: Tab =
      event.key === "Home" ? "comments" : event.key === "End" ? "activity" : tab === "comments" ? "activity" : "comments";
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="border-t border-[var(--border)] pt-4">
      <div role="tablist" aria-label="Comments and activity" onKeyDown={onKeyDown} className="mb-4 flex gap-1 border-b border-[var(--border)]">
        {tabs.map(({ key, label, count, Icon }) => {
          const selected = tab === key;
          return (
            <button
              key={key}
              ref={(el) => {
                tabRefs.current[key] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-${key}-tab`}
              aria-selected={selected}
              aria-controls={`${id}-${key}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(key)}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors ${
                selected
                  ? "border-[var(--brand-primary)] text-[var(--accent-light)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              <Icon size={15} stroke={1.75} />
              {label}
              {count ? ` (${count})` : ""}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`${id}-comments-panel`} aria-labelledby={`${id}-comments-tab`} hidden={tab !== "comments"}>
        <BugComments projectId={projectId} bugId={bugId} onCommentAdded={() => setCommentTick((n) => n + 1)} onCountChange={setCommentCount} />
      </div>
      <div role="tabpanel" id={`${id}-activity-panel`} aria-labelledby={`${id}-activity-tab`} hidden={tab !== "activity"}>
        <BugActivity projectId={projectId} bugId={bugId} refreshKey={`${refreshKey}|${commentTick}`} onCountChange={setActivityCount} />
      </div>
    </div>
  );
}
