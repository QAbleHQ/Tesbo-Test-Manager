"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconDownload, IconPlayerStop } from "@tabler/icons-react";
import {
  downloadText,
  fetchNyraExport,
  listNyraItems,
  listNyraRecordings,
  NYRA_ACTIVE,
  NYRA_KINDS,
  nyraFileUrl,
  nyraLiveFrameUrl,
  stopNyraRun,
  useNyraRunStream,
  type NyraApproval,
  type NyraEmbeddings,
  type NyraExport,
  type NyraItem,
  type NyraKind,
  type NyraRecording,
  type NyraRun,
} from "@/lib/nyra";
import { Button, Card, FieldError, Input, PageLoader, StatusChip } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import NyraItemCard from "@/components/nyra/NyraItemCard";
import NyraReviewTab from "@/components/nyra/NyraReviewTab";

type Tab = "overview" | "findings" | "review" | "knowledge" | "rules" | "report" | "recording" | "log";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "findings", label: "Findings" },
  { key: "review", label: "Review" },
  { key: "knowledge", label: "Knowledge file" },
  { key: "rules", label: "Business rules" },
  { key: "report", label: "Report" },
  { key: "recording", label: "Recording" },
  { key: "log", label: "Log" },
];

export const runTone = (s: NyraRun["status"]) =>
  s === "completed" ? "success" : s === "failed" ? "error" : s === "partial" ? "warning" : s === "running" ? "running" : "neutral";

const errText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

