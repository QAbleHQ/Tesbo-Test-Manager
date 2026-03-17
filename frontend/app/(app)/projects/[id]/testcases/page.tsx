"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import TagInput from "@/components/TagInput";
import {
  authMe,
  listTestCases,
  listSuites,
  createSuite,
  updateSuite,
  deleteSuite,
  getTestCase,
  createTestCase,
  updateTestCase,
  deleteTestCase,
  bulkUpdateTestCases,
  bulkDeleteTestCases,
  getAgentSettings,
  type TestCaseListItem,
  type SuiteNode,
} from "@/lib/api";
import { runAegisInBackground, recoverOrphanedTasks } from "@/lib/aegis-runner";
import { AegisBackgroundIndicator } from "@/components/aegis-background-indicator";

const PAGE_SIZE = 100;
const TESTCASE_STATUSES = ["Draft", "In Review", "Approved", "Deprecated", "Archived"];
const TESTCASE_PRIORITIES = ["P0", "P1", "P2", "P3"];
const TESTCASE_TYPES = [
  "Functional",
  "Regression",
  "Smoke",
  "Sanity",
  "Integration",
  "API",
  "UI",
  "Performance",
  "Security",
];
const AUTOMATION_FEASIBILITY_OPTIONS = ["In Planning", "Not able to Automate", "Ready for the Automation", "Automated"];

type Step = { stepNumber?: number; action?: string; expectedResult?: string };
type PanelMode = "closed" | "edit" | "create";
type PanelTab = "overview" | "steps" | "automation";
type BulkAction = "" | "delete" | "update" | "archive";
type ViewMode = "bySuites" | "allCases";

const EMPTY_STEP: Step = { stepNumber: 1, action: "", expectedResult: "" };

