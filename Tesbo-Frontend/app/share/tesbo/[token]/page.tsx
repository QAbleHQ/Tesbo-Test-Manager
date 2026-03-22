"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getPublicTesboRun, type TesboPublicRunDetail } from "@/lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

export default function PublicTesboRunPage() {
  const params = useParams();
  const token = params.token as string;
  const [run, setRun] = useState<TesboPublicRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPublicTesboRun(token)
      .then((data) => {
        setRun(data);
        setError(null);
      })
      .catch(() => {
        setRun(null);
        setError("Shared Tesbo run not found or expired.");
      });
  }, [token]);

  return (
    <main className="min-h-screen bg-[var(--background)] px-6 py-10">
      <div className="max-w-3xl mx-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Tesbo Shared Run</h1>
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        {run && (
          <div className="mt-4 space-y-4 text-sm">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Metric label="Run" value={run.name} />
              <Metric label="Status" value={run.status} />
              <Metric label="Total" value={String(run.total)} />
              <Metric label="Passed" value={String(run.passed)} />
              <Metric label="Failed" value={String(run.failed)} />
            </div>

            <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
              <table className="min-w-[840px] w-full text-sm">
                <thead className="bg-[var(--surface-secondary)] text-[var(--muted)]">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Test</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-right px-4 py-3 font-medium">Duration</th>
                    <th className="text-left px-4 py-3 font-medium">Artifacts</th>
                  </tr>
                </thead>
                <tbody>
                  {run.cases.map((item) => (
                    <tr key={item.caseId} className="border-t border-[var(--border-subtle)]">
                      <td className="px-4 py-3 break-all">{item.title}</td>
                      <td className="px-4 py-3">{item.status}</td>
                      <td className="px-4 py-3 text-right">{item.durationMs ?? "-"}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-3">
                          {item.traceUrl && (
                            <a className="text-[var(--brand-primary)] hover:underline" href={toAbsoluteArtifactUrl(item.traceUrl)} target="_blank" rel="noreferrer">
                              Trace
                            </a>
                          )}
                          {item.screenshotUrl && (
                            <a className="text-[var(--brand-primary)] hover:underline" href={toAbsoluteArtifactUrl(item.screenshotUrl)} target="_blank" rel="noreferrer">
                              Screenshot
                            </a>
                          )}
                          {item.videoUrl && (
                            <a className="text-[var(--brand-primary)] hover:underline" href={toAbsoluteArtifactUrl(item.videoUrl)} target="_blank" rel="noreferrer">
                              Video
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {run.cases.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-[var(--muted)]">
                        No tests found in this shared run.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] p-3 bg-[var(--surface)]">
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[var(--foreground)]">{value}</p>
    </div>
  );
}

function toAbsoluteArtifactUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}
