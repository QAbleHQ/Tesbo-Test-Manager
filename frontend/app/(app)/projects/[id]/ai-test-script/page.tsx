"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  authMe,
  addJiraComment,
  createTestCase,
  generateAiTestCases,
  getProject,
  listJiraTickets,
  listSuites,
  trackAiGenerationSaved,
  type AiGeneratedDraft,
  type JiraTicket,
  type SuiteNode,
} from "@/lib/api";
import { Button, Input, Card, StatusChip, Modal, Field, FieldLabel, Textarea, Select } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

type ProjectSettingsPayload = {
  ai?: {
    provider?: "openai" | "anthropic";
    model?: string;
    openAiApiKey?: string;
    anthropicApiKey?: string;
  };
  jiraAutoComment?: boolean;
  jiraTicketSelector?: boolean;
  [key: string]: unknown;
};

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function AiTestScriptGenerationPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [projectProvider, setProjectProvider] = useState<"openai" | "anthropic">("openai");
  const [projectModel, setProjectModel] = useState("");
  const [hasLlmKey, setHasLlmKey] = useState(true);
  const [suiteId, setSuiteId] = useState("");
  const [suites, setSuites] = useState<SuiteNode[]>([]);

  const [storyDetails, setStoryDetails] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(5);
  const [includeHappyFlow, setIncludeHappyFlow] = useState(true);
  const [includeNegativeFlow, setIncludeNegativeFlow] = useState(true);
  const [includeMultiTab, setIncludeMultiTab] = useState(false);
  const [includeCrossBrowser, setIncludeCrossBrowser] = useState(false);
  const [includeBoundary, setIncludeBoundary] = useState(true);

  const [generationRequestId, setGenerationRequestId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<AiGeneratedDraft[]>([]);
  const [selectedDraftIndexes, setSelectedDraftIndexes] = useState<number[]>([]);

  const [showSuitePickerModal, setShowSuitePickerModal] = useState(false);

  // Jira ticket context
  const [sourceJiraKey, setSourceJiraKey] = useState<string | null>(null);
  const [sourceJiraUrl, setSourceJiraUrl] = useState<string | null>(null);
  const [jiraAutoComment, setJiraAutoComment] = useState(false);
  const [jiraTicketSelectorEnabled, setJiraTicketSelectorEnabled] = useState(false);
  const [jiraTickets, setJiraTickets] = useState<JiraTicket[]>([]);
  const [jiraTicketSearch, setJiraTicketSearch] = useState("");
  const [showTicketDropdown, setShowTicketDropdown] = useState(false);

  const selectedDrafts = useMemo(
    () => selectedDraftIndexes.map((i) => drafts[i]).filter(Boolean),
    [drafts, selectedDraftIndexes]
  );

  const loadJiraTickets = useCallback(
    async (query: string) => {
      try {
        const data = await listJiraTickets(projectId, { limit: 50, search: query || undefined });
        setJiraTickets(data.list);
      } catch {
        /* ignore */
      }
    },
    [projectId]
  );

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([getProject(projectId), listSuites(projectId)])
        .then(([project, suiteList]) => {
          const settingsRaw = typeof project.settings === "string" ? project.settings : "{}";
          let settings: ProjectSettingsPayload = {};
          try {
            settings = JSON.parse(settingsRaw) as ProjectSettingsPayload;
          } catch {
            settings = {};
          }
          const provider = settings.ai?.provider === "anthropic" ? "anthropic" : "openai";
          setProjectProvider(provider);
          setProjectModel(settings.ai?.model ?? "");
          setHasLlmKey(project.aiConfigured === true);
          setSuites(suiteList);

          const autoComment = settings.jiraAutoComment === true;
          const ticketSelector = settings.jiraTicketSelector === true;
          setJiraAutoComment(autoComment);
          setJiraTicketSelectorEnabled(ticketSelector);

          // Pre-fill from query params (redirected from Knowledge Base)
          const jiraKey = searchParams.get("jiraKey");
          const jiraUrl = searchParams.get("jiraUrl");
          const summary = searchParams.get("summary");
          const description = searchParams.get("description");
          if (jiraKey) {
            setSourceJiraKey(jiraKey);
            setSourceJiraUrl(jiraUrl || null);
            const storyText = `[${jiraKey}] ${summary || ""}\n\n${description || ""}`.trim();
            setStoryDetails(storyText);
          }

          if (ticketSelector) {
            loadJiraTickets("");
          }
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Failed to load AI generation page"))
        .finally(() => setLoading(false));
    });
  }, [projectId, router, searchParams, loadJiraTickets]);

  function handleSelectJiraTicket(ticket: JiraTicket) {
    setSourceJiraKey(ticket.jiraIssueKey);
    setSourceJiraUrl(ticket.jiraUrl || null);
    const storyText = `[${ticket.jiraIssueKey}] ${ticket.summary}\n\n${ticket.description || ""}`.trim();
    setStoryDetails(storyText);
    setShowTicketDropdown(false);
    setJiraTicketSearch("");
  }

  async function handleGenerate() {
    if (!hasLlmKey) {
      setError("Workspace AI key is not configured for this project. Ask workspace owner to allocate one in Workspace Settings -> Integrations.");
      return;
    }
    if (!storyDetails.trim()) {
      setError("Story or feature details are required.");
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const result = await generateAiTestCases(projectId, {
        userStory: storyDetails.trim(),
        acceptanceCriteria: acceptanceCriteria.trim(),
        prompt: prompt.trim(),
        style: "strict",
        count,
        provider: projectProvider,
        model: projectModel || undefined,
        includeHappyFlow,
        includeNegativeFlow,
        includeMultiTab,
        includeCrossBrowser,
        includeBoundary,
      });
      setGenerationRequestId(result.generationRequestId);
      setDrafts(result.drafts);
      setSelectedDraftIndexes(result.drafts.map((_, i) => i));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate test cases");
    } finally {
      setGenerating(false);
    }
  }

  function toggleDraftSelection(index: number) {
    setSelectedDraftIndexes((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  }

  async function handleSaveSelectedDrafts() {
    if (!generationRequestId) {
      setError("Generate test cases before saving.");
      return;
    }
    if (selectedDrafts.length === 0) {
      setError("Select at least one generated draft to save.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const createdIds: string[] = [];
      const createdTitles: string[] = [];
      for (const draft of selectedDrafts) {
        const parsedSteps = parseJsonArray(draft.stepsJson);
        const created = await createTestCase(projectId, {
          suiteId: suiteId || undefined,
          title: draft.title,
          description: `${acceptanceCriteria ? `${acceptanceCriteria}\n\n` : ""}${draft.expectedSummary}`,
          preconditions: draft.preconditions,
          steps: JSON.stringify(parsedSteps.length > 0 ? parsedSteps : []),
          priority: draft.priority || "P2",
          type: "Functional",
          status: "Draft",
          automationTags: (draft.tags ?? []).join(", "),
          ...(sourceJiraKey ? { jiraIssueKey: sourceJiraKey } : {}),
          ...(sourceJiraUrl ? { jiraUrl: sourceJiraUrl } : {}),
        });
        createdIds.push(String(created.id));
        createdTitles.push(draft.title);
      }
      await trackAiGenerationSaved(projectId, generationRequestId, {
        suiteId: suiteId || undefined,
        testcaseIds: createdIds,
      });

      // Post comment to Jira if auto-comment is enabled and we have a source ticket
      if (jiraAutoComment && sourceJiraKey) {
        try {
          const testCases = createdIds.map((id, i) => ({ id, title: createdTitles[i] }));
          await addJiraComment(projectId, sourceJiraKey, "", testCases);
        } catch {
          // Non-blocking — don't fail the save if commenting fails
        }
      }

      const suiteName = suites.find((s) => s.id === suiteId)?.name ?? "uncategorized";
      setError(`Saved ${createdIds.length} test case(s) to "${suiteName}".${jiraAutoComment && sourceJiraKey ? " Jira comment added." : ""}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save generated test cases");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="px-6 py-6">
        <p className="text-[var(--muted)]">Loading AI Test Script Generation...</p>
      </main>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Test Script Generation"
          subtitle="Generate AI-based test cases from stories/features, then save to a suite."
          actions={
            <div className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">
              Provider: {projectProvider.toUpperCase()}
              {projectModel ? ` · ${projectModel}` : ""}
            </div>
          }
        />
      }
    >
      {error && (
        <p className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--muted)]">
          {error}
        </p>
      )}
      {!hasLlmKey && (
        <p className="mb-4 rounded-lg border border-[var(--warning)]/50 bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--warning)]">
          Workspace AI key is not configured for this project. Ask workspace owner to allocate one in Workspace Settings {"->"} Integrations.
        </p>
      )}

      <section className="space-y-4">
          {/* Jira ticket context banner */}
          {sourceJiraKey && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--brand-primary)]/30 bg-[var(--brand-soft)] px-3 py-2">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-[var(--brand-primary)] shrink-0" fill="currentColor">
                <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
              </svg>
              <span className="text-sm text-[var(--brand-primary)]">
                Generating from Jira ticket <span className="font-semibold">{sourceJiraKey}</span>
              </span>
              <button
                type="button"
                onClick={() => { setSourceJiraKey(null); setSourceJiraUrl(null); }}
                className="ml-auto text-xs text-[var(--brand-primary)] hover:opacity-80"
              >
                Clear
              </button>
            </div>
          )}

          <Card className="p-4">
            <div className="grid gap-4">
              {/* Jira ticket selector */}
              {jiraTicketSelectorEnabled && !sourceJiraKey && (
                <Field>
                  <FieldLabel>Select Jira Ticket (optional)</FieldLabel>
                  <div className="relative">
                    <Input
                      type="text"
                      value={jiraTicketSearch}
                      onChange={(e) => {
                        setJiraTicketSearch(e.target.value);
                        loadJiraTickets(e.target.value);
                        setShowTicketDropdown(true);
                      }}
                      onFocus={() => {
                        setShowTicketDropdown(true);
                        if (jiraTickets.length === 0) loadJiraTickets("");
                      }}
                      placeholder="Search by ticket key or summary..."
                      className="pl-9"
                    />
                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-soft)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
                    </svg>
                  </div>
                  {showTicketDropdown && jiraTickets.length > 0 && (
                    <div className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg">
                      {jiraTickets.map((ticket) => (
                        <button
                          key={ticket.id}
                          type="button"
                          onClick={() => handleSelectJiraTicket(ticket)}
                          className="w-full text-left px-3 py-2 hover:bg-[var(--surface-secondary)] border-b border-[var(--border-subtle)] last:border-b-0"
                        >
                          <span className="font-mono text-xs text-[var(--brand-primary)]">{ticket.jiraIssueKey}</span>
                          <span className="ml-2 text-sm text-[var(--muted)]">{ticket.summary}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </Field>
              )}

              <Field>
                <FieldLabel>Story / Feature details</FieldLabel>
                <Textarea
                  value={storyDetails}
                  onChange={(e) => setStoryDetails(e.target.value)}
                  rows={4}
                  placeholder="Describe the story, feature, and user behavior in detail..."
                />
              </Field>
              <Field>
                <FieldLabel>Acceptance criteria (optional)</FieldLabel>
                <Textarea
                  value={acceptanceCriteria}
                  onChange={(e) => setAcceptanceCriteria(e.target.value)}
                  rows={3}
                />
              </Field>
              <Field>
                <FieldLabel>Prompt refinement (optional)</FieldLabel>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={2}
                  placeholder="Add more context to generate additional/targeted test cases..."
                />
              </Field>
              <Field>
                <FieldLabel>Case count</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                  className="w-24"
                />
              </Field>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={includeHappyFlow} onChange={(e) => setIncludeHappyFlow(e.target.checked)} />
                  Functional - Happy Flow
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={includeNegativeFlow} onChange={(e) => setIncludeNegativeFlow(e.target.checked)} />
                  Functional - Negative Flow
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={includeMultiTab} onChange={(e) => setIncludeMultiTab(e.target.checked)} />
                  Functional - Multi Tab (if required)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={includeCrossBrowser} onChange={(e) => setIncludeCrossBrowser(e.target.checked)} />
                  Functional - Cross Browser (if required)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={includeBoundary} onChange={(e) => setIncludeBoundary(e.target.checked)} />
                  Boundary Value Analysis / Techniques
                </label>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={generating || !hasLlmKey}
                >
                  {generating ? "Generating..." : "Generate test cases"}
                </Button>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    if (!generationRequestId) {
                      setError("Generate test cases before saving.");
                      return;
                    }
                    if (selectedDraftIndexes.length === 0) {
                      setError("Select at least one generated draft to save.");
                      return;
                    }
                    setSuiteId("");
                    setShowSuitePickerModal(true);
                  }}
                  disabled={saving || drafts.length === 0 || selectedDraftIndexes.length === 0}
                >
                  {saving ? "Saving..." : `Save selected (${selectedDraftIndexes.length})`}
                </Button>
              </div>
            </div>
          </Card>

          {drafts.length > 0 && (
            <div className="space-y-3">
              {drafts.map((draft, idx) => (
                <Card key={`${draft.title}-${idx}`} className="p-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedDraftIndexes.includes(idx)}
                        onChange={() => toggleDraftSelection(idx)}
                      />
                      Select
                    </label>
                    <StatusChip tone="neutral">{draft.priority}</StatusChip>
                  </div>
                  <h3 className="text-base font-semibold text-[var(--foreground)]">{draft.title}</h3>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {draft.expectedSummary}
                  </p>
                  {(draft.tags ?? []).length > 0 && (
                    <p className="mt-2 text-xs text-[var(--muted)]">Tags: {draft.tags.join(", ")}</p>
                  )}
                </Card>
              ))}
            </div>
          )}
        </section>

      {/* Suite picker modal */}
      <Modal
        open={showSuitePickerModal}
        onClose={() => setShowSuitePickerModal(false)}
        title="Select target suite"
        className="max-w-md"
      >
        <p className="mt-1 text-sm text-[var(--muted)] mb-4">
          Choose which suite to save the selected test case(s) into.
        </p>
        <Field>
          <FieldLabel>Suite</FieldLabel>
          <Select
            value={suiteId}
            onChange={(e) => setSuiteId(e.target.value)}
          >
            <option value="">No suite (uncategorized)</option>
            {suites.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setShowSuitePickerModal(false)}>
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() => {
              setShowSuitePickerModal(false);
              void handleSaveSelectedDrafts();
            }}
          >
            {saving ? "Saving..." : "Save test cases"}
          </Button>
        </div>
      </Modal>
    </StandardPageLayout>
  );
}
