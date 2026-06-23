"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconFolders } from "@tabler/icons-react";
import {
  authMe,
  getProject,
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
  type TestCaseListItem,
  type SuiteNode,
} from "@/lib/api";
import { RepositoryTestCaseTable } from "@/components/testcases/RepositoryTestCaseTable";
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
import { PageHeader } from "@/components/workflows";
import ImportTestCasesModal from "@/components/ImportTestCasesModal";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const TESTCASE_STATUSES = ["Draft", "In Review", "Approved", "Deprecated", "Archived"];
const TESTCASE_PRIORITIES = ["P0", "P1", "P2", "P3"];
const TESTCASE_TYPES = [
  "Functional", "Regression", "Smoke", "Sanity", "Integration",
  "API", "UI", "Performance", "Security",
];

type Step = { stepNumber?: number; action?: string; expectedResult?: string };
type PanelMode = "closed" | "edit" | "create";
type PanelTab = "overview" | "steps";
type BulkAction = "" | "delete" | "update" | "archive" | "move";

const EMPTY_STEP: Step = { stepNumber: 1, action: "", expectedResult: "" };

function normalizeTestcaseIdPrefix(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
}

function parseProjectSettings(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
  const activeJiraIssueKey = searchParams.get("jiraIssueKey") || "";

  const [suites, setSuites] = useState<SuiteNode[]>([]);
  const [suiteCases, setSuiteCases] = useState<TestCaseListItem[]>([]);
  const [suiteCasesTotal, setSuiteCasesTotal] = useState(0);
  const [suiteCasesLoading, setSuiteCasesLoading] = useState(false);
  const [suiteCasesError, setSuiteCasesError] = useState<string | null>(null);
  const [suiteCasesPage, setSuiteCasesPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
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
  const [estimatedDuration, setEstimatedDuration] = useState("");
  const [attachments, setAttachments] = useState("");
  const [type, setType] = useState("Functional");
  const [priority, setPriority] = useState("P2");
  const [status, setStatus] = useState("Draft");
  const [suiteId, setSuiteId] = useState("");
  const [defaultTestcaseIdPrefix, setDefaultTestcaseIdPrefix] = useState("TC");
  const [testcaseIdPrefix, setTestcaseIdPrefix] = useState("TC");
  const [panelJiraIssueKey, setPanelJiraIssueKey] = useState("");
  const [panelJiraUrl, setPanelJiraUrl] = useState("");

  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<BulkAction>("");
  const [isBulkActionModalOpen, setIsBulkActionModalOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkStatus, setBulkStatus] = useState("Draft");
  const [bulkPriority, setBulkPriority] = useState("P2");
  const [bulkTargetSuiteId, setBulkTargetSuiteId] = useState("");

  const [deleteSuiteId, setDeleteSuiteId] = useState<string | null>(null);
  const [deleteSuiteSaving, setDeleteSuiteSaving] = useState(false);

  const [isRenameSuiteModalOpen, setIsRenameSuiteModalOpen] = useState(false);
  const [renameSuiteId, setRenameSuiteId] = useState<string | null>(null);
  const [renameSuiteInputValue, setRenameSuiteInputValue] = useState("");
  const [isRenamingSuite, setIsRenamingSuite] = useState(false);

  const [suiteSearch, setSuiteSearch] = useState("");
  const [suiteStatusFilter, setSuiteStatusFilter] = useState("all");
  const [suitePriorityFilter, setSuitePriorityFilter] = useState("all");
  const [suiteTypeFilter, setSuiteTypeFilter] = useState("all");
  const [debouncedSuiteSearch, setDebouncedSuiteSearch] = useState("");

  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isImportExportMenuOpen, setIsImportExportMenuOpen] = useState(false);
  const importExportMenuRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async () => {
    const [suiteList, project] = await Promise.all([
      listSuites(projectId),
      getProject(projectId),
    ]);
    const settings = parseProjectSettings(project.settings);
    const prefix = normalizeTestcaseIdPrefix(String(settings.testcaseIdPrefix || project.key || "TC")) || "TC";
    setSuites(suiteList);
    setDefaultTestcaseIdPrefix(prefix);
    setTestcaseIdPrefix(prefix);
  }, [projectId]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      loadData().catch(() => router.replace("/projects")).finally(() => setLoading(false));
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
  const repositoryCaseCount = useMemo(
    () => visibleSuites.reduce((sum, suite) => sum + suite.testCaseCount, 0),
    [visibleSuites]
  );
  const activeFilterCount = [
    suiteSearch.trim() !== "",
    suiteStatusFilter !== "all",
    suitePriorityFilter !== "all",
    suiteTypeFilter !== "all",
    activeJiraIssueKey !== "",
  ].filter(Boolean).length;
  const totalPages = Math.max(1, Math.ceil(suiteCasesTotal / pageSize));

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
    activeSuiteId,
    debouncedSuiteSearch,
    suiteStatusFilter,
    suitePriorityFilter,
    suiteTypeFilter,
    activeJiraIssueKey,
    pageSize,
  ]);

  const loadSelectedSuiteCases = useCallback(async (pageOverride?: number) => {
    setSuiteCasesLoading(true);
    setSuiteCasesError(null);
    try {
      const { list, total } = await listTestCases(projectId, {
        limit: pageSize,
        offset: ((pageOverride ?? suiteCasesPage) - 1) * pageSize,
        suiteId: activeSuiteId ?? undefined,
        status: suiteStatusFilter === "all" ? undefined : suiteStatusFilter,
        priority: suitePriorityFilter === "all" ? undefined : suitePriorityFilter,
        type: suiteTypeFilter === "all" ? undefined : suiteTypeFilter,
        jiraIssueKey: activeJiraIssueKey || undefined,
        search: debouncedSuiteSearch || undefined,
      });
      setSuiteCases(list);
      setSuiteCasesTotal(total);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load test cases.";
      setSuiteCasesError(message);
      setSuiteCases([]);
      setSuiteCasesTotal(0);
    } finally {
      setSuiteCasesLoading(false);
    }
  }, [
    activeSuiteId,
    debouncedSuiteSearch,
    projectId,
    suiteCasesPage,
    suitePriorityFilter,
    suiteStatusFilter,
    suiteTypeFilter,
    activeJiraIssueKey,
    pageSize,
  ]);

  useEffect(() => {
    void loadSelectedSuiteCases();
  }, [loadSelectedSuiteCases]);

  useEffect(() => {
    const visibleIds = new Set(selectedSuiteCases.map((tc) => tc.id));
    setSelectedCaseIds((prev) => prev.filter((id) => visibleIds.has(id)));
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
    setEstimatedDuration((data.estimatedDuration as string) ?? "");
    setAttachments((data.attachments as string) ?? "");
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
    setEstimatedDuration("");
    setAttachments("");
    setType("Functional");
    setPriority("P2");
    setStatus("Draft");
    setSuiteId(defaultSuiteId ?? activeSuiteId ?? "");
    setTestcaseIdPrefix(defaultTestcaseIdPrefix);
    setPanelJiraIssueKey("");
    setPanelJiraUrl("");
  }

  async function openCreatePanel() {
    setPanelError(null);
    setPanelTestcaseId(null);
    setPanelMode("create");
    setPanelTab("overview");
    resetForm(activeSuiteId);
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
    setSuiteCasesPage(1);
    if (activeJiraIssueKey) router.replace(`/projects/${projectId}/testcases`);
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

  function openBulkActionModal() {
    if (selectedCaseIds.length === 0) return;
    setBulkAction("");
    setBulkError(null);
    setBulkTargetSuiteId("");
    setBulkStatus("Draft");
    setBulkPriority("P2");
    setIsBulkActionModalOpen(true);
  }

  function closeBulkActionModal() {
    if (bulkSaving) return;
    setIsBulkActionModalOpen(false);
    setBulkError(null);
    setBulkAction("");
    setBulkTargetSuiteId("");
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
      } else if (bulkAction === "move") {
        await bulkUpdateTestCases(projectId, {
          testcaseIds: selectedCaseIds,
          suiteId: bulkTargetSuiteId || undefined,
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
      setBulkTargetSuiteId("");
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

  function handleRenameSuite(suiteId: string, currentName: string) {
    setRenameSuiteId(suiteId);
    setRenameSuiteInputValue(currentName);
    setIsRenameSuiteModalOpen(true);
  }

  async function handleRenameSuiteConfirm() {
    if (!renameSuiteId || !renameSuiteInputValue.trim() || isRenamingSuite) return;
    setIsRenamingSuite(true);
    try {
      await updateSuite(renameSuiteId, { name: renameSuiteInputValue.trim() });
      setIsRenameSuiteModalOpen(false);
      setRenameSuiteId(null);
      await refreshData();
    } finally {
      setIsRenamingSuite(false);
    }
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
        const created = await createTestCase(projectId, {
          suiteId: suiteId || undefined,
          title,
          description,
          preconditions,
          steps: JSON.stringify(steps),
          testData,
          estimatedDuration,
          attachments,
          type,
          priority,
          status,
          testcaseIdPrefix,
        });
        setSuiteCasesPage(1);
        setSuiteSearch("");
        setDebouncedSuiteSearch("");
        setSuiteStatusFilter("all");
        setSuitePriorityFilter("all");
        setSuiteTypeFilter("all");
        await refreshData(1);
        setPanelSuccess("Test case created successfully.");
        setTimeout(() => setPanelSuccess(null), 4000);
        if (submitAction === "create-next") {
          resetForm(suiteId || activeSuiteId);
        } else {
          await openViewPanel(created.id);
        }
      } else if (panelMode === "edit" && panelTestcaseId) {
        await updateTestCase(projectId, panelTestcaseId, {
          suiteId: suiteId || undefined,
          title,
          description,
          preconditions,
          steps: JSON.stringify(steps),
          testData,
          estimatedDuration,
          attachments,
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
      <div className="w-full">
        {/* Page header */}
        <PageHeader
          title="Test case repository"
          subtitle="Organize suites, curate test cases, and move from review into execution."
          actions={
            <div className="flex flex-wrap items-center gap-2">
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
                      Import test cases
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
                      Download CSV template
                    </a>
                    <a
                      href={getTemplateUrl(projectId, "xlsx")}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setIsImportExportMenuOpen(false)}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                    >
                      Download Excel template
                    </a>
                  </div>
                )}
              </div>
            </div>
          }
        />

        {loading ? (
          <p className="mt-5 text-[var(--muted)]">Loading...</p>
        ) : (
          <div className="mt-5 flex items-start gap-4">
            {/* ── Suite sidebar ── */}
            <aside className="w-60 shrink-0 sticky top-6">
              <nav className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                {/* Header: label + add-suite button */}
                <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2.5">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">
                    Suites
                    {visibleSuites.length > 0 && (
                      <span className="ml-1.5 font-normal normal-case text-[var(--muted)]">
                        ({visibleSuites.length})
                      </span>
                    )}
                  </p>
                  <button
                    type="button"
                    title="Add suite"
                    onClick={() => setIsAddSuiteModalOpen(true)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--brand-primary)]"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                </div>

                {/* All test cases */}
                <div className="p-1.5">
                  <button
                    type="button"
                    onClick={() => router.push(`/projects/${projectId}/testcases`)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      !activeSuiteId
                        ? "bg-[var(--brand-soft)] font-medium text-[var(--brand-primary)]"
                        : "text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                    }`}
                  >
                    <span>All test cases</span>
                    <span className={`text-xs ${!activeSuiteId ? "text-[var(--brand-primary)] opacity-70" : "text-[var(--muted)]"}`}>
                      {repositoryCaseCount}
                    </span>
                  </button>
                </div>

                <div className="border-t border-[var(--border)]" />

                {/* Suite list — scrollable */}
                <div className="max-h-[calc(100vh-280px)] overflow-y-auto p-1.5">
                  {visibleSuites.length === 0 ? (
                    <div className="px-3 py-4 text-center">
                      <p className="text-xs text-[var(--muted)]">No suites yet</p>
                      <button
                        type="button"
                        onClick={() => setIsAddSuiteModalOpen(true)}
                        className="mt-2 text-xs text-[var(--brand-primary)] hover:underline"
                      >
                        Create your first suite
                      </button>
                    </div>
                  ) : (
                    visibleSuites.map((suite) => {
                      const isActive = activeSuiteId === suite.id;
                      return (
                        <div
                          key={suite.id}
                          className={`group rounded-lg transition-colors ${
                            isActive
                              ? "bg-[var(--brand-soft)]"
                              : "hover:bg-[var(--surface-secondary)]"
                          }`}
                        >
                          {/* Name row */}
                          <div className="flex items-start gap-2 px-2 pt-2 pb-1">
                            <IconFolders
                              size={14}
                              stroke={1.75}
                              className={`mt-0.5 shrink-0 ${isActive ? "text-[var(--brand-primary)]" : "text-[var(--muted)]"}`}
                            />
                            <button
                              type="button"
                              onClick={() =>
                                router.push(`/projects/${projectId}/testcases?suiteId=${suite.id}`)
                              }
                              className={`min-w-0 flex-1 break-words text-left text-sm font-medium leading-snug ${
                                isActive ? "text-[var(--brand-primary)]" : "text-[var(--foreground)]"
                              }`}
                            >
                              {suite.name}
                            </button>
                            {/* Count → hidden on hover, replaced by actions */}
                            <span className={`shrink-0 text-xs group-hover:hidden ${isActive ? "text-[var(--brand-primary)] opacity-60" : "text-[var(--muted)]"}`}>
                              {suite.testCaseCount}
                            </span>
                            {/* Actions — shown on hover instead of count */}
                            <div className="hidden shrink-0 items-center group-hover:flex">
                              <button
                                type="button"
                                title="Add test case"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void openCreatePanelForSuite(suite.id);
                                }}
                                className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--brand-primary)]"
                              >
                                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                title="Rename suite"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRenameSuite(suite.id, suite.name);
                                }}
                                className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
                              >
                                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                title="Delete suite"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteSuiteId(suite.id);
                                }}
                                className="flex h-6 w-6 items-center justify-center rounded text-[var(--error)] hover:bg-[var(--surface)] hover:opacity-80"
                              >
                                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          {/* Bottom padding to keep rows from feeling cramped */}
                          <div className="pb-1.5" />
                        </div>
                      );
                    })
                  )}
                </div>
              </nav>
            </aside>

            {/* ── Main content ── */}
            <div className="min-w-0 flex-1 space-y-3">
              {/* Toolbar */}
              <Card className="overflow-hidden p-0">
                {/* Action row */}
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedCaseIds.length > 0 ? (
                      <>
                        <span className="text-sm font-medium text-[var(--foreground)]">
                          {selectedCaseIds.length} selected
                        </span>
                        <Button size="sm" variant="secondary" onClick={openBulkActionModal}>
                          Bulk actions
                        </Button>
                        <button
                          type="button"
                          onClick={() => setSelectedCaseIds([])}
                          className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                        >
                          Clear selection
                        </button>
                      </>
                    ) : (
                      <p className="text-sm font-medium text-[var(--foreground)]">
                        {activeSuiteId
                          ? (selectedSuite?.name ?? "Suite")
                          : "All test cases"}
                      </p>
                    )}
                  </div>
                  <Button size="sm" onClick={() => { void openCreatePanel(); }}>
                    + Add test case
                  </Button>
                </div>

                {/* Filter row */}
                <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--background)] px-4 py-2.5">
                  <div className="min-w-[180px] flex-[2]">
                    <Input
                      type="text"
                      value={suiteSearch}
                      onChange={(e) => setSuiteSearch(e.target.value)}
                      placeholder="Search by ID, title, or type"
                      className="h-8 text-sm"
                    />
                  </div>
                  <Select
                    value={suiteTypeFilter}
                    onChange={(e) => setSuiteTypeFilter(e.target.value)}
                    className="h-8 min-w-[110px] flex-1 text-sm"
                  >
                    <option value="all">All types</option>
                    {TESTCASE_TYPES.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </Select>
                  <Select
                    value={suiteStatusFilter}
                    onChange={(e) => setSuiteStatusFilter(e.target.value)}
                    className="h-8 min-w-[120px] flex-1 text-sm"
                  >
                    <option value="all">All statuses</option>
                    {TESTCASE_STATUSES.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </Select>
                  <Select
                    value={suitePriorityFilter}
                    onChange={(e) => setSuitePriorityFilter(e.target.value)}
                    className="h-8 min-w-[110px] flex-1 text-sm"
                  >
                    <option value="all">All priorities</option>
                    {TESTCASE_PRIORITIES.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </Select>
                  {suiteStatusFilter !== "all" && (
                    <button
                      type="button"
                      onClick={() => setSuiteStatusFilter("all")}
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--brand-primary)] hover:opacity-80"
                    >
                      {suiteStatusFilter}
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                  {suitePriorityFilter !== "all" && (
                    <button
                      type="button"
                      onClick={() => setSuitePriorityFilter("all")}
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--brand-primary)] hover:opacity-80"
                    >
                      {suitePriorityFilter}
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                  {suiteTypeFilter !== "all" && (
                    <button
                      type="button"
                      onClick={() => setSuiteTypeFilter("all")}
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--brand-primary)] hover:opacity-80"
                    >
                      {suiteTypeFilter}
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                  {activeJiraIssueKey && (
                    <button
                      type="button"
                      onClick={() => router.replace(`/projects/${projectId}/testcases`)}
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--info-soft,#EEF2FF)] px-2.5 py-0.5 text-xs font-medium text-[var(--info-foreground,#2D3DB0)] hover:opacity-80"
                    >
                      Jira: {activeJiraIssueKey}
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                  {activeFilterCount > 0 && (
                    <Button variant="secondary" size="sm" onClick={clearSuiteFilters} className="h-8 shrink-0">
                      Clear all
                    </Button>
                  )}
                </div>
              </Card>

              {/* Content */}
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
                  description={
                    activeFilterCount > 0
                      ? "No test cases match your current filters."
                      : activeSuiteId
                        ? "This suite has no test cases yet."
                        : "No test cases in this project yet."
                  }
                  action={
                    <Button size="sm" onClick={() => { void openCreatePanel(); }}>
                      + Add test case
                    </Button>
                  }
                />
              ) : (
                <>
                  <RepositoryTestCaseTable
                    key={projectId}
                    projectId={projectId}
                    suiteNameMap={suiteNameMap}
                    cases={selectedSuiteCases}
                    rowHighlightId={panelTestcaseId}
                    selectedCaseIdSet={selectedCaseIdSet}
                    areAllCasesSelected={areAllCasesSelected}
                    onToggleSelectAll={toggleSelectAllCases}
                    onToggleCase={toggleCaseSelection}
                    onOpenRow={openViewPanel}
                  />

                  {/* Pagination */}
                  <Card className="flex items-center justify-between px-4 py-3 text-sm">
                    <span className="text-[var(--muted)]">
                      <span className="font-medium text-[var(--foreground)]">{suiteCasesTotal}</span>{" "}
                      {suiteCasesTotal === 1 ? "result" : "results"}
                      {totalPages > 1 && (
                        <>
                          {" · "}page{" "}
                          <span className="font-medium text-[var(--foreground)]">{suiteCasesPage}</span>{" "}
                          of{" "}
                          <span className="font-medium text-[var(--foreground)]">{totalPages}</span>
                        </>
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <Select
                        value={pageSize}
                        onChange={(e) => {
                          setPageSize(Number(e.target.value));
                          setSuiteCasesPage(1);
                        }}
                        className="h-8 text-sm"
                      >
                        {PAGE_SIZE_OPTIONS.map((n) => (
                          <option key={n} value={n}>{n} / page</option>
                        ))}
                      </Select>
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
                          setSuiteCasesPage((prev) => (prev >= totalPages ? prev : prev + 1))
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
          </div>
        )}
      </div>

      {/* ── Detail panel ── */}
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
                {(["overview", "steps"] as PanelTab[]).map((tab) => (
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
                    {tab === "overview" ? "Overview" : `Steps${steps.length > 0 ? ` (${steps.length})` : ""}`}
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
                <form onSubmit={handlePanelSubmit} id="panel-form-global">
                  {/* CREATE MODE */}
                  {panelMode === "create" && (
                    <div className="space-y-5 px-6 py-5">
                      <Field>
                        <FieldLabel>Title <span className="text-[var(--error)]">*</span></FieldLabel>
                        <Input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="Describe what this test case validates" />
                      </Field>
                      <Field>
                        <FieldLabel>Test case ID prefix</FieldLabel>
                        <Input
                          type="text"
                          value={testcaseIdPrefix}
                          maxLength={3}
                          onChange={(e) => setTestcaseIdPrefix(normalizeTestcaseIdPrefix(e.target.value))}
                          placeholder="TC"
                          className="max-w-28 font-mono uppercase"
                        />
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          Max 3 letters or numbers. This can be changed before saving only.
                        </p>
                      </Field>
                      <Field>
                        <FieldLabel>Description</FieldLabel>
                        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What does this test case cover?" />
                      </Field>
                      <div className="grid grid-cols-3 gap-3">
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
                          <Input type="text" value={estimatedDuration} onChange={(e) => setEstimatedDuration(e.target.value)} placeholder="e.g. 10 min" />
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
                      <div>
                        <div className="mb-3 flex items-center justify-between">
                          <FieldLabel>Test Steps</FieldLabel>
                          <Button variant="secondary" size="sm" onClick={addStep} className="border-[var(--brand-primary)] text-[var(--brand-primary)]">+ Add step</Button>
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
                        <FieldLabel>Attachments</FieldLabel>
                        <Textarea value={attachments} onChange={(e) => setAttachments(e.target.value)} rows={2} placeholder="Links/paths to screenshots, logs, or reference docs" />
                      </Field>
                    </div>
                  )}

                  {/* EDIT MODE — tabbed content */}
                  {panelMode === "edit" && (
                    <>
                      {panelTab === "overview" && (
                        <div className="space-y-5 px-6 py-5">
                          <Field>
                            <FieldLabel>Title <span className="text-[var(--error)]">*</span></FieldLabel>
                            <Input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
                          </Field>
                          <Field>
                            <FieldLabel>Description</FieldLabel>
                            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
                          </Field>
                          <Field>
                            <FieldLabel>Preconditions</FieldLabel>
                            <Textarea value={preconditions} onChange={(e) => setPreconditions(e.target.value)} rows={3} />
                          </Field>
                          <Field>
                            <FieldLabel>Test Data</FieldLabel>
                            <Textarea value={testData} onChange={(e) => setTestData(e.target.value)} rows={2} placeholder="Input data, sample values, or setup-specific data" />
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
                              <Input type="text" value={estimatedDuration} onChange={(e) => setEstimatedDuration(e.target.value)} placeholder="e.g. 10 min" />
                            </Field>
                          </div>
                          <Field>
                            <FieldLabel>Attachments</FieldLabel>
                            <Textarea value={attachments} onChange={(e) => setAttachments(e.target.value)} rows={2} placeholder="Links/paths to screenshots, logs, or reference docs" />
                          </Field>
                        </div>
                      )}
                      {panelTab === "steps" && (
                        <div className="px-6 py-5">
                          <div className="mb-4 flex items-center justify-between">
                            <p className="text-sm font-medium text-[var(--foreground)]">{steps.length} step{steps.length === 1 ? "" : "s"}</p>
                            <Button variant="secondary" size="sm" onClick={addStep} className="border-[var(--brand-primary)] text-[var(--brand-primary)]">+ Add step</Button>
                          </div>
                          {steps.length === 0 ? (
                            <EmptyStateBlock title="No steps yet" description="Add your first step above." />
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
                    </>
                  )}
                </form>
              )}
            </div>

            {/* Sticky footer */}
            {!panelLoading && (
              <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-6 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Button type="submit" form="panel-form-global" variant="primary" onClick={() => setSubmitAction("create")} disabled={panelSaving}>
                      {panelSaving ? "Saving..." : panelMode === "create" ? "Create" : "Save changes"}
                    </Button>
                    {panelMode === "create" && (
                      <Button type="submit" form="panel-form-global" variant="secondary" onClick={() => setSubmitAction("create-next")} disabled={panelSaving} className="border-[var(--brand-primary)] text-[var(--brand-primary)]">
                        {panelSaving ? "Saving..." : "Create & Add Next"}
                      </Button>
                    )}
                    <Button variant="secondary" onClick={closePanel} disabled={panelSaving}>Cancel</Button>
                  </div>
                  {panelMode === "edit" && panelTestcaseId && (
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => void handleArchivePanelTestCase()} disabled={panelSaving} className="border-[var(--warning)] text-[var(--warning)]">Archive</Button>
                      <Button variant="destructive" size="sm" onClick={() => void handleDeletePanelTestCase()} disabled={panelSaving}>Delete</Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* ── Add Suite Modal ── */}
      <Modal
        open={isAddSuiteModalOpen}
        onClose={() => {
          if (isCreatingSuite) return;
          setIsAddSuiteModalOpen(false);
          setNewSuiteName("");
        }}
        title="Add suite"
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

      {/* ── Delete Suite Modal ── */}
      <Modal
        open={!!deleteSuiteId}
        onClose={() => { if (!deleteSuiteSaving) setDeleteSuiteId(null); }}
        title="Delete suite"
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
            <span className="block text-sm font-medium text-[var(--foreground)]">Delete suite only</span>
            <span className="mt-0.5 block text-xs text-[var(--muted)]">Move all test cases to the Default Suite</span>
          </button>
          <button
            type="button"
            disabled={deleteSuiteSaving}
            onClick={() => void handleDeleteSuiteConfirm("deleteTestcases")}
            className="w-full rounded-lg border border-[var(--error)] px-4 py-3 text-left hover:bg-[var(--surface-secondary)] disabled:opacity-50"
          >
            <span className="block text-sm font-medium text-[var(--error)]">Delete suite and all test cases</span>
            <span className="mt-0.5 block text-xs text-[var(--muted)]">Permanently delete the suite and all its test cases</span>
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

      {/* ── Bulk Action Modal ── */}
      <Modal
        open={isBulkActionModalOpen}
        onClose={closeBulkActionModal}
        title="Bulk actions"
      >
        <p className="text-sm text-[var(--muted)]">
          <span className="font-medium text-[var(--foreground)]">{selectedCaseIds.length}</span>{" "}
          test case{selectedCaseIds.length === 1 ? "" : "s"} selected
        </p>

        <Field className="mt-4">
          <FieldLabel>Action</FieldLabel>
          <Select
            value={bulkAction}
            onChange={(e) => setBulkAction(e.target.value as BulkAction)}
          >
            <option value="">Select an action…</option>
            <option value="move">Move to suite</option>
            <option value="update">Update status / priority</option>
            <option value="archive">Archive</option>
            <option value="delete">Delete</option>
          </Select>
        </Field>

        {bulkAction === "move" && (
          <Field className="mt-4">
            <FieldLabel>Target suite</FieldLabel>
            <Select
              value={bulkTargetSuiteId}
              onChange={(e) => setBulkTargetSuiteId(e.target.value)}
            >
              <option value="">Unassigned (no suite)</option>
              {suites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>
        )}

        {bulkAction === "update" && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>Status</FieldLabel>
              <Select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                {TESTCASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <Field>
              <FieldLabel>Priority</FieldLabel>
              <Select value={bulkPriority} onChange={(e) => setBulkPriority(e.target.value)}>
                {TESTCASE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </Field>
          </div>
        )}

        {bulkAction === "archive" && (
          <p className="mt-4 rounded-lg border border-[var(--warning)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--warning)]">
            All selected test cases will be archived.
          </p>
        )}

        {bulkAction === "delete" && (
          <p className="mt-4 rounded-lg border border-[var(--error)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--error)]">
            This permanently deletes the selected test cases. This action cannot be undone.
          </p>
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
          <Button
            variant={bulkAction === "delete" ? "destructive" : "primary"}
            onClick={() => void handleBulkActionConfirm()}
            disabled={!bulkAction || bulkSaving}
          >
            {bulkSaving ? "Applying..." : "Confirm"}
          </Button>
        </div>
      </Modal>

      {/* ── Rename Suite Modal ── */}
      <Modal
        open={isRenameSuiteModalOpen}
        onClose={() => {
          if (isRenamingSuite) return;
          setIsRenameSuiteModalOpen(false);
          setRenameSuiteId(null);
        }}
        title="Rename suite"
      >
        <Field className="mt-4">
          <FieldLabel>Suite name</FieldLabel>
          <Input
            type="text"
            value={renameSuiteInputValue}
            onChange={(e) => setRenameSuiteInputValue(e.target.value)}
            placeholder="Enter suite name"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRenameSuiteConfirm();
            }}
            autoFocus
          />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              if (isRenamingSuite) return;
              setIsRenameSuiteModalOpen(false);
              setRenameSuiteId(null);
            }}
            disabled={isRenamingSuite}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleRenameSuiteConfirm()}
            disabled={!renameSuiteInputValue.trim() || isRenamingSuite}
          >
            {isRenamingSuite ? "Saving..." : "Save"}
          </Button>
        </div>
      </Modal>

      {/* ── Import Modal ── */}
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
