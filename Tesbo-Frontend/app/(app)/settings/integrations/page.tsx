"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  authMe,
  getWorkspace,
  listWorkspaceAiKeys,
  createWorkspaceAiKey,
  deleteWorkspaceAiKey,
  allocateWorkspaceAiKeyToProject,
  type WorkspaceAiKey,
  type WorkspaceAiProjectAllocation,
} from "@/lib/api";
import { Button, Card, Field, FieldLabel, Input, Select } from "@/components/ui";
import { StandardPageLayout, PageHeader } from "@/components/workflows";

export default function WorkspaceIntegrationsPage() {
  const router = useRouter();
  const [auth, setAuth] = useState<{ userId: string } | null>(null);
  const [workspaceRole, setWorkspaceRole] = useState<string>("member");
  const [keys, setKeys] = useState<WorkspaceAiKey[]>([]);
  const [projects, setProjects] = useState<WorkspaceAiProjectAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newProvider, setNewProvider] = useState("openai");
  const [newCustomProvider, setNewCustomProvider] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [newDefaultModel, setNewDefaultModel] = useState("gpt-4o");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newAuthHeaderName, setNewAuthHeaderName] = useState("Authorization");
  const [newAuthScheme, setNewAuthScheme] = useState("Bearer");
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);
  const [allocatingProjectId, setAllocatingProjectId] = useState<string | null>(null);

  const canManageKeys = workspaceRole === "owner";
  const providerValue = newProvider === "custom" ? newCustomProvider.trim().toLowerCase() : newProvider;
  const modelOptions =
    newProvider === "anthropic"
      ? ["claude-sonnet-4-6", "claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022"]
      : newProvider === "openai"
        ? ["gpt-4o", "gpt-4.1", "gpt-4.1-mini"]
        : [];

  const loadData = useCallback(async () => {
    try {
      const [workspace, aiData] = await Promise.all([getWorkspace(), listWorkspaceAiKeys()]);
      setWorkspaceRole((workspace.role || "member").toLowerCase());
      setKeys(aiData.keys || []);
      setProjects(aiData.projects || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workspace integrations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    authMe().then((me) => {
      setAuth(me);
      if (!me) router.replace("/login");
      else void loadData();
    });
  }, [loadData, router]);

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!canManageKeys) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const isKnownProvider = ["openai", "anthropic"].includes(providerValue);
      await createWorkspaceAiKey({
        name: newName.trim(),
        provider: providerValue,
        apiKey: newApiKey.trim(),
        defaultModel: newDefaultModel.trim() === "custom" ? undefined : newDefaultModel.trim() || undefined,
        baseUrl: newBaseUrl.trim() || undefined,
        // Only send auth overrides for custom providers — known providers use well-defined SDK defaults
        authHeaderName: isKnownProvider ? undefined : (newAuthHeaderName.trim() || undefined),
        authScheme: isKnownProvider ? undefined : (newAuthScheme.trim() || undefined),
      });
      setNewName("");
      setNewCustomProvider("");
      setNewApiKey("");
      setNewDefaultModel(newProvider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o");
      setNewBaseUrl("");
      setNewAuthHeaderName("Authorization");
      setNewAuthScheme("Bearer");
      setMessage("Workspace AI key added.");
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create workspace AI key.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteKey(keyId: string) {
    if (!canManageKeys) return;
    setDeletingKeyId(keyId);
    setMessage(null);
    setError(null);
    try {
      await deleteWorkspaceAiKey(keyId);
      setMessage("Workspace AI key removed.");
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete workspace AI key.");
    } finally {
      setDeletingKeyId(null);
    }
  }

  async function handleAllocate(projectId: string, workspaceAiKeyId: string) {
    if (!canManageKeys) return;
    setAllocatingProjectId(projectId);
    setMessage(null);
    setError(null);
    try {
      await allocateWorkspaceAiKeyToProject({
        projectId,
        workspaceAiKeyId: workspaceAiKeyId || undefined,
      });
      setMessage("Project AI key allocation updated.");
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update project allocation.");
    } finally {
      setAllocatingProjectId(null);
    }
  }

  if (!auth) {
    return (
      <StandardPageLayout header={<PageHeader title="Integrations" />}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      </StandardPageLayout>
    );
  }

  if (loading) {
    return (
      <StandardPageLayout
        header={
          <PageHeader
            title="Integrations"
            subtitle="Manage workspace AI keys and per-project allocations."
          />
        }
      >
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading workspace integrations...</p>
        </div>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Integrations"
          subtitle="Configure workspace AI keys and assign one key per project."
          actions={
            <Link href="/settings/integrations/ai-providers" className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">
              AI provider details
            </Link>
          }
        />
      }
    >
      {!canManageKeys && (
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)]">
            Only workspace owner can manage AI keys and project allocations.
          </p>
        </Card>
      )}

      {message && (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--foreground)]">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-[var(--error)]/40 bg-[color-mix(in_oklab,var(--error)_8%,white)] px-3 py-2 text-sm text-[var(--error)]">
          {error}
        </p>
      )}

      <Card className="p-4 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Workspace AI keys</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Add multiple OpenAI/Anthropic keys once at workspace level, then allocate them to projects.
          </p>
        </div>

        {canManageKeys && (
          <form onSubmit={handleCreateKey} className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel>Key name</FieldLabel>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Primary OpenAI key"
                disabled={saving}
              />
            </Field>
            <Field>
              <FieldLabel>Provider</FieldLabel>
              <Select
                value={newProvider}
                onChange={(e) => {
                  const next = e.target.value;
                  setNewProvider(next);
                  setNewDefaultModel(next === "anthropic" ? "claude-sonnet-4-6" : next === "openai" ? "gpt-4o" : "");
                }}
                disabled={saving}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="custom">Custom provider</option>
              </Select>
            </Field>
            {newProvider === "custom" && (
              <>
                <Field>
                  <FieldLabel>Provider name</FieldLabel>
                  <Input value={newCustomProvider} onChange={(e) => setNewCustomProvider(e.target.value)} placeholder="groq, together, ollama" disabled={saving} />
                </Field>
                <Field>
                  <FieldLabel>API base URL</FieldLabel>
                  <Input value={newBaseUrl} onChange={(e) => setNewBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" disabled={saving} />
                </Field>
              </>
            )}
            <Field className="sm:col-span-2">
              <FieldLabel>API key</FieldLabel>
              <Input
                type="password"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder={newProvider === "anthropic" ? "sk-ant-..." : "sk-..."}
                disabled={saving}
              />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel>Default model</FieldLabel>
              <Input
                list="workspace-ai-model-options"
                value={newDefaultModel}
                onChange={(e) => setNewDefaultModel(e.target.value)}
                placeholder={newProvider === "custom" ? "Custom model name" : "Select or type a model name"}
                disabled={saving}
              />
              <datalist id="workspace-ai-model-options">
                {modelOptions.map((model) => <option key={model} value={model} />)}
              </datalist>
            </Field>
            {newProvider === "custom" && (
              <>
                <Field>
                  <FieldLabel>Auth header</FieldLabel>
                  <Input value={newAuthHeaderName} onChange={(e) => setNewAuthHeaderName(e.target.value)} placeholder="Authorization" disabled={saving} />
                </Field>
                <Field>
                  <FieldLabel>Auth scheme</FieldLabel>
                  <Input value={newAuthScheme} onChange={(e) => setNewAuthScheme(e.target.value)} placeholder="Bearer" disabled={saving} />
                </Field>
              </>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={saving || !providerValue || (newProvider === "custom" && !newBaseUrl.trim())}>
                {saving ? "Adding key..." : "Add workspace AI key"}
              </Button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="tesbo-table min-w-full text-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Provider</th>
                <th>Masked key</th>
                <th>Default model</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td className="text-[var(--foreground)]">{key.name}</td>
                  <td className="text-[var(--muted)]">{key.provider.toUpperCase()}</td>
                  <td className="font-mono text-[var(--muted)]">{key.maskedKey}</td>
                  <td className="text-[var(--muted)]">{key.defaultModel || "—"}</td>
                  <td className="text-right">
                    {canManageKeys ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={deletingKeyId === key.id}
                        onClick={() => void handleDeleteKey(key.id)}
                      >
                        {deletingKeyId === key.id ? "Removing..." : "Remove"}
                      </Button>
                    ) : (
                      <span className="text-xs text-[var(--muted)]">Owner only</span>
                    )}
                  </td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-[var(--muted)]">
                    No workspace AI keys added yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Project key allocation</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Select which workspace AI key each project should use. Agents are blocked when no key is allocated.
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="tesbo-table min-w-full text-sm">
            <thead>
              <tr>
                <th>Project</th>
                <th>Allocated AI key</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.projectId}>
                  <td>
                    <div className="text-[var(--foreground)]">{project.projectName}</div>
                    <div className="text-xs text-[var(--muted)]">{project.projectKey}</div>
                  </td>
                  <td>
                    <Select
                      value={project.workspaceAiKeyId || ""}
                      onChange={(e) => void handleAllocate(project.projectId, e.target.value)}
                      disabled={!canManageKeys || allocatingProjectId === project.projectId}
                    >
                      <option value="">No key allocated</option>
                      {keys.map((key) => (
                        <option key={key.id} value={key.id}>
                          {key.name} ({key.provider})
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
              {projects.length === 0 && (
                <tr>
                  <td colSpan={2} className="py-6 text-center text-[var(--muted)]">
                    No projects found in this workspace.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </StandardPageLayout>
  );
}
