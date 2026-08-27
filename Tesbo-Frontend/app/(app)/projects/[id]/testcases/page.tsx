"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IconChevronDown,
  IconChevronRight,
  IconDownload,
  IconFileText,
  IconArchive,
  IconFolderOff,
  IconFolders,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
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
  getRepositorySummary,
  listCustomFieldDefinitions,
  getCustomFieldValues,
  buildCustomFieldFiltersQueryParam,
  UNASSIGNED_SUITE_ID,
  type TestCaseListItem,
  type SuiteNode,
  type RepositorySummary,
  type CustomFieldDefinition,
  type CustomFieldValue,
  type CustomFieldFilterCondition,
} from "@/lib/api";
import { RepositoryTestCaseTable } from "@/components/testcases/RepositoryTestCaseTable";
import { useTopBarSlots } from "@/components/TopBarSlots";
import {
  Button,
  CopyButton,
  Input,
  Select,
  Textarea,
  Modal,
  EmptyStateBlock,
  PageLoader,
  StatusChip,
  Field,
  FieldLabel,
  FieldError,
  FieldHint,
} from "@/components/ui";
import ImportTestCasesModal from "@/components/ImportTestCasesModal";
import CustomFieldsSection from "@/components/customFields/CustomFieldsSection";
import CustomFieldFilterPopover from "@/components/customFields/CustomFieldFilterPopover";
import { getConfiguredDefaultValue, validateCustomFieldValues } from "@/components/customFields/customFieldTypes";
import { readStoredValue, writeStoredValue } from "@/lib/storage";
import { toTsv } from "@/lib/tsv";
import { SUITE_NAME_MAX_LENGTH, validateSuiteName } from "@/lib/validation";

// 500 is the server's per-request ceiling (listTestCases clamps `limit`), so it is the largest
// page we can offer. Paired with "select all matching" below, a 500-case suite no longer has to
// be bulk-edited in five separate passes.
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250, 500] as const;
const MAX_PAGE_SIZE = 500;
/* The bulk-edit selects' "don't touch this field" value. Empty so the API reads it as omitted. */
const BULK_NO_CHANGE = "";
const DEFAULT_PAGE_SIZE = 25;
const TESTCASE_STATUSES = ["Draft", "In Review", "Approved", "Deprecated", "Archived"];
const TESTCASE_PRIORITIES = ["P0", "P1", "P2", "P3"];
const TESTCASE_TYPES = [
  "Functional", "Regression", "Smoke", "Sanity", "Integration",
  "API", "UI", "Performance", "Security",
];
const TESTCASE_AUTOMATION_TYPES = ["Automated", "Not Automated", "Can't Automate"];

type Step = { stepNumber?: number; action?: string; expectedResult?: string };
type PanelMode = "closed" | "edit" | "create";
type PanelTab = "overview" | "steps" | "customFields";
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

function automationTone(a: string) {
  if (a === "Automated") return "success" as const;
  if (a === "Can't Automate") return "error" as const;
  return "neutral" as const;
}