export default function NyraRunView({ projectId, nyraId, run, canApprove }: { projectId: string; nyraId: string; run: NyraRun; canApprove: boolean }) {
  const [tab, setTab] = useState<Tab>("overview");
  const active = NYRA_ACTIVE.has(run.status);
  // Live events while the scan runs. For a finished scan the same stream replays its log, so it opens only for the Log tab.
  const stream = useNyraRunStream(projectId, nyraId, run.id, active || tab === "log");

  const [saved, setSaved] = useState<{ list: NyraItem[]; approval: NyraApproval | null; embeddings: NyraEmbeddings } | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    setSaved(null);
    setSavedError(null);
    setTab("overview");
  }, [run.id]);
  // NYRA saves results when the scan ends, and sets the run's status after saving, so the run status is the end signal.
  useEffect(() => {
    if (active) return;
    let cancelled = false;
    listNyraItems(projectId, nyraId, run.id)
      .then((r) => !cancelled && setSaved({ list: r.list, approval: r.approval, embeddings: r.embeddings }))
      .catch((err) => !cancelled && setSavedError(errText(err, "Could not load the results.")));
    return () => {
      cancelled = true;
    };
  }, [projectId, nyraId, run.id, active, reloads]);

  const items = active ? stream.items : (saved?.list ?? null);
  const counts = useMemo(() => {
    const c: Partial<Record<NyraKind, number>> = {};
    for (const i of items ?? []) c[i.kind] = (c[i.kind] ?? 0) + 1;
    return c;
  }, [items]);

  return (
    <div className="min-w-0 space-y-4">
      <div role="tablist" aria-label="Scan results" className="flex flex-wrap gap-1 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors ${
              tab === t.key ? "border-[var(--brand-primary)] text-[var(--accent-light)]" : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview projectId={projectId} nyraId={nyraId} run={run} active={active} stream={stream} counts={counts} />}
      {tab === "findings" && <Findings items={items} error={savedError} active={active} projectId={projectId} nyraId={nyraId} runId={run.id} />}
      {tab === "review" && (
        <>
          {active && <Card className="p-5 text-sm text-[var(--muted)]">NYRA saves its findings when the scan finishes. Review opens then.</Card>}
          {!active && savedError && <FieldError>{savedError}</FieldError>}
          {!active && !savedError && !saved && <PageLoader label="Loading findings…" />}
          {!active && saved && (
            <NyraReviewTab
              projectId={projectId}
              nyraId={nyraId}
              runId={run.id}
              items={saved.list}
              approval={saved.approval}
              embeddings={saved.embeddings}
              canApprove={canApprove}
              onItem={(item) => setSaved((cur) => cur && { ...cur, list: cur.list.map((i) => (i.kind === item.kind && i.key === item.key ? item : i)) })}
              onApproved={(approval, embeddings) => setSaved((cur) => cur && { ...cur, approval, embeddings })}
              onReload={() => setReloads((n) => n + 1)}
            />
          )}
        </>
      )}
      {tab === "knowledge" && <ExportText key={`k-${run.id}`} projectId={projectId} nyraId={nyraId} run={run} file="knowledge.md" empty="NYRA found nothing to put in a knowledge file." />}
      {tab === "rules" && <ExportText key={`r-${run.id}`} projectId={projectId} nyraId={nyraId} run={run} file="business-rules.md" empty="NYRA found no business rules in this scan." />}
      {tab === "report" && <Report items={items} error={savedError} active={active} projectId={projectId} nyraId={nyraId} run={run} />}
      {tab === "recording" && <Recording key={`v-${run.id}`} projectId={projectId} nyraId={nyraId} run={run} active={active} />}
      {tab === "log" && <Log stream={stream} active={active} />}
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({
  projectId,
  nyraId,
  run,
  active,
  stream,
  counts,
}: {
  projectId: string;
  nyraId: string;
  run: NyraRun;
  active: boolean;
  stream: ReturnType<typeof useNyraRunStream>;
  counts: Partial<Record<NyraKind, number>>;
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setStopping(true);
    setError(null);
    try {
      await stopNyraRun(projectId, nyraId, run.id);
    } catch (err) {
      setError(errText(err, "Could not stop the scan."));
    } finally {
      setStopping(false);
    }
  }

  const s = run.summary;
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <StatusChip tone={runTone(run.status)}>{run.status}</StatusChip>
            {active && stream.live === false && <span className="text-[12px] text-[var(--muted)]">Live updates unavailable; status refreshes every few seconds.</span>}
          </div>
          {active && (
            <Button type="button" variant="secondary" onClick={stop} disabled={stopping}>
              <IconPlayerStop size={15} stroke={1.75} /> {stopping ? "Stopping…" : "Stop scan"}
            </Button>
          )}
        </div>
        {error && <FieldError className="mt-2">{error}</FieldError>}
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-4">
          <Stat name="Started">{run.startedAt ? formatDateTime(run.startedAt) : "Waiting to start"}</Stat>
          <Stat name="Finished">{run.finishedAt ? formatDateTime(run.finishedAt) : "—"}</Stat>
          <Stat name="Pages visited">{s.pagesVisited ?? (active ? "…" : "—")}</Stat>
          <Stat name="Findings">{active || total ? total : "—"}</Stat>
          <Stat name="Budget">
            {run.budget.maxPages} pages · {run.budget.maxMinutes} min · depth {run.budget.maxDepth}
          </Stat>
          {s.reason && <Stat name="Ended because">{s.reason}</Stat>}
        </dl>
        {!active && Object.keys(s.counts).length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {NYRA_KINDS.filter((k) => s.counts[k.key]).map((k) => (
              <span key={k.key} className="rounded-full bg-[var(--surface-secondary)] px-2.5 py-1 text-[11px] text-[var(--muted)]">
                {k.label} {s.counts[k.key]}
              </span>
            ))}
          </div>
        )}
      </Card>

      {(active || run.status === "completed" || run.status === "partial" || run.status === "stopped") && (
        <LiveFrame key={run.id} url={nyraLiveFrameUrl(projectId, nyraId, run.id)} active={active} />
      )}

      {active && stream.digest && (
        <Card className="p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-soft)]">What the agent is reading</div>
          <div className="mb-1 break-all text-[12px] text-[var(--muted)]">{stream.digest.url}</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--surface-secondary)] p-3 text-[12px] text-[var(--foreground)]">{stream.digest.text}</pre>
        </Card>
      )}
    </div>
  );
}

/**
 * NYRA's browser, one frame at a time. The next frame is requested only after the last one answered:
 * a fixed timer plus a changing <img> src cancelled every frame slower than the timer, so the picture
 * could stay blank. 204 means NYRA has no frame yet, which is not a failure while the scan runs.
 * A finished scan keeps its last frame, so it is requested once.
 */