function parseTagString(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export default function TestCasesPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const activeSuiteId = searchParams.get("suiteId");

  const [suites, setSuites] = useState<SuiteNode[]>([]);
  const [suiteCases, setSuiteCases] = useState<TestCaseListItem[]>([]);
  const [suiteCasesTotal, setSuiteCasesTotal] = useState(0);
  const [suiteCasesLoading, setSuiteCasesLoading] = useState(false);
  const [suiteCasesError, setSuiteCasesError] = useState<string | null>(null);
  const [suiteCasesPage, setSuiteCasesPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [isAddSuiteModalOpen, setIsAddSuiteModalOpen] = useState(false);
  const [newSuiteName, setNewSuiteName] = useState("");
  const [isCreatingSuite, setIsCreatingSuite] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>("closed");
  const [panelTab, setPanelTab] = useState<PanelTab>("overview");
  const [panelTestcaseId, setPanelTestcaseId] = useState<string | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelSaving, setPanelSaving] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelSuccess, setPanelSuccess] = useState<string | null>(null);
  const [submitAction, setSubmitAction] = useState<"create" | "create-next">("create");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [preconditions, setPreconditions] = useState("");
  const [steps, setSteps] = useState<Step[]>([{ ...EMPTY_STEP }]);
  const [testData, setTestData] = useState("");
  const [automationStatus, setAutomationStatus] = useState("In Planning");
  const [automationScript, setAutomationScript] = useState("");
  const [estimatedDuration, setEstimatedDuration] = useState("");
  const [attachments, setAttachments] = useState("");
  const [automationTags, setAutomationTags] = useState<string[]>([]);
  const [type, setType] = useState("Functional");
  const [priority, setPriority] = useState("P2");
  const [status, setStatus] = useState("Draft");
  const [suiteId, setSuiteId] = useState("");
  const [panelJiraIssueKey, setPanelJiraIssueKey] = useState("");
  const [panelJiraUrl, setPanelJiraUrl] = useState("");
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<BulkAction>("");
  const [isBulkActionModalOpen, setIsBulkActionModalOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkStatus, setBulkStatus] = useState("Draft");
  const [bulkPriority, setBulkPriority] = useState("P2");
  const [deleteSuiteId, setDeleteSuiteId] = useState<string | null>(null);
  const [deleteSuiteSaving, setDeleteSuiteSaving] = useState(false);
  const [suiteSearch, setSuiteSearch] = useState("");
  const [suiteStatusFilter, setSuiteStatusFilter] = useState("all");
  const [suitePriorityFilter, setSuitePriorityFilter] = useState("all");
  const [suiteTypeFilter, setSuiteTypeFilter] = useState("all");
  const [suiteAutomationFilter, setSuiteAutomationFilter] = useState("all");
  const [allCasesSuiteFilter, setAllCasesSuiteFilter] = useState("all");
  const [debouncedSuiteSearch, setDebouncedSuiteSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("bySuites");
  

  const loadData = useCallback(async () => {
    const suiteList = await listSuites(projectId);
    setSuites(suiteList);
  }, [projectId]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      loadData().catch(() => router.replace("/projects")).finally(() => setLoading(false));
    });
    recoverOrphanedTasks(projectId);
  }, [router, loadData, projectId]);

  const visibleSuites = useMemo(
    () => [...suites].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [suites]
  );
  const selectedSuite = useMemo(
    () => suites.find((suite) => suite.id === activeSuiteId) ?? null,
    [suites, activeSuiteId]
  );
  const suiteNameMap = useMemo(
    () => new Map(suites.map((s) => [s.id, s.name])),
    [suites]
  );
  const selectedSuiteCases = suiteCases;
  const selectedCaseIdSet = useMemo(() => new Set(selectedCaseIds), [selectedCaseIds]);
  const areAllCasesSelected =
    selectedSuiteCases.length > 0 && selectedSuiteCases.every((tc) => selectedCaseIdSet.has(tc.id));

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSuiteSearch(suiteSearch.trim());
    }, 250);
    return () => clearTimeout(timeout);
  }, [suiteSearch]);

  useEffect(() => {
    setSuiteCasesPage(1);
  }, [
    viewMode,
    activeSuiteId,
    allCasesSuiteFilter,
    debouncedSuiteSearch,
    suiteStatusFilter,
    suitePriorityFilter,
    suiteTypeFilter,
    suiteAutomationFilter,
  ]);

  const loadSelectedSuiteCases = useCallback(async (pageOverride?: number) => {
    if (viewMode === "bySuites" && !activeSuiteId) {
      setSuiteCases([]);
      setSuiteCasesTotal(0);
      setSuiteCasesError(null);
      return;
    }
    setSuiteCasesLoading(true);
    setSuiteCasesError(null);
    try {
      const { list, total } = await listTestCases(projectId, {
        limit: PAGE_SIZE,
        offset: ((pageOverride ?? suiteCasesPage) - 1) * PAGE_SIZE,
        suiteId:
          viewMode === "bySuites"
            ? activeSuiteId ?? undefined
            : allCasesSuiteFilter === "all"
              ? undefined
              : allCasesSuiteFilter,
        status: suiteStatusFilter === "all" ? undefined : suiteStatusFilter,
        priority: suitePriorityFilter === "all" ? undefined : suitePriorityFilter,
        type: suiteTypeFilter === "all" ? undefined : suiteTypeFilter,
        automationStatus: suiteAutomationFilter === "all" ? undefined : suiteAutomationFilter,
        search: debouncedSuiteSearch || undefined,
      });
      setSuiteCases(list);
      setSuiteCasesTotal(total);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load suite test cases.";
      setSuiteCasesError(message);
      setSuiteCases([]);
      setSuiteCasesTotal(0);
    } finally {
      setSuiteCasesLoading(false);
    }
  }, [
    viewMode,
    activeSuiteId,
    allCasesSuiteFilter,
    debouncedSuiteSearch,
    projectId,
    suiteCasesPage,
    suiteAutomationFilter,
    suitePriorityFilter,
    suiteStatusFilter,
    suiteTypeFilter,
  ]);

  useEffect(() => {
    void loadSelectedSuiteCases();
  }, [loadSelectedSuiteCases]);

  useEffect(() => {
    const visibleIds = new Set(selectedSuiteCases.map((tc) => tc.id));
    setSelectedCaseIds((prev) => prev.filter((id) => visibleIds.has(id)));
  }, [selectedSuiteCases]);

  const existingTagSuggestions = useMemo(() => {
    const unique = new Set<string>();
    selectedSuiteCases.forEach((tc) => {
      parseTagString(tc.automationTags ?? "").forEach((tag) => unique.add(tag));
    });
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [selectedSuiteCases]);

  function parseSteps(raw: unknown): Step[] {
    if (typeof raw !== "string") return [{ ...EMPTY_STEP }];
    try {
      const parsed = JSON.parse(raw) as Step[];
      if (!Array.isArray(parsed) || parsed.length === 0) return [{ ...EMPTY_STEP }];
      return parsed;
    } catch {
      return [{ ...EMPTY_STEP }];
    }
  }

  function fillFormFromTestCase(data: Record<string, unknown>) {
    setTitle((data.title as string) ?? "");
    setDescription((data.description as string) ?? "");
    setPreconditions((data.preconditions as string) ?? "");
    setSteps(parseSteps(data.steps));
    setTestData((data.testData as string) ?? "");
    setAutomationStatus((data.automationStatus as string) ?? "In Planning");
    setAutomationScript((data.automationScript as string) ?? "");
    setEstimatedDuration((data.estimatedDuration as string) ?? "");
    setAttachments((data.attachments as string) ?? "");
    setAutomationTags(parseTagString((data.automationTags as string) ?? ""));
    setType((data.type as string) ?? "Functional");
    setPriority((data.priority as string) ?? "P2");
    setStatus((data.status as string) ?? "Draft");
    setSuiteId((data.suiteId as string) ?? activeSuiteId ?? "");
    setPanelJiraIssueKey((data.jiraIssueKey as string) ?? "");
    setPanelJiraUrl((data.jiraUrl as string) ?? "");
  }

  function resetForm(defaultSuiteId?: string | null) {
    setTitle("");
    setDescription("");
    setPreconditions("");
    setSteps([{ ...EMPTY_STEP }]);
    setTestData("");
    setAutomationStatus("In Planning");
    setAutomationScript("");
    setEstimatedDuration("");
    setAttachments("");
    setAutomationTags([]);
    setType("Functional");
    setPriority("P2");
    setStatus("Draft");
    setSuiteId(defaultSuiteId ?? activeSuiteId ?? "");
    setPanelJiraIssueKey("");
    setPanelJiraUrl("");
  }

  async function openCreatePanel(overrideSuiteId?: string) {
    setPanelError(null);
    setPanelTestcaseId(null);
    setPanelMode("create");
    setPanelTab("overview");
    const defaultSuite = overrideSuiteId ?? (viewMode === "allCases" ? null : activeSuiteId);
    resetForm(defaultSuite);
  }

  async function openViewPanel(testcaseId: string) {
    setPanelError(null);
    setPanelLoading(true);
    setPanelTestcaseId(testcaseId);
    setPanelMode("edit");
    setPanelTab("overview");
    try {
      const data = await getTestCase(projectId, testcaseId);
      fillFormFromTestCase(data);
    } catch {
      setPanelError("Failed to load test case details.");
    } finally {
      setPanelLoading(false);
    }
  }

  function closePanel() {
    setPanelMode("closed");
    setPanelTestcaseId(null);
    setPanelError(null);
  }

  function clearSuiteFilters() {
    setSuiteSearch("");
    setSuiteStatusFilter("all");
    setSuitePriorityFilter("all");
    setSuiteTypeFilter("all");
    setSuiteAutomationFilter("all");
    setAllCasesSuiteFilter("all");
    setSuiteCasesPage(1);
  }

  function handleViewModeChange(nextMode: ViewMode) {
    setViewMode(nextMode);
    setSelectedCaseIds([]);
    if (nextMode === "allCases" && activeSuiteId) {
      router.replace(`/projects/${projectId}/testcases`);
    }
  }

  function addStep() {
    setSteps((prev) => [...prev, { stepNumber: prev.length + 1, action: "", expectedResult: "" }]);
  }

  function removeStep(index: number) {
    setSteps((prev) =>
      prev.filter((_, i) => i !== index).map((step, i) => ({ ...step, stepNumber: i + 1 }))
    );
  }

  function updateStep(index: number, field: keyof Step, value: string | number) {
    setSteps((prev) => prev.map((step, i) => (i === index ? { ...step, [field]: value } : step)));
  }

  function openSingleTestRun(testcaseId: string) {
    const rerunUrl = `/projects/${projectId}/testcases/${testcaseId}/rerun-live-preview`;
    window.open(rerunUrl, "_blank", "noopener,noreferrer");
  }

  async function refreshData(pageOverride?: number) {
    await loadData();
    await loadSelectedSuiteCases(pageOverride);
  }

  function toggleCaseSelection(testcaseId: string) {
    setSelectedCaseIds((prev) =>
      prev.includes(testcaseId) ? prev.filter((id) => id !== testcaseId) : [...prev, testcaseId]
    );
  }

  function toggleSelectAllCases() {
    if (areAllCasesSelected) {
      setSelectedCaseIds([]);
      return;
    }
    setSelectedCaseIds(selectedSuiteCases.map((tc) => tc.id));
  }

  function openBulkActionModal(action: BulkAction) {
    if (!action || selectedCaseIds.length === 0) return;
    if (action === "update") {
      const firstSelected = selectedSuiteCases.find((tc) => selectedCaseIdSet.has(tc.id));
      setBulkStatus(firstSelected?.status || "Draft");
      setBulkPriority(firstSelected?.priority || "P2");
    }
    setBulkError(null);
    setIsBulkActionModalOpen(true);
  }

  function closeBulkActionModal() {
    if (bulkSaving) return;
    setIsBulkActionModalOpen(false);
    setBulkError(null);
    setBulkAction("");
  }

  async function handleBulkActionConfirm() {
    if (!bulkAction || selectedCaseIds.length === 0 || bulkSaving) return;
    setBulkSaving(true);
    setBulkError(null);
    try {
      if (bulkAction === "delete") {
        await bulkDeleteTestCases(projectId, { testcaseIds: selectedCaseIds });
      } else if (bulkAction === "archive") {
        await bulkUpdateTestCases(projectId, { testcaseIds: selectedCaseIds, status: "Archived" });
      } else if (bulkAction === "update") {
        await bulkUpdateTestCases(projectId, {
          testcaseIds: selectedCaseIds,
          status: bulkStatus,
          priority: bulkPriority,
        });
      }
      const refreshPanelTestcaseId = panelTestcaseId && selectedCaseIdSet.has(panelTestcaseId) ? panelTestcaseId : null;
      await refreshData();
      if (bulkAction === "delete" && refreshPanelTestcaseId) {
        closePanel();
      } else if (refreshPanelTestcaseId) {
        await openViewPanel(refreshPanelTestcaseId);
      }
      setSelectedCaseIds([]);
      setIsBulkActionModalOpen(false);
      setBulkAction("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to apply bulk action.";
      setBulkError(message);
    } finally {
      setBulkSaving(false);
    }
  }

  async function handleCreateRootSuite() {
    const name = newSuiteName.trim();
    if (!name || isCreatingSuite) return;
    setIsCreatingSuite(true);
    try {
      await createSuite(projectId, { name });
      setNewSuiteName("");
      setIsAddSuiteModalOpen(false);
      await refreshData();
    } finally {
      setIsCreatingSuite(false);
    }
  }

  async function handleRenameSuite(suiteId: string, currentName: string) {
    const name = window.prompt("Rename suite", currentName);
    if (!name?.trim() || name.trim() === currentName) return;
    await updateSuite(suiteId, { name: name.trim() });
    await refreshData();
  }

  async function handleDeleteSuiteConfirm(mode: "deleteTestcases" | "moveToDefault") {
    if (!deleteSuiteId || deleteSuiteSaving) return;
    setDeleteSuiteSaving(true);
    try {
      await deleteSuite(deleteSuiteId, mode);
      if (activeSuiteId === deleteSuiteId) {
        router.replace(`/projects/${projectId}/testcases`);
      }
      setDeleteSuiteId(null);
      await refreshData();
    } finally {
      setDeleteSuiteSaving(false);
    }
  }

  async function handleDeletePanelTestCase() {
    if (!panelTestcaseId || panelSaving) return;
    const ok = window.confirm("Delete this test case?");
    if (!ok) return;
    setPanelSaving(true);
    setPanelError(null);
    try {
      await deleteTestCase(projectId, panelTestcaseId);
      await refreshData();
      closePanel();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete test case.";
      setPanelError(message);
    } finally {
      setPanelSaving(false);
    }
  }

  async function handleArchivePanelTestCase() {
    if (!panelTestcaseId || panelSaving) return;
    const ok = window.confirm("Archive this test case?");
    if (!ok) return;
    setPanelSaving(true);
    setPanelError(null);
    try {
      await updateTestCase(projectId, panelTestcaseId, { status: "Archived" });
      await refreshData();
      await openViewPanel(panelTestcaseId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to archive test case.";
      setPanelError(message);
    } finally {
      setPanelSaving(false);
    }
  }

  async function handlePanelSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (panelMode !== "create" && panelMode !== "edit") return;
    if (title.length > 300) {
      setPanelError("Title must be 300 characters or fewer.");
      return;
    }
    setPanelSaving(true);
    setPanelError(null);
    setPanelSuccess(null);
    try {
      if (panelMode === "create") {
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
            runAegisInBackground(projectId, created.id, title, created.externalId || "", "ready_for_automation");
          }
        }
        setSuiteCasesPage(1);
        setSuiteSearch("");
        setDebouncedSuiteSearch("");
        setSuiteStatusFilter("all");
        setSuitePriorityFilter("all");
        setSuiteTypeFilter("all");
        setSuiteAutomationFilter("all");
        await refreshData(1);
        setPanelSuccess("Test case created successfully. Aegis is working on it in the background.");
        setTimeout(() => setPanelSuccess(null), 4000);
        if (submitAction === "create-next") {
          resetForm(suiteId || (viewMode === "allCases" ? null : activeSuiteId));
        } else {
          await openViewPanel(created.id);
        }
      } else if (panelMode === "edit" && panelTestcaseId) {
        const effectiveAutomationStatus = automationScript.trim() ? "Automated" : automationStatus;
        await updateTestCase(projectId, panelTestcaseId, {
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
            runAegisInBackground(projectId, panelTestcaseId, title, "", "ready_for_automation");
          }
        }
        setPanelSuccess("Test case updated successfully.");
        setTimeout(() => setPanelSuccess(null), 4000);
        await refreshData();
        const savedTab = panelTab;
        await openViewPanel(panelTestcaseId);
        setPanelTab(savedTab);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save test case.";
      setPanelError(message);
    } finally {
      setPanelSaving(false);
      setSubmitAction("create");
    }
  }

  return (
    <main className="px-6 py-6">
      <AegisBackgroundIndicator />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Repository</h1>
          <p className="text-sm text-zinc-500">Switch between suite view and all test cases listing.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-xl border border-zinc-300 bg-white p-1 dark:border-zinc-600 dark:bg-zinc-900">
            <button
              type="button"
              onClick={() => handleViewModeChange("bySuites")}
              className={`rounded-lg px-3 py-1 text-sm ${
                viewMode === "bySuites"
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              By Suites
            </button>
            <button
              type="button"
              onClick={() => handleViewModeChange("allCases")}
              className={`rounded-lg px-3 py-1 text-sm ${
                viewMode === "allCases"
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              All Test Cases
            </button>
          </div>
          <button
            type="button"
            onClick={() => setIsAddSuiteModalOpen(true)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Add Suite
          </button>
          <button
            type="button"
            onClick={() => {
              void openCreatePanel();
            }}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Add Test cases
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-zinc-500">Loading suites...</p>
      ) : viewMode === "bySuites" && activeSuiteId && !selectedSuite ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Suite not found.
            <div className="mt-3">
              <Link href={`/projects/${projectId}/testcases`} className="text-blue-600 hover:underline">
                Back to suites
              </Link>
            </div>
          </div>
        ) : viewMode === "allCases" || (viewMode === "bySuites" && activeSuiteId && selectedSuite) ? (
          <section className="mt-2">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                {viewMode === "bySuites" && selectedSuite ? (
                  <>
                    <Link
                      href={`/projects/${projectId}/testcases`}
                      className="rounded border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                    >
                      Back to suites
                    </Link>
                    <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                      {selectedSuite.name} test cases
                    </h2>
                  </>
                ) : (
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">All test cases</h2>
                )}
              </div>
              <div className="flex items-center gap-2">
                {selectedCaseIds.length > 0 && (
                  <>
                    <span className="text-xs text-zinc-500">{selectedCaseIds.length} selected</span>
                    <select
                      value={bulkAction}
                      onChange={(e) => setBulkAction(e.target.value as BulkAction)}
                      className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                    >
                      <option value="">Action</option>
                      <option value="delete">Delete</option>
                      <option value="update">Update</option>
                      <option value="archive">Archive</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => openBulkActionModal(bulkAction)}
                      disabled={!bulkAction}
                      className="rounded border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                    >
                      Apply
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void openCreatePanel()}
                  className="rounded border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                >
                  Add test case
                </button>
              </div>
            </div>
            <div className="space-y-3">
              <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                  <input
                    type="text"
                    value={suiteSearch}
                    onChange={(e) => setSuiteSearch(e.target.value)}
                    placeholder="Search by ID, title, or type"
                    className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                  />
                  {viewMode === "allCases" && (
                    <select
                      value={allCasesSuiteFilter}
                      onChange={(e) => setAllCasesSuiteFilter(e.target.value)}
                      className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                    >
                      <option value="all">All suites</option>
                      {visibleSuites.map((suite) => (
                        <option key={suite.id} value={suite.id}>
                          {suite.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <select
                    value={suiteTypeFilter}
                    onChange={(e) => setSuiteTypeFilter(e.target.value)}
                    className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                  >
                    <option value="all">All types</option>
                    {TESTCASE_TYPES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <select
                    value={suiteAutomationFilter}
                    onChange={(e) => setSuiteAutomationFilter(e.target.value)}
                    className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                  >
                    <option value="all">All automation feasibility</option>
                    {AUTOMATION_FEASIBILITY_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <select
                    value={suiteStatusFilter}
                    onChange={(e) => setSuiteStatusFilter(e.target.value)}
                    className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                  >
                    <option value="all">All statuses</option>
                    {TESTCASE_STATUSES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <select
                    value={suitePriorityFilter}
                    onChange={(e) => setSuitePriorityFilter(e.target.value)}
                    className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                  >
                    <option value="all">All priorities</option>
                    {TESTCASE_PRIORITIES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={clearSuiteFilters}
                    className="rounded border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                  >
                    Clear filters
                  </button>
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  Showing {selectedSuiteCases.length} of {suiteCasesTotal} matching test cases
                </p>
              </div>

              {suiteCasesError ? (
                <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                  {suiteCasesError}
                </p>
              ) : suiteCasesLoading ? (
                <p className="rounded-xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
                  Loading test cases...
                </p>
              ) : suiteCasesTotal === 0 ? (
                <p className="rounded-xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
                  No test cases match your current criteria.
                </p>
              ) : (
                <>
                  <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-700">
                          <th className="px-4 py-2">
                            <input
                              type="checkbox"
                              checked={areAllCasesSelected}
                              onChange={toggleSelectAllCases}
                              aria-label="Select all test cases on this page"
                            />
                          </th>
                          <th className="px-4 py-2">ID</th>
                          <th className="px-4 py-2">Title</th>
                          <th className="px-4 py-2">Suite</th>
                          <th className="px-4 py-2">Jira</th>
                          <th className="px-4 py-2">Priority</th>
                          <th className="px-4 py-2">Status</th>
                          <th className="px-4 py-2">Updated</th>
                          <th className="px-4 py-2">Run</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedSuiteCases.map((tc) => (
                          <tr
                            key={tc.id}
                            className={`border-b border-zinc-100 last:border-b-0 dark:border-zinc-800 ${
                              panelTestcaseId === tc.id ? "bg-blue-50/60 dark:bg-blue-950/20" : ""
                            }`}
                          >
                            <td className="px-4 py-2">
                              <input
                                type="checkbox"
                                checked={selectedCaseIdSet.has(tc.id)}
                                onChange={() => toggleCaseSelection(tc.id)}
                                aria-label={`Select ${tc.title}`}
                              />
                            </td>
                            <td className="px-4 py-2 font-mono">
                              <button
                                type="button"
                                onClick={() => void openViewPanel(tc.id)}
                                className="text-blue-600 hover:underline"
                              >
                                {tc.externalId}
                              </button>
                            </td>
                            <td className="px-4 py-2">
                              <button type="button" onClick={() => void openViewPanel(tc.id)} className="hover:underline">
                                {tc.title}
                              </button>
                            </td>
                            <td className="px-4 py-2 text-zinc-500">
                              {tc.suiteId ? suiteNameMap.get(tc.suiteId) ?? "—" : "—"}
                            </td>
                            <td className="px-4 py-2">
                              {tc.jiraIssueKey && tc.jiraUrl ? (
                                <a
                                  href={tc.jiraUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-1 font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                                >
                                  <svg viewBox="0 0 24 24" className="w-3 h-3 shrink-0" fill="currentColor">
                                    <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
                                  </svg>
                                  {tc.jiraIssueKey}
                                </a>
                              ) : tc.jiraIssueKey ? (
                                <span className="font-mono text-xs text-zinc-500">{tc.jiraIssueKey}</span>
                              ) : (
                                <span className="text-zinc-300 dark:text-zinc-600">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2">{tc.priority}</td>
                            <td className="px-4 py-2">{tc.status}</td>
                            <td className="px-4 py-2 text-zinc-500">{new Date(tc.updatedAt).toLocaleDateString()}</td>
                            <td className="px-4 py-2">
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openSingleTestRun(tc.id);
                                  }}
                                  className="rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                                  title="Run this single test case"
                                >
                                  Run Single Test
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
                    <span className="text-zinc-500">
                      Page {suiteCasesPage} of {Math.max(1, Math.ceil(suiteCasesTotal / PAGE_SIZE))}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSuiteCasesPage((prev) => Math.max(1, prev - 1))}
                        disabled={suiteCasesPage === 1 || suiteCasesLoading}
                        className="rounded border border-zinc-300 px-3 py-1 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSuiteCasesPage((prev) =>
                            prev >= Math.ceil(suiteCasesTotal / PAGE_SIZE) ? prev : prev + 1
                          )
                        }
                        disabled={suiteCasesPage >= Math.ceil(suiteCasesTotal / PAGE_SIZE) || suiteCasesLoading}
                        className="rounded border border-zinc-300 px-3 py-1 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

          </section>
      ) : visibleSuites.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No suites in this folder yet.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleSuites.map((suite) => {
            return (
              <div
                key={suite.id}
                className="rounded-2xl border border-zinc-300 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <button
                  type="button"
                  onClick={() => router.push(`/projects/${projectId}/testcases?suiteId=${suite.id}`)}
                  className="truncate text-left text-base font-semibold text-zinc-900 hover:underline dark:text-zinc-100"
                >
                  {suite.name}
                </button>
                <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                  Open suite to browse test cases
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => handleRenameSuite(suite.id, suite.name)}
                    className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteSuiteId(suite.id)}
                    className="rounded border border-red-300 px-2 py-1 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => void openCreatePanel(suite.id)}
                    className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                  >
                    Add test case
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {isAddSuiteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-300 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Add Suite</h3>
            <p className="mt-1 text-sm text-zinc-500">Create a new suite in the repository.</p>
            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Suite name
              </label>
              <input
                type="text"
                value={newSuiteName}
                onChange={(e) => setNewSuiteName(e.target.value)}
                placeholder="Enter suite name"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreateRootSuite();
                }}
                autoFocus
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (isCreatingSuite) return;
                  setIsAddSuiteModalOpen(false);
                  setNewSuiteName("");
                }}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleCreateRootSuite()}
                disabled={!newSuiteName.trim() || isCreatingSuite}
                className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isCreatingSuite ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
      {!!deleteSuiteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-300 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Delete Suite</h3>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              This suite contains test cases. What would you like to do with them?
            </p>
            <div className="mt-5 flex flex-col gap-3">
              <button
                type="button"
                disabled={deleteSuiteSaving}
                onClick={() => void handleDeleteSuiteConfirm("moveToDefault")}
                className="w-full rounded-lg border border-zinc-300 px-4 py-3 text-left hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
              >
                <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  Delete suite only
                </span>
                <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                  Move all test cases to the Default Suite
                </span>
              </button>
              <button
                type="button"
                disabled={deleteSuiteSaving}
                onClick={() => void handleDeleteSuiteConfirm("deleteTestcases")}
                className="w-full rounded-lg border border-red-300 px-4 py-3 text-left hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:hover:bg-red-950/40"
              >
                <span className="block text-sm font-medium text-red-700 dark:text-red-300">
                  Delete suite and all test cases
                </span>
                <span className="mt-0.5 block text-xs text-red-500 dark:text-red-400">
                  Permanently delete the suite and all its test cases
                </span>
              </button>
            </div>
            {deleteSuiteSaving && (
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Processing...</p>
            )}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => { if (!deleteSuiteSaving) setDeleteSuiteId(null); }}
                disabled={deleteSuiteSaving}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {isBulkActionModalOpen && bulkAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-300 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {bulkAction === "delete" ? "Delete test cases" : bulkAction === "archive" ? "Archive test cases" : "Update test cases"}
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
              {selectedCaseIds.length} selected test case{selectedCaseIds.length === 1 ? "" : "s"} will be updated.
            </p>
            {bulkAction === "delete" && (
              <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                This action permanently deletes the selected test cases.
              </p>
            )}
            {bulkAction === "update" && (
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Status</label>
                  <select
                    value={bulkStatus}
                    onChange={(e) => setBulkStatus(e.target.value)}
                    className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                  >
                    <option value="Draft">Draft</option>
                    <option value="In Review">In Review</option>
                    <option value="Approved">Approved</option>
                    <option value="Deprecated">Deprecated</option>
                    <option value="Archived">Archived</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Priority</label>
                  <select
                    value={bulkPriority}
                    onChange={(e) => setBulkPriority(e.target.value)}
                    className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                  >
                    <option value="P0">P0</option>
                    <option value="P1">P1</option>
                    <option value="P2">P2</option>
                    <option value="P3">P3</option>
                  </select>
                </div>
              </div>
            )}
            {bulkError && (
              <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                {bulkError}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeBulkActionModal}
                disabled={bulkSaving}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleBulkActionConfirm()}
                disabled={bulkSaving}
                className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {bulkSaving ? "Applying..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
      {panelMode !== "closed" && (
        <div className="fixed inset-0 z-40">
          <button
            type="button"
            aria-label="Close panel"
            onClick={closePanel}
            className="absolute inset-0 bg-black/35"
          />
          <aside className="absolute right-0 top-0 h-full w-1/2 min-w-[480px] border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 flex flex-col">
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-200 px-6 py-4 dark:border-zinc-700">
              <div className="min-w-0 flex-1">
                <p className="mb-0.5 text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  {panelMode === "create" ? "New Test Case" : "Test Case"}
                </p>
                <h3 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                  {panelMode === "create" ? "Create Test Case" : (title || "Untitled")}
                </h3>
                {panelMode === "edit" && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {status && (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        status === "Approved" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" :
                        status === "In Review" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" :
                        status === "Draft" ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" :
                        "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                      }`}>{status}</span>
                    )}
                    {priority && (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        priority === "P0" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" :
                        priority === "P1" ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" :
                        "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                      }`}>{priority}</span>
                    )}
                    {panelJiraIssueKey && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                        <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="currentColor" aria-hidden="true">
                          <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
                        </svg>
                        {panelJiraUrl ? (
                          <a href={panelJiraUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{panelJiraIssueKey}</a>
                        ) : panelJiraIssueKey}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {panelMode === "edit" && panelTestcaseId && (
                  <button
                    type="button"
                    onClick={() => openSingleTestRun(panelTestcaseId)}
                    className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                  >
                    Run Test
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Close panel"
                  onClick={closePanel}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
                    <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            {panelMode === "edit" && (
              <div className="flex shrink-0 gap-0 border-b border-zinc-200 px-6 dark:border-zinc-700">
                {(["overview", "steps", "automation"] as PanelTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setPanelTab(tab)}
                    className={`-mb-px border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                      panelTab === tab
                        ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400"
                        : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                    }`}
                  >
                    {tab === "overview" ? "Overview" : tab === "steps" ? `Steps${steps.length > 0 ? ` (${steps.length})` : ""}` : "Automation"}
                  </button>
                ))}
              </div>
            )}

            {(panelError || panelSuccess) && (
              <div className="shrink-0 px-6 pt-3">
                {panelError && (
                  <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                    {panelError}
                  </p>
                )}
                {panelSuccess && (
                  <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-700/40 dark:bg-green-900/20 dark:text-green-300">
                    {panelSuccess}
                  </p>
                )}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
              {panelLoading ? (
                <div className="flex items-center justify-center p-12">
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-600" />
                    <p className="text-sm text-zinc-500">Loading test case...</p>
                  </div>
                </div>
              ) : (
                <form onSubmit={handlePanelSubmit} id="panel-form">
                  {panelMode === "create" && (
                    <div className="space-y-5 px-6 py-5">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Title <span className="text-red-500">*</span></label>
                        <input
                          type="text"
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          required
                          maxLength={300}
                          placeholder="Describe what this test case validates"
                          className={`w-full rounded-lg border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 dark:bg-zinc-900 ${
                            title.length > 300
                              ? "border-red-400 focus:border-red-500 focus:ring-red-500 dark:border-red-600"
                              : "border-zinc-300 focus:border-blue-500 focus:ring-blue-500 dark:border-zinc-600"
                          }`}
                        />
                        <div className="mt-1 flex items-center justify-between">
                          {title.length > 300 ? (
                            <p className="text-xs text-red-600 dark:text-red-400">Title must be 300 characters or fewer.</p>
                          ) : <span />}
                          <p className={`text-xs ${title.length > 300 ? "text-red-500" : "text-zinc-400"}`}>{title.length}/300</p>
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Description</label>
                        <textarea
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          rows={3}
                          placeholder="What does this test case cover?"
                          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-900"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Suite</label>
                          <select
                            value={suiteId}
                            onChange={(e) => setSuiteId(e.target.value)}
                            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                          >
                            <option value="">No suite</option>
                            {suites.map((suite) => (
                              <option key={suite.id} value={suite.id}>{suite.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Type</label>
                          <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
                            {TESTCASE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Priority</label>
                          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
                            {TESTCASE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Status</label>
                          <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
                            {TESTCASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Estimated Duration</label>
                          <input
                            type="number"
                            min="0"
                            value={estimatedDuration}
                            onChange={(e) => setEstimatedDuration(e.target.value)}
                            placeholder="Minutes (e.g. 10)"
                            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Automation</label>
                          <select value={automationStatus} onChange={(e) => setAutomationStatus(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
                            {AUTOMATION_FEASIBILITY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Preconditions</label>
                        <textarea value={preconditions} onChange={(e) => setPreconditions(e.target.value)} rows={2} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Test Data</label>
                        <textarea value={testData} onChange={(e) => setTestData(e.target.value)} rows={2} placeholder="Input data, sample values, or setup-specific data" className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                      </div>
                      <TagInput label="Tags / Labels" selectedTags={automationTags} onChange={setAutomationTags} suggestions={existingTagSuggestions} placeholder="Type a tag then press Enter" />
                      <div>
                        <div className="mb-3 flex items-center justify-between">
                          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Test Steps</label>
                          <button type="button" onClick={addStep} className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
                            + Add step
                          </button>
                        </div>
                        <div className="space-y-3">
                          {steps.map((step, index) => (
                            <div key={index} className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-700 dark:bg-zinc-900/60">
                              <div className="mb-2 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">{index + 1}</span>
                                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Step {index + 1}</p>
                                </div>
                                {steps.length > 1 && (
                                  <button type="button" onClick={() => removeStep(index)} className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40">Remove</button>
                                )}
                              </div>
                              <div className="grid gap-2">
                                <div>
                                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">Action</label>
                                  <textarea placeholder="Describe the action to perform" value={step.action ?? ""} onChange={(e) => updateStep(index, "action", e.target.value)} rows={2} className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                                </div>
                                <div>
                                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">Expected Result</label>
                                  <textarea placeholder="Describe the expected outcome" value={step.expectedResult ?? ""} onChange={(e) => updateStep(index, "expectedResult", e.target.value)} rows={2} className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Playwright Script</label>
                        <textarea
                          value={automationScript}
                          onChange={(e) => setAutomationScript(e.target.value)}
                          rows={8}
                          placeholder={"import { test, expect } from '@playwright/test';\n\ntest('sample', async ({ page }) => {\n  await page.goto('https://example.com');\n  await expect(page).toHaveTitle(/Example/);\n});"}
                          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-600 dark:bg-zinc-900"
                        />
                        <p className="mt-1 text-xs text-zinc-500">Saving with script content will mark automation status as Automated.</p>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Attachments</label>
                        <textarea value={attachments} onChange={(e) => setAttachments(e.target.value)} rows={2} placeholder="Links/paths to screenshots, logs, or reference docs" className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                      </div>
                    </div>
                  )}

                  {panelMode === "edit" && (
                    <>
                      {panelTab === "overview" && (
                        <div className="space-y-5 px-6 py-5">
                          <div>
                            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Title <span className="text-red-500">*</span></label>
                            <input
                              type="text"
                              value={title}
                              onChange={(e) => setTitle(e.target.value)}
                              required
                              maxLength={300}
                              className={`w-full rounded-lg border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 dark:bg-zinc-900 ${
                                title.length > 300
                                  ? "border-red-400 focus:border-red-500 focus:ring-red-500 dark:border-red-600"
                                  : "border-zinc-300 focus:border-blue-500 focus:ring-blue-500 dark:border-zinc-600"
                              }`}
                            />
                            <div className="mt-1 flex items-center justify-between">
                              {title.length > 300 ? (
                                <p className="text-xs text-red-600 dark:text-red-400">Title must be 300 characters or fewer.</p>
                              ) : <span />}
                              <p className={`text-xs ${title.length > 300 ? "text-red-500" : "text-zinc-400"}`}>{title.length}/300</p>
                            </div>
                          </div>
                          <div>
                            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Description</label>
                            <textarea
                              value={description}
                              onChange={(e) => setDescription(e.target.value)}
                              rows={4}
                              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Preconditions</label>
                            <textarea
                              value={preconditions}
                              onChange={(e) => setPreconditions(e.target.value)}
                              rows={3}
                              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Test Data</label>
                            <textarea
                              value={testData}
                              onChange={(e) => setTestData(e.target.value)}
                              rows={2}
                              placeholder="Input data, sample values, or setup-specific data"
                              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                            <div>
                              <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Suite</label>
                              <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
                                <option value="">No suite</option>
                                {suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Type</label>
                              <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
                                {TESTCASE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Priority</label>
                              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
                                {TESTCASE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Status</label>
                              <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
                                {TESTCASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Estimated Duration</label>
                              <input
                                type="number"
                                min="0"
                                value={estimatedDuration}
                                onChange={(e) => setEstimatedDuration(e.target.value)}
                                placeholder="Minutes (e.g. 10)"
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                              />
                            </div>
                            <div>
                              <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Automation</label>
                              <select value={automationStatus} onChange={(e) => setAutomationStatus(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
                                {AUTOMATION_FEASIBILITY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                              </select>
                            </div>
                          </div>
                          <TagInput label="Tags / Labels" selectedTags={automationTags} onChange={setAutomationTags} suggestions={existingTagSuggestions} placeholder="Type a tag then press Enter" />
                          <div>
                            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Attachments</label>
                            <textarea value={attachments} onChange={(e) => setAttachments(e.target.value)} rows={2} placeholder="Links/paths to screenshots, logs, or reference docs" className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                          </div>
                        </div>
                      )}

                      {panelTab === "steps" && (
                        <div className="px-6 py-5">
                          <div className="mb-4 flex items-center justify-between">
                            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                              {steps.length} step{steps.length === 1 ? "" : "s"}
                            </p>
                            <button type="button" onClick={addStep} className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
                              + Add step
                            </button>
                          </div>
                          {steps.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
                              <p className="text-sm text-zinc-500">No steps yet. Add your first step above.</p>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {steps.map((step, index) => (
                                <div key={index} className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-700 dark:bg-zinc-900/60">
                                  <div className="mb-3 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">{index + 1}</span>
                                      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Step {index + 1}</p>
                                    </div>
                                    {steps.length > 1 && (
                                      <button type="button" onClick={() => removeStep(index)} className="rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40">Remove</button>
                                    )}
                                  </div>
                                  <div className="grid gap-3">
                                    <div>
                                      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Action</label>
                                      <textarea placeholder="Describe the action to perform" value={step.action ?? ""} onChange={(e) => updateStep(index, "action", e.target.value)} rows={2} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                                    </div>
                                    <div>
                                      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Expected Result</label>
                                      <textarea placeholder="Describe the expected outcome" value={step.expectedResult ?? ""} onChange={(e) => updateStep(index, "expectedResult", e.target.value)} rows={2} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {panelTab === "automation" && (
                        <div className="space-y-5 px-6 py-5">
                          <div>
                            <div className="mb-3 flex items-center justify-between">
                              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Playwright Script</label>
                              {panelTestcaseId && (
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      runAegisInBackground(projectId, panelTestcaseId, title, "", "manual");
                                      setPanelSuccess("Added to Aegis queue.");
                                      setTimeout(() => setPanelSuccess(null), 4000);
                                    }}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-900/20 dark:text-violet-300 dark:hover:bg-violet-900/40"
                                  >
                                    Send to Aegis
                                  </button>
                                  <a
                                    href={`/projects/${projectId}/testcases/${panelTestcaseId}/automate`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                                  >
                                    Open in Aegis
                                  </a>
                                </div>
                              )}
                            </div>
                            <textarea
                              value={automationScript}
                              onChange={(e) => setAutomationScript(e.target.value)}
                              rows={16}
                              placeholder={"import { test, expect } from '@playwright/test';\n\ntest('sample', async ({ page }) => {\n  await page.goto('https://example.com');\n  await expect(page).toHaveTitle(/Example/);\n});"}
                              className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 font-mono text-xs leading-relaxed dark:border-zinc-600 dark:bg-zinc-950"
                            />
                            <p className="mt-1.5 text-xs text-zinc-500">Saving with script content will mark automation status as Automated.</p>
                          </div>
                          <div>
                            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Automation Feasibility</label>
                            <select value={automationStatus} onChange={(e) => setAutomationStatus(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-900">
                              {AUTOMATION_FEASIBILITY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </form>
              )}
            </div>

            {!panelLoading && (
              <div className="shrink-0 border-t border-zinc-200 bg-white px-6 py-4 dark:border-zinc-700 dark:bg-zinc-900">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      form="panel-form"
                      onClick={() => setSubmitAction("create")}
                      disabled={panelSaving}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {panelSaving ? "Saving..." : panelMode === "create" ? "Create" : "Save changes"}
                    </button>
                    {panelMode === "create" && (
                      <button
                        type="submit"
                        form="panel-form"
                        onClick={() => setSubmitAction("create-next")}
                        disabled={panelSaving}
                        className="rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"
                      >
                        {panelSaving ? "Saving..." : "Create & Add Next"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={closePanel}
                      disabled={panelSaving}
                      className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                  </div>
                  {panelMode === "edit" && panelTestcaseId && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleArchivePanelTestCase()}
                        disabled={panelSaving}
                        className="rounded-lg border border-amber-200 px-3 py-2 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
                      >
                        Archive
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeletePanelTestCase()}
                        disabled={panelSaving}
                        className="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