export default function TestCasesPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const activeSuiteId = searchParams.get("suiteId");
  /*
   * "?suiteId=none" is the "No suites" node — the cases that belong to no suite.
   *
   * It rides the same query parameter as a real suite id so the list request, the filter chips and the
   * pagination reset all keep working unchanged. `formSuiteId` is the value the create/edit form may
   * pre-select from it: the sentinel is not a suite, so it must resolve to "no suite chosen" there
   * rather than being written to a testcase's suite_id.
   */
  const isUnfiledView = activeSuiteId === UNASSIGNED_SUITE_ID;
  const formSuiteId = isUnfiledView ? null : activeSuiteId;
  const activeJiraIssueKey = searchParams.get("jiraIssueKey") || "";
  const activeLinearIssueKey = searchParams.get("linearIssueKey") || "";

  // Take over the shared TopBar with this page's breadcrumb + actions (portaled below),
  // and hide the default global "Search projects" search while this page is mounted.
  const { startEl: topBarStartEl, endEl: topBarEndEl, setFilled: setTopBarFilled } = useTopBarSlots();
  useEffect(() => {
    setTopBarFilled(true);
    return () => setTopBarFilled(false);
  }, [setTopBarFilled]);

  // Filter-bar slot that the table portals its "Columns" control into, so it sits
  // inline beside the type/status/priority dropdowns instead of in its own strip.
  const [columnsSlotEl, setColumnsSlotEl] = useState<HTMLElement | null>(null);

  const [suites, setSuites] = useState<SuiteNode[]>([]);
  const [projectName, setProjectName] = useState("");
  const [repoSummary, setRepoSummary] = useState<RepositorySummary | null>(null);
  const [suitePanelOpen, setSuitePanelOpen] = useState(true);
  const [suiteCases, setSuiteCases] = useState<TestCaseListItem[]>([]);
  const [suiteCasesTotal, setSuiteCasesTotal] = useState(0);
  const [suiteCasesLoading, setSuiteCasesLoading] = useState(false);
  const [suiteCasesError, setSuiteCasesError] = useState<string | null>(null);
  const [suiteCasesPage, setSuiteCasesPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(true);

  const [isAddSuiteModalOpen, setIsAddSuiteModalOpen] = useState(false);
  const [newSuiteName, setNewSuiteName] = useState("");
  const [newSuiteParentId, setNewSuiteParentId] = useState("");
  const [isCreatingSuite, setIsCreatingSuite] = useState(false);
  const [newSuiteNameError, setNewSuiteNameError] = useState("");
  const [expandedSuiteIds, setExpandedSuiteIds] = useState<Set<string>>(new Set());

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
  const [automationStatus, setAutomationStatus] = useState("Not Automated");
  const [suiteId, setSuiteId] = useState("");
  const [defaultTestcaseIdPrefix, setDefaultTestcaseIdPrefix] = useState("TC");
  const [testcaseIdPrefix, setTestcaseIdPrefix] = useState("TC");
  const [panelJiraIssueKey, setPanelJiraIssueKey] = useState("");
  const [panelJiraUrl, setPanelJiraUrl] = useState("");

  // Custom fields (Pro plan feature): `customFieldDefinitions` is the project's active
  // definitions (used for the create form and as the base for edit-mode merging).
  // `panelCustomFields` is the edit-mode merge of definitions + this test case's stored
  // values (including archived/inactive fields that still hold a historical value).
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<CustomFieldDefinition[]>([]);
  const [panelCustomFields, setPanelCustomFields] = useState<CustomFieldValue[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, unknown>>({});
  const [customFieldErrors, setCustomFieldErrors] = useState<Record<string, string>>({});

  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [selectAllMatchingLoading, setSelectAllMatchingLoading] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkAction>("");
  const [isBulkActionModalOpen, setIsBulkActionModalOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkStatus, setBulkStatus] = useState("Draft");
  const [bulkPriority, setBulkPriority] = useState("P2");
  const [bulkAutomationStatus, setBulkAutomationStatus] = useState("Not Automated");
  const [bulkTargetSuiteId, setBulkTargetSuiteId] = useState("");

  const [deleteSuiteId, setDeleteSuiteId] = useState<string | null>(null);
  const [deleteSuiteSaving, setDeleteSuiteSaving] = useState(false);

  const [isRenameSuiteModalOpen, setIsRenameSuiteModalOpen] = useState(false);
  const [renameSuiteId, setRenameSuiteId] = useState<string | null>(null);
  const [renameSuiteInputValue, setRenameSuiteInputValue] = useState("");
  const [isRenamingSuite, setIsRenamingSuite] = useState(false);
  const [renameSuiteError, setRenameSuiteError] = useState("");

  const [suiteSearch, setSuiteSearch] = useState("");
  const [suiteStatusFilter, setSuiteStatusFilter] = useState("all");
  const [suitePriorityFilter, setSuitePriorityFilter] = useState("all");
  const [suiteTypeFilter, setSuiteTypeFilter] = useState("all");
  const [suiteAutomationFilter, setSuiteAutomationFilter] = useState("all");
  const [customFieldFilters, setCustomFieldFilters] = useState<CustomFieldFilterCondition[]>([]);
  const [debouncedSuiteSearch, setDebouncedSuiteSearch] = useState("");

  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isImportExportMenuOpen, setIsImportExportMenuOpen] = useState(false);
  const importExportMenuRef = useRef<HTMLDivElement>(null);
  const [importToast, setImportToast] = useState<string | null>(null);

  function showImportToast(msg: string) {
    setImportToast(msg);
    setTimeout(() => setImportToast(null), 4000);
  }

  const loadData = useCallback(async () => {
    const [suiteList, project, summary, activeCustomFields] = await Promise.all([
      listSuites(projectId),
      getProject(projectId),
      getRepositorySummary(projectId).catch(() => null),
      listCustomFieldDefinitions(projectId, { statuses: ["active"] }).catch(() => []),
    ]);
    const settings = parseProjectSettings(project.settings);
    const prefix = normalizeTestcaseIdPrefix(String(settings.testcaseIdPrefix || project.key || "TC")) || "TC";
    setSuites(suiteList);
    setProjectName(String(project.name || ""));
    setRepoSummary(summary);
    setDefaultTestcaseIdPrefix(prefix);
    setTestcaseIdPrefix(prefix);
    setCustomFieldDefinitions(activeCustomFields);
  }, [projectId]);

  useEffect(() => {
    const saved = readStoredValue("tesbo_tc_suite_panel");
    if (saved === "closed") setSuitePanelOpen(false);
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      loadData().catch(() => router.replace("/projects")).finally(() => setLoading(false));
    });
  }, [router, loadData, projectId]);

  function toggleSuitePanel() {
    setSuitePanelOpen((prev) => {
      const next = !prev;
      writeStoredValue("tesbo_tc_suite_panel", next ? "open" : "closed");
      return next;
    });
  }

  function sortSuites(list: SuiteNode[]) {
    return [...list].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }
  const rootSuites = useMemo(
    () => sortSuites(suites.filter((s) => !s.parentId)),
    [suites]
  );
  const childrenBySuiteId = useMemo(() => {
    const map = new Map<string, SuiteNode[]>();
    for (const s of suites) {
      if (!s.parentId) continue;
      map.set(s.parentId, [...(map.get(s.parentId) ?? []), s]);
    }
    for (const [key, list] of map) map.set(key, sortSuites(list));
    return map;
  }, [suites]);
  const selectedSuite = useMemo(
    () => suites.find((suite) => suite.id === activeSuiteId) ?? null,
    [suites, activeSuiteId]
  );
  const suiteNameMap = useMemo(() => {
    const byId = new Map(suites.map((s) => [s.id, s]));
    return new Map(
      suites.map((s) => {
        const parent = s.parentId ? byId.get(s.parentId) : undefined;
        return [s.id, parent ? `${parent.name} / ${s.name}` : s.name];
      })
    );
  }, [suites]);
  const selectedSuiteCases = suiteCases;
  const selectedCaseIdSet = useMemo(() => new Set(selectedCaseIds), [selectedCaseIds]);
  const areAllCasesSelected =
    selectedSuiteCases.length > 0 && selectedSuiteCases.every((tc) => selectedCaseIdSet.has(tc.id));
  // Copy-to-clipboard only has the currently loaded page to draw from — a selection made via
  // "Select all N matching" can reach beyond it, so this is the subset of the selection (or of
  // the page, with no selection) that TSV export can actually see.
  const copyableCases =
    selectedCaseIds.length > 0 ? selectedSuiteCases.filter((tc) => selectedCaseIdSet.has(tc.id)) : selectedSuiteCases;
  const copySelectionIncomplete = selectedCaseIds.length > 0 && copyableCases.length < selectedCaseIds.length;
  const testCasesTsv = useMemo(
    () =>
      toTsv(
        ["ID", "Title", "Suite", "Priority", "Type", "Automation", "Status", "Updated"],
        copyableCases.map((tc) => [
          tc.externalId || tc.id,
          tc.title,
          (tc.suiteId && suiteNameMap.get(tc.suiteId)) || "",
          tc.priority,
          tc.type,
          tc.automationStatus,
          tc.status,
          tc.updatedAt ? new Date(tc.updatedAt).toLocaleDateString() : "",
        ])
      ),
    [copyableCases, suiteNameMap]
  );
  const copyCasesLabel = selectedCaseIds.length > 0 ? `Copy ${copyableCases.length} selected` : `Copy page (${selectedSuiteCases.length})`;
  const copyCasesTitle = selectedCaseIds.length > 0
    ? copySelectionIncomplete
      ? `Copies the ${copyableCases.length} selected test cases loaded on this page as tab-separated values, ready to paste into Excel. ${selectedCaseIds.length - copyableCases.length} more selected case(s) are on other pages and won't be included.`
      : `Copies the ${copyableCases.length} selected test cases as tab-separated values, ready to paste into Excel.`
    : `Copies the ${selectedSuiteCases.length} test cases on this page as tab-separated values, ready to paste into Excel.`;
  /*
   * The sum of the suite counts, which is NOT the size of the repository.
   *
   * listSuites counts cases through `t.suite_id = s.id`, so a case with no suite (the create form's
   * default, and what import produces when no suite column is mapped) is counted by no suite row at
   * all. Only ever a fallback for before the summary lands — see repositoryTotalCount.
   */
  const suiteCaseCountSum = useMemo(
    () => suites.reduce((sum, suite) => sum + suite.testCaseCount, 0),
    [suites]
  );
  const activeFilterCount = [
    suiteSearch.trim() !== "",
    suiteStatusFilter !== "all",
    suitePriorityFilter !== "all",
    suiteTypeFilter !== "all",
    suiteAutomationFilter !== "all",
    activeJiraIssueKey !== "",
    customFieldFilters.length > 0,
  ].filter(Boolean).length;
  const totalPages = Math.max(1, Math.ceil(suiteCasesTotal / pageSize));

  const statusCount = useCallback(
    (name: string) => repoSummary?.byStatus.find((s) => s.name === name)?.count ?? 0,
    [repoSummary]
  );
  const repoStats = repoSummary
    ? {
        total: repoSummary.totalTestCases,
        draft: statusCount("Draft"),
        inReview: statusCount("In Review"),
        approved: statusCount("Approved"),
        deprecated: statusCount("Deprecated") + statusCount("Archived"),
      }
    : null;

  /*
   * The repository's true size, for every counter that claims to describe the whole repository.
   *
   * repositorySummary counts `testcases_active` for the project, so it includes cases that belong to
   * no suite; suiteCaseCountSum cannot see those at all. Basecamp 10194323432 was reported against a
   * project where the two disagreed on screen — the sidebar said 1 while the tiles said 50 with 24
   * Draft — so the Draft tile read as invented.
   */
  const repositoryTotalCount = repoStats?.total ?? suiteCaseCountSum;
  /*
   * How many cases belong to no suite, from repositorySummary's bySuite bucket — it groups on
   * COALESCE(s.name, 'Unassigned'), so the unfiled cases are already counted there and this needs no
   * extra request. Falls back to the arithmetic when the summary has not landed yet.
   */
  /*
   * Archived cases are excluded from the list by default (see listTestCases), so the screen has to say
   * so — the DEPRECATED tile still counts them, and "33 test cases" above "30 results" with no
   * explanation is exactly the count-mismatch confusion this screen has already been reported for.
   */
  const archivedCaseCount = useMemo(
    () => repoSummary?.byStatus.find((s) => s.name === "Archived")?.count ?? 0,
    [repoSummary]
  );
  const archivedHidden = archivedCaseCount > 0 && suiteStatusFilter !== "Archived";
  const unfiledCaseCount = useMemo(() => {
    const bucket = repoSummary?.bySuite.find((s) => s.name === "Unassigned");
    if (bucket) return bucket.count;
    return Math.max(0, repositoryTotalCount - suiteCaseCountSum);
  }, [repoSummary, repositoryTotalCount, suiteCaseCountSum]);

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
    suiteAutomationFilter,
    activeJiraIssueKey,
    customFieldFilters,
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
        automationStatus: suiteAutomationFilter === "all" ? undefined : suiteAutomationFilter,
        jiraIssueKey: activeJiraIssueKey || undefined,
        linearIssueKey: activeLinearIssueKey || undefined,
        search: debouncedSuiteSearch || undefined,
        customFieldFilters: buildCustomFieldFiltersQueryParam(customFieldFilters),
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
    suiteAutomationFilter,
    activeJiraIssueKey,
    activeLinearIssueKey,
    customFieldFilters,
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
    setAutomationStatus((data.automationStatus as string) ?? "Not Automated");
    setSuiteId((data.suiteId as string) ?? formSuiteId ?? "");
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
    setAutomationStatus("Not Automated");
    setSuiteId(defaultSuiteId ?? formSuiteId ?? "");
    setTestcaseIdPrefix(defaultTestcaseIdPrefix);
    setPanelJiraIssueKey("");
    setPanelJiraUrl("");
    const defaults: Record<string, unknown> = {};
    for (const def of customFieldDefinitions) {
      const fallback = getConfiguredDefaultValue(def);
      if (fallback !== undefined) defaults[def.id] = fallback;
    }
    setCustomFieldValues(defaults);
    setCustomFieldErrors({});
    setPanelCustomFields([]);
  }

  async function openCreatePanel() {
    setPanelError(null);
    setPanelTestcaseId(null);
    setPanelMode("create");
    setPanelTab("overview");
    resetForm(formSuiteId);
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
    setCustomFieldErrors({});
    try {
      const [data, customFields] = await Promise.all([
        getTestCase(projectId, testcaseId),
        getCustomFieldValues(projectId, testcaseId).catch(() => []),
      ]);
      fillFormFromTestCase(data);
      setPanelCustomFields(customFields);
      setCustomFieldValues(Object.fromEntries(customFields.map((f) => [f.id, f.value])));
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
    setCustomFieldFilters([]);
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

  // Selects every case matching the current filters, not just the ones on screen. The header
  // checkbox can only reach the loaded page, which is why bulk-editing a large suite used to
  // mean repeating the operation once per page.
  async function selectAllMatchingCases() {
    if (selectAllMatchingLoading) return;
    setSelectAllMatchingLoading(true);
    setSuiteCasesError(null);
    try {
      const ids: string[] = [];
      for (let offset = 0; offset < suiteCasesTotal; offset += MAX_PAGE_SIZE) {
        const { list } = await listTestCases(projectId, {
          limit: MAX_PAGE_SIZE,
          offset,
          suiteId: activeSuiteId ?? undefined,
          status: suiteStatusFilter === "all" ? undefined : suiteStatusFilter,
          priority: suitePriorityFilter === "all" ? undefined : suitePriorityFilter,
          type: suiteTypeFilter === "all" ? undefined : suiteTypeFilter,
          automationStatus: suiteAutomationFilter === "all" ? undefined : suiteAutomationFilter,
          jiraIssueKey: activeJiraIssueKey || undefined,
          linearIssueKey: activeLinearIssueKey || undefined,
          search: debouncedSuiteSearch || undefined,
          customFieldFilters: buildCustomFieldFiltersQueryParam(customFieldFilters),
        });
        if (!list.length) break;
        ids.push(...list.map((tc) => tc.id));
      }
      setSelectedCaseIds(ids);
    } catch (err) {
      setSuiteCasesError(err instanceof Error ? err.message : "Failed to select all matching test cases.");
    } finally {
      setSelectAllMatchingLoading(false);
    }
  }

  function openBulkActionModal() {
    if (selectedCaseIds.length === 0) return;
    setBulkAction("");
    setBulkError(null);
    setBulkTargetSuiteId("");
    /*
     * "Leave unchanged", not concrete defaults.
     *
     * Basecamp 10194318194 asked "can we move Priority and Automation Type separately". Underneath the
     * ask was data loss: these three opened pre-set to Draft / P2 / Not Automated and ALL THREE were
     * always sent, so a user who only wanted to change Priority also silently reset every selected
     * case's Status to Draft and its Automation to Not Automated. On a 25-case selection that is 50
     * fields overwritten to answer one question.
     *
     * The backend already tolerates this: bulkUpdateTestCases uses COALESCE($n, column) with
     * `body.status || null`, so an empty value leaves that column alone.
     */
    setBulkStatus(BULK_NO_CHANGE);
    setBulkPriority(BULK_NO_CHANGE);
    setBulkAutomationStatus(BULK_NO_CHANGE);
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
        // Only the fields actually chosen. Omitted keys hit COALESCE server-side and leave the column
        // as it was — see openBulkActionModal for why this matters.
        await bulkUpdateTestCases(projectId, {
          testcaseIds: selectedCaseIds,
          ...(bulkStatus !== BULK_NO_CHANGE ? { status: bulkStatus } : {}),
          ...(bulkPriority !== BULK_NO_CHANGE ? { priority: bulkPriority } : {}),
          ...(bulkAutomationStatus !== BULK_NO_CHANGE ? { automationStatus: bulkAutomationStatus } : {}),
        });
      } else if (bulkAction === "move") {
        // An empty target used to become `undefined`, which the API COALESCE'd back to each case's
        // existing suite — so "Unassigned (no suite)" reported success and moved nothing (Basecamp
        // 10194174342). UNASSIGNED_SUITE_ID is the explicit "clear it" value the API now understands.
        await bulkUpdateTestCases(projectId, {
          testcaseIds: selectedCaseIds,
          suiteId: bulkTargetSuiteId || UNASSIGNED_SUITE_ID,
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

  function openAddSuiteModal(parentId?: string) {
    setNewSuiteName("");
    setNewSuiteParentId(parentId ?? "");
    setNewSuiteNameError("");
    setIsAddSuiteModalOpen(true);
  }

  function toggleSuiteExpanded(id: string) {
    setExpandedSuiteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreateSuite() {
    if (isCreatingSuite) return;
    const nameError = validateSuiteName(newSuiteName);
    if (nameError) {
      setNewSuiteNameError(nameError);
      return;
    }
    setIsCreatingSuite(true);
    setNewSuiteNameError("");
    try {
      const created = await createSuite(projectId, { name: newSuiteName.trim(), parentId: newSuiteParentId || undefined });
      if (created.parentId) setExpandedSuiteIds((prev) => new Set(prev).add(created.parentId as string));
      setNewSuiteName("");
      setNewSuiteParentId("");
      setIsAddSuiteModalOpen(false);
      await refreshData();
    } catch (err) {
      setNewSuiteNameError(err instanceof Error ? err.message : "Failed to create suite.");
    } finally {
      setIsCreatingSuite(false);
    }
  }

  function handleRenameSuite(suiteId: string, currentName: string) {
    setRenameSuiteId(suiteId);
    setRenameSuiteInputValue(currentName);
    setRenameSuiteError("");
    setIsRenameSuiteModalOpen(true);
  }

  async function handleRenameSuiteConfirm() {
    if (!renameSuiteId || isRenamingSuite) return;
    const nameError = validateSuiteName(renameSuiteInputValue);
    if (nameError) {
      setRenameSuiteError(nameError);
      return;
    }
    setIsRenamingSuite(true);
    setRenameSuiteError("");
    try {
      await updateSuite(renameSuiteId, { name: renameSuiteInputValue.trim() });
      setIsRenameSuiteModalOpen(false);
      setRenameSuiteId(null);
      await refreshData();
    } catch (err) {
      setRenameSuiteError(err instanceof Error ? err.message : "Failed to rename suite.");
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

  async function handleUnarchivePanelTestCase() {
    if (!panelTestcaseId || panelSaving) return;
    setPanelSaving(true);
    setPanelError(null);
    try {
      await updateTestCase(projectId, panelTestcaseId, { status: "Draft" });
      await refreshData();
      await openViewPanel(panelTestcaseId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to unarchive test case.";
      setPanelError(message);
    } finally {
      setPanelSaving(false);
    }
  }

  async function handlePanelSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (panelMode !== "create" && panelMode !== "edit") return;

    // Required custom fields must be filled before the test case can be saved. Checked
    // client-side against whichever list is currently in scope — the edit-mode tab is
    // unmounted (not just hidden) when inactive, so relying on native `required` inputs
    // wouldn't catch a missing value if the user is looking at the Overview tab.
    const fieldsToValidate = panelMode === "create" ? customFieldDefinitions : panelCustomFields;
    const validationErrors = validateCustomFieldValues(fieldsToValidate, customFieldValues);
    if (Object.keys(validationErrors).length > 0) {
      setCustomFieldErrors(validationErrors);
      setPanelError("Fix the highlighted custom field errors before saving.");
      if (panelMode === "edit") setPanelTab("customFields");
      return;
    }
    setCustomFieldErrors({});

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
          automationStatus,
          testcaseIdPrefix,
          customFieldValues,
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
          automationStatus,
          customFieldValues,
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
    // Full-bleed, full-height IDE-style workspace. `tc-fullbleed` makes the wrapping
    // .tesbo-page drop its centered 1280px cap + padding, so this fills the whole
    // content region below the 3.5rem TopBar and the table scrolls internally.
    <main className="tc-fullbleed flex flex-col pb-4 pr-4 pt-4" style={{ height: "calc(100vh - 3.5rem)" }}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* This page takes over the shared TopBar: breadcrumb (start slot) + actions (end slot). */}
        {topBarStartEl &&
          createPortal(
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12px]">
              {projectName && (
                <>
                  <button
                    type="button"
                    onClick={() => router.push("/projects")}
                    className="truncate text-[var(--muted-soft)] transition-colors hover:text-[var(--accent-light)]"
                  >
                    {projectName}
                  </button>
                  <IconChevronRight size={12} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
                </>
              )}
              <span className="font-medium text-[var(--accent-light)]">Test cases</span>
            </nav>,
            topBarStartEl,
          )}
        {topBarEndEl &&
          createPortal(
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setIsImportModalOpen(true)}
                className="flex h-[30px] items-center gap-1.5 rounded-[6px] border border-[var(--ink-200)] bg-transparent px-3 text-[12px] font-medium text-[var(--ink-600)] transition-colors hover:bg-[var(--ink-100)]"
              >
                <IconDownload size={13} stroke={1.75} />
                Import
              </button>
              <div ref={importExportMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setIsImportExportMenuOpen((v) => !v)}
                  className="flex h-[30px] items-center gap-1.5 rounded-[6px] border border-[var(--ink-200)] bg-transparent px-3 text-[12px] font-medium text-[var(--ink-600)] transition-colors hover:bg-[var(--ink-100)]"
                >
                  <IconUpload size={13} stroke={1.75} />
                  Export
                  <IconChevronDown size={12} stroke={1.75} className="text-[var(--muted-soft)]" />
                </button>
                {isImportExportMenuOpen && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-elevated)]">
                    <a
                      href={getExportUrl(projectId, "csv")}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setIsImportExportMenuOpen(false)}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                    >
                      <IconUpload size={14} stroke={1.75} className="text-[var(--muted-soft)]" />
                      Export as CSV
                    </a>
                    <a
                      href={getExportUrl(projectId, "xlsx")}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setIsImportExportMenuOpen(false)}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                    >
                      <IconUpload size={14} stroke={1.75} className="text-[var(--muted-soft)]" />
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
              <button
                type="button"
                onClick={() => { void openCreatePanel(); }}
                className="flex h-[30px] items-center gap-1.5 rounded-[6px] border-0 bg-[var(--cta-primary)] px-3.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-[var(--cta-hover)]"
              >
                <IconPlus size={14} stroke={2} />
                Add test case
              </button>
            </div>,
            topBarEndEl,
          )}

        {/* Title + stats row */}
        <div className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-4 pl-4">
          <div>
            <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">
              Test case repository
            </h1>
            <p className="mt-[3px] text-[13px] text-[var(--muted-soft)]">
              {/* Counts every suite, not just the top-level ones, to agree with the "Total Suites" badge below. */}
              {repositoryTotalCount} test case{repositoryTotalCount === 1 ? "" : "s"} across {suites.length} suite{suites.length === 1 ? "" : "s"}
            </p>
          </div>
          {!loading && repoStats && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
                <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--foreground)]">{repoStats.total}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Total</div>
              </div>
              <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
                <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--status-draft-text)]">{repoStats.draft}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Draft</div>
              </div>
              <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
                <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--warning-foreground)]">{repoStats.inReview}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">In Review</div>
              </div>
              <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
                <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--status-pass-text)]">{repoStats.approved}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Approved</div>
              </div>
              <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
                <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--status-fail-text)]">{repoStats.deprecated}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Deprecated</div>
              </div>
            </div>
          )}
        </div>

        {loading ? (
          <PageLoader
            variant="inline"
            className="min-h-0 flex-1 rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]"
          />
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]">
            {/* ── Suite panel ── */}
            <aside className={`flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-[width] duration-150 ${suitePanelOpen ? "w-[260px]" : "w-[38px]"}`}>
              <nav className="flex min-h-0 flex-1 flex-col">
                {/* Header: label + add-suite + collapse toggle */}
                <div className={`flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3 ${suitePanelOpen ? "justify-between" : "justify-center"}`}>
                  {suitePanelOpen && (
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--ink-600)]">
                      <IconFolders size={14} stroke={1.75} className="text-[var(--accent-light)]" />
                      Total Suites
                      {suites.length > 0 && (
                        <span className="rounded-full bg-[var(--brand-soft)] px-1.5 py-px font-mono text-[10px] font-normal normal-case text-[var(--accent-light)]">
                          {suites.length}
                        </span>
                      )}
                    </p>
                  )}
                  <div className="flex items-center gap-0.5">
                    {suitePanelOpen && (
                      <button
                        type="button"
                        title="Add suite"
                        onClick={() => openAddSuiteModal()}
                        className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] transition-colors hover:bg-[var(--brand-soft)] hover:text-[var(--accent-light)]"
                      >
                        <IconPlus size={14} stroke={2.5} />
                      </button>
                    )}
                    <button
                      type="button"
                      title={suitePanelOpen ? "Collapse suites" : "Show suites"}
                      onClick={toggleSuitePanel}
                      className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                    >
                      {suitePanelOpen ? (
                        <IconLayoutSidebarLeftCollapse size={14} stroke={1.75} />
                      ) : (
                        <IconLayoutSidebarLeftExpand size={14} stroke={1.75} />
                      )}
                    </button>
                  </div>
                </div>

                {!suitePanelOpen ? null : (
                <>
                {/* Suite list — scrollable, all test cases + tree share one scroll region */}
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {/* All test cases */}
                  <button
                    type="button"
                    onClick={() => router.push(`/projects/${projectId}/testcases`)}
                    className={`mb-1 flex h-8 w-full items-center justify-between rounded-[6px] px-2 text-left text-[13px] transition-colors ${
                      !activeSuiteId
                        ? "bg-[var(--brand-soft)] font-medium text-[var(--accent-light)]"
                        : "text-[var(--ink-600)] hover:bg-[var(--surface-secondary)]"
                    }`}
                  >
                    <span>All test cases</span>
                    <span className={`font-mono text-[11px] ${!activeSuiteId ? "text-[var(--accent-light)] opacity-70" : "text-[var(--muted)]"}`}>
                      {repositoryTotalCount}
                    </span>
                  </button>

                  <div className="my-1.5 mx-1 h-px bg-[var(--border)]" />
                  {rootSuites.length === 0 ? (
                    <div className="px-3 py-4 text-center">
                      <p className="text-xs text-[var(--muted)]">No suites yet</p>
                      <button
                        type="button"
                        onClick={() => openAddSuiteModal()}
                        className="mt-2 text-xs text-[var(--accent-light)] hover:underline"
                      >
                        Create your first suite
                      </button>
                    </div>
                  ) : (
                    rootSuites.map((suite) => {
                      const isActive = activeSuiteId === suite.id;
                      const children = childrenBySuiteId.get(suite.id) ?? [];
                      const hasChildren = children.length > 0;
                      const isExpanded = expandedSuiteIds.has(suite.id);
                      const rollupCount =
                        suite.testCaseCount + children.reduce((sum, c) => sum + c.testCaseCount, 0);
                      return (
                        <div key={suite.id} className="mb-0.5">
                          <div
                            className={`group flex h-8 items-center gap-1 rounded-[6px] pl-1 pr-1 transition-colors ${
                              isActive ? "bg-[var(--brand-soft)]" : "hover:bg-[var(--surface-secondary)]"
                            }`}
                          >
                            {hasChildren ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleSuiteExpanded(suite.id);
                                }}
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
                              >
                                {isExpanded ? (
                                  <IconChevronDown size={13} stroke={1.75} />
                                ) : (
                                  <IconChevronRight size={13} stroke={1.75} />
                                )}
                              </button>
                            ) : (
                              <span className="w-5 shrink-0" />
                            )}
                            <IconFolders
                              size={14}
                              stroke={1.75}
                              className={`shrink-0 ${isActive ? "text-[var(--accent-light)]" : "text-[var(--muted)]"}`}
                            />
                            <button
                              type="button"
                              onClick={() =>
                                router.push(`/projects/${projectId}/testcases?suiteId=${suite.id}`)
                              }
                              className={`ml-1 min-w-0 flex-1 truncate text-left text-[12.5px] font-medium ${
                                isActive ? "text-[var(--accent-light)]" : "text-[var(--ink-600)]"
                              }`}
                            >
                              {suite.name}
                            </button>
                            {/* Count → hidden on hover, replaced by actions */}
                            <span className={`mx-1 shrink-0 font-mono text-[11px] group-hover:hidden ${isActive ? "text-[var(--accent-light)] opacity-70" : "text-[var(--muted)]"}`}>
                              {rollupCount}
                            </span>
                            {/* Actions — shown on hover instead of count */}
                            <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                              <button
                                type="button"
                                title="Add sub-suite"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openAddSuiteModal(suite.id);
                                }}
                                className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent-light)]"
                              >
                                <IconPlus size={12} stroke={2.5} />
                              </button>
                              <button
                                type="button"
                                title="Rename suite"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRenameSuite(suite.id, suite.name);
                                }}
                                className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
                              >
                                <IconPencil size={12} stroke={1.75} />
                              </button>
                              <button
                                type="button"
                                title="Delete suite"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteSuiteId(suite.id);
                                }}
                                className="mr-1 flex h-5 w-5 items-center justify-center rounded text-[var(--error-foreground)] hover:bg-[var(--surface)] hover:opacity-80"
                              >
                                <IconTrash size={12} stroke={1.75} />
                              </button>
                            </div>
                          </div>

                          {hasChildren && isExpanded && (
                            <div className="relative ml-[19px] mt-0.5 border-l border-[var(--border)] pl-2">
                              {children.map((child) => {
                                const childActive = activeSuiteId === child.id;
                                return (
                                  <div
                                    key={child.id}
                                    className={`group flex h-[30px] items-center gap-1.5 rounded-[6px] px-1.5 transition-colors ${
                                      childActive ? "bg-[var(--brand-soft)]" : "hover:bg-[var(--surface-secondary)]"
                                    }`}
                                  >
                                    <IconFileText
                                      size={13}
                                      stroke={1.75}
                                      className={`shrink-0 ${childActive ? "text-[var(--accent-light)]" : "text-[var(--muted)]"}`}
                                    />
                                    <button
                                      type="button"
                                      onClick={() =>
                                        router.push(`/projects/${projectId}/testcases?suiteId=${child.id}`)
                                      }
                                      className={`min-w-0 flex-1 truncate text-left text-[12px] font-medium ${
                                        childActive ? "text-[var(--accent-light)]" : "text-[var(--ink-600)]"
                                      }`}
                                    >
                                      {child.name}
                                    </button>
                                    <span className={`shrink-0 font-mono text-[10px] group-hover:hidden ${childActive ? "text-[var(--accent-light)] opacity-70" : "text-[var(--muted)]"}`}>
                                      {child.testCaseCount}
                                    </span>
                                    <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                                      <button
                                        type="button"
                                        title="Add test case"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void openCreatePanelForSuite(child.id);
                                        }}
                                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent-light)]"
                                      >
                                        <IconPlus size={11} stroke={2.5} />
                                      </button>
                                      <button
                                        type="button"
                                        title="Rename suite"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleRenameSuite(child.id, child.name);
                                        }}
                                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
                                      >
                                        <IconPencil size={11} stroke={1.75} />
                                      </button>
                                      <button
                                        type="button"
                                        title="Delete suite"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setDeleteSuiteId(child.id);
                                        }}
                                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--error-foreground)] hover:bg-[var(--surface)] hover:opacity-80"
                                      >
                                        <IconTrash size={11} stroke={1.75} />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}

                  {/*
                    * The cases that belong to no suite.
                    *
                    * Basecamp 10212879823 / 10212867874: cases with a null suite_id were counted by no
                    * suite row and reachable from no node, so the suite tree said 26 for a repository
                    * holding 33 and the 7 unfiled ones — Zyra had created them without naming a suite —
                    * were invisible here. Cases land unfiled routinely: the create form defaults to no
                    * suite and an import with no suite column mapped leaves it null.
                    *
                    * Rendered only when there are some, so a tidy project gains no empty node.
                    */}
                  {unfiledCaseCount > 0 && (
                    <button
                      type="button"
                      onClick={() => router.push(`/projects/${projectId}/testcases?suiteId=${UNASSIGNED_SUITE_ID}`)}
                      className={`mt-0.5 flex h-8 w-full items-center justify-between rounded-[6px] px-2 text-left text-[13px] transition-colors ${
                        isUnfiledView
                          ? "bg-[var(--brand-soft)] font-medium text-[var(--accent-light)]"
                          : "text-[var(--ink-600)] hover:bg-[var(--surface-secondary)]"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <IconFolderOff size={13} stroke={1.75} className="shrink-0 opacity-70" />
                        <span className="truncate">No suites</span>
                      </span>
                      <span className={`font-mono text-[11px] ${isUnfiledView ? "text-[var(--accent-light)] opacity-70" : "text-[var(--muted)]"}`}>
                        {unfiledCaseCount}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => openAddSuiteModal()}
                    className="mt-2 flex h-8 w-full items-center gap-1.5 rounded-[6px] border border-dashed border-[var(--border)] px-2 text-[12px] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)]"
                  >
                    <IconPlus size={13} stroke={1.75} />
                    New suite
                  </button>
                </div>
                </>
                )}
              </nav>
            </aside>

            {/* ── Main content ── */}
            <div className="flex min-w-0 flex-1 flex-col bg-[var(--surface)]">
              {/* Filter bar */}
              <div className="flex min-h-[48px] shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
                  <label className="flex h-[30px] min-w-[200px] max-w-[280px] flex-1 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[12px] text-[var(--muted-soft)] transition-colors focus-within:border-[var(--brand-primary)]">
                    <IconSearch size={13} stroke={1.75} className="shrink-0" />
                    <input
                      type="text"
                      value={suiteSearch}
                      onChange={(e) => setSuiteSearch(e.target.value)}
                      placeholder="Search by ID, title, or type"
                      className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none placeholder:text-[var(--muted-soft)]"
                    />
                    {suiteSearch && (
                      <button
                        type="button"
                        onClick={() => setSuiteSearch("")}
                        aria-label="Clear search"
                        className="shrink-0 rounded-full p-0.5 text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                      >
                        <IconX size={12} stroke={2} />
                      </button>
                    )}
                  </label>
                  {activeSuiteId && (
                    <span className="rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-[11.5px] font-medium text-[var(--accent-light)]">
                      {/* The unfiled view has no suite row to take a name from, so it names itself. */}
                      {isUnfiledView ? "No suites" : selectedSuite?.name ?? "Suite"}
                    </span>
                  )}
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    {archivedHidden && (
                      <button
                        type="button"
                        data-testid="archived-hidden-chip"
                        title="Archived test cases are not shown in this list"
                        onClick={() => setSuiteStatusFilter("Archived")}
                        className="flex items-center gap-1 rounded-full border border-[var(--border)] px-2.5 py-0.5 text-[11.5px] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)]"
                      >
                        <IconArchive size={11} stroke={1.75} />
                        {archivedCaseCount} archived hidden
                      </button>
                    )}
                    {suiteStatusFilter !== "all" && (
                      <button
                        type="button"
                        onClick={() => setSuiteStatusFilter("all")}
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] py-[3px] pl-2 pr-2.5 text-[11.5px] font-medium text-[var(--accent-light)] hover:opacity-80"
                      >
                        <span className="text-[var(--muted)]">Status:</span> {suiteStatusFilter}
                        <IconX size={11} stroke={2.5} />
                      </button>
                    )}
                    {suitePriorityFilter !== "all" && (
                      <button
                        type="button"
                        onClick={() => setSuitePriorityFilter("all")}
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] py-[3px] pl-2 pr-2.5 text-[11.5px] font-medium text-[var(--accent-light)] hover:opacity-80"
                      >
                        <span className="text-[var(--muted)]">Priority:</span> {suitePriorityFilter}
                        <IconX size={11} stroke={2.5} />
                      </button>
                    )}
                    {suiteTypeFilter !== "all" && (
                      <button
                        type="button"
                        onClick={() => setSuiteTypeFilter("all")}
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] py-[3px] pl-2 pr-2.5 text-[11.5px] font-medium text-[var(--accent-light)] hover:opacity-80"
                      >
                        <span className="text-[var(--muted)]">Type:</span> {suiteTypeFilter}
                        <IconX size={11} stroke={2.5} />
                      </button>
                    )}
                    {suiteAutomationFilter !== "all" && (
                      <button
                        type="button"
                        onClick={() => setSuiteAutomationFilter("all")}
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] py-[3px] pl-2 pr-2.5 text-[11.5px] font-medium text-[var(--accent-light)] hover:opacity-80"
                      >
                        <span className="text-[var(--muted)]">Automation:</span> {suiteAutomationFilter}
                        <IconX size={11} stroke={2.5} />
                      </button>
                    )}
                    {activeJiraIssueKey && (
                      <button
                        type="button"
                        onClick={() => router.replace(`/projects/${projectId}/testcases`)}
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--info-soft,#EEF2FF)] py-[3px] pl-2 pr-2.5 text-[11.5px] font-medium text-[var(--info-foreground,#2D3DB0)] hover:opacity-80"
                      >
                        <span className="opacity-70">Jira:</span> {activeJiraIssueKey}
                        <IconX size={11} stroke={2.5} />
                      </button>
                    )}
                    {activeLinearIssueKey && (
                      <button
                        type="button"
                        onClick={() => router.replace(`/projects/${projectId}/testcases`)}
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--info-soft,#EEF2FF)] py-[3px] pl-2 pr-2.5 text-[11.5px] font-medium text-[var(--info-foreground,#2D3DB0)] hover:opacity-80"
                      >
                        <span className="opacity-70">Linear:</span> {activeLinearIssueKey}
                        <IconX size={11} stroke={2.5} />
                      </button>
                    )}
                    <select
                      value={suiteTypeFilter}
                      onChange={(e) => setSuiteTypeFilter(e.target.value)}
                      className="h-[30px] rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[12px] text-[var(--ink-600)] outline-none"
                    >
                      <option value="all">All types</option>
                      {TESTCASE_TYPES.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                    <select
                      value={suiteStatusFilter}
                      onChange={(e) => setSuiteStatusFilter(e.target.value)}
                      className="h-[30px] rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[12px] text-[var(--ink-600)] outline-none"
                    >
                      <option value="all">All statuses</option>
                      {TESTCASE_STATUSES.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                    <select
                      value={suitePriorityFilter}
                      onChange={(e) => setSuitePriorityFilter(e.target.value)}
                      className="h-[30px] rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[12px] text-[var(--ink-600)] outline-none"
                    >
                      <option value="all">All priorities</option>
                      {TESTCASE_PRIORITIES.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                    <select
                      value={suiteAutomationFilter}
                      onChange={(e) => setSuiteAutomationFilter(e.target.value)}
                      className="h-[30px] rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[12px] text-[var(--ink-600)] outline-none"
                    >
                      <option value="all">All automation types</option>
                      {TESTCASE_AUTOMATION_TYPES.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                    <CustomFieldFilterPopover
                      definitions={customFieldDefinitions}
                      conditions={customFieldFilters}
                      onChange={setCustomFieldFilters}
                    />
                    {/* Columns control renders here (portaled from the table), as the 5th dropdown. */}
                    <div ref={setColumnsSlotEl} className="flex items-center empty:hidden" />
                    {selectedSuiteCases.length > 0 && (
                      <span title={copyCasesTitle}>
                        <CopyButton value={testCasesTsv} label={copyCasesLabel} copiedLabel="Copied" />
                      </span>
                    )}
                    {activeFilterCount > 0 && (
                      <button
                        type="button"
                        onClick={clearSuiteFilters}
                        className="flex h-[30px] shrink-0 items-center rounded-[6px] border border-[var(--ink-200)] px-3 text-[12px] font-medium text-[var(--ink-600)] hover:bg-[var(--ink-100)]"
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                </div>

                {/* Bulk action bar (when rows selected) */}
                {selectedCaseIds.length > 0 && (
                  <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-[var(--border)] bg-[var(--brand-soft)] px-4 text-[12px]">
                    <span className="font-medium text-[var(--accent-light)]">
                      {selectedCaseIds.length} selected
                    </span>
                    <div className="h-4 w-px bg-[var(--border-strong)]" />
                    <button
                      type="button"
                      onClick={openBulkActionModal}
                      className="font-medium text-[var(--accent-light)] hover:underline"
                    >
                      Bulk actions
                    </button>
                    {selectedCaseIds.length < suiteCasesTotal && (
                      <>
                        <div className="h-4 w-px bg-[var(--border-strong)]" />
                        <button
                          type="button"
                          data-testid="select-all-matching"
                          onClick={selectAllMatchingCases}
                          disabled={selectAllMatchingLoading}
                          className="font-medium text-[var(--brand-primary)] hover:underline disabled:opacity-60"
                        >
                          {selectAllMatchingLoading
                            ? "Selecting…"
                            : `Select all ${suiteCasesTotal} matching`}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedCaseIds([])}
                      className="ml-auto flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]"
                    >
                      <IconX size={12} stroke={2} />
                      Clear selection
                    </button>
                  </div>
                )}

                {/* Content */}
                {suiteCasesError ? (
                  <p className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-[var(--error-foreground)]">
                    {suiteCasesError}
                  </p>
                ) : suiteCasesLoading ? (
                  <p className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-[var(--muted)]">
                    Loading test cases...
                  </p>
                ) : suiteCasesTotal === 0 ? (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-10 text-center">
                    <p className="text-[15px] font-semibold text-[var(--foreground)]">No test cases found</p>
                    <p className="mt-2 text-[13px] text-[var(--muted)]">
                      {activeFilterCount > 0
                        ? "No test cases match your current filters."
                        : isUnfiledView
                          ? "Every test case is assigned to a suite."
                          : activeSuiteId
                            ? "This suite has no test cases yet."
                            : "No test cases in this project yet."}
                    </p>
                    <button
                      type="button"
                      onClick={() => { void openCreatePanel(); }}
                      className="mt-5 inline-flex h-[30px] items-center gap-1.5 rounded-[6px] border-0 bg-[var(--cta-primary)] px-3.5 text-[12px] font-medium text-white hover:bg-[var(--cta-hover)]"
                    >
                      <IconPlus size={14} stroke={2} />
                      Add test case
                    </button>
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col">
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
                      suitePanelOpen={suitePanelOpen}
                      columnsSlot={columnsSlotEl}
                    />

                    {/* Pagination */}
                    <div
                      data-testid="testcases-pagination"
                      className="flex h-11 shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--surface)] px-4 text-[12px]"
                    >
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
                        <select
                          data-testid="testcases-page-size"
                          value={pageSize}
                          onChange={(e) => {
                            setPageSize(Number(e.target.value));
                            setSuiteCasesPage(1);
                          }}
                          className="h-7 rounded-[5px] border border-[var(--border)] bg-[var(--background)] px-2 text-[12px] text-[var(--ink-600)] outline-none"
                        >
                          {PAGE_SIZE_OPTIONS.map((n) => (
                            <option key={n} value={n}>{n} / page</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => setSuiteCasesPage((prev) => Math.max(1, prev - 1))}
                          disabled={suiteCasesPage === 1 || suiteCasesLoading}
                          className="rounded-[5px] border border-[var(--border)] px-3 py-1 text-[12px] text-[var(--muted)] hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)] disabled:pointer-events-none disabled:opacity-50"
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setSuiteCasesPage((prev) => (prev >= totalPages ? prev : prev + 1))
                          }
                          disabled={suiteCasesPage >= totalPages || suiteCasesLoading}
                          className="rounded-[5px] border border-[var(--border)] px-3 py-1 text-[12px] text-[var(--muted)] hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)] disabled:pointer-events-none disabled:opacity-50"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  </div>
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
                    {automationStatus && <StatusChip tone={automationTone(automationStatus)}>{automationStatus}</StatusChip>}
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
                {(["overview", "steps", "customFields"] as PanelTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setPanelTab(tab)}
                    className={`-mb-px border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                      panelTab === tab
                        ? "border-[var(--brand-primary)] text-[var(--accent-light)]"
                        : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {tab === "overview"
                      ? "Overview"
                      : tab === "steps"
                      ? `Steps${steps.length > 0 ? ` (${steps.length})` : ""}`
                      : `Custom Fields${panelCustomFields.length > 0 ? ` (${panelCustomFields.length})` : ""}`}
                  </button>
                ))}
              </div>
            )}

            {/* Alerts */}
            {(panelError || panelSuccess) && (
              <div className="shrink-0 px-6 pt-3">
                {panelError && (
                  <p className="rounded-lg border border-[var(--error)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--error-foreground)]">
                    {panelError}
                  </p>
                )}
                {panelSuccess && (
                  <p className="rounded-lg border border-[var(--success)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--success-foreground)]">
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
                        <FieldLabel>Title <span className="text-[var(--error-foreground)]">*</span></FieldLabel>
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
                            {suites.map((suite) => <option key={suite.id} value={suite.id}>{suiteNameMap.get(suite.id) ?? suite.name}</option>)}
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
                          <FieldLabel>Automation Type</FieldLabel>
                          <Select value={automationStatus} onChange={(e) => setAutomationStatus(e.target.value)}>
                            {TESTCASE_AUTOMATION_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel>Estimated Duration</FieldLabel>
                          <Input type="text" value={estimatedDuration} onChange={(e) => setEstimatedDuration(e.target.value)} placeholder="e.g. 90, 45 min, or 2h 30m" />
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
                          <Button variant="secondary" size="sm" onClick={addStep} className="border-[var(--brand-primary)] text-[var(--accent-light)]">+ Add step</Button>
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
                                  <button type="button" onClick={() => removeStep(index)} className="rounded px-2 py-1 text-xs text-[var(--error-foreground)] hover:bg-[var(--surface-secondary)]">Remove</button>
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
                        <FieldLabel>Notes</FieldLabel>
                        <Textarea value={attachments} onChange={(e) => setAttachments(e.target.value)} rows={2} placeholder="Add notes, links to screenshots, logs, or reference docs" />
                      </Field>
                      {customFieldDefinitions.length > 0 && (
                        <div className="border-t border-[var(--border)] pt-5">
                          <FieldLabel>Custom Fields</FieldLabel>
                          <div className="mt-3">
                            <CustomFieldsSection
                              definitions={customFieldDefinitions}
                              values={customFieldValues}
                              errors={customFieldErrors}
                              onChange={(id, value) => setCustomFieldValues((prev) => ({ ...prev, [id]: value }))}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* EDIT MODE — tabbed content */}
                  {panelMode === "edit" && (
                    <>
                      {panelTab === "overview" && (
                        <div className="space-y-5 px-6 py-5">
                          <Field>
                            <FieldLabel>Title <span className="text-[var(--error-foreground)]">*</span></FieldLabel>
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
                                {suites.map((suite) => <option key={suite.id} value={suite.id}>{suiteNameMap.get(suite.id) ?? suite.name}</option>)}
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
                              <FieldLabel>Automation Type</FieldLabel>
                              <Select value={automationStatus} onChange={(e) => setAutomationStatus(e.target.value)}>
                                {TESTCASE_AUTOMATION_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}
                              </Select>
                            </Field>
                            <Field>
                              <FieldLabel>Estimated Duration</FieldLabel>
                              <Input type="text" value={estimatedDuration} onChange={(e) => setEstimatedDuration(e.target.value)} placeholder="e.g. 90, 45 min, or 2h 30m" />
                            </Field>
                          </div>
                          <Field>
                            <FieldLabel>Notes</FieldLabel>
                            <Textarea value={attachments} onChange={(e) => setAttachments(e.target.value)} rows={2} placeholder="Add notes, links to screenshots, logs, or reference docs" />
                          </Field>
                        </div>
                      )}
                      {panelTab === "steps" && (
                        <div className="px-6 py-5">
                          <div className="mb-4 flex items-center justify-between">
                            <p className="text-sm font-medium text-[var(--foreground)]">{steps.length} step{steps.length === 1 ? "" : "s"}</p>
                            <Button variant="secondary" size="sm" onClick={addStep} className="border-[var(--brand-primary)] text-[var(--accent-light)]">+ Add step</Button>
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
                                      <button type="button" onClick={() => removeStep(index)} className="rounded-lg px-2 py-1 text-xs text-[var(--error-foreground)] hover:bg-[var(--surface-secondary)]">Remove</button>
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
                      {panelTab === "customFields" && (
                        <div className="px-6 py-5">
                          <CustomFieldsSection
                            definitions={panelCustomFields}
                            values={customFieldValues}
                            errors={customFieldErrors}
                            onChange={(id, value) => setCustomFieldValues((prev) => ({ ...prev, [id]: value }))}
                          />
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
                      <Button type="submit" form="panel-form-global" variant="secondary" onClick={() => setSubmitAction("create-next")} disabled={panelSaving} className="border-[var(--brand-primary)] text-[var(--accent-light)]">
                        {panelSaving ? "Saving..." : "Create & Add Next"}
                      </Button>
                    )}
                    <Button variant="secondary" onClick={closePanel} disabled={panelSaving}>Cancel</Button>
                  </div>
                  {panelMode === "edit" && panelTestcaseId && (
                    <div className="flex items-center gap-2">
                      {status === "Archived" ? (
                        <Button variant="secondary" size="sm" onClick={() => void handleUnarchivePanelTestCase()} disabled={panelSaving} className="border-[var(--brand-primary)] text-[var(--accent-light)]">Unarchive</Button>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => void handleArchivePanelTestCase()} disabled={panelSaving} className="border-[var(--warning)] text-[var(--warning-foreground)]">Archive</Button>
                      )}
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
          setNewSuiteNameError("");
        }}
        title="Add suite"
      >
        <p className="text-sm text-[var(--muted)]">Create a new suite in the repository.</p>
        <Field className="mt-4">
          <FieldLabel>Suite name</FieldLabel>
          <Input
            type="text"
            value={newSuiteName}
            onChange={(e) => {
              setNewSuiteName(e.target.value);
              if (newSuiteNameError && !validateSuiteName(e.target.value)) setNewSuiteNameError("");
            }}
            placeholder="Enter suite name"
            maxLength={SUITE_NAME_MAX_LENGTH}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateSuite();
            }}
            autoFocus
          />
          {newSuiteNameError ? (
            <FieldError>{newSuiteNameError}</FieldError>
          ) : (
            newSuiteName.length >= SUITE_NAME_MAX_LENGTH && (
              <FieldHint className="text-[var(--warning-foreground)]">
                Suite name can&rsquo;t exceed {SUITE_NAME_MAX_LENGTH} characters.
              </FieldHint>
            )
          )}
        </Field>
        <Field className="mt-4">
          <FieldLabel>Parent suite</FieldLabel>
          <Select value={newSuiteParentId} onChange={(e) => setNewSuiteParentId(e.target.value)}>
            <option value="">No parent (top-level suite)</option>
            {rootSuites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              if (isCreatingSuite) return;
              setIsAddSuiteModalOpen(false);
              setNewSuiteName("");
              setNewSuiteNameError("");
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleCreateSuite()}
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
        {deleteSuiteId && (childrenBySuiteId.get(deleteSuiteId)?.length ?? 0) > 0 && (
          <p className="mt-2 rounded-lg border border-[var(--warning)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--warning-foreground)]">
            This suite has {childrenBySuiteId.get(deleteSuiteId)?.length} sub-suite
            {childrenBySuiteId.get(deleteSuiteId)?.length === 1 ? "" : "s"}. Deleting it may affect those too.
          </p>
        )}
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
            <span className="block text-sm font-medium text-[var(--error-foreground)]">Delete suite and all test cases</span>
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
            <option value="update">Update status / priority / automation type</option>
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
                <option key={s.id} value={s.id}>{suiteNameMap.get(s.id) ?? s.name}</option>
              ))}
            </Select>
          </Field>
        )}

        {bulkAction === "update" && (
          <>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>Status</FieldLabel>
              <Select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                <option value={BULK_NO_CHANGE}>Leave unchanged</option>
                {TESTCASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <Field>
              <FieldLabel>Priority</FieldLabel>
              <Select value={bulkPriority} onChange={(e) => setBulkPriority(e.target.value)}>
                <option value={BULK_NO_CHANGE}>Leave unchanged</option>
                {TESTCASE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </Field>
            <Field>
              <FieldLabel>Automation Type</FieldLabel>
              <Select value={bulkAutomationStatus} onChange={(e) => setBulkAutomationStatus(e.target.value)}>
                <option value={BULK_NO_CHANGE}>Leave unchanged</option>
                {TESTCASE_AUTOMATION_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}
              </Select>
            </Field>
          </div>
          <p className="mt-2 text-[12px] text-[var(--muted)]">
            Only the fields you change are applied — anything left on &ldquo;Leave unchanged&rdquo; keeps its
            current value on every selected test case.
          </p>
          </>
        )}

        {bulkAction === "archive" && (
          <p className="mt-4 rounded-lg border border-[var(--warning)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--warning-foreground)]">
            All selected test cases will be archived.
          </p>
        )}

        {bulkAction === "delete" && (
          <p className="mt-4 rounded-lg border border-[var(--error)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--error-foreground)]">
            This permanently deletes the selected test cases. This action cannot be undone.
          </p>
        )}

        {bulkError && (
          <p className="mt-3 rounded-lg border border-[var(--error)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--error-foreground)]">
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
          setRenameSuiteError("");
        }}
        title="Rename suite"
      >
        <Field className="mt-4">
          <FieldLabel>Suite name</FieldLabel>
          <Input
            type="text"
            value={renameSuiteInputValue}
            onChange={(e) => {
              setRenameSuiteInputValue(e.target.value);
              if (renameSuiteError && !validateSuiteName(e.target.value)) setRenameSuiteError("");
            }}
            placeholder="Enter suite name"
            maxLength={SUITE_NAME_MAX_LENGTH}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRenameSuiteConfirm();
            }}
            autoFocus
          />
          {renameSuiteError ? (
            <FieldError>{renameSuiteError}</FieldError>
          ) : (
            renameSuiteInputValue.length >= SUITE_NAME_MAX_LENGTH && (
              <FieldHint className="text-[var(--warning-foreground)]">
                Suite name can&rsquo;t exceed {SUITE_NAME_MAX_LENGTH} characters.
              </FieldHint>
            )
          )}
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              if (isRenamingSuite) return;
              setIsRenameSuiteModalOpen(false);
              setRenameSuiteId(null);
              setRenameSuiteError("");
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
        defaultSuiteId={formSuiteId || undefined}
        onImported={(result) => {
          if (result.imported > 0) {
            void loadData();
            void loadSelectedSuiteCases();
          }
          if (result.expandSuiteIds?.length) {
            setExpandedSuiteIds((prev) => new Set([...prev, ...result.expandSuiteIds!]));
          }
          showImportToast(
            result.errors.length > 0
              ? `${result.imported} of ${result.total} test case${result.total !== 1 ? "s" : ""} imported, ${result.errors.length} skipped`
              : `${result.imported} test case${result.imported !== 1 ? "s" : ""} imported successfully`
          );
        }}
      />

      {importToast && (
        <div className="fixed bottom-5 right-5 z-[60] rounded-[var(--radius-control)] bg-[var(--toast-surface)] px-4 py-2.5 text-sm text-[var(--toast-foreground)] shadow-lg">
          {importToast}
        </div>
      )}
    </main>
  );
}
