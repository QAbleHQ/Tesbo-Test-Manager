"use client";

import { useEffect, useState, useCallback } from "react";
import { getSystemHealth } from "@/lib/api";

type ServiceStatus = {
  status: string;
  latency_ms?: number;
  url?: string;
  error?: string;
  http_status?: number;
  provider?: string;
  latest_migration?: string;
};

type HealthResponse = {
  status: string;
  timestamp: string;
  services: Record<string, ServiceStatus>;
};

const SERVICE_META: Record<string, { label: string; description: string }> = {
  backend: { label: "Backend API", description: "NestJS API server" },
  database: { label: "PostgreSQL", description: "Primary database" },
  artifact_storage: {
    label: "Artifact Storage",
    description: "Screenshots & trace storage",
  },
};

function StatusDot({ status }: { status: string }) {
  const color =
    status === "up"
      ? "bg-[var(--success)]"
      : status === "misconfigured"
        ? "bg-[var(--warning)]"
        : "bg-[var(--error)]";
  const pulse = status === "up" ? "animate-pulse" : "";
  return (
    <span className="relative flex h-3 w-3">
      {status === "up" && (
        <span
          className={`absolute inline-flex h-full w-full rounded-full ${color} opacity-40 ${pulse}`}
        />
      )}
      <span className={`relative inline-flex h-3 w-3 rounded-full ${color}`} />
    </span>
  );
}

function ServiceCard({
  serviceKey,
  data,
}: {
  serviceKey: string;
  data: ServiceStatus;
}) {
  const meta = SERVICE_META[serviceKey] || {
    label: serviceKey,
    description: "",
  };
  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusDot status={data.status} />
          <div>
            <h3 className="text-[15px] font-semibold text-[var(--foreground)]">
              {meta.label}
            </h3>
            <p className="text-[13px] text-[var(--muted)]">
              {meta.description}
            </p>
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[12px] font-semibold uppercase tracking-wider ${
            data.status === "up"
              ? "bg-[var(--success-soft)] text-[var(--success)]"
              : data.status === "misconfigured"
                ? "bg-[var(--warning-soft)] text-[var(--warning)]"
                : "bg-[var(--error-soft)] text-[var(--error)]"
          }`}
        >
          {data.status}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
        {data.latency_ms !== undefined && (
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--muted)]">Latency</span>
            <span className="font-medium text-[var(--foreground)]">
              {data.latency_ms}ms
            </span>
          </div>
        )}
        {data.provider && (
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--muted)]">Provider</span>
            <span className="font-medium text-[var(--foreground)]">
              {data.provider}
            </span>
          </div>
        )}
        {data.latest_migration && (
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--muted)]">Migration</span>
            <span className="font-medium text-[var(--foreground)]">
              {data.latest_migration}
            </span>
          </div>
        )}
        {data.url && (
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--muted)]">URL</span>
            <span className="font-mono text-[12px] text-[var(--foreground)]">
              {data.url}
            </span>
          </div>
        )}
      </div>

      {data.error && (
        <div className="rounded-lg bg-[var(--error-soft)] px-3 py-2 text-[13px] text-[var(--error)]">
          {data.error}
        </div>
      )}
    </div>
  );
}

export default function SystemHealthPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const data = await getSystemHealth();
      setHealth(data);
      setError(null);
      setLastChecked(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch health");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchHealth]);

  const serviceEntries = health?.services
    ? Object.entries(health.services)
    : [];
  const upCount = serviceEntries.filter(
    ([, s]) => s.status === "up"
  ).length;
  const totalCount = serviceEntries.length;

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-[var(--foreground)]">
            System Health
          </h1>
          <p className="mt-1 text-[15px] text-[var(--muted)]">
            Post-deployment service status and connectivity
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-[13px] text-[var(--muted)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-[var(--border)] bg-[var(--surface)] accent-[var(--brand-primary)]"
            />
            Auto-refresh (30s)
          </label>
          <button
            type="button"
            onClick={fetchHealth}
            disabled={loading}
            className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-[14px] font-semibold text-white hover:bg-[var(--brand-hover)] transition-colors disabled:opacity-60"
          >
            {loading ? "Checking..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-2xl border border-[var(--error)] bg-[var(--error-soft)] p-4 text-[14px] text-[var(--error)]">
          {error}
        </div>
      )}

      {/* Overall status banner */}
      {health && (
        <div
          className={`rounded-2xl border p-5 flex items-center justify-between ${
            health.status === "healthy"
              ? "border-[var(--success)]/30 bg-[var(--success-soft)]"
              : "border-[var(--warning)]/30 bg-[var(--warning-soft)]"
          }`}
        >
          <div className="flex items-center gap-3">
            <StatusDot status={health.status === "healthy" ? "up" : "down"} />
            <div>
              <span className="text-[16px] font-bold text-[var(--foreground)]">
                {health.status === "healthy"
                  ? "All Systems Operational"
                  : "System Degraded"}
              </span>
              <p className="text-[13px] text-[var(--muted)]">
                {upCount}/{totalCount} services healthy
              </p>
            </div>
          </div>
          {lastChecked && (
            <span className="text-[13px] text-[var(--muted)]">
              Last checked:{" "}
              {lastChecked.toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      {/* Service cards */}
      {loading && !health ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-[140px] animate-pulse rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)]"
            />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {serviceEntries.map(([key, data]) => (
            <ServiceCard key={key} serviceKey={key} data={data} />
          ))}
        </div>
      )}
    </div>
  );
}
