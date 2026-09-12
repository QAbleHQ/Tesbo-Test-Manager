"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  listWorkspaceAiKeys,
  createWorkspaceAiKey,
  deleteWorkspaceAiKey,
  allocateWorkspaceAiKeyToProject,
  listProviderModels,
  listAiProviders,
  type AiProviderOption,
  type ProviderModelOption,
  type WorkspaceAiKey,
  type WorkspaceAiProjectAllocation,
} from "@/lib/api";
import { Button, Card, Field, FieldLabel, Input, Select } from "@/components/ui";
import { useAppData } from "@/components/app/AppDataProvider";

/** Sentinel option that switches the model dropdown to free-text entry. */
const MANUAL_MODEL_VALUE = "__manual__";

export default function AiProvidersTab() {
  const { workspace } = useAppData();
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

  const [providerCatalog, setProviderCatalog] = useState<AiProviderOption[]>([]);
  const [modelOptions, setModelOptions] = useState<ProviderModelOption[]>([]);
  const [modelsFromProvider, setModelsFromProvider] = useState(false);
  const [modelHint, setModelHint] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [manualModelEntry, setManualModelEntry] = useState(false);

  const canManageKeys = (workspace?.role || "member").toLowerCase() === "owner";
  const providerValue = newProvider === "custom" ? newCustomProvider.trim().toLowerCase() : newProvider;
  const catalogProvider = providerCatalog.find((p) => p.id === providerValue);
  // Base URL is asked for when it can't be derived: user-defined gateways, per-resource
  // hosts like Azure, and self-hosted runtimes whose default is only a localhost guess.
  const showBaseUrl = newProvider === "custom" || Boolean(catalogProvider?.requiresBaseUrl) || Boolean(catalogProvider?.defaultBaseUrl);
  // Only warn about an unrecognised model when the list actually came from the provider —
  // against the curated fallback a valid model would look wrong.
  const modelNotOffered =
    modelsFromProvider && newDefaultModel.trim() !== "" && !modelOptions.some((m) => m.id === newDefaultModel.trim());

  const loadData = useCallback(async () => {
    try {
      const [aiData, catalog] = await Promise.all([
        listWorkspaceAiKeys(),
        // Failure here only costs the prefills — the form still works with free text.
        listAiProviders().catch(() => ({ providers: [] })),
      ]);
      setKeys(aiData.keys || []);
      setProjects(aiData.projects || []);
      setProviderCatalog(catalog.providers || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load AI providers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  // Ask the provider which models this key can actually reach, so the list can never
  // offer a retired or unauthorised model. Debounced because the key arrives keystroke
  // by keystroke. The server answers with a curated fallback rather than failing when
  // the provider has no /v1/models route (custom gateways, Bedrock, Vertex).
  useEffect(() => {
    if (!canManageKeys || !providerValue) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoadingModels(true);
      try {
        const res = await listProviderModels({
          provider: providerValue,
          apiKey: newApiKey.trim() || undefined,
          baseUrl: newBaseUrl.trim() || undefined,
        });
        if (cancelled) return;
        setModelOptions(res.models);
        setModelsFromProvider(res.source === "live");
        setModelHint(res.reason);
      } catch {
        if (cancelled) return;
        // Our own API is unreachable — keep whatever list is on screen rather than
        // blanking it out and stranding the user with no suggestions.
        setModelsFromProvider(false);
        setModelHint("Couldn't reach the server to load the model list.");
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [canManageKeys, providerValue, newApiKey, newBaseUrl]);

  // Keep the selection honest about what the provider actually offers. A seeded default
  // the provider doesn't serve gets cleared so the dropdown reflects real state rather
  // than holding a value it can't display — and can't silently save one that would 404.
  // Manual entries are exempt: those are deliberate and often unlistable.
  useEffect(() => {
    if (manualModelEntry || modelOptions.length === 0) return;
    setNewDefaultModel((current) =>
      current && !modelOptions.some((model) => model.id === current) ? "" : current
    );
  }, [modelOptions, manualModelEntry]);

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!canManageKeys) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      // Catalog providers derive auth from their wire server-side; only user-defined
      // gateways need explicit header/scheme overrides sent along.
      const isKnownProvider = catalogProvider !== undefined;
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
      setNewDefaultModel(catalogProvider?.defaultModel ?? "");
      setNewBaseUrl(catalogProvider?.defaultBaseUrl ?? "");
      setManualModelEntry(false);
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

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <p className="text-[var(--muted)]">Loading AI providers...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">AI Providers</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Configure workspace AI keys and assign one key per project.
          </p>
        </div>
        <Link href="/settings/ai-providers/details" className="shrink-0 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)] whitespace-nowrap">
          Provider details
        </Link>
      </div>

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
        <p className="rounded-lg border border-[var(--error)]/40 bg-[color-mix(in_oklab,var(--error)_8%,white)] px-3 py-2 text-sm text-[var(--error-foreground)]">
          {error}
        </p>
      )}

      <Card className="p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Workspace AI keys</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">
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
                  const definition = providerCatalog.find((p) => p.id === next);
                  setNewProvider(next);
                  // Reset model and base URL to the new provider's defaults — carrying
                  // the previous provider's values over would fail on the first call.
                  setNewDefaultModel(definition?.defaultModel ?? "");
                  setNewBaseUrl(definition?.defaultBaseUrl ?? "");
                  setModelOptions([]);
                  setManualModelEntry(false);
                }}
                disabled={saving}
              >
                {/* Keeps the current selection visible while the catalog is in flight. */}
                {providerCatalog.length === 0 && <option value={newProvider}>{newProvider}</option>}
                {providerCatalog.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                ))}
                <option value="custom">Custom provider</option>
              </Select>
            </Field>
            {newProvider === "custom" && (
              <Field>
                <FieldLabel>Provider name</FieldLabel>
                <Input value={newCustomProvider} onChange={(e) => setNewCustomProvider(e.target.value)} placeholder="perplexity, cerebras, custom-gateway" disabled={saving} />
              </Field>
            )}
            {showBaseUrl && (
              <Field>
                <FieldLabel>
                  API base URL{catalogProvider?.requiresBaseUrl ? "" : " (optional)"}
                </FieldLabel>
                <Input
                  value={newBaseUrl}
                  onChange={(e) => setNewBaseUrl(e.target.value)}
                  placeholder={
                    catalogProvider?.wire === "azure"
                      ? "https://<resource>.openai.azure.com"
                      : catalogProvider?.defaultBaseUrl || "https://api.example.com/v1"
                  }
                  disabled={saving}
                />
                {catalogProvider?.wire === "azure" && (
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Azure routes by deployment name, so enter your deployment as the model below. Append ?api-version=... to pin a contract version.
                  </p>
                )}
              </Field>
            )}
            <Field className="sm:col-span-2">
              <FieldLabel>API key</FieldLabel>
              <Input
                type="password"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder={
                  catalogProvider?.optionalApiKey
                    ? "Leave blank if the server is unauthenticated"
                    : newProvider === "anthropic"
                      ? "sk-ant-..."
                      : "sk-..."
                }
                disabled={saving}
              />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel>Default model</FieldLabel>
              {/* A real dropdown whenever we have models to offer. Falls back to free
                  text when discovery found nothing, and always keeps a manual escape
                  hatch — Azure deployment names and private gateways never appear in
                  any list we can fetch. */}
              {modelOptions.length > 0 && !manualModelEntry ? (
                <Select
                  value={modelOptions.some((m) => m.id === newDefaultModel) ? newDefaultModel : ""}
                  onChange={(e) => {
                    if (e.target.value === MANUAL_MODEL_VALUE) {
                      setManualModelEntry(true);
                      setNewDefaultModel("");
                      return;
                    }
                    setNewDefaultModel(e.target.value);
                  }}
                  disabled={saving || loadingModels}
                >
                  <option value="">
                    {loadingModels ? "Loading models..." : "Select a model"}
                  </option>
                  {modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName === model.id ? model.id : `${model.displayName} (${model.id})`}
                    </option>
                  ))}
                  <option value={MANUAL_MODEL_VALUE}>Enter a model name manually...</option>
                </Select>
              ) : (
                <Input
                  value={newDefaultModel}
                  onChange={(e) => setNewDefaultModel(e.target.value)}
                  placeholder={catalogProvider?.wire === "azure" ? "Your Azure deployment name" : "Model name"}
                  disabled={saving}
                />
              )}
              <p className="mt-1 text-xs text-[var(--muted)]">
                {loadingModels
                  ? "Loading models this key can access..."
                  : modelNotOffered
                    ? `"${newDefaultModel.trim()}" isn't in this key's model list — it may be retired or outside the account's access.`
                    : modelsFromProvider
                      ? `${modelOptions.length} model${modelOptions.length === 1 ? "" : "s"} available to this key, newest first.`
                      : modelHint || "Add an API key to load the models it can access."}
                {manualModelEntry && modelOptions.length > 0 && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="cursor-pointer underline hover:no-underline"
                      onClick={() => { setManualModelEntry(false); setNewDefaultModel(""); }}
                    >
                      Choose from the list instead
                    </button>
                  </>
                )}
              </p>
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
              <Button
                type="submit"
                disabled={
                  saving ||
                  !providerValue ||
                  // Mirrors the server rule: a base URL is mandatory wherever it can't be derived.
                  ((newProvider === "custom" || Boolean(catalogProvider?.requiresBaseUrl)) && !newBaseUrl.trim()) ||
                  (!catalogProvider?.optionalApiKey && !newApiKey.trim())
                }
              >
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
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Project key allocation</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">
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
    </div>
  );
}
