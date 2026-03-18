"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  authMe,
  createTestCase,
  listAiGenerationHistory,
  listSuites,
  trackAiGenerationSaved,
  type AiGeneratedDraft,
  type AiGenerationHistoryItem,
  type SuiteNode,
} from "@/lib/api";
import { Button, Card, StatusChip, Modal, Field, FieldLabel, Select, EmptyStateBlock } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function AiGenerationHistoryPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AiGenerationHistoryItem[]>([]);
  const [suites, setSuites] = useState<SuiteNode[]>([]);

  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [historyDrafts, setHistoryDrafts] = useState<AiGeneratedDraft[]>([]);
  const [selectedDraftIndexes, setSelectedDraftIndexes] = useState<number[]>([]);
  const [savingFromHistory, setSavingFromHistory] = useState(false);

  const [showSuitePickerModal, setShowSuitePickerModal] = useState(false);
  const [suiteId, setSuiteId] = useState("");

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([listSuites(projectId), listAiGenerationHistory(projectId, { limit: 50 })])
        .then(([suiteList, historyRes]) => {
          setSuites(suiteList);
          setHistory(historyRes.list);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Failed to load generation history"))
        .finally(() => setLoading(false));
    });
  }, [projectId, router]);

  async function refreshHistory() {
    const res = await listAiGenerationHistory(projectId, { limit: 50 });
    setHistory(res.list);
  }

  function handleExpandHistory(item: AiGenerationHistoryItem) {
    if (expandedHistoryId === item.id) {
      setExpandedHistoryId(null);
      setHistoryDrafts([]);
      setSelectedDraftIndexes([]);
      return;
    }
    setExpandedHistoryId(item.id);
    const payload = parseJsonArray(item.generatedPayload) as AiGeneratedDraft[];
    setHistoryDrafts(payload);
    setSelectedDraftIndexes([]);
  }

  function toggleDraftSelection(index: number) {
    setSelectedDraftIndexes((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  }

  function toggleAllDrafts() {
    if (selectedDraftIndexes.length === historyDrafts.length) {
      setSelectedDraftIndexes([]);
    } else {
      setSelectedDraftIndexes(historyDrafts.map((_, i) => i));
    }
  }

  async function handleSaveFromHistory() {
    if (!expandedHistoryId) return;
    const selected = selectedDraftIndexes.map((i) => historyDrafts[i]).filter(Boolean);
    if (selected.length === 0) {
      setError("Select at least one test case to save.");
      return;
    }
    setSavingFromHistory(true);
    setError(null);
    try {
      const expandedItem = history.find((h) => h.id === expandedHistoryId);
      const createdIds: string[] = [];
      for (const draft of selected) {
        const parsedSteps = parseJsonArray(draft.stepsJson);
        const created = await createTestCase(projectId, {
          suiteId: suiteId || undefined,
          title: draft.title,
          description: `${expandedItem?.acceptanceCriteria ? `${expandedItem.acceptanceCriteria}\n\n` : ""}${draft.expectedSummary}`,
          preconditions: draft.preconditions,
          steps: JSON.stringify(parsedSteps.length > 0 ? parsedSteps : []),
          priority: draft.priority || "P2",
          type: "Functional",
          status: "Draft",
          automationTags: (draft.tags ?? []).join(", "),
        });
        createdIds.push(String(created.id));
      }
      await trackAiGenerationSaved(projectId, expandedHistoryId, {
        suiteId: suiteId || undefined,
        testcaseIds: createdIds,
      });
      await refreshHistory();
      setSelectedDraftIndexes([]);
      setError(`Saved ${createdIds.length} test case(s) successfully.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save test cases from history");
    } finally {
      setSavingFromHistory(false);
    }
  }

  if (loading) {
    return (
      <main className="px-6 py-6">
        <p className="text-[var(--muted)]">Loading generation history...</p>
      </main>
    );
  }

  const emptyIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-10 h-10">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Generation History"
          subtitle="Browse past AI test case generations. Open a record to view the prompt, generated test cases, and optionally save them to a suite."
        />
      }
    >
      {error && (
        <p className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--muted)]">
          {error}
        </p>
      )}

      {history.length === 0 ? (
        <EmptyStateBlock
          title="No generation history yet"
          description="Generate test cases from the Test Generation page to see history here."
          icon={emptyIcon}
        />
      ) : (
        <div className="space-y-3">
          {history.map((item) => {
            const saveEvents = parseJsonArray(item.saveEvents);
            const isExpanded = expandedHistoryId === item.id;
            const coverageTags = [
              item.includeHappyFlow && "Happy Flow",
              item.includeNegativeFlow && "Negative Flow",
              item.includeMultiTab && "Multi-Tab",
              item.includeCrossBrowser && "Cross-Browser",
              item.includeBoundary && "BVA",
            ].filter(Boolean) as string[];

            return (
              <Card
                key={item.id}
                className={`transition-colors ${
                  isExpanded
                    ? "border-[var(--brand-primary)]"
                    : ""
                }`}
              >
                {/* Clickable header row */}
                <button
                  type="button"
                  onClick={() => handleExpandHistory(item)}
                  className="flex w-full items-center gap-3 p-4 text-left hover:bg-[var(--surface-secondary)] rounded-xl transition-colors"
                >
                    <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className={`w-4 h-4 shrink-0 text-[var(--muted-soft)] transition-transform ${isExpanded ? "rotate-90" : ""}`}
                  >
                    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-[var(--foreground)]">
                        {new Date(item.createdAt).toLocaleString()}
                        <span className="ml-2 inline-flex items-center rounded-full bg-[var(--surface-tertiary)] px-2 py-0.5 text-xs font-medium text-[var(--muted)]">
                          {item.provider.toUpperCase()}
                        </span>
                      </h3>
                      <div className="flex items-center gap-3 text-xs text-[var(--muted)]">
                        <span className="inline-flex items-center gap-1">
                          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                            <path d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.949 5.684a1 1 0 00-1.898 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.898l2.051.684a1 1 0 01.633.632l.683 2.051a1 1 0 001.898 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.898l-2.051-.683a1 1 0 01-.633-.633L6.95 5.684zM13.949 13.684a1 1 0 00-1.898 0l-.184.551a1 1 0 01-.632.633l-.551.183a1 1 0 000 1.898l.551.183a1 1 0 01.633.633l.183.551a1 1 0 001.898 0l.184-.551a1 1 0 01.632-.633l.551-.183a1 1 0 000-1.898l-.551-.184a1 1 0 01-.633-.632l-.183-.551z" />
                          </svg>
                          {item.generatedCount} generated
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                            <path d="M15.621 4.379a3 3 0 00-4.242 0l-7 7a3 3 0 004.241 4.243h.001l.497-.5a.75.75 0 011.064 1.057l-.498.501-.002.002a4.5 4.5 0 01-6.364-6.364l7-7a4.5 4.5 0 016.368 6.36l-3.455 3.553A2.625 2.625 0 119.52 9.52l3.45-3.451a.75.75 0 111.061 1.06l-3.45 3.451a1.125 1.125 0 001.587 1.595l3.454-3.553a3 3 0 000-4.242z" />
                          </svg>
                          {item.savedCount} saved
                        </span>
                      </div>
                    </div>
                    <p className="mt-1 text-sm text-[var(--muted)] truncate">{item.userStory}</p>
                  </div>
                </button>

                {/* Expanded detail view */}
                {isExpanded && (
                  <div className="border-t border-[var(--border)]">
                    {/* Prompt & configuration section */}
                    <div className="p-4 space-y-4 bg-[var(--surface-secondary)]">
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-1.5">Story / Feature Details</h4>
                        <p className="text-sm text-[var(--foreground)] whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
                          {item.userStory}
                        </p>
                      </div>

                      {item.acceptanceCriteria && (
                        <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-1.5">Acceptance Criteria</h4>
                        <p className="text-sm text-[var(--foreground)] whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
                            {item.acceptanceCriteria}
                          </p>
                        </div>
                      )}

                      {item.customPrompt && (
                        <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-1.5">Custom Prompt</h4>
                        <p className="text-sm text-[var(--foreground)] whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
                            {item.customPrompt}
                          </p>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-4">
                        <div>
                          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Coverage</span>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {coverageTags.map((tag) => (
                              <span key={tag} className="inline-flex rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--brand-primary)]">
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="text-xs text-[var(--muted)]">
                          Style: <span className="font-medium text-[var(--foreground)]">{item.style}</span>
                          {item.model && <> · Model: <span className="font-medium text-[var(--foreground)]">{item.model}</span></>}
                          {" "}· Requested: <span className="font-medium text-[var(--foreground)]">{item.requestedCount}</span>
                        </div>
                      </div>

                      {saveEvents.length > 0 && (
                        <div>
                          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Save History</span>
                          <div className="mt-1.5 space-y-1">
                            {(saveEvents as Array<{ savedAt?: string; savedCount?: number; suiteId?: string }>).map((evt, idx) => (
                              <div key={idx} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs">
                                <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-emerald-500">
                                  <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                                </svg>
                                <span className="text-[var(--muted)]">
                                  {evt.savedCount ?? 0} test case(s) saved
                                  {evt.savedAt ? ` on ${new Date(evt.savedAt).toLocaleString()}` : ""}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Generated test cases section */}
                    <div className="border-t border-[var(--border)] p-4">
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <h4 className="text-sm font-semibold text-[var(--foreground)]">
                          Generated Test Cases ({historyDrafts.length})
                        </h4>
                        {historyDrafts.length > 0 && (
                          <label className="flex items-center gap-1.5 text-xs text-[var(--muted)] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedDraftIndexes.length === historyDrafts.length && historyDrafts.length > 0}
                              onChange={toggleAllDrafts}
                              className="rounded"
                            />
                            Select all
                          </label>
                        )}
                      </div>

                      {historyDrafts.length === 0 ? (
                        <p className="text-sm text-[var(--muted)] italic">No generated payload stored for this record.</p>
                      ) : (
                        <div className="space-y-2">
                          {historyDrafts.map((draft, idx) => {
                            const steps = parseJsonArray(draft.stepsJson) as Array<{ action?: string; expected?: string }>;
                            const isSelected = selectedDraftIndexes.includes(idx);
                            return (
                              <div
                                key={idx}
                                className={`rounded-lg border p-3 transition-colors ${
                                  isSelected
                                    ? "border-[var(--brand-primary)] bg-[var(--brand-soft)]"
                                    : "border-[var(--border)] bg-[var(--surface)]"
                                }`}
                              >
                                <div className="flex items-start gap-3">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleDraftSelection(idx)}
                                    className="mt-0.5 rounded"
                                  />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                      <h5 className="text-sm font-medium text-[var(--foreground)]">{draft.title}</h5>
                                      <StatusChip tone="neutral">{draft.priority}</StatusChip>
                                    </div>
                                    {draft.expectedSummary && (
                                      <p className="text-xs text-[var(--muted)] mb-1.5">{draft.expectedSummary}</p>
                                    )}
                                    {draft.preconditions && (
                                      <p className="text-xs text-[var(--muted)] mb-1"><span className="font-medium">Preconditions:</span> {draft.preconditions}</p>
                                    )}
                                    {steps.length > 0 && (
                                      <div className="mt-1.5">
                                        <p className="text-xs font-medium text-[var(--muted)] mb-1">Steps:</p>
                                        <ol className="list-decimal list-inside space-y-0.5">
                                          {steps.map((step, si) => (
                                            <li key={si} className="text-xs text-[var(--muted)]">
                                              {step.action}
                                              {step.expected && (
                                                <span className="ml-1 text-[var(--success)]">
                                                  → {step.expected}
                                                </span>
                                              )}
                                            </li>
                                          ))}
                                        </ol>
                                      </div>
                                    )}
                                    {(draft.tags ?? []).length > 0 && (
                                      <div className="mt-1.5 flex flex-wrap gap-1">
                                        {draft.tags.map((tag) => (
                                          <span key={tag} className="inline-flex rounded bg-[var(--surface-tertiary)] px-1.5 py-0.5 text-xs text-[var(--muted)]">
                                            {tag}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Save from history controls */}
                      {historyDrafts.length > 0 && (
                        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
                          <Button
                            type="button"
                            onClick={() => {
                              if (selectedDraftIndexes.length === 0) {
                                setError("Select at least one test case to save.");
                                return;
                              }
                              setSuiteId("");
                              setShowSuitePickerModal(true);
                            }}
                            disabled={savingFromHistory || selectedDraftIndexes.length === 0}
                            size="sm"
                          >
                            {savingFromHistory
                              ? "Saving..."
                              : `Save selected (${selectedDraftIndexes.length})`}
                          </Button>
                          {selectedDraftIndexes.length === 0 && (
                            <span className="text-xs text-[var(--muted-soft)]">Select test cases above to save</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

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
            disabled={savingFromHistory}
            onClick={() => {
              setShowSuitePickerModal(false);
              void handleSaveFromHistory();
            }}
          >
            {savingFromHistory ? "Saving..." : "Save test cases"}
          </Button>
        </div>
      </Modal>
    </StandardPageLayout>
  );
}
