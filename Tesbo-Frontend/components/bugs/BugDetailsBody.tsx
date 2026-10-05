"use client";

import type { BugItem } from "@/lib/api";
import BugAttachments from "@/components/bugs/BugAttachments";
import { BugAssignee, BugPriorityBadge, BugSeverityBadge, BugStatusBadge } from "@/components/bugs/BugBadges";

/*
 * Every read-only field of a bug, in the order the bugs screen has always shown them. Rendered by
 * both the Bug Details side panel and the full-page bug view, so the two cannot drift apart.
 * Layout (padding, scrolling, header, actions) belongs to the caller.
 */
export default function BugDetailsBody({
  bug,
  projectId,
  onAttachmentDeleted,
}: {
  bug: BugItem;
  projectId: string;
  /** Called after an attachment is deleted from the Attachments section, to refresh the bug. */
  onAttachmentDeleted: (attachmentId: string) => void;
}) {
  return (
    <>
      {/* Description */}
      {bug.description && (
        <div>
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
            Description
          </p>
          <div className="rounded-lg bg-[var(--background)] border border-[var(--border-subtle)] p-3">
            <p className="text-sm text-[var(--foreground)] whitespace-pre-wrap break-words">
              {bug.description}
            </p>
          </div>
        </div>
      )}

      {/* Bug Link */}
      {bug.externalUrl && (
        <div>
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
            {bug.integrationProvider ? `${bug.integrationProvider === "JIRA" ? "Jira" : "Linear"} Ticket` : "Bug Link"}
          </p>
          <a
            href={bug.externalUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--accent-light)] hover:underline break-all"
          >
            <svg
              className="w-4 h-4 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
            {bug.integrationIssueKey || bug.externalUrl}
          </a>
        </div>
      )}

      {/* Evidence */}
      {bug.betterbugsUrl ? (
        <div>
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">BetterBugs Session</p>
          <a
            href={bug.betterbugsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--accent-light)] hover:underline break-all"
          >
            {bug.betterbugsUrl}
          </a>
        </div>
      ) : bug.attachments.length > 0 ? (
        <BugAttachments projectId={projectId} attachments={bug.attachments} onDeleted={onAttachmentDeleted} />
      ) : null}

      {/* Severity / Priority / Status — read-only here; Edit Bug is where they change. These
          used to sit unlabelled beside the title, where an untriaged bug's priority rendered as
          a bare "—" that read as a separator rather than a value. */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
            Severity
          </p>
          {bug.severity ? (
            <BugSeverityBadge severity={bug.severity} />
          ) : (
            <span className="text-sm text-[var(--muted-soft)]">Not selected</span>
          )}
        </div>
        <div>
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
            Priority
          </p>
          {bug.priority ? (
            <BugPriorityBadge priority={bug.priority} />
          ) : (
            <span className="text-sm text-[var(--muted-soft)]">Not selected</span>
          )}
        </div>
        <div>
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
            Status
          </p>
          <BugStatusBadge status={bug.status} />
        </div>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
            Linked Test Cases &amp; Runs
          </p>
          {bug.links.length ? (
            <ul className="space-y-1">
              {bug.links.map((link) => (
                <li key={link.id} className="text-sm text-[var(--foreground)]">
                  <span className="font-mono text-xs text-[var(--muted-soft)]">{link.testcaseExternalId}</span>{" "}
                  {link.testcaseTitle}
                  <span className="text-[var(--muted)]"> — {link.cycleName}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-sm text-[var(--muted-soft)]">Not linked</span>
          )}
        </div>
        <div>
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
            Reported By
          </p>
          <span className="text-sm text-[var(--foreground)]">
            {bug.reporterName || bug.reporterEmail || "Unknown"}
          </span>
        </div>
        <div>
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
            Assigned To
          </p>
          <BugAssignee id={bug.assigneeId} name={bug.assigneeName} />
        </div>
        <div>
          <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
            Reported On
          </p>
          <span className="text-sm text-[var(--foreground)]">
            {new Date(bug.createdAt).toLocaleString()}
          </span>
        </div>
      </div>

      {bug.updatedAt !== bug.createdAt && (
        <p className="text-xs text-[var(--muted-soft)]">
          Last updated: {new Date(bug.updatedAt).toLocaleString()}
        </p>
      )}
    </>
  );
}
