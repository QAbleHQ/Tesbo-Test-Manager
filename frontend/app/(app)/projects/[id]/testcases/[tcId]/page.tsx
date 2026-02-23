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
  type SuiteNode,
  type TestCaseListItem,
} from "@/lib/api";

type Step = { stepNumber?: number; action?: string; expectedResult?: string };

const FETCH_LIMIT = 100;

function parseTagString(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
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
  const [automationStatus, setAutomationStatus] = useState("No");
  const [estimatedDuration, setEstimatedDuration] = useState("");
  const [attachments, setAttachments] = useState("");
  const [automationTags, setAutomationTags] = useState<string[]>([]);
  const [existingTagSuggestions, setExistingTagSuggestions] = useState<string[]>([]);
  const [type, setType] = useState("Functional");
  const [priority, setPriority] = useState("P2");
  const [status, setStatus] = useState("Draft");
  const [suiteId, setSuiteId] = useState("");
  const [saving, setSaving] = useState(false);

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
        setAutomationStatus((p.automationStatus as string) ?? "No");
        setEstimatedDuration((p.estimatedDuration as string) ?? "");
        setAttachments((p.attachments as string) ?? "");
        setAutomationTags(parseTagString((p.automationTags as string) ?? ""));
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
        await createTestCase(projectId, {
          suiteId: suiteId || undefined,
          title,
          description,
          preconditions,
          steps: JSON.stringify(steps),
          testData,
          automationStatus,
          estimatedDuration,
          attachments,
          automationTags: automationTags.join(", "),
          type,
          priority,
          status,
        });
        if (action === "create-next") {
          setTitle("");
          setDescription("");
          setPreconditions("");
          setSteps([{ stepNumber: 1, action: "", expectedResult: "" }]);
          setTestData("");
          setAutomationStatus("No");
          setEstimatedDuration("");
          setAttachments("");
          setAutomationTags([]);
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
        await updateTestCase(projectId, testcaseId, {
          suiteId: suiteId || undefined,
          title,
          description,
          preconditions,
          steps: JSON.stringify(steps),
          testData,
          automationStatus,
          estimatedDuration,
          attachments,
          automationTags: automationTags.join(", "),
          type,
          priority,
          status,
        });
      }
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

  if (tc === null && !isNew) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 flex items-center gap-4">
        <Link href="/projects" className="font-semibold text-zinc-900 dark:text-zinc-100">BetterCases</Link>
        <span className="text-zinc-500">/</span>
        <Link href={`/projects/${projectId}/dashboard`} className="text-zinc-700 dark:text-zinc-300">Project</Link>
        <span className="text-zinc-500">/</span>
        <Link href={`/projects/${projectId}/testcases`} className="text-zinc-700 dark:text-zinc-300">Test cases</Link>
        <span className="text-zinc-500">/</span>
        <span className="text-zinc-700 dark:text-zinc-300">{isNew ? "New" : (tc as Record<string, string>)?.externalId}</span>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-8">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Preconditions</label>
            <textarea
              value={preconditions}
              onChange={(e) => setPreconditions(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Test Data</label>
            <textarea
              value={testData}
              onChange={(e) => setTestData(e.target.value)}
              rows={3}
              placeholder="Input data, sample values, or setup-specific data"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Steps</label>
              <button type="button" onClick={addStep} className="text-sm text-blue-600 hover:underline">Add step</button>
            </div>
            <div className="space-y-3">
              {steps.map((step, i) => (
                <div key={i} className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 flex gap-2">
                  <span className="text-zinc-500 font-mono text-sm w-8">{i + 1}.</span>
                  <div className="flex-1 grid gap-2">
                    <input
                      placeholder="Action"
                      value={step.action ?? ""}
                      onChange={(e) => updateStep(i, "action", e.target.value)}
                      className="w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1 text-sm"
                    />
                    <input
                      placeholder="Expected result"
                      value={step.expectedResult ?? ""}
                      onChange={(e) => updateStep(i, "expectedResult", e.target.value)}
                      className="w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1 text-sm"
                    />
                  </div>
                  {steps.length > 1 && (
                    <button type="button" onClick={() => removeStep(i)} className="text-red-600 text-sm">Remove</button>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-4">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Suite</label>
              <select
                value={suiteId}
                onChange={(e) => setSuiteId(e.target.value)}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
              >
                <option value="">No suite</option>
                {suites.map((suite) => (
                  <option key={suite.id} value={suite.id}>
                    {suite.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Test case type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
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
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Automation Feasibility</label>
              <select
                value={automationStatus}
                onChange={(e) => setAutomationStatus(e.target.value)}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
              >
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
              >
                <option value="P0">P0</option>
                <option value="P1">P1</option>
                <option value="P2">P2</option>
                <option value="P3">P3</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
              >
                <option value="Draft">Draft</option>
                <option value="In Review">In Review</option>
                <option value="Approved">Approved</option>
                <option value="Deprecated">Deprecated</option>
                <option value="Archived">Archived</option>
              </select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Estimated Duration</label>
              <input
                type="text"
                value={estimatedDuration}
                onChange={(e) => setEstimatedDuration(e.target.value)}
                placeholder="e.g. 10 min"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
              />
            </div>
            <TagInput
              label="Tags / Labels"
              selectedTags={automationTags}
              onChange={setAutomationTags}
              suggestions={existingTagSuggestions}
              placeholder="Type a tag then press Enter"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Attachments</label>
            <textarea
              value={attachments}
              onChange={(e) => setAttachments(e.target.value)}
              rows={2}
              placeholder="Links/paths to screenshots, logs, or reference docs"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2"
            />
          </div>
          <div className="flex gap-2">
            {!isNew && (
              <Link
                href={`/projects/${projectId}/testcases/${testcaseId}/automate`}
                className="rounded-lg border border-blue-300 bg-blue-50 text-blue-700 py-2 px-4 font-medium hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-900/40"
              >
                Automate
              </Link>
            )}
            <button
              type="submit"
              value="create"
              disabled={saving}
              className="rounded-lg bg-blue-600 text-white py-2 px-4 font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : isNew ? "Create" : "Save"}
            </button>
            {isNew && (
              <button
                type="submit"
                value="create-next"
                disabled={saving}
                className="rounded-lg border border-blue-300 bg-white text-blue-700 py-2 px-4 font-medium hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:bg-zinc-900 dark:text-blue-300 dark:hover:bg-blue-950/30"
              >
                {saving ? "Saving…" : "Create and Add Next"}
              </button>
            )}
            {!isNew && (
              <Link
                href={`/projects/${projectId}/testcases`}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 py-2 px-4 font-medium"
              >
                Cancel
              </Link>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
