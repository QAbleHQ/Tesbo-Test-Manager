"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { authMe, getWorkspace, listWorkspaceAiKeys, type WorkspaceAiKey } from "@/lib/api";
import { Card, PageLoader, StatusChip } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";

export default function AiProviderDetailsPage() {
  const router = useRouter();
  const [keys, setKeys] = useState<WorkspaceAiKey[]>([]);
  const [role, setRole] = useState("member");
  const [workspaceName, setWorkspaceName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [workspace, aiData] = await Promise.all([getWorkspace(), listWorkspaceAiKeys()]);
      setRole((workspace.role || "member").toLowerCase());
      setWorkspaceName(workspace.name || "");
      setKeys(aiData.keys || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load AI providers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) router.replace("/login");
      else void loadData();
    });
  }, [loadData, router]);

  const breadcrumb = (
    <Breadcrumbs
      items={[
        { label: workspaceName || "Workspace", href: "/dashboard" },
        { label: "Workspace settings", href: "/settings?tab=ai" },
        { label: "AI provider details" },
      ]}
    />
  );

  if (loading) {
    return (
      <StandardPageLayout header={<PageHeader title="AI provider details" breadcrumb={breadcrumb} />}>
        <PageLoader label="Loading providers…" />
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="AI provider details"
          subtitle="Review workspace provider configuration, custom API endpoints, authentication headers, and model names."
          breadcrumb={breadcrumb}
          actions={<Link href="/settings?tab=ai" className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">Back to AI providers</Link>}
        />
      }
    >
      {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">{error}</p>}
      {role !== "owner" && (
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)]">Only workspace owners can add or change providers. This page is read-only for your role.</p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {keys.map((key) => (
          <Card key={key.id} className="p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[var(--foreground)]">{key.name}</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">{key.provider.toUpperCase()}</p>
              </div>
              <StatusChip tone={key.active ? "success" : "neutral"}>{key.active ? "Active" : "Inactive"}</StatusChip>
            </div>
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">Model</dt>
                <dd className="mt-1 text-[var(--foreground)]">{key.defaultModel || "Default provider model"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">API URL</dt>
                <dd className="mt-1 break-all text-[var(--foreground)]">{key.baseUrl || (key.provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/chat/completions")}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">Authentication</dt>
                <dd className="mt-1 text-[var(--foreground)]">{key.authHeaderName || "Authorization"}: {(key.authScheme || "Bearer") ? `${key.authScheme || "Bearer"} ${key.maskedKey}` : key.maskedKey}</dd>
              </div>
            </dl>
          </Card>
        ))}
        {keys.length === 0 && (
          <Card className="p-8 text-center text-sm text-[var(--muted)]">
            No AI providers have been added yet.
          </Card>
        )}
      </div>
    </StandardPageLayout>
  );
}
