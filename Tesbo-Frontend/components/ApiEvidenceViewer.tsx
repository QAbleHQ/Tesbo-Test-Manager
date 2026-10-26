"use client";

import { useState } from "react";
import { IconDownload } from "@tabler/icons-react";
import { getExecutionApiEvidence, type ExecutionEvidence } from "@/lib/api";
import {
  parseApiEvidence,
  redactHeaderValue,
  truncateBody,
  type ApiCall,
  type ApiMessage,
} from "@/lib/apiEvidence";
import { formatFileSizeShort } from "@/lib/validation";

/*
 * One `api` evidence file — an API call (or several, for a HAR) captured by an automated test —
 * shown as method, URL, status, duration, headers and body instead of a .json download.
 *
 * The content is fetched through the API (getExecutionApiEvidence) only when View is pressed, so a
 * run with many captured calls doesn't pull every body just to draw the list. Credential headers
 * are masked for display only; the stored file and its download are untouched.
 */

function statusTone(status: number | null): string {
  if (status === null) return "text-[var(--muted)]";
  if (status >= 500) return "text-[var(--error-foreground,var(--error))]";
  if (status >= 400) return "text-[var(--warning-foreground,var(--muted))]";
  return "text-[var(--accent-light)]";
}

function MessageView({ title, message, testId }: { title: string; message: ApiMessage; testId: string }) {
  const body = message.body === null ? null : truncateBody(message.body);
  return (
    <div className="min-w-0 space-y-1" data-testid={testId}>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">{title}</p>
      {message.headers.length > 0 && (
        <dl className="space-y-0.5 font-mono text-[11px]" data-testid={`${testId}-headers`}>
          {message.headers.map(([name, value], i) => (
            <div key={`${name}-${i}`} className="flex gap-1.5">
              <dt className="shrink-0 text-[var(--muted)]">{name}:</dt>
              <dd className="min-w-0 break-all text-[var(--foreground)]">{redactHeaderValue(name, value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {body ? (
        <>
          <pre
            data-testid={`${testId}-body`}
            className="max-h-[260px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-2 font-mono text-[11px] text-[var(--foreground)]"
          >
            {body.text}
          </pre>
          {body.truncated && (
            <p className="text-[11px] text-[var(--muted-soft)]">Body truncated for display — download the file for the full content.</p>
          )}
        </>
      ) : (
        <p className="text-[11.5px] text-[var(--muted-soft)]">No body.</p>
      )}
    </div>
  );
}

function CallView({ call }: { call: ApiCall }) {
  return (
    <div className="space-y-2 rounded-lg border border-[var(--border-subtle)] p-2.5" data-testid="api-evidence-call">
      <p className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
        <span className="font-mono font-semibold text-[var(--foreground)]" data-testid="api-evidence-method">{call.method}</span>
        <span className="min-w-0 break-all font-mono text-[var(--foreground)]" data-testid="api-evidence-url">{call.url}</span>
        <span className={`font-mono font-semibold ${statusTone(call.status)}`} data-testid="api-evidence-status">
          {call.status ?? "—"}
          {call.statusText ? ` ${call.statusText}` : ""}
        </span>
        {call.durationMs !== null && (
          <span className="font-mono text-[11px] text-[var(--muted-soft)]" data-testid="api-evidence-duration">{call.durationMs} ms</span>
        )}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <MessageView title="Request" message={call.request} testId="api-evidence-request" />
        <MessageView title="Response" message={call.response} testId="api-evidence-response" />
      </div>
    </div>
  );
}

interface Props {
  cycleId: string;
  executionId: string;
  file: ExecutionEvidence;
  downloadUrl: string;
  removeButton?: React.ReactNode;
}

export default function ApiEvidenceViewer({ cycleId, executionId, file, downloadUrl, removeButton }: Props) {
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState<ApiCall[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || calls !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getExecutionApiEvidence(cycleId, executionId, file.id);
      const parsed = parseApiEvidence(res.data);
      if (parsed.length === 0) {
        setError("This file isn't a recognised API call format (expected a HAR or a { method, url, status, request, response } object).");
      } else {
        setCalls(parsed);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load this API evidence.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <li className="space-y-1.5">
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-2.5 py-1.5 text-[12.5px]">
        <span className="truncate text-[var(--foreground)]">{file.fileName}</span>
        {file.fileSize != null && (
          <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--muted-soft)]">{formatFileSizeShort(file.fileSize)}</span>
        )}
        <button
          type="button"
          onClick={() => void toggle()}
          aria-expanded={open}
          data-testid="evidence-view-api"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--accent-light)] hover:underline"
        >
          {open ? "Hide" : "View"}
        </button>
        <a
          href={downloadUrl}
          aria-label={`Download ${file.fileName}`}
          title="Download"
          className="shrink-0 text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          <IconDownload size={13} />
        </a>
        {removeButton}
      </div>
      {open && loading && <p className="text-[12px] text-[var(--muted)]">Loading…</p>}
      {open && error && (
        <p data-testid="api-evidence-error" className="rounded-lg border border-[var(--error)] px-2.5 py-1.5 text-[12px] text-[var(--error-foreground,var(--error))]">
          {error}
        </p>
      )}
      {open && calls && (
        <div className="space-y-2" data-testid="api-evidence-viewer">
          {calls.map((call, i) => (
            <CallView key={i} call={call} />
          ))}
        </div>
      )}
    </li>
  );
}