function LiveFrame({ url, active }: { url: string; active: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const current = useRef<string | null>(null);
  // Read inside the loop, so the scan ending does not restart it: that aborted the request in flight,
  // which showed up as a cancelled live.jpg at the very moment the results loaded.
  const activeNow = useRef(active);
  activeNow.current = active;

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let misses = 0;
    async function pull() {
      const startedAt = Date.now();
      const wasActive = activeNow.current;
      try {
        const res = await fetch(url, { credentials: "include", signal: abort.signal });
        if (res.status === 200) {
          const next = URL.createObjectURL(await res.blob());
          if (current.current) URL.revokeObjectURL(current.current);
          current.current = next;
          setSrc(next);
          setFailed(false);
          misses = 0;
        } else {
          misses++;
        }
      } catch {
        if (abort.signal.aborted) return;
        misses++;
      }
      if (abort.signal.aborted) return;
      if (activeNow.current) {
        // NYRA makes one frame a second: count the request's own time towards that second.
        timer = setTimeout(pull, misses ? Math.min(1500 * misses, 5000) : Math.max(0, 1000 - (Date.now() - startedAt)));
      } else if (wasActive) {
        void pull(); // the scan ended while this request was in flight: fetch its last frame once
      } else if (misses) {
        setFailed(true);
      }
    }
    void pull();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [url]);
  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    []
  );

  if (failed && !src) return null;
  return (
    <Card className="p-4">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-soft)]">{active ? "Live browser" : "Last frame"}</div>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="NYRA's browser" className="w-full rounded-md border border-[var(--border-subtle)]" />
      ) : (
        <div className="text-[13px] text-[var(--muted)]">Waiting for the first frame…</div>
      )}
    </Card>
  );
}

function Stat({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-soft)]">{name}</dt>
      <dd className="mt-0.5 break-words text-[var(--foreground)]">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------- findings

const FINDING_COLUMNS: NyraKind[] = ["screen", "feature", "workflow", "business_rule"];

