"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import TagInput from "@/components/TagInput";
import {
  authMe,
  getTestCase,
  updateTestCase,
  createTestCase,
  listSuites,
  listTestCases,
  getAgentSettings,
  getProject,
  type SuiteNode,
  type TestCaseListItem,
} from "@/lib/api";
import { runAegisInBackground } from "@/lib/aegis-runner";
import { AegisBackgroundIndicator } from "@/components/aegis-background-indicator";
import { Button, Input, Select, Textarea, Modal, Field, FieldLabel } from "@/components/ui";
import { PageHeader } from "@/components/workflows";

type Step = { stepNumber?: number; action?: string; expectedResult?: string };
type ScriptHistoryEntry = {
  scriptVersion: number;
  testcaseVersion: number | null;
  script: string;
  language: string;
  capturedAt: string;
  isCurrent: boolean;
};

const FETCH_LIMIT = 100;
const AGENT_ALLOCATION_ERROR = "AI Key is not allocated to this Project, can not utilize the Agents";

function parseTagString(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseProjectSettings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export default function TestCaseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const testcaseId = params.tcId as string;
  const isNew = testcaseId === "new";
  const initialSuiteId = searchParams.get("suiteId");
  const [tc, setTc] = useState<Record<string, unknown> | null>(null);
  const [suites, setSuites] = useState<SuiteNode[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [preconditions, setPreconditions] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [testData, setTestData] = useState("");
  const [automationStatus, setAutomationStatus] = useState("In Planning");
  const [estimatedDuration, setEstimatedDuration] = useState("");
  const [attachments, setAttachments] = useState("");
  const [automationTags, setAutomationTags] = useState<string[]>([]);
  const [automationScript, setAutomationScript] = useState("");
  const [automationScriptVersion, setAutomationScriptVersion] = useState(0);
  const [scriptVersionHistory, setScriptVersionHistory] = useState<ScriptHistoryEntry[]>([]);
  const [selectedScriptHistoryKey, setSelectedScriptHistoryKey] = useState("current");
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [existingTagSuggestions, setExistingTagSuggestions] = useState<string[]>([]);
  const [type, setType] = useState("Functional");
  const [priority, setPriority] = useState("P2");
  const [status, setStatus] = useState("Draft");
  const [suiteId, setSuiteId] = useState("");
  const [saving, setSaving] = useState(false);
  const [assigningToAegis, setAssigningToAegis] = useState(false);
  const [saveNotification, setSaveNotification] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [canUseAgents, setCanUseAgents] = useState(false);
  

  async function loadAllCases(): Promise<TestCaseListItem[]> {
    let offset = 0;
    const out: TestCaseListItem[] = [];
    while (true) {
      const { list, total } = await listTestCases(projectId, { limit: FETCH_LIMIT, offset });
      out.push(...list);
      offset += list.length;
      if (offset >= total || list.length === 0) break;
    }
    return out;
  }

  async function loadTagSuggestions() {
    const cases = await loadAllCases();
    const unique = new Set<string>();
    cases.forEach((tc) => {
      parseTagString(tc.automationTags ?? "").forEach((tag) => unique.add(tag));
    });
    setExistingTagSuggestions(Array.from(unique).sort((a, b) => a.localeCompare(b)));
  }

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getProject(projectId)
        .then((project) => {
          const parsedSettings = parseProjectSettings(project.settings);
          const aiRaw = (parsedSettings.ai ?? {}) as Record<string, unknown>;
          const aiEnabled = aiRaw.enabled !== false;
          setCanUseAgents(project.aiConfigured === true && aiEnabled);
        })
        .catch(() => setCanUseAgents(false));
      if (isNew) {
        setTc({});
        listSuites(projectId).then((items) => {
          setSuites(items);
          if (initialSuiteId) {
            setSuiteId(initialSuiteId);
          } else if (items.length > 0) {
            setSuiteId(items[0].id);
          }
        });
        loadTagSuggestions().catch(() => {});
        setTitle("");
        setDescription("");
        setPreconditions("");
        setSteps([{ stepNumber: 1, action: "", expectedResult: "" }]);
        setTestData("");
        setAutomationStatus("No");
        setEstimatedDuration("");
        setAttachments("");
        setAutomationTags([]);
        setAutomationScript("");
        setAutomationScriptVersion(0);
        setScriptVersionHistory([]);
        setSelectedScriptHistoryKey("current");
        setType("Functional");
        setPriority("P2");
        setStatus("Draft");
        return;
      }
      getTestCase(projectId, testcaseId).then((p) => {
        setTc(p);
        listSuites(projectId).then(setSuites);
        loadTagSuggestions().catch(() => {});
        setTitle((p.title as string) ?? "");
        setDescription((p.description as string) ?? "");
        setPreconditions((p.preconditions as string) ?? "");
        setTestData((p.testData as string) ?? "");
        setAutomationStatus((p.automationStatus as string) ?? "In Planning");
        setEstimatedDuration((p.estimatedDuration as string) ?? "");
        setAttachments((p.attachments as string) ?? "");
        setAutomationTags(parseTagString((p.automationTags as string) ?? ""));
        setAutomationScript((p.automationScript as string) ?? "");
        const loadedScriptVersion = Number(p.automationScriptVersion ?? 0);
        setAutomationScriptVersion(Number.isFinite(loadedScriptVersion) ? loadedScriptVersion : 0);
        const historyRaw = Array.isArray(p.automationScriptHistory)
          ? (p.automationScriptHistory as Array<Record<string, unknown>>)
              .map((entry): ScriptHistoryEntry | null => {
                const script = typeof entry.script === "string" ? entry.script : "";
                if (!script.trim()) return null;
                const scriptVersion = Number(entry.scriptVersion ?? 0);
                const testcaseVersionRaw =
                  entry.testcaseVersion == null ? null : Number(entry.testcaseVersion);
                return {
                  scriptVersion: Number.isFinite(scriptVersion) ? scriptVersion : 0,
                  testcaseVersion:
                    testcaseVersionRaw != null && Number.isFinite(testcaseVersionRaw)
                      ? testcaseVersionRaw
                      : null,
                  script,
                  language: typeof entry.language === "string" ? entry.language : "",
                  capturedAt: typeof entry.capturedAt === "string" ? entry.capturedAt : "",
                  isCurrent: entry.isCurrent === true,
                };
              })
              .filter((entry): entry is ScriptHistoryEntry => entry !== null)
          : [];
        setScriptVersionHistory(historyRaw);
        setSelectedScriptHistoryKey("current");
        setType((p.type as string) ?? "Functional");
        setSuiteId((p.suiteId as string) ?? "");
        const s = (p.steps as string) ?? "[]";
        let parsed: Step[] = [];
        try {
          parsed = JSON.parse(s);
        } catch {
          parsed = [{ stepNumber: 1, action: "", expectedResult: "" }];
        }
        if (!Array.isArray(parsed) || parsed.length === 0) parsed = [{ stepNumber: 1, action: "", expectedResult: "" }];
        setSteps(parsed);
        setPriority((p.priority as string) ?? "P2");
        setStatus((p.status as string) ?? "Draft");
      }).catch(() => router.replace("/projects"));
    });
  }, [projectId, testcaseId, isNew, initialSuiteId, router]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const action =
      ((e.nativeEvent as unknown as { submitter?: { value?: string } }).submitter?.value as string | undefined) ??
      "create";
    setSaving(true);
    try {
      if (isNew) {
        const effectiveAutomationStatus = automationScript.trim() ? "Automated" : automationStatus;
        const created = await createTestCase(projectId, {
          suiteId: suiteId || undefined,
          title,
          description,
          preconditions,
          steps: JSON.stringify(steps),
          testData,
          automationStatus: effectiveAutomationStatus,
          estimatedDuration,
          attachments,
          automationTags: automationTags.join(", "),
          automationScript,
          automationScriptLanguage: "playwright-ts",
          type,
          priority,
          status,
        });
        if (effectiveAutomationStatus === "Ready for the Automation") {
          const settings = getAgentSettings(projectId, "aegis");
          if (settings.autoStartOnReady) {
            if (canUseAgents) {
              await runAegisInBackground(projectId, created.id, title, created.externalId || "", "ready_for_automation");
            } else {
              setSaveNotification({ type: "error", message: AGENT_ALLOCATION_ERROR });
              setTimeout(() => setSaveNotification(null), 6000);
            }
          }
        }
        if (action === "create-next") {
          setTitle("");
          setDescription("");
          setPreconditions("");
          setSteps([{ stepNumber: 1, action: "", expectedResult: "" }]);
          setTestData("");
          setAutomationStatus("In Planning");
          setEstimatedDuration("");
          setAttachments("");
          setAutomationTags([]);
          setAutomationScript("");
          setType("Functional");
          setPriority("P2");
          setStatus("Draft");
          router.push(
            suiteId
              ? `/projects/${projectId}/testcases/new?suiteId=${suiteId}`
              : `/projects/${projectId}/testcases/new`
          );
        } else {
          router.push(
            suiteId
              ? `/projects/${projectId}/testcases?suiteId=${suiteId}`
              : `/projects/${projectId}/testcases`
          );
        }
        router.refresh();
      } else {
        const effectiveAutomationStatus = automationScript.trim() ? "Automated" : automationStatus;
        await updateTestCase(projectId, testcaseId, {
          suiteId: suiteId || undefined,
          title,
          description,
          preconditions,
          steps: JSON.stringify(steps),
          testData,
          automationStatus: effectiveAutomationStatus,
          estimatedDuration,
          attachments,
          automationTags: automationTags.join(", "),
          automationScript,
          automationScriptLanguage: "playwright-ts",
          type,
          priority,
          status,
        });
        if (effectiveAutomationStatus === "Ready for the Automation") {
          const settings = getAgentSettings(projectId, "aegis");
          if (settings.autoStartOnReady) {
            if (canUseAgents) {
              await runAegisInBackground(projectId, testcaseId, title, "", "ready_for_automation");
            } else {
              setSaveNotification({ type: "error", message: AGENT_ALLOCATION_ERROR });
              setTimeout(() => setSaveNotification(null), 6000);
            }
          }
        }
        setSaveNotification({ type: "success", message: "Test case updated successfully." });
        setTimeout(() => setSaveNotification(null), 4000);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save test case.";
      setSaveNotification({ type: "error", message });
      setTimeout(() => setSaveNotification(null), 6000);
    } finally {
      setSaving(false);
    }
  }

  function addStep() {
    setSteps((s) => [...s, { stepNumber: s.length + 1, action: "", expectedResult: "" }]);
  }

  function removeStep(i: number) {
    setSteps((s) => s.filter((_, idx) => idx !== i).map((st, idx) => ({ ...st, stepNumber: idx + 1 })));
  }

  function updateStep(i: number, field: keyof Step, value: string | number) {
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, [field]: value } : st)));
  }

  function onOpenLivePreviewRerun() {
    if (isNew) return;
    const rerunUrl = `/projects/${projectId}/testcases/${testcaseId}/rerun-live-preview`;
    window.open(rerunUrl, "_blank", "noopener,noreferrer");
  }

  async function onAssignToAegisQueue() {
    if (isNew || assigningToAegis) return;
    setAssigningToAegis(true);
    try {
      if (!canUseAgents) {
        throw new Error(AGENT_ALLOCATION_ERROR);
      }
      const currentExternalId = String((tc as Record<string, unknown> | null)?.externalId ?? "");
      const currentTitle = String((tc as Record<string, unknown> | null)?.title ?? "");
      await runAegisInBackground(
        projectId,
        testcaseId,
        title.trim() || currentTitle || "Untitled test case",
        currentExternalId,
        "manual"
      );
      setSaveNotification({ type: "success", message: "Assigned to Aegis. Task added to queue." });
      setTimeout(() => setSaveNotification(null), 4000);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to assign test case to Aegis queue.";
      setSaveNotification({ type: "error", message });
      setTimeout(() => setSaveNotification(null), 6000);
    } finally {
      setAssigningToAegis(false);
    }
  }

  if (tc === null && !isNew) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const previousScriptHistory = scriptVersionHistory.filter((entry) => !entry.isCurrent);
  const selectedHistoryEntry =
    selectedScriptHistoryKey === "current"
      ? null
      : previousScriptHistory[Number(selectedScriptHistoryKey.replace("history-", ""))] || null;
  const displayedScript = selectedHistoryEntry ? selectedHistoryEntry.script : automationScript;
  const currentScriptVersionLabel = automationScript.trim()
    ? `v${Math.max(1, automationScriptVersion)}`
    : "Not versioned yet";

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <main className="max-w-3xl mx-auto px-4 py-8">
        <PageHeader
          title={isNew ? "New Test Case" : (tc as Record<string, string>)?.externalId ?? "Test Case"}
          breadcrumb={
            <nav className="flex items-center gap-1 text-sm">
              <Link href={`/projects/${projectId}/dashboard`} className="text-[var(--muted)] hover:text-[var(--foreground)]">Project</Link>
              <span className="text-[var(--muted-soft)]">/</span>
              <Link href={`/projects/${projectId}/testcases`} className="text-[var(--muted)] hover:text-[var(--foreground)]">Test cases</Link>
            </nav>
          }
        />
        <AegisBackgroundIndicator />
        {saveNotification && (
          <div className={`mb-6 flex items-center justify-between rounded-lg border px-4 py-3 ${
            saveNotification.type === "success"
              ? "border-[var(--success)]/30 bg-[var(--brand-soft)]"
              : "border-[var(--error)]/30 bg-red-50"
          }`}>
            <p className={`text-sm ${
              saveNotification.type === "success"
                ? "text-[var(--success)]"
                : "text-[var(--error)]"
            }`}>{saveNotification.message}</p>
            <button
              type="button"
              onClick={() => setSaveNotification(null)}
              className={`ml-4 text-sm ${
                saveNotification.type === "success"
                  ? "text-[var(--success)] hover:opacity-80"
                  : "text-[var(--error)] hover:opacity-80"
              }`}
            >
              Dismiss
            </button>
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-6">
          <Field>
            <FieldLabel>Title</FieldLabel>
            <Input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </Field>
          <Field>
            <FieldLabel>Preconditions</FieldLabel>
            <Textarea
              value={preconditions}
              onChange={(e) => setPreconditions(e.target.value)}
              rows={2}
            />
          </Field>
          <Field>
            <FieldLabel>Test Data</FieldLabel>
            <Textarea
              value={testData}
              onChange={(e) => setTestData(e.target.value)}
              rows={3}
              placeholder="Input data, sample values, or setup-specific data"
            />
          </Field>
          <div>
            <div className="flex items-center justify-between mb-2">
              <FieldLabel>Steps</FieldLabel>
              <button type="button" onClick={addStep} className="text-sm text-[var(--brand-primary)] hover:underline">Add step</button>
            </div>
            <div className="space-y-3">
              {steps.map((step, i) => (
                <div key={i} className="rounded-lg border border-[var(--border)] p-3 flex gap-2">
                  <span className="text-[var(--muted)] font-mono text-sm w-8">{i + 1}.</span>
                  <div className="flex-1 grid gap-2">
                    <Input
                      placeholder="Action"
                      value={step.action ?? ""}
                      onChange={(e) => updateStep(i, "action", e.target.value)}
                      className="text-sm"
                    />
                    <Input
                      placeholder="Expected result"
                      value={step.expectedResult ?? ""}
                      onChange={(e) => updateStep(i, "expectedResult", e.target.value)}
                      className="text-sm"
                    />
                  </div>
                  {steps.length > 1 && (
                    <button type="button" onClick={() => removeStep(i)} className="text-[var(--error)] text-sm">Remove</button>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-4">
            <Field>
              <FieldLabel>Suite</FieldLabel>
              <Select
                value={suiteId}
                onChange={(e) => setSuiteId(e.target.value)}
              >
                <option value="">No suite</option>
                {suites.map((suite) => (
                  <option key={suite.id} value={suite.id}>
                    {suite.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel>Test case type</FieldLabel>
              <Select
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                <option value="Functional">Functional</option>
                <option value="Regression">Regression</option>
                <option value="Smoke">Smoke</option>
                <option value="Sanity">Sanity</option>
                <option value="Integration">Integration</option>
                <option value="API">API</option>
                <option value="UI">UI</option>
                <option value="Performance">Performance</option>
                <option value="Security">Security</option>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Automation Feasibility</FieldLabel>
              <Select
                value={automationStatus}
                onChange={(e) => setAutomationStatus(e.target.value)}
              >
                <option value="In Planning">In Planning</option>
                <option value="Not able to Automate">Not able to Automate</option>
                <option value="Ready for the Automation">Ready for the Automation</option>
                <option value="Automated">Automated</option>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Priority</FieldLabel>
              <Select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="P0">P0</option>
                <option value="P1">P1</option>
                <option value="P2">P2</option>
                <option value="P3">P3</option>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Status</FieldLabel>
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="Draft">Draft</option>
                <option value="In Review">In Review</option>
                <option value="Approved">Approved</option>
                <option value="Deprecated">Deprecated</option>
                <option value="Archived">Archived</option>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Estimated Duration</FieldLabel>
              <Input
                type="text"
                value={estimatedDuration}
                onChange={(e) => setEstimatedDuration(e.target.value)}
                placeholder="e.g. 10 min"
              />
            </Field>
            <TagInput
              label="Tags / Labels"
              selectedTags={automationTags}
              onChange={setAutomationTags}
              suggestions={existingTagSuggestions}
              placeholder="Type a tag then press Enter"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <FieldLabel>Playwright Script</FieldLabel>
              {!isNew && (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={onOpenLivePreviewRerun}
                    className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                  >
                    Re Run Last Test (Live Preview)
                  </Button>
                </div>
              )}
            </div>
            <p className="mb-2 text-xs text-[var(--muted)]">
              You can edit the script manually here and use the run action to validate the latest flow.
            </p>
            <p className="mb-2 text-xs text-[var(--muted)]">
              Current script version: <span className="font-medium">{currentScriptVersionLabel}</span>
              {previousScriptHistory.length > 0
                ? ` • ${previousScriptHistory.length} previous version${previousScriptHistory.length === 1 ? "" : "s"}`
                : ""}
            </p>
            <button
              type="button"
              onClick={() => setVersionHistoryOpen(true)}
              disabled={scriptVersionHistory.length === 0}
              className="mb-2 text-xs text-[var(--brand-primary)] hover:underline disabled:text-[var(--muted-soft)] disabled:no-underline"
            >
              View Version History
            </button>
            <Textarea
              value={automationScript}
              onChange={(e) => setAutomationScript(e.target.value)}
              rows={14}
              placeholder={"import { test, expect } from '@playwright/test';\n\ntest('sample', async ({ page }) => {\n  await page.goto('https://example.com');\n  await expect(page).toHaveTitle(/Example/);\n});"}
              className="font-mono text-xs"
            />
          </div>
          <Field>
            <FieldLabel>Attachments</FieldLabel>
            <Textarea
              value={attachments}
              onChange={(e) => setAttachments(e.target.value)}
              rows={2}
              placeholder="Links/paths to screenshots, logs, or reference docs"
            />
          </Field>
          <div className="flex gap-2">
            {!isNew && (
              <Button
                type="button"
                variant="ai"
                onClick={() => void onAssignToAegisQueue()}
                disabled={assigningToAegis || saving}
                title={!canUseAgents ? AGENT_ALLOCATION_ERROR : "Assign to Aegis"}
              >
                {assigningToAegis ? "Assigning..." : "Assign to Aegis"}
              </Button>
            )}
            {!isNew && (
              <span className="rounded-xl border border-[var(--brand-primary)]/20 bg-[var(--brand-soft)] py-2 px-4 text-sm text-[var(--brand-primary)]">
                Update script and use the run action from the script section to validate changes.
              </span>
            )}
            <Button
              type="submit"
              value="create"
              variant="primary"
              disabled={saving}
            >
              {saving ? "Saving…" : isNew ? "Create" : "Save"}
            </Button>
            {isNew && (
              <Button
                type="submit"
                value="create-next"
                variant="secondary"
                disabled={saving}
              >
                {saving ? "Saving…" : "Create and Add Next"}
              </Button>
            )}
            {!isNew && (
              <Link
                href={`/projects/${projectId}/testcases`}
                className="inline-flex items-center justify-center h-10 rounded-xl border border-[var(--border)] px-4 font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
              >
                Cancel
              </Link>
            )}
          </div>
        </form>
      </main>
      <Modal
        open={versionHistoryOpen}
        onClose={() => setVersionHistoryOpen(false)}
        title="Script Version History"
        className="max-w-5xl"
      >
        <div className="grid gap-3 md:grid-cols-[220px_1fr]">
          <div className="max-h-[60vh] overflow-auto rounded-xl border border-[var(--border)] p-2">
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setSelectedScriptHistoryKey("current")}
                className={`w-full rounded-lg px-2 py-1 text-left text-xs ${
                  selectedScriptHistoryKey === "current"
                    ? "bg-[var(--brand-primary)] text-white"
                    : "bg-[var(--background)] text-[var(--foreground)]"
                }`}
              >
                {`v${Math.max(1, automationScriptVersion)} (Latest)`}
              </button>
              {previousScriptHistory.map((entry, idx) => {
                const itemKey = `history-${idx}`;
                return (
                  <button
                    key={`${entry.scriptVersion}-${idx}`}
                    type="button"
                    onClick={() => setSelectedScriptHistoryKey(itemKey)}
                    className={`w-full rounded-lg px-2 py-1 text-left text-xs ${
                      selectedScriptHistoryKey === itemKey
                        ? "bg-[var(--brand-primary)] text-white"
                        : "bg-[var(--background)] text-[var(--foreground)]"
                    }`}
                  >
                    {`v${entry.scriptVersion}`}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--border)] p-2">
            <textarea
              value={displayedScript}
              readOnly
              rows={24}
              className="h-[60vh] w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs text-[var(--foreground)]"
            />
            {selectedHistoryEntry?.testcaseVersion != null && (
              <p className="mt-2 text-[11px] text-[var(--muted)]">
                Snapshot from testcase version {selectedHistoryEntry.testcaseVersion}.
              </p>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
