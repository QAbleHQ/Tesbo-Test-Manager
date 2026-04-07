"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  getExportUrl,
  getTemplateUrl,
  getProject,
  type TestCaseListItem,
  type SuiteNode,
} from "@/lib/api";
import {
  RepositoryTestCaseTable,
  REPO_TC_AI_DISABLED_TITLE,
} from "@/components/testcases/RepositoryTestCaseTable";
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
import { PageHeader, ListWorkspaceLayout } from "@/components/workflows";
import ImportTestCasesModal from "@/components/ImportTestCasesModal";

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
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isImportExportMenuOpen, setIsImportExportMenuOpen] = useState(false);
  const importExportMenuRef = useRef<HTMLDivElement>(null);
  const [aiConfigured, setAiConfigured] = useState(false);
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
      getProject(projectId)
        .then((p) => setAiConfigured(p.aiConfigured === true))
        .catch(() => setAiConfigured(false));
    });
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
  const totalSuiteCount = visibleSuites.length;
  const repositoryCaseCount = useMemo(
    () => visibleSuites.reduce((sum, suite) => sum + suite.testCaseCount, 0),
    [visibleSuites]
  );
  const activeFilterCount = [
    suiteSearch.trim() !== "",
    suiteStatusFilter !== "all",
    suitePriorityFilter !== "all",
    suiteTypeFilter !== "all",
    suiteAutomationFilter !== "all",
    viewMode === "allCases" && allCasesSuiteFilter !== "all",
  ].filter(Boolean).length;
  const totalPages = Math.max(1, Math.ceil(suiteCasesTotal / PAGE_SIZE));
  const pageStart = suiteCasesTotal === 0 ? 0 : (suiteCasesPage - 1) * PAGE_SIZE + 1;
  const pageEnd = suiteCasesTotal === 0 ? 0 : Math.min(suiteCasesTotal, suiteCasesPage * PAGE_SIZE);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSuiteSearch(suiteSearch.trim());
    }, 250);
    return () => clearTimeout(timeout);
  }, [suiteSearch]);

  useEffect(() => {
    if (!isImportExportMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (importExportMenuRef.current && !importExportMenuRef.current.contains(e.target as Node)) {
        setIsImportExportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isImportExportMenuOpen]);

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

  async function openCreatePanelForSuite(targetSuiteId: string) {
    setPanelError(null);
    setPanelTestcaseId(null);
    setPanelMode("create");
    setPanelTab("overview");
    resetForm(targetSuiteId);
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
        setSuiteCasesPage(1);
        setSuiteSearch("");
        setDebouncedSuiteSearch("");
        setSuiteStatusFilter("all");
        setSuitePriorityFilter("all");
        setSuiteTypeFilter("all");
        setSuiteAutomationFilter("all");
        await refreshData(1);
        setPanelSuccess("Test case created successfully.");
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
      <ListWorkspaceLayout
        header={
          <PageHeader
            title="Test case repository"
            subtitle="Organize suites, curate test cases, and move from repository review into execution and automation with a cleaner operational workspace."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-card)]">
                  <button
                    type="button"
                    onClick={() => handleViewModeChange("bySuites")}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                      viewMode === "bySuites"
                        ? "bg-[var(--brand-surface)] text-[var(--brand-primary)]"
                        : "text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    By Suites
                  </button>
                  <button
                    type="button"
                    onClick={() => handleViewModeChange("allCases")}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                      viewMode === "allCases"
                        ? "bg-[var(--brand-surface)] text-[var(--brand-primary)]"
                        : "text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    All Test Cases
                  </button>
                </div>
                <div ref={importExportMenuRef} className="relative">
                  <Button
                    variant="secondary"
                    onClick={() => setIsImportExportMenuOpen((v) => !v)}
                    className="flex items-center gap-1.5"
                  >
                    Import / Export
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </Button>
                  {isImportExportMenuOpen && (
                    <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-elevated)]">
                      <button
                        type="button"
                        onClick={() => {
                          setIsImportModalOpen(true);
                          setIsImportExportMenuOpen(false);
                        }}
                        className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                      >
                        Import Test Cases
                      </button>
                      <div className="my-1 border-t border-[var(--border)]" />
                      <a
                        href={getExportUrl(projectId, "csv")}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setIsImportExportMenuOpen(false)}
                        className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                      >
                        Export as CSV
                      </a>
                      <a
                        href={getExportUrl(projectId, "xlsx")}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setIsImportExportMenuOpen(false)}
                        className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                      >
                        Export as Excel
                      </a>
                      <div className="my-1 border-t border-[var(--border)]" />
                      <a
                        href={getTemplateUrl(projectId, "csv")}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setIsImportExportMenuOpen(false)}
                        className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                      >
                        Download CSV Template
                      </a>
                      <a
                        href={getTemplateUrl(projectId, "xlsx")}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setIsImportExportMenuOpen(false)}
                        className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                      >
                        Download Excel Template
                      </a>
                    </div>
                  )}
                </div>
                <Button variant="secondary" onClick={() => setIsAddSuiteModalOpen(true)}>
                  Add Suite
                </Button>
                <Button
                  onClick={() => { void openCreatePanel(); }}
                  disabled={viewMode === "bySuites" && !activeSuiteId}
                  title={viewMode === "bySuites" && !activeSuiteId ? "Open a suite first to create a case inside it." : undefined}
                >
                  Add Test Case
                </Button>
              </div>
            }
          />
        }
      >
        <Card className="p-4 lg:p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip tone={viewMode === "allCases" ? "confidenceHigh" : "brand"}>
                  {viewMode === "allCases" ? "All repository cases" : "Suites workspace"}
                </StatusChip>
                {selectedSuite ? <StatusChip tone="brand">{selectedSuite.name}</StatusChip> : null}
                {activeFilterCount > 0 ? (
                  <StatusChip tone="warning">
                    {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} active
                  </StatusChip>
                ) : null}
              </div>
              <p className="max-w-3xl text-sm leading-6 text-[var(--muted)]">
                {viewMode === "allCases"
                  ? "Use the repository-wide view to search, filter, and bulk-edit cases across suites with stronger visibility into readiness and review state."
                  : activeSuiteId && selectedSuite
                    ? "Work inside a single suite with cleaner filtering, bulk actions, and quick access to automation and execution."
                    : "Browse suites first, then drill into a focused case list when you are ready to review or edit detailed test coverage."}
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">Suites</p>
              <p className="mt-2 text-[28px] font-semibold tracking-tight text-[var(--foreground)]">{totalSuiteCount}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">Structured coverage groups in this project</p>
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">Repository Cases</p>
              <p className="mt-2 text-[28px] font-semibold tracking-tight text-[var(--foreground)]">{repositoryCaseCount}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">Total cases currently organized across suites</p>
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">Current View</p>
              <p className="mt-2 text-[20px] font-semibold tracking-tight text-[var(--foreground)]">
                {viewMode === "allCases" ? "All test cases" : activeSuiteId && selectedSuite ? selectedSuite.name : "Browse suites"}
              </p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {viewMode === "allCases"
                  ? "Cross-suite review mode"
                  : activeSuiteId && selectedSuite
                    ? `${selectedSuite.testCaseCount} case${selectedSuite.testCaseCount === 1 ? "" : "s"} in this suite`
                    : "Choose a suite to review contained cases"}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">Filtered Results</p>
              <p className="mt-2 text-[28px] font-semibold tracking-tight text-[var(--foreground)]">
                {loading ? "..." : suiteCasesTotal}
              </p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {activeFilterCount > 0
                  ? "Results after the current search and filter set"
                  : "Visible results in the active repository view"}
              </p>
            </div>
          </div>
        </Card>

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
          <section className="mt-2 space-y-4">
            <Card className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {viewMode === "bySuites" && selectedSuite ? <StatusChip tone="brand">{selectedSuite.name}</StatusChip> : null}
                    <StatusChip tone="confidenceHigh">
                      {pageStart}-{pageEnd} of {suiteCasesTotal}
                    </StatusChip>
                    {selectedCaseIds.length > 0 ? (
                      <StatusChip tone="warning">
                        {selectedCaseIds.length} selected
                      </StatusChip>
                    ) : null}
                  </div>
                  <div>
                    <h2 className="text-[22px] font-semibold tracking-tight text-[var(--foreground)]">
                      {viewMode === "bySuites" && selectedSuite ? `${selectedSuite.name} test cases` : "All test cases"}
                    </h2>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      {viewMode === "bySuites" && selectedSuite
                        ? `Review ${selectedSuite.testCaseCount} case${selectedSuite.testCaseCount === 1 ? "" : "s"} in this suite, then open the side panel for detailed editing and automation.`
                        : `Search, filter, and bulk-manage repository cases across ${totalSuiteCount} suite${totalSuiteCount === 1 ? "" : "s"}.`}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {viewMode === "bySuites" && selectedSuite ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => router.push(`/projects/${projectId}/testcases`)}
                    >
                      Back to suites
                    </Button>
                  ) : null}
                  {selectedCaseIds.length > 0 ? (
                    <>
                      <Select
                        value={bulkAction}
                        onChange={(e) => setBulkAction(e.target.value as BulkAction)}
                        className="h-9 w-auto min-w-[140px]"
                      >
                        <option value="">Bulk action</option>
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
                        Apply to selection
                      </Button>
                    </>
                  ) : null}
                  <Button size="sm" onClick={() => { void openCreatePanel(); }}>
                    Add test case
                  </Button>
                </div>
              </div>
            </Card>

            <div className="space-y-3">
              <Card className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                      Filter repository
                    </p>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      Narrow results by search, suite scope, workflow status, and automation readiness.
                    </p>
                  </div>
                  {activeFilterCount > 0 ? (
                    <StatusChip tone="warning">
                      {activeFilterCount} active filter{activeFilterCount === 1 ? "" : "s"}
                    </StatusChip>
                  ) : null}
                </div>
                <div className={`mt-4 grid gap-3 ${viewMode === "allCases" ? "sm:grid-cols-2 xl:grid-cols-6" : "sm:grid-cols-2 xl:grid-cols-5"}`}>
                  <div className={viewMode === "allCases" ? "xl:col-span-2" : "xl:col-span-1"}>
                    <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                      Search
                    </label>
                    <Input
                      type="text"
                      value={suiteSearch}
                      onChange={(e) => setSuiteSearch(e.target.value)}
                      placeholder="Search by ID, title, or type"
                      className="h-9"
                    />
                  </div>
                  {viewMode === "allCases" && (
                    <div>
                      <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                        Suite
                      </label>
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
                    </div>
                  )}
                  <div>
                    <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                      Type
                    </label>
                    <Select value={suiteTypeFilter} onChange={(e) => setSuiteTypeFilter(e.target.value)} className="h-9">
                      <option value="all">All types</option>
                      {TESTCASE_TYPES.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                      Automation
                    </label>
                    <Select value={suiteAutomationFilter} onChange={(e) => setSuiteAutomationFilter(e.target.value)} className="h-9">
                      <option value="all">All automation states</option>
                      {AUTOMATION_FEASIBILITY_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                      Workflow status
                    </label>
                    <Select value={suiteStatusFilter} onChange={(e) => setSuiteStatusFilter(e.target.value)} className="h-9">
                      <option value="all">All statuses</option>
                      {TESTCASE_STATUSES.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                      Priority
                    </label>
                    <div className="flex gap-2">
                      <Select value={suitePriorityFilter} onChange={(e) => setSuitePriorityFilter(e.target.value)} className="h-9">
                        <option value="all">All priorities</option>
                        {TESTCASE_PRIORITIES.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </Select>
                      <Button variant="secondary" size="sm" onClick={clearSuiteFilters} className="shrink-0">
                        Clear
                      </Button>
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-xs text-[var(--muted)]">
                  Showing {pageStart}-{pageEnd} of {suiteCasesTotal} matching test case{suiteCasesTotal === 1 ? "" : "s"}.
                </p>
              </Card>

              {suiteCasesError ? (
                <p className="rounded-xl border border-[var(--error-border)] bg-[var(--error-soft)] p-4 text-sm text-[var(--error-foreground)]">
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
                  <RepositoryTestCaseTable
                    key={projectId}
                    projectId={projectId}
                    suiteNameMap={suiteNameMap}
                    cases={selectedSuiteCases}
                    aiConfigured={aiConfigured}
                    rowHighlightId={panelTestcaseId}
                    selectedCaseIdSet={selectedCaseIdSet}
                    areAllCasesSelected={areAllCasesSelected}
                    onToggleSelectAll={toggleSelectAllCases}
                    onToggleCase={toggleCaseSelection}
                    onOpenRow={openViewPanel}
                    onRunSingle={openSingleTestRun}
                  />

                  <Card className="flex items-center justify-between px-4 py-3 text-sm">
                    <span className="text-[var(--muted)]">
                      Showing {pageStart}-{pageEnd} of {suiteCasesTotal} on page {suiteCasesPage} of {totalPages}
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
                            prev >= totalPages ? prev : prev + 1
                          )
                        }
                        disabled={suiteCasesPage >= totalPages || suiteCasesLoading}
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
                                        {aiConfigured ? (
                                          <a
                                            href={`/projects/${projectId}/testcases/${panelTestcaseId}/automate`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-[var(--ai-primary)] bg-[var(--ai-soft)] px-3 text-xs font-semibold text-[var(--ai-primary)] hover:bg-[var(--ai-surface)]"
                                          >
                                            Open Automate
                                          </a>
                                        ) : (
                                          <Button
                                            type="button"
                                            variant="ai"
                                            size="sm"
                                            disabled
                                            title={REPO_TC_AI_DISABLED_TITLE}
                                          >
                                            Open Automate
                                          </Button>
                                        )}
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
              <Card key={suite.id} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => router.push(`/projects/${projectId}/testcases?suiteId=${suite.id}`)}
                      className="truncate text-left text-[18px] font-semibold text-[var(--foreground)] hover:underline"
                    >
                      {suite.name}
                    </button>
                    <p className="mt-1.5 text-sm text-[var(--muted)]">
                      Open this suite to review contained cases, bulk-manage items, and jump into automation or execution.
                    </p>
                  </div>
                  <StatusChip tone={suite.testCaseCount > 0 ? "confidenceHigh" : "neutral"}>
                    {suite.testCaseCount} case{suite.testCaseCount === 1 ? "" : "s"}
                  </StatusChip>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => router.push(`/projects/${projectId}/testcases?suiteId=${suite.id}`)}>
                    Open suite
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => { void openCreatePanelForSuite(suite.id); }}
                  >
                    Add test case
                  </Button>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
                  <button
                    type="button"
                    onClick={() => handleRenameSuite(suite.id, suite.name)}
                    className="font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteSuiteId(suite.id)}
                    className="font-medium text-[var(--error)] hover:opacity-80"
                  >
                    Delete
                  </button>
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
      <ImportTestCasesModal
        projectId={projectId}
        open={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImported={() => {
          void loadData();
          void loadSelectedSuiteCases();
        }}
      />
    </main>
  );
}
