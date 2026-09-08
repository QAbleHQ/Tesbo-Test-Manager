"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { authMe, getBillingInfo, getWorkspace } from "@/lib/api";
import { useTopBarSlots } from "@/components/TopBarSlots";
import { Breadcrumbs } from "@/components/workflows";
import { PageLoader } from "@/components/ui";
import GeneralTab from "@/components/settings/GeneralTab";
import MembersTab from "@/components/settings/MembersTab";
import IntegrationsTab from "@/components/settings/IntegrationsTab";
import AiProvidersTab from "@/components/settings/AiProvidersTab";
import AdminsTab from "@/components/settings/AdminsTab";
import BillingTab from "@/components/settings/BillingTab";

type SettingsTab = "general" | "members" | "integrations" | "ai" | "billing" | "admins";

function WorkspaceSettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"loading" | "ready" | "denied">("loading");
  const [workspaceName, setWorkspaceName] = useState("");
  const [canManageWorkspace, setCanManageWorkspace] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab | null>(null);
  const { startEl: topBarStartEl, setFilled: setTopBarFilled } = useTopBarSlots();

  const visibleTabs = useMemo<Array<{ key: SettingsTab; label: string }>>(
    () => [
      ...(canManageWorkspace
        ? ([
            { key: "general", label: "General" },
            { key: "members", label: "Members" },
            { key: "integrations", label: "Integrations" },
            { key: "ai", label: "AI Providers" },
            ...(billingEnabled ? ([{ key: "billing", label: "Billing" }] as const) : []),
          ] as const)
        : []),
      ...(isPlatformAdmin ? ([{ key: "admins", label: "Manage Admins" }] as const) : []),
    ],
    [canManageWorkspace, isPlatformAdmin, billingEnabled]
  );

  const load = useCallback(async () => {
    const me = await authMe();
    if (!me) {
      router.replace("/login");
      return;
    }
    try {
      const workspace = await getWorkspace();
      const role = String(workspace.role || "qa_engineer").toLowerCase();
      const canManage = role === "owner" || role === "manager";
      const platformAdmin = Boolean(me.isPlatformAdmin);
      if (!canManage && !platformAdmin) {
        router.replace("/projects");
        return;
      }
      setWorkspaceName(workspace.name || "");
      setCanManageWorkspace(canManage);
      setIsPlatformAdmin(platformAdmin);
      try {
        const billing = await getBillingInfo();
        // enabled:false → hide tab; enabled:true (or omitted on old servers) → show.
        setBillingEnabled(billing.enabled !== false);
      } catch {
        setBillingEnabled(false);
      }
      setStatus("ready");
    } catch {
      router.replace("/projects");
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (visibleTabs.length === 0) return;
    const requested = searchParams.get("tab") as SettingsTab | null;
    const allowed = visibleTabs.map((t) => t.key);
    if (requested && allowed.includes(requested)) {
      setActiveTab(requested);
    } else if (!activeTab || !allowed.includes(activeTab)) {
      setActiveTab(visibleTabs[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabs, searchParams]);

  useEffect(() => {
    setTopBarFilled(true);
    return () => setTopBarFilled(false);
  }, [setTopBarFilled]);

  function handleTabChange(tab: SettingsTab) {
    setActiveTab(tab);
    router.replace(`/settings?tab=${tab}`, { scroll: false });
  }

  if (status !== "ready" || !activeTab) {
    return <PageLoader variant="screen" label="Loading workspace settings…" />;
  }

  return (
    <main className="tc-fullbleed flex flex-col pb-4 pr-4 pt-4" style={{ height: "calc(100vh - 3.5rem)" }}>
      <div className="flex min-h-0 flex-1 flex-col">
        {topBarStartEl &&
          createPortal(
            <Breadcrumbs
              items={[
                { label: workspaceName || "Workspace", href: "/dashboard" },
                { label: "Workspace settings" },
              ]}
            />,
            topBarStartEl,
          )}

        <div className="mb-3 shrink-0 pl-4">
          <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">
            Workspace settings
          </h1>
          <p className="mt-1 text-[13px] text-[var(--muted-soft)]">
            Manage members, integrations, AI providers, and admin access for {workspaceName || "your workspace"}.
          </p>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]">
          {/* ── Settings nav rail ── */}
          <aside className="flex w-[200px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] p-2">
            <div className="mb-1 px-2.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
              Workspace
            </div>
            <nav className="flex flex-col gap-0.5">
              {visibleTabs
                .filter((tab) => tab.key !== "admins")
                .map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => handleTabChange(tab.key)}
                    className={`cursor-pointer rounded-[6px] px-2.5 py-2 text-left text-[13px] transition-colors ${
                      activeTab === tab.key
                        ? "bg-[var(--brand-soft)] font-medium text-[var(--accent-light)]"
                        : "text-[var(--ink-600)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
            </nav>

            {isPlatformAdmin && (
              <>
                <div className="mb-1 mt-4 px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                  Admin
                </div>
                <nav className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => handleTabChange("admins")}
                    className={`cursor-pointer rounded-[6px] px-2.5 py-2 text-left text-[13px] transition-colors ${
                      activeTab === "admins"
                        ? "bg-[var(--brand-soft)] font-medium text-[var(--accent-light)]"
                        : "text-[var(--ink-600)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    Manage Admins
                  </button>
                </nav>
              </>
            )}
          </aside>

          {/* ── Tab content ── */}
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            <div className="max-w-3xl">
              {activeTab === "general" && <GeneralTab />}
              {activeTab === "members" && <MembersTab />}
              {activeTab === "integrations" && <IntegrationsTab />}
              {activeTab === "ai" && <AiProvidersTab />}
              {activeTab === "billing" && <BillingTab />}
              {activeTab === "admins" && <AdminsTab />}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function WorkspaceSettingsPage() {
  return (
    <Suspense>
      <WorkspaceSettingsContent />
    </Suspense>
  );
}
