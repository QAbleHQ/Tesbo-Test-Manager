"use client";

import { useCallback, useEffect, useState } from "react";
import { IconPlus, IconSettings2 } from "@tabler/icons-react";
import { getNyraProject, listNyraRuns, NYRA_ACTIVE, type NyraProjectDetail, type NyraRun } from "@/lib/nyra";
import { getBillingInfo, type BillingInfo } from "@/lib/api";
import { Button, Card, EmptyStateBlock, PageLoader, StatusChip } from "@/components/ui";
import PricingModal from "@/components/PricingModal";
import { ListWorkspaceLayout, PageHeader, Breadcrumbs } from "@/components/workflows";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";
import { formatDateTime } from "@/lib/date";
import NewScanModal from "@/components/nyra/NewScanModal";
import NyraSettingsModal from "@/components/nyra/NyraSettingsModal";
import NyraRunView, { runTone } from "@/components/nyra/NyraRunView";

const errorBox = "rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]";
// While a scan is queued or running the list is the source of truth for its end: NYRA's live stream
// announces the end before the results are saved.
const POLL_MS = 4000;

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (["manager", "admin", "test_manager"].includes(n)) return "manager";
  return "qa_engineer";
}

export default function NyraWorkspace({ projectId, nyraId }: { projectId: string; nyraId: string }) {
  const { currentUser } = useAppData();
  const { project, projectMembers } = useProjectData();
  const projectName = String(project.name || "");
  const role = currentUser ? normalizeRole(projectMembers.find((m) => m.userId === currentUser.userId)?.role ?? "qa_engineer") : "qa_engineer";
  const canManage = role !== "qa_engineer";

  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [billingError, setBillingError] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [nyra, setNyra] = useState<NyraProjectDetail | null>(null);
  const [runs, setRuns] = useState<NyraRun[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isPro = !!billing && (billing.plan === "pro" || billing.inGracePeriod);

  useEffect(() => {
    getBillingInfo().then(setBilling).catch(() => setBillingError(true));
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const { list } = await listNyraRuns(projectId, nyraId);
      // Newest first, so the latest scan is what opens.
      const sorted = [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      setRuns(sorted);
      setSelected((cur) => cur ?? sorted[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the scans.");
    }
  }, [projectId, nyraId]);

  useEffect(() => {
    if (!isPro) return;
    getNyraProject(projectId, nyraId)
      .then(setNyra)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load this NYRA project."));
    void loadRuns();
  }, [isPro, projectId, nyraId, loadRuns]);

  const anyActive = !!runs?.some((r) => NYRA_ACTIVE.has(r.status));
  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(() => void loadRuns(), POLL_MS);
    return () => clearInterval(id);
  }, [anyActive, loadRuns]);

  const environment = nyra?.environments[0] ?? null;
  const selectedRun = runs?.find((r) => r.id === selected) ?? null;

  const header = (
    <PageHeader
      title={nyra?.name || "NYRA project"}
      subtitle={nyra?.appUrl ?? undefined}
      breadcrumb={
        <Breadcrumbs
          items={[
            { label: "Projects", href: "/projects" },
            { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
            { label: "Agents", href: `/projects/${projectId}/agents` },
            { label: "NYRA", href: `/projects/${projectId}/agents/nyra` },
            { label: nyra?.name || "Project" },
          ]}
        />
      }
      actions={
        isPro && nyra ? (
          <div className="flex gap-2">
            {canManage && (
              <Button type="button" variant="secondary" onClick={() => setSettingsOpen(true)}>
                <IconSettings2 size={16} stroke={1.75} /> Settings
              </Button>
            )}
            <Button type="button" onClick={() => setScanOpen(true)} disabled={!environment}>
              <IconPlus size={16} stroke={1.75} /> New scan
            </Button>
          </div>
        ) : undefined
      }
    />
  );

  if (billingError) {
    return (
      <ListWorkspaceLayout header={header}>
        <p className={errorBox}>Couldn&apos;t verify your plan. Reload to try again.</p>
      </ListWorkspaceLayout>
    );
  }
  if (!billing) {
    return (
      <ListWorkspaceLayout header={header}>
        <PageLoader label="Checking your plan…" />
      </ListWorkspaceLayout>
    );
  }
  if (!isPro) {
    return (
      <ListWorkspaceLayout header={header}>
        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--foreground)]">NYRA is a Pro plan feature</h2>
          <p className="mt-1.5 text-sm text-[var(--muted)]">Upgrade to Pro to run NYRA scans.</p>
          <Button type="button" className="mt-3" onClick={() => setPricingOpen(true)}>
            Upgrade to Pro
          </Button>
        </Card>
        <PricingModal open={pricingOpen} onClose={() => setPricingOpen(false)} billingInfo={billing} />
      </ListWorkspaceLayout>
    );
  }

  return (
    <ListWorkspaceLayout header={header}>
      {error && <p className={errorBox}>{error}</p>}
      {(!nyra || !runs) && !error && <PageLoader label="Loading NYRA project…" />}

      {nyra && runs && runs.length === 0 && (
        <EmptyStateBlock
          title="No scans yet"
          description={environment ? "Start a scan and NYRA will explore the app and report what it finds." : "This project has no environment, so there is nothing to scan."}
          action={
            environment ? (
              <Button type="button" onClick={() => setScanOpen(true)}>
                <IconPlus size={16} stroke={1.75} /> New scan
              </Button>
            ) : undefined
          }
        />
      )}

      {nyra && runs && runs.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside aria-label="Scans" className="space-y-2">
            {runs.map((r) => (
              <button
                key={r.id}
                type="button"
                data-testid="nyra-run"
                aria-current={r.id === selected}
                onClick={() => setSelected(r.id)}
                className={`w-full rounded-[10px] border px-3 py-2.5 text-left transition ${
                  r.id === selected ? "border-[var(--brand-primary)] bg-[var(--surface-secondary)]" : "border-[var(--border-subtle)] bg-[var(--surface)] hover:border-[var(--brand-primary)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <StatusChip tone={runTone(r.status)}>{r.status}</StatusChip>
                  <span className="text-[11px] text-[var(--muted-soft)]">{r.summary.pagesVisited != null ? `${r.summary.pagesVisited} pages` : ""}</span>
                </div>
                <div className="mt-1.5 text-[12px] text-[var(--muted)]">{r.createdAt ? formatDateTime(r.createdAt) : ""}</div>
              </button>
            ))}
          </aside>
          <div className="min-w-0">{selectedRun && <NyraRunView key={selectedRun.id} projectId={projectId} nyraId={nyraId} run={selectedRun} canApprove={canManage} />}</div>
        </div>
      )}

      {nyra && (
        <>
          <NewScanModal
            open={scanOpen}
            projectId={projectId}
            nyraId={nyraId}
            environments={nyra.environments}
            onClose={() => setScanOpen(false)}
            onStarted={(run) => {
              setScanOpen(false);
              setRuns((prev) => [run, ...(prev ?? [])]);
              setSelected(run.id);
            }}
          />
          <NyraSettingsModal
            open={settingsOpen}
            projectId={projectId}
            nyraId={nyraId}
            environment={environment}
            onClose={() => setSettingsOpen(false)}
            onSaved={(saved) => {
              setNyra(saved);
              setSettingsOpen(false);
            }}
          />
        </>
      )}
    </ListWorkspaceLayout>
  );
}