function Findings({ items, error, active, projectId, nyraId, runId }: { items: NyraItem[] | null; error: string | null; active: boolean; projectId: string; nyraId: string; runId: string }) {
  if (error) return <FieldError>{error}</FieldError>;
  if (!items) return <PageLoader label="Loading findings…" />;
  if (!items.length) return <Card className="p-5 text-sm text-[var(--muted)]">{active ? "Nothing found yet. Findings appear here as NYRA works." : "This scan found nothing."}</Card>;
  return (
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
      {FINDING_COLUMNS.map((kind) => {
        const rows = items.filter((i) => i.kind === kind);
        return (
          <section key={kind} aria-label={NYRA_KINDS.find((k) => k.key === kind)!.label} className="min-w-0 space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-[var(--muted)]">
              {NYRA_KINDS.find((k) => k.key === kind)!.label} <span className="ml-1 rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px]">{rows.length}</span>
            </h3>
            {rows.map((i) => (
              <NyraItemCard key={`${i.kind}:${i.key}`} item={i} projectId={projectId} nyraId={nyraId} runId={runId} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- knowledge file / business rules

function ExportText({ projectId, nyraId, run, file, empty }: { projectId: string; nyraId: string; run: NyraRun; file: NyraExport; empty: string }) {
  const active = NYRA_ACTIVE.has(run.status);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (active) return;
    let cancelled = false;
    fetchNyraExport(projectId, nyraId, run.id, file)
      .then((t) => !cancelled && setText(t))
      .catch((err) => !cancelled && setError(errText(err, "Could not load this file.")));
    return () => {
      cancelled = true;
    };
  }, [projectId, nyraId, run.id, file, active]);

  if (active) return <Card className="p-5 text-sm text-[var(--muted)]">This file is built when the scan finishes.</Card>;
  if (error) return <FieldError>{error}</FieldError>;
  if (text === null) return <PageLoader label="Loading…" />;
  if (!text.trim()) return <Card className="p-5 text-sm text-[var(--muted)]">{empty}</Card>;
  return (
    <Card className="p-4">
      <div className="mb-3 flex justify-end">
        <Button type="button" variant="secondary" onClick={() => downloadText(text, `nyra-${run.id.slice(0, 8)}-${file}`, "text/markdown")}>
          <IconDownload size={15} stroke={1.75} /> Download
        </Button>
      </div>
      {/* Markdown from a scanned site is shown as plain text, never rendered as HTML. */}
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap text-[13px] leading-6 text-[var(--foreground)]">{text}</pre>
    </Card>
  );
}

// ---------------------------------------------------------------- report

function Report({ items, error, active, projectId, nyraId, run }: { items: NyraItem[] | null; error: string | null; active: boolean; projectId: string; nyraId: string; run: NyraRun }) {
  const [kind, setKind] = useState<NyraKind>("screen");
  const [query, setQuery] = useState("");
  const [csvError, setCsvError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((i) => i.kind === kind && (!q || `${i.title} ${JSON.stringify(i.data)}`.toLowerCase().includes(q)));
  }, [items, kind, query]);

  if (error) return <FieldError>{error}</FieldError>;
  if (!items) return <PageLoader label="Loading report…" />;

  async function downloadCsv() {
    setCsvError(null);
    try {
      downloadText(await fetchNyraExport(projectId, nyraId, run.id, "test-cases.csv"), `nyra-${run.id.slice(0, 8)}-test-cases.csv`, "text/csv");
    } catch (err) {
      setCsvError(errText(err, "Could not download the test cases."));
    }
  }

  return (
    <div className="space-y-4">
      {active && <p className="text-[13px] text-[var(--muted)]">The scan is still running. This list grows as NYRA finds things.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Report sections" className="flex flex-wrap gap-1">
          {NYRA_KINDS.map((k) => {
            const n = items.filter((i) => i.kind === k.key).length;
            return (
              <button
                key={k.key}
                type="button"
                role="tab"
                aria-selected={kind === k.key}
                onClick={() => setKind(k.key)}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                  kind === k.key ? "bg-[var(--brand-primary)] text-white" : "bg-[var(--surface-secondary)] text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {k.label} {n}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Input aria-label="Search the report" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} className="w-48" />
          {kind === "test_case" && !active && (
            <Button type="button" variant="secondary" onClick={downloadCsv}>
              <IconDownload size={15} stroke={1.75} /> CSV
            </Button>
          )}
        </div>
      </div>
      {csvError && <FieldError>{csvError}</FieldError>}
      {rows.length === 0 ? (
        <Card className="p-5 text-sm text-[var(--muted)]">{query ? "Nothing matches that search." : "Nothing of this kind was found."}</Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((i) => (
            <NyraItemCard key={`${i.kind}:${i.key}`} item={i} projectId={projectId} nyraId={nyraId} runId={run.id} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- recording

function Recording({ projectId, nyraId, run, active }: { projectId: string; nyraId: string; run: NyraRun; active: boolean }) {
  const [list, setList] = useState<NyraRecording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (active) return;
    let cancelled = false;
    listNyraRecordings(projectId, nyraId, run.id)
      .then((r) => !cancelled && setList(r.list))
      .catch((err) => !cancelled && setError(errText(err, "Could not load the recording.")));
    return () => {
      cancelled = true;
    };
  }, [projectId, nyraId, run.id, active]);

  if (active) return <Card className="p-5 text-sm text-[var(--muted)]">The recording is saved when the scan finishes. Watch the live browser on the Overview tab meanwhile.</Card>;
  if (error) return <FieldError>{error}</FieldError>;
  if (!list) return <PageLoader label="Loading recording…" />;
  if (!list.length) return <Card className="p-5 text-sm text-[var(--muted)]">This scan has no recording.</Card>;
  return (
    <div className="space-y-4">
      {list.map((rec) => {
        const url = nyraFileUrl(projectId, nyraId, run.id, "recordings", rec.name);
        return (
          <Card key={rec.name} className="p-4">
            {/* The file is served by Tesbo with Range support, so the player can seek without downloading it all. */}
            <video controls preload="metadata" src={url} className="w-full rounded-md bg-black" />
            <div className="mt-2 flex items-center justify-between text-[12px] text-[var(--muted)]">
              <span>
                {rec.name} · {(rec.sizeBytes / (1024 * 1024)).toFixed(1)} MB
              </span>
              <a href={url} download={rec.name} className="font-medium text-[var(--accent-light)] hover:underline">
                Download
              </a>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- log

const LOG_TONE: Record<string, string> = { error: "text-[var(--error-foreground)]", warn: "text-[var(--warning,#b7791f)]" };

function Log({ stream, active }: { stream: ReturnType<typeof useNyraRunStream>; active: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const scroll = useCallback(() => end.current?.scrollIntoView({ block: "nearest" }), []);
  useEffect(() => {
    if (follow) scroll();
  }, [stream.log.length, follow, scroll]);

  if (!stream.log.length) {
    return (
      <Card className="p-5 text-sm text-[var(--muted)]">
        {stream.live ? "Waiting for the first log line…" : active ? "Log unavailable right now." : "NYRA keeps a scan's log for 7 days. This one is empty or has expired."}
      </Card>
    );
  }
  return (
    <Card className="p-0">
      <div className="max-h-[65vh] overflow-auto p-4 font-mono text-[12px] leading-5" onScroll={(e) => setFollow(e.currentTarget.scrollTop + e.currentTarget.clientHeight >= e.currentTarget.scrollHeight - 24)}>
        {stream.log.map((l) => (
          <div key={l.id} className={LOG_TONE[l.level] ?? "text-[var(--foreground)]"}>
            <span className="mr-2 text-[var(--muted-soft)]">{l.ts.slice(11, 19)}</span>
            {l.message}
          </div>
        ))}
        <div ref={end} />
      </div>
    </Card>
  );
}
