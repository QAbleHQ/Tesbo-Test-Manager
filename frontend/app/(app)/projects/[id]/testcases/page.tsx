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
import {
  Button,
  Input,
  Select,
  Textarea,
  Card,
  Modal,
  EmptyStateBlock,
  StatusChip,
  Field,
  FieldLabel,
} from "@/components/ui";
import { PageHeader, ListWorkspaceLayout, FilterBar } from "@/components/workflows";

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

function statusTone(s: string) {
  if (s === "Approved") return "success" as const;
  if (s === "In Review") return "warning" as const;
  return "neutral" as const;
}

function priorityTone(p: string) {
  if (p === "P0") return "error" as const;
  if (p === "P1") return "warning" as const;
  return "neutral" as const;
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

  async function openCreatePanel() {
    setPanelError(null);
    setPanelTestcaseId(null);
    setPanelMode("create");
    setPanelTab("overview");
    resetForm(viewMode === "allCases" ? null : activeSuiteId);
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
      <ListWorkspaceLayout
        header={
          <PageHeader
            title="Test case repository"
            subtitle="Switch between suite view and all test cases listing."
            actions={
              <>
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1">
                  <button
                    type="button"
                    onClick={() => handleViewModeChange("bySuites")}
                    className={`rounded-lg px-3 py-1 text-sm ${
                      viewMode === "bySuites"
                        ? "bg-[var(--foreground)] text-[var(--surface)]"
                        : "text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
                    }`}
                  >
                    By Suites
                  </button>
                  <button
                    type="button"
                    onClick={() => handleViewModeChange("allCases")}
                    className={`rounded-lg px-3 py-1 text-sm ${
                      viewMode === "allCases"
                        ? "bg-[var(--foreground)] text-[var(--surface)]"
                        : "text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
                    }`}
                  >
                    All Test Cases
                  </button>
                </div>
                <Button variant="secondary" onClick={() => setIsAddSuiteModalOpen(true)}>
                  Add Suite
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => { void openCreatePanel(); }}
                  disabled={viewMode === "bySuites" && !activeSuiteId}
                >
                  Add Test cases
                </Button>
              </>
            }
          />
        }
      >
        {loading ? (
          <p className="text-[var(--muted)]">Loading suites...</p>
        ) : viewMode === "bySuites" && activeSuiteId && !selectedSuite ? (
          <EmptyStateBlock
            title="Suite not found"
            description="The suite you're looking for doesn't exist."
            action={
              <Link href={`/projects/${projectId}/testcases`} className="text-[var(--brand-primary)] hover:underline">
                Back to suites
              </Link>
            }
          />
        ) : viewMode === "allCases" || (viewMode === "bySuites" && activeSuiteId && selectedSuite) ? (
          <section className="mt-2">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                {viewMode === "bySuites" && selectedSuite ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => router.push(`/projects/${projectId}/testcases`)}
                    >
                      Back to suites
                    </Button>
                    <h2 className="text-lg font-semibold text-[var(--foreground)]">
                      {selectedSuite.name} test cases
                    </h2>
                  </>
                ) : (
                  <h2 className="text-lg font-semibold text-[var(--foreground)]">All test cases</h2>
                )}
              </div>
              <div className="flex items-center gap-2">
                {selectedCaseIds.length > 0 && (
                  <>
                    <span className="text-xs text-[var(--muted)]">{selectedCaseIds.length} selected</span>
                    <Select
                      value={bulkAction}
                      onChange={(e) => setBulkAction(e.target.value as BulkAction)}
                      className="h-9 w-auto min-w-[100px]"
                    >
                      <option value="">Action</option>
                      <option value="delete">Delete</option>
                      <option value="update">Update</option>
                      <option value="archive">Archive</option>
                    </Select>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openBulkActionModal(bulkAction)}
                      disabled={!bulkAction}
                    >
                      Apply
                    </Button>
                  </>
                )}
                <Button variant="secondary" size="sm" onClick={() => void openCreatePanel()}>
                  Add test case
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <Card className="p-3">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                  <Input
                    type="text"
                    value={suiteSearch}
                    onChange={(e) => setSuiteSearch(e.target.value)}
                    placeholder="Search by ID, title, or type"
                    className="h-9"
                  />
                  {viewMode === "allCases" && (
                    <Select
                      value={allCasesSuiteFilter}
                      onChange={(e) => setAllCasesSuiteFilter(e.target.value)}
                      className="h-9"
                    >
                      <option value="all">All suites</option>
                      {visibleSuites.map((suite) => (
                        <option key={suite.id} value={suite.id}>
                          {suite.name}
                        </option>
                      ))}
                    </Select>
                  )}
                  <Select value={suiteTypeFilter} onChange={(e) => setSuiteTypeFilter(e.target.value)} className="h-9">
                    <option value="all">All types</option>
                    {TESTCASE_TYPES.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </Select>
                  <Select value={suiteAutomationFilter} onChange={(e) => setSuiteAutomationFilter(e.target.value)} className="h-9">
                    <option value="all">All automation feasibility</option>
                    {AUTOMATION_FEASIBILITY_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </Select>
                  <Select value={suiteStatusFilter} onChange={(e) => setSuiteStatusFilter(e.target.value)} className="h-9">
                    <option value="all">All statuses</option>
                    {TESTCASE_STATUSES.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </Select>
                  <Select value={suitePriorityFilter} onChange={(e) => setSuitePriorityFilter(e.target.value)} className="h-9">
                    <option value="all">All priorities</option>
                    {TESTCASE_PRIORITIES.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </Select>
                  <Button variant="secondary" size="sm" onClick={clearSuiteFilters}>
                    Clear filters
                  </Button>
                </div>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  Showing {selectedSuiteCases.length} of {suiteCasesTotal} matching test cases
                </p>
              </Card>

              {suiteCasesError ? (
                <p className="rounded-xl border border-[var(--error)] bg-[var(--surface)] p-4 text-sm text-[var(--error)]">
                  {suiteCasesError}
                </p>
              ) : suiteCasesLoading ? (
                <Card className="border-dashed p-4 text-sm text-[var(--muted)]">
                  Loading test cases...
                </Card>
              ) : suiteCasesTotal === 0 ? (
                <EmptyStateBlock
                  title="No test cases found"
                  description="No test cases match your current criteria."
                />
              ) : (
                <>
                  <Card className="overflow-hidden">
                    <table className="tesbo-table">
                      <thead>
                        <tr>
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
                            className={
                              panelTestcaseId === tc.id ? "bg-[var(--brand-soft)]" : ""
                            }
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
                                className="text-[var(--brand-primary)] hover:underline"
                              >
                                {tc.externalId}
                              </button>
                            </td>
                            <td className="px-4 py-2">
                              <button type="button" onClick={() => void openViewPanel(tc.id)} className="hover:underline">
                                {tc.title}
                              </button>
                            </td>
                            <td className="px-4 py-2 text-[var(--muted)]">
                              {tc.suiteId ? suiteNameMap.get(tc.suiteId) ?? "—" : "—"}
                            </td>
                            <td className="px-4 py-2">
                              {tc.jiraIssueKey && tc.jiraUrl ? (
                                <a
                                  href={tc.jiraUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-1 font-mono text-xs text-[var(--brand-primary)] hover:underline"
                                >
                                  <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="currentColor">
                                    <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
                                  </svg>
                                  {tc.jiraIssueKey}
                                </a>
                              ) : tc.jiraIssueKey ? (
                                <span className="font-mono text-xs text-[var(--muted)]">{tc.jiraIssueKey}</span>
                              ) : (
                                <span className="text-[var(--muted-soft)]">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2">{tc.priority}</td>
                            <td className="px-4 py-2">{tc.status}</td>
                            <td className="px-4 py-2 text-[var(--muted)]">{new Date(tc.updatedAt).toLocaleDateString()}</td>
                            <td className="px-4 py-2">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openSingleTestRun(tc.id);
                                }}
                                className="border-[var(--success)] text-[var(--success)] hover:bg-[var(--brand-soft)]"
                                title="Run this single test case"
                              >
                                Run Single Test
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>

                  <Card className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="text-[var(--muted)]">
                      Page {suiteCasesPage} of {Math.max(1, Math.ceil(suiteCasesTotal / PAGE_SIZE))}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setSuiteCasesPage((prev) => Math.max(1, prev - 1))}
                        disabled={suiteCasesPage === 1 || suiteCasesLoading}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setSuiteCasesPage((prev) =>
                            prev >= Math.ceil(suiteCasesTotal / PAGE_SIZE) ? prev : prev + 1
                          )
                        }
                        disabled={suiteCasesPage >= Math.ceil(suiteCasesTotal / PAGE_SIZE) || suiteCasesLoading}
                      >
                        Next
                      </Button>
                    </div>
                  </Card>
                </>
              )}
            </div>

            {/* Detail panel */}
            {panelMode !== "closed" && (
              <div className="fixed inset-0 z-40">
                <button
                  type="button"
                  aria-label="Close panel"
                  onClick={closePanel}
                  className="absolute inset-0 bg-black/35"
                />
                <aside className="absolute right-0 top-0 flex h-full w-1/2 min-w-[480px] flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]">
                  {/* Panel header */}
                  <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-6 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="mb-0.5 text-xs font-medium uppercase tracking-wide text-[var(--muted-soft)]">
                        {panelMode === "create" ? "New Test Case" : "Test Case"}
                      </p>
                      <h3 className="truncate text-lg font-semibold text-[var(--foreground)]">
                        {panelMode === "create" ? "Create Test Case" : (title || "Untitled")}
                      </h3>
                      {panelMode === "edit" && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          {status && <StatusChip tone={statusTone(status)}>{status}</StatusChip>}
                          {priority && <StatusChip tone={priorityTone(priority)}>{priority}</StatusChip>}
                          {panelJiraIssueKey && (
                            <StatusChip tone="info">
                              <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="currentColor" aria-hidden="true">
                                <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
                              </svg>
                              {panelJiraUrl ? (
                                <a href={panelJiraUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{panelJiraIssueKey}</a>
                              ) : panelJiraIssueKey}
                            </StatusChip>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {panelMode === "edit" && panelTestcaseId && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => openSingleTestRun(panelTestcaseId)}
                          className="border-[var(--success)] text-[var(--success)]"
                        >
                          Run Test
                        </Button>
                      )}
                      <button
                        type="button"
                        aria-label="Close panel"
                        onClick={closePanel}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
                      >
                        <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
                          <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Tabs (only for edit mode) */}
                  {panelMode === "edit" && (
                    <div className="flex shrink-0 gap-0 border-b border-[var(--border)] px-6">
                      {(["overview", "steps", "automation"] as PanelTab[]).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setPanelTab(tab)}
                          className={`-mb-px border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                            panelTab === tab
                              ? "border-[var(--brand-primary)] text-[var(--brand-primary)]"
                              : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
                          }`}
                        >
                          {tab === "overview" ? "Overview" : tab === "steps" ? `Steps${steps.length > 0 ? ` (${steps.length})` : ""}` : "Automation"}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Alerts */}
                  {(panelError || panelSuccess) && (
                    <div className="shrink-0 px-6 pt-3">
                      {panelError && (
                        <p className="rounded-lg border border-[var(--error)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--error)]">
                          {panelError}
                        </p>
                      )}
                      {panelSuccess && (
                        <p className="rounded-lg border border-[var(--success)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--success)]">
                          {panelSuccess}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Scrollable body */}
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {panelLoading ? (
                      <div className="flex items-center justify-center p-12">
                        <div className="flex flex-col items-center gap-3">
                          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--brand-primary)]" />
                          <p className="text-sm text-[var(--muted)]">Loading test case...</p>
                        </div>
                      </div>
                    ) : (
                      <form onSubmit={handlePanelSubmit} id="panel-form">
                        {/* CREATE MODE */}
                        {panelMode === "create" && (
                          <div className="space-y-5 px-6 py-5">
                            <Field>
                              <FieldLabel>Title <span className="text-[var(--error)]">*</span></FieldLabel>
                              <Input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                required
                                placeholder="Describe what this test case validates"
                              />
                            </Field>
                            <Field>
                              <FieldLabel>Description</FieldLabel>
                              <Textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={3}
                                placeholder="What does this test case cover?"
                              />
                            </Field>
                            <div className="grid grid-cols-3 gap-3">
                              <Field>
                                <FieldLabel>Suite</FieldLabel>
                                <Select value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
                                  <option value="">No suite</option>
                                  {suites.map((suite) => (
                                    <option key={suite.id} value={suite.id}>{suite.name}</option>
                                  ))}
                                </Select>
                              </Field>
                              <Field>
                                <FieldLabel>Type</FieldLabel>
                                <Select value={type} onChange={(e) => setType(e.target.value)}>
                                  {TESTCASE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                                </Select>
                              </Field>
                              <Field>
                                <FieldLabel>Priority</FieldLabel>
                                <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                                  {TESTCASE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                                </Select>
                              </Field>
                              <Field>
                                <FieldLabel>Status</FieldLabel>
                                <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                                  {TESTCASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                                </Select>
                              </Field>
                              <Field>
                                <FieldLabel>Estimated Duration</FieldLabel>
                                <Input
                                  type="text"
                                  value={estimatedDuration}
                                  onChange={(e) => setEstimatedDuration(e.target.value)}
                                  placeholder="e.g. 10 min"
                                />
                              </Field>
                              <Field>
                                <FieldLabel>Automation</FieldLabel>
                                <Select value={automationStatus} onChange={(e) => setAutomationStatus(e.target.value)}>
                                  {AUTOMATION_FEASIBILITY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                                </Select>
                              </Field>
                            </div>
                            <Field>
                              <FieldLabel>Preconditions</FieldLabel>
                              <Textarea value={preconditions} onChange={(e) => setPreconditions(e.target.value)} rows={2} />
                            </Field>
                            <Field>
                              <FieldLabel>Test Data</FieldLabel>
                              <Textarea value={testData} onChange={(e) => setTestData(e.target.value)} rows={2} placeholder="Input data, sample values, or setup-specific data" />
                            </Field>
                            <TagInput label="Tags / Labels" selectedTags={automationTags} onChange={setAutomationTags} suggestions={existingTagSuggestions} placeholder="Type a tag then press Enter" />
                            {/* Test steps section */}
                            <div>
                              <div className="mb-3 flex items-center justify-between">
                                <FieldLabel>Test Steps</FieldLabel>
                                <Button variant="secondary" size="sm" onClick={addStep} className="border-[var(--brand-primary)] text-[var(--brand-primary)]">
                                  + Add step
                                </Button>
                              </div>
                              <div className="space-y-3">
                                {steps.map((step, index) => (
                                  <div key={index} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--background)] p-3">
                                    <div className="mb-2 flex items-center justify-between">
                                      <div className="flex items-center gap-2">
                                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--brand-primary)] text-xs font-semibold text-white">{index + 1}</span>
                                        <p className="text-sm font-medium text-[var(--foreground)]">Step {index + 1}</p>
                                      </div>
                                      {steps.length > 1 && (
                                        <button type="button" onClick={() => removeStep(index)} className="rounded px-2 py-1 text-xs text-[var(--error)] hover:bg-[var(--surface-secondary)]">Remove</button>
                                      )}
                                    </div>
                                    <div className="grid gap-2">
                                      <div>
                                        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">Action</label>
                                        <Textarea placeholder="Describe the action to perform" value={step.action ?? ""} onChange={(e) => updateStep(index, "action", e.target.value)} rows={2} className="px-2 py-1.5" />
                                      </div>
                                      <div>
                                        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">Expected Result</label>
                                        <Textarea placeholder="Describe the expected outcome" value={step.expectedResult ?? ""} onChange={(e) => updateStep(index, "expectedResult", e.target.value)} rows={2} className="px-2 py-1.5" />
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <Field>
                              <FieldLabel>Playwright Script</FieldLabel>
                              <Textarea
                                value={automationScript}
                                onChange={(e) => setAutomationScript(e.target.value)}
                                rows={8}
                                placeholder={"import { test, expect } from '@playwright/test';\n\ntest('sample', async ({ page }) => {\n  await page.goto('https://example.com');\n  await expect(page).toHaveTitle(/Example/);\n});"}
                                className="font-mono text-xs"
                              />
                              <p className="mt-1 text-xs text-[var(--muted)]">Saving with script content will mark automation status as Automated.</p>
                            </Field>
                            <Field>
                              <FieldLabel>Attachments</FieldLabel>
                              <Textarea value={attachments} onChange={(e) => setAttachments(e.target.value)} rows={2} placeholder="Links/paths to screenshots, logs, or reference docs" />
                            </Field>
                          </div>
                        )}

                        {/* EDIT MODE — tabbed content */}
                        {panelMode === "edit" && (
                          <>
                            {/* Overview tab */}
                            {panelTab === "overview" && (
                              <div className="space-y-5 px-6 py-5">
                                <Field>
                                  <FieldLabel>Title <span className="text-[var(--error)]">*</span></FieldLabel>
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
                                    rows={3}
                                  />
                                </Field>
                                <Field>
                                  <FieldLabel>Test Data</FieldLabel>
                                  <Textarea
                                    value={testData}
                                    onChange={(e) => setTestData(e.target.value)}
                                    rows={2}
                                    placeholder="Input data, sample values, or setup-specific data"
                                  />
                                </Field>
                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                                  <Field>
                                    <FieldLabel>Suite</FieldLabel>
                                    <Select value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
                                      <option value="">No suite</option>
                                      {suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
                                    </Select>
                                  </Field>
                                  <Field>
                                    <FieldLabel>Type</FieldLabel>
                                    <Select value={type} onChange={(e) => setType(e.target.value)}>
                                      {TESTCASE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                                    </Select>
                                  </Field>
                                  <Field>
                                    <FieldLabel>Priority</FieldLabel>
                                    <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                                      {TESTCASE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                                    </Select>
                                  </Field>
                                  <Field>
                                    <FieldLabel>Status</FieldLabel>
                                    <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                                      {TESTCASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                                    </Select>
                                  </Field>
                                  <Field>
                                    <FieldLabel>Estimated Duration</FieldLabel>
                                    <Input
                                      type="text"
                                      value={estimatedDuration}
                                      onChange={(e) => setEstimatedDuration(e.target.value)}
                                      placeholder="e.g. 10 min"
                                    />
                                  </Field>
                                  <Field>
                                    <FieldLabel>Automation</FieldLabel>
                                    <Select value={automationStatus} onChange={(e) => setAutomationStatus(e.target.value)}>
                                      {AUTOMATION_FEASIBILITY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                                    </Select>
                                  </Field>
                                </div>
                                <TagInput label="Tags / Labels" selectedTags={automationTags} onChange={setAutomationTags} suggestions={existingTagSuggestions} placeholder="Type a tag then press Enter" />
                                <Field>
                                  <FieldLabel>Attachments</FieldLabel>
                                  <Textarea value={attachments} onChange={(e) => setAttachments(e.target.value)} rows={2} placeholder="Links/paths to screenshots, logs, or reference docs" />
                                </Field>
                              </div>
                            )}

                            {/* Steps tab */}
                            {panelTab === "steps" && (
                              <div className="px-6 py-5">
                                <div className="mb-4 flex items-center justify-between">
                                  <p className="text-sm font-medium text-[var(--foreground)]">
                                    {steps.length} step{steps.length === 1 ? "" : "s"}
                                  </p>
                                  <Button variant="secondary" size="sm" onClick={addStep} className="border-[var(--brand-primary)] text-[var(--brand-primary)]">
                                    + Add step
                                  </Button>
                                </div>
                                {steps.length === 0 ? (
                                  <EmptyStateBlock
                                    title="No steps yet"
                                    description="Add your first step above."
                                  />
                                ) : (
                                  <div className="space-y-3">
                                    {steps.map((step, index) => (
                                      <div key={index} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--background)] p-4">
                                        <div className="mb-3 flex items-center justify-between">
                                          <div className="flex items-center gap-2">
                                            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--brand-primary)] text-xs font-semibold text-white">{index + 1}</span>
                                            <p className="text-sm font-semibold text-[var(--foreground)]">Step {index + 1}</p>
                                          </div>
                                          {steps.length > 1 && (
                                            <button type="button" onClick={() => removeStep(index)} className="rounded-lg px-2 py-1 text-xs text-[var(--error)] hover:bg-[var(--surface-secondary)]">Remove</button>
                                          )}
                                        </div>
                                        <div className="grid gap-3">
                                          <div>
                                            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">Action</label>
                                            <Textarea placeholder="Describe the action to perform" value={step.action ?? ""} onChange={(e) => updateStep(index, "action", e.target.value)} rows={2} className="px-3 py-2" />
                                          </div>
                                          <div>
                                            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">Expected Result</label>
                                            <Textarea placeholder="Describe the expected outcome" value={step.expectedResult ?? ""} onChange={(e) => updateStep(index, "expectedResult", e.target.value)} rows={2} className="px-3 py-2" />
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Automation tab */}
                            {panelTab === "automation" && (
                              <div className="space-y-5 px-6 py-5">
                                <div>
                                  <div className="mb-3 flex items-center justify-between">
                                    <FieldLabel>Playwright Script</FieldLabel>
                                    {panelTestcaseId && (
                                      <div className="flex items-center gap-2">
                                        <Button
                                          variant="ai"
                                          size="sm"
                                          onClick={() => {
                                            runAegisInBackground(projectId, panelTestcaseId, title, "", "manual");
                                            setPanelSuccess("Added to Aegis queue.");
                                            setTimeout(() => setPanelSuccess(null), 4000);
                                          }}
                                        >
                                          Send to Aegis
                                        </Button>
                                        <a
                                          href={`/projects/${projectId}/testcases/${panelTestcaseId}/automate`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-[var(--border)] px-3 text-xs font-semibold text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
                                        >
                                          Open in Aegis
                                        </a>
                                      </div>
                                    )}
                                  </div>
                                  <Textarea
                                    value={automationScript}
                                    onChange={(e) => setAutomationScript(e.target.value)}
                                    rows={16}
                                    placeholder={"import { test, expect } from '@playwright/test';\n\ntest('sample', async ({ page }) => {\n  await page.goto('https://example.com');\n  await expect(page).toHaveTitle(/Example/);\n});"}
                                    className="bg-[var(--background)] font-mono text-xs leading-relaxed"
                                  />
                                  <p className="mt-1.5 text-xs text-[var(--muted)]">Saving with script content will mark automation status as Automated.</p>
                                </div>
                                <Field>
                                  <FieldLabel>Automation Feasibility</FieldLabel>
                                  <Select value={automationStatus} onChange={(e) => setAutomationStatus(e.target.value)}>
                                    {AUTOMATION_FEASIBILITY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                                  </Select>
                                </Field>
                              </div>
                            )}
                          </>
                        )}
                      </form>
                    )}
                  </div>

                  {/* Sticky footer with actions */}
                  {!panelLoading && (
                    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-6 py-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <Button
                            type="submit"
                            form="panel-form"
                            variant="primary"
                            onClick={() => setSubmitAction("create")}
                            disabled={panelSaving}
                          >
                            {panelSaving ? "Saving..." : panelMode === "create" ? "Create" : "Save changes"}
                          </Button>
                          {panelMode === "create" && (
                            <Button
                              type="submit"
                              form="panel-form"
                              variant="secondary"
                              onClick={() => setSubmitAction("create-next")}
                              disabled={panelSaving}
                              className="border-[var(--brand-primary)] text-[var(--brand-primary)]"
                            >
                              {panelSaving ? "Saving..." : "Create & Add Next"}
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            onClick={closePanel}
                            disabled={panelSaving}
                          >
                            Cancel
                          </Button>
                        </div>
                        {panelMode === "edit" && panelTestcaseId && (
                          <div className="flex items-center gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void handleArchivePanelTestCase()}
                              disabled={panelSaving}
                              className="border-[var(--warning)] text-[var(--warning)]"
                            >
                              Archive
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => void handleDeletePanelTestCase()}
                              disabled={panelSaving}
                            >
                              Delete
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </aside>
              </div>
            )}
          </section>
        ) : visibleSuites.length === 0 ? (
          <EmptyStateBlock
            title="No suites yet"
            description="No suites in this folder yet."
            action={
              <Button variant="secondary" onClick={() => setIsAddSuiteModalOpen(true)}>
                Add Suite
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleSuites.map((suite) => (
              <Card key={suite.id} className="p-4">
                <button
                  type="button"
                  onClick={() => router.push(`/projects/${projectId}/testcases?suiteId=${suite.id}`)}
                  className="truncate text-left text-base font-semibold text-[var(--foreground)] hover:underline"
                >
                  {suite.name}
                </button>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Open suite to browse test cases
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <Button variant="secondary" size="sm" onClick={() => handleRenameSuite(suite.id, suite.name)}>
                    Rename
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setDeleteSuiteId(suite.id)}>
                    Delete
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => router.push(`/projects/${projectId}/testcases/new?suiteId=${suite.id}`)}
                  >
                    Add test case
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </ListWorkspaceLayout>

      {/* Add Suite Modal */}
      <Modal
        open={isAddSuiteModalOpen}
        onClose={() => {
          if (isCreatingSuite) return;
          setIsAddSuiteModalOpen(false);
          setNewSuiteName("");
        }}
        title="Add Suite"
      >
        <p className="text-sm text-[var(--muted)]">Create a new suite in the repository.</p>
        <Field className="mt-4">
          <FieldLabel>Suite name</FieldLabel>
          <Input
            type="text"
            value={newSuiteName}
            onChange={(e) => setNewSuiteName(e.target.value)}
            placeholder="Enter suite name"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateRootSuite();
            }}
            autoFocus
          />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              if (isCreatingSuite) return;
              setIsAddSuiteModalOpen(false);
              setNewSuiteName("");
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleCreateRootSuite()}
            disabled={!newSuiteName.trim() || isCreatingSuite}
          >
            {isCreatingSuite ? "Creating..." : "Create"}
          </Button>
        </div>
      </Modal>

      {/* Delete Suite Modal */}
      <Modal
        open={!!deleteSuiteId}
        onClose={() => { if (!deleteSuiteSaving) setDeleteSuiteId(null); }}
        title="Delete Suite"
      >
        <p className="text-sm text-[var(--muted)]">
          This suite contains test cases. What would you like to do with them?
        </p>
        <div className="mt-5 flex flex-col gap-3">
          <button
            type="button"
            disabled={deleteSuiteSaving}
            onClick={() => void handleDeleteSuiteConfirm("moveToDefault")}
            className="w-full rounded-lg border border-[var(--border)] px-4 py-3 text-left hover:bg-[var(--surface-secondary)] disabled:opacity-50"
          >
            <span className="block text-sm font-medium text-[var(--foreground)]">
              Delete suite only
            </span>
            <span className="mt-0.5 block text-xs text-[var(--muted)]">
              Move all test cases to the Default Suite
            </span>
          </button>
          <button
            type="button"
            disabled={deleteSuiteSaving}
            onClick={() => void handleDeleteSuiteConfirm("deleteTestcases")}
            className="w-full rounded-lg border border-[var(--error)] px-4 py-3 text-left hover:bg-[var(--surface-secondary)] disabled:opacity-50"
          >
            <span className="block text-sm font-medium text-[var(--error)]">
              Delete suite and all test cases
            </span>
            <span className="mt-0.5 block text-xs text-[var(--muted)]">
              Permanently delete the suite and all its test cases
            </span>
          </button>
        </div>
        {deleteSuiteSaving && (
          <p className="mt-3 text-xs text-[var(--muted)]">Processing...</p>
        )}
        <div className="mt-4 flex justify-end">
          <Button
            variant="secondary"
            onClick={() => { if (!deleteSuiteSaving) setDeleteSuiteId(null); }}
            disabled={deleteSuiteSaving}
          >
            Cancel
          </Button>
        </div>
      </Modal>

      {/* Bulk Action Modal */}
      <Modal
        open={isBulkActionModalOpen && !!bulkAction}
        onClose={closeBulkActionModal}
        title={
          bulkAction === "delete" ? "Delete test cases" : bulkAction === "archive" ? "Archive test cases" : "Update test cases"
        }
      >
        <p className="text-sm text-[var(--muted)]">
          {selectedCaseIds.length} selected test case{selectedCaseIds.length === 1 ? "" : "s"} will be updated.
        </p>
        {bulkAction === "delete" && (
          <p className="mt-3 rounded-lg border border-[var(--error)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--error)]">
            This action permanently deletes the selected test cases.
          </p>
        )}
        {bulkAction === "update" && (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel>Status</FieldLabel>
              <Select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                <option value="Draft">Draft</option>
                <option value="In Review">In Review</option>
                <option value="Approved">Approved</option>
                <option value="Deprecated">Deprecated</option>
                <option value="Archived">Archived</option>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Priority</FieldLabel>
              <Select value={bulkPriority} onChange={(e) => setBulkPriority(e.target.value)}>
                <option value="P0">P0</option>
                <option value="P1">P1</option>
                <option value="P2">P2</option>
                <option value="P3">P3</option>
              </Select>
            </Field>
          </div>
        )}
        {bulkError && (
          <p className="mt-3 rounded-lg border border-[var(--error)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--error)]">
            {bulkError}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={closeBulkActionModal} disabled={bulkSaving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleBulkActionConfirm()} disabled={bulkSaving}>
            {bulkSaving ? "Applying..." : "Confirm"}
          </Button>
        </div>
      </Modal>
    </main>
  );
}
