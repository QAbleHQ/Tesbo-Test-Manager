"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getTemplateUrl,
  importTestCases,
  listCustomFieldDefinitions,
  type ImportResult,
  type ImportTestCaseRow,
  type CustomFieldDefinition,
  type SuiteNode,
} from "@/lib/api";
import { validateCustomFieldValue } from "@/components/customFields/customFieldTypes";

type ImportStep = "upload" | "mapping" | "result";
type ParsedSheet = {
  name: string;
  headers: string[];
  rows: string[][];
  totalRows: number;
  headerRowIndex: number;
};

type ImportPreviewResult = {
  uploadId: string;
  sheets: ParsedSheet[];
  selectedSheetName: string;
  headers: string[];
  previewRows: string[][];
  totalRows: number;
};

const SUPPORTED_FILE_EXTENSIONS = [".csv", ".xlsx", ".xls"];
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_FILE_SIZE_LABEL = "20MB";

// Which of the four outcomes the result step is in, and the visual treatment for each. Kept as a
// static lookup rather than inline conditionals so the banner, the icon and the copy can never
// drift out of sync with each other the way the old single hardcoded "success" template did.
type ImportResultStatus = "success" | "partial" | "failure" | "empty";

const RESULT_STATUS_STYLES: Record<ImportResultStatus, { iconPath: string; containerClass: string; textClass: string }> = {
  success: {
    iconPath: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
    containerClass: "border-[var(--success-border)] bg-[var(--success-soft)]",
    textClass: "text-[var(--success-foreground)]",
  },
  partial: {
    iconPath:
      "M10.29 3.86L1.82 18a1.5 1.5 0 001.3 2.25h17.76a1.5 1.5 0 001.3-2.25L13.71 3.86a1.5 1.5 0 00-2.42 0zM12 9v4m0 3.5h.01",
    containerClass: "border-[var(--warning-border)] bg-[var(--warning-soft)]",
    textClass: "text-[var(--warning-foreground)]",
  },
  failure: {
    iconPath: "M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    containerClass: "border-[var(--error-border)] bg-[var(--error-soft)]",
    textClass: "text-[var(--error-foreground)]",
  },
  empty: {
    iconPath: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    containerClass: "border-[var(--border)] bg-[var(--surface-secondary)]",
    textClass: "text-[var(--muted)]",
  },
};

const IMPORTABLE_FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: "title", label: "Title", required: true },
  { key: "description", label: "Description" },
  { key: "preconditions", label: "Preconditions" },
  { key: "postconditions", label: "Postconditions" },
  { key: "steps", label: "Steps" },
  { key: "testData", label: "Test Data" },
  { key: "priority", label: "Priority" },
  { key: "severity", label: "Severity" },
  { key: "type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "suite", label: "Suite" },
  { key: "component", label: "Component" },
  { key: "estimatedDuration", label: "Estimated Duration" },
];

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
  // The suite the user was browsing when they opened Import, if any. This is only the *initial*
  // value of the in-modal suite picker below — it used to be sent to the server as-is, which is
  // what let an import silently land at the project root whenever the page's own notion of "open
  // suite" was unset (e.g. the user had only expanded a suite to see its children, rather than
  // clicking into it). The picker makes the target explicit and confirmable instead of ambient.
  defaultSuiteId?: string;
  // All suites in the project, for the picker, plus the same full-path label map the rest of this
  // page already uses (e.g. "Parent / Child") so the picker reads identically to the suite tree
  // and the "Add test case" form's own suite select.
  suites: SuiteNode[];
  suiteNameMap: Map<string, string>;
  // False only while the page's very first suite fetch is still in flight. The page's own Import
  // button lives in a shared top-bar slot that isn't gated by that fetch, so it can be clicked
  // before `suites` has ever been populated — without this flag, an empty `suites` array in that
  // split second would be indistinguishable from "this project truly has no suites", and the
  // stale-suite cleanup effect below would wrongly clear a real, URL-selected defaultSuiteId back
  // to root before it ever got a chance to load.
  suitesLoaded: boolean;
}

export default function ImportTestCasesModal({ projectId, open, onClose, onImported, defaultSuiteId, suites, suiteNameMap, suitesLoaded }: Props) {
  const [step, setStep] = useState<ImportStep>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [rejectedFileName, setRejectedFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [selectedSheetName, setSelectedSheetName] = useState("");
  const [mapping, setMapping] = useState<Record<string, number>>({});
  // "" means the project root. Seeded from defaultSuiteId when the modal opens (see the effect
  // below) but is otherwise the user's own explicit choice from here on — never silently
  // recomputed from the page's ambient state while the modal is open.
  const [targetSuiteId, setTargetSuiteId] = useState<string>("");
  // Captures whatever defaultSuiteId was at the moment the modal opened, without making the
  // open-effect below re-fire (and clobber the user's in-progress choice) every time the page's
  // own active-suite state happens to change while the modal is already open.
  const defaultSuiteIdRef = useRef(defaultSuiteId);
  defaultSuiteIdRef.current = defaultSuiteId;
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<CustomFieldDefinition[]>([]);
  const [customFieldMapping, setCustomFieldMapping] = useState<Record<string, number>>({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  // Collapsed by default only when there is a meaningful rollup to collapse into (see
  // hasRepeatedErrors below) — otherwise the full row-by-row table is always what's shown.
  const [showAllErrorRows, setShowAllErrorRows] = useState(false);

  const reset = useCallback(() => {
    setStep("upload");
    setFile(null);
    setUploading(false);
    setUploadError(null);
    setRejectedFileName(null);
    setPreview(null);
    setSelectedSheetName("");
    setMapping({});
    setImporting(false);
    setResult(null);
    setImportError(null);
    setDragActive(false);
    setCustomFieldMapping({});
    setShowAllErrorRows(false);
    setTargetSuiteId("");
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    // Re-seeded from whatever suite the user had open at the moment Import was clicked, but stays
    // a plain, overridable default — never sent to the server until the user confirms it (or
    // changes it) via the picker below.
    setTargetSuiteId(defaultSuiteIdRef.current ?? "");
    listCustomFieldDefinitions(projectId, { statuses: ["active"] })
      .then(setCustomFieldDefinitions)
      .catch(() => setCustomFieldDefinitions([]));
  }, [open, projectId, reset]);

  // Suites the user was browsing may since have been renamed or deleted by a teammate; re-deriving
  // the label from the live suites/suiteNameMap props (rather than freezing it at open-time) means
  // the picker never shows a stale name, and silently falls back to "no suite" if the previously
  // selected suite has disappeared entirely. Gated on suitesLoaded so the modal opened during the
  // page's initial fetch doesn't mistake "not loaded yet" for "doesn't exist".
  useEffect(() => {
    if (suitesLoaded && targetSuiteId && !suites.some((s) => s.id === targetSuiteId)) {
      setTargetSuiteId("");
    }
  }, [suites, suitesLoaded, targetSuiteId]);

  const suiteOptions = useMemo(
    () =>
      [...suites].sort((a, b) =>
        (suiteNameMap.get(a.id) ?? a.name).localeCompare(suiteNameMap.get(b.id) ?? b.name)
      ),
    [suites, suiteNameMap]
  );

  const normalizeHeader = useCallback((value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ""), []);

  const autoMap = useCallback((headers: string[]) => {
    const map: Record<string, number> = {};
    const lowerHeaders = headers.map(normalizeHeader);
    const aliases: Record<string, string[]> = {
      title: ["title", "testcasetitle", "testcase", "name", "summary", "scenario"],
      description: ["description", "desc", "details"],
      preconditions: ["preconditions", "precondition", "prerequisites", "prerequisite"],
      postconditions: ["postconditions", "postcondition"],
      steps: ["steps", "teststeps", "action", "actions"],
      testData: ["testdata", "data", "inputdata"],
      priority: ["priority", "prio"],
      severity: ["severity"],
      type: ["type", "testtype", "casetype"],
      status: ["status", "state"],
      suite: ["suite", "suitename", "folder", "foldername", "module", "modulename"],
      component: ["component", "componentname", "subfolder", "subfoldername", "feature", "area"],
      estimatedDuration: ["estimatedduration", "duration", "estimate"],
    };
    for (const field of IMPORTABLE_FIELDS) {
      const normalized = normalizeHeader(field.key);
      const labelNormalized = normalizeHeader(field.label);
      const candidates = new Set([normalized, labelNormalized, ...(aliases[field.key] || [])]);
      const idx = lowerHeaders.findIndex(
        (h) => candidates.has(h)
      );
      if (idx >= 0) map[field.key] = idx;
    }
    return map;
  }, [normalizeHeader]);

  const autoMapCustomFields = useCallback((headers: string[]) => {
    const map: Record<string, number> = {};
    const lowerHeaders = headers.map(normalizeHeader);
    for (const definition of customFieldDefinitions) {
      const candidates = new Set([normalizeHeader(definition.name), normalizeHeader(definition.key)]);
      const idx = lowerHeaders.findIndex((h) => candidates.has(h));
      if (idx >= 0) map[definition.id] = idx;
    }
    return map;
  }, [customFieldDefinitions, normalizeHeader]);

  // Coerces a raw spreadsheet cell into the shape setValuesForTestCase expects for this
  // field's type. Returns `error` (without `value`) when the cell can't be parsed, so the
  // caller can attribute a specific, field-named message to the row instead of a generic
  // "failed to import row" once it reaches the backend.
  const coerceCustomFieldImportValue = useCallback((definition: CustomFieldDefinition, raw: string): { value?: unknown; error?: string } => {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    switch (definition.fieldType) {
      case "text":
      case "long_text":
        return { value: trimmed };
      case "boolean": {
        const normalized = trimmed.toLowerCase();
        if (["yes", "true", "1"].includes(normalized)) return { value: true };
        if (["no", "false", "0"].includes(normalized)) return { value: false };
        return { error: `'${raw}' is not a valid value for ${definition.name} (expected yes/no)` };
      }
      case "number": {
        const num = Number(trimmed);
        if (!Number.isFinite(num)) return { error: `'${raw}' is not a valid number for ${definition.name}` };
        return { value: num };
      }
      case "date": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
          const parsed = new Date(trimmed);
          if (Number.isNaN(parsed.getTime())) return { error: `'${raw}' is not a valid date for ${definition.name}` };
          return { value: parsed.toISOString().slice(0, 10) };
        }
        return { value: trimmed };
      }
      case "single_select": {
        const options = definition.config.options || [];
        const match = options.find((o) => o.label.toLowerCase() === trimmed.toLowerCase());
        if (!match) return { error: `'${raw}' is not a valid option for ${definition.name}` };
        if (!match.active) return { error: `'${raw}' is an inactive option for ${definition.name}` };
        return { value: match.id };
      }
      case "multi_select": {
        const options = definition.config.options || [];
        const tokens = trimmed.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
        const ids: string[] = [];
        for (const token of tokens) {
          const match = options.find((o) => o.label.toLowerCase() === token.toLowerCase());
          if (!match || !match.active) return { error: `'${token}' is not a valid option for ${definition.name}` };
          ids.push(match.id);
        }
        return { value: ids };
      }
      default:
        return {};
    }
  }, []);

  const buildPreview = useCallback((sheets: ParsedSheet[], sheetName: string): ImportPreviewResult => {
    const selected = sheets.find((sheet) => sheet.name === sheetName) || sheets[0];
    return {
      uploadId: `${Date.now()}`,
      sheets,
      selectedSheetName: selected?.name || "",
      headers: selected?.headers || [],
      previewRows: selected?.rows.slice(0, 5) || [],
      totalRows: selected?.totalRows || 0,
    };
  }, []);

  const selectSheet = useCallback((sheetName: string, sheetsOverride?: ParsedSheet[]) => {
    const sheets = sheetsOverride || preview?.sheets || [];
    if (!sheets.length) return;
    const nextPreview = buildPreview(sheets, sheetName);
    setSelectedSheetName(nextPreview.selectedSheetName);
    setPreview(nextPreview);
    setMapping(autoMap(nextPreview.headers));
    setCustomFieldMapping(autoMapCustomFields(nextPreview.headers));
    setImportError(null);
  }, [autoMap, autoMapCustomFields, buildPreview, preview?.sheets]);

  const parseWorkbook = useCallback(async (inputFile: File): Promise<ParsedSheet[]> => {
    const XLSX = await import("xlsx");
    const buffer = await inputFile.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
    const sheets = workbook.SheetNames.map((name) => {
      const worksheet = workbook.Sheets[name];
      const rawRows = XLSX.utils.sheet_to_json<string[]>(worksheet, {
        header: 1,
        blankrows: false,
        defval: "",
        raw: false,
      });
      const rows = rawRows
        .map((row) => row.map((cell) => String(cell ?? "").trim()))
        .filter((row) => row.some(Boolean));
      const headerRowIndex = rows.findIndex((row) => row.some((cell) => {
        const normalized = normalizeHeader(cell);
        return ["title", "testcasetitle", "testcase", "summary", "name"].includes(normalized);
      }));
      const effectiveHeaderIndex = headerRowIndex >= 0 ? headerRowIndex : 0;
      const headers = (rows[effectiveHeaderIndex] || []).map((cell, index) => cell || `Column ${index + 1}`);
      const dataRows = rows.slice(effectiveHeaderIndex + 1).filter((row) => row.some(Boolean));
      return {
        name,
        headers,
        rows: dataRows,
        totalRows: dataRows.length,
        headerRowIndex: effectiveHeaderIndex,
      };
    });
    return sheets.filter((sheet) => sheet.headers.length > 0);
  }, [normalizeHeader]);

  // The <input accept> hint only filters the OS file picker — and not even reliably there (an
  // "All Files" option, a file manager that ignores it) — and drag-and-drop bypasses it entirely.
  // This is the only real gate against a PDF, image, or other unsupported file reaching the
  // XLSX parser, which otherwise fails deep in handleUpload with a confusing "Failed to parse
  // file" rather than telling the user their format isn't supported at all.
  const getFileExtension = (name: string) => {
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx).toLowerCase() : "";
  };

  const handleFileSelect = (f: File) => {
    const ext = getFileExtension(f.name);
    if (!SUPPORTED_FILE_EXTENSIONS.includes(ext)) {
      setFile(null);
      setRejectedFileName(f.name);
      setUploadError(
        ext
          ? `Unsupported file format "${ext}". Please upload a .csv, .xlsx, or .xls file.`
          : "This file type isn't supported. Please upload a .csv, .xlsx, or .xls file.",
      );
      return;
    }
    if (f.size > MAX_FILE_SIZE_BYTES) {
      setFile(null);
      setRejectedFileName(f.name);
      setUploadError(
        `File is too large (${(f.size / (1024 * 1024)).toFixed(1)}MB). Maximum allowed size is ${MAX_FILE_SIZE_LABEL}.`,
      );
      return;
    }
    setFile(f);
    setRejectedFileName(null);
    setUploadError(null);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const sheets = await parseWorkbook(file);
      if (!sheets.length) throw new Error("No readable sheets or rows were found in this file.");
      const preferredSheet = sheets.find((sheet) => autoMap(sheet.headers).title != null && sheet.totalRows > 0) || sheets[0];
      const result = buildPreview(sheets, preferredSheet.name);
      setPreview(result);
      setSelectedSheetName(result.selectedSheetName);
      setMapping(autoMap(result.headers));
      setCustomFieldMapping(autoMapCustomFields(result.headers));
      setStep("mapping");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to parse file");
    } finally {
      setUploading(false);
    }
  };

  const handleImport = async () => {
    if (!preview) return;
    if (!mapping.title && mapping.title !== 0) {
      setImportError("Title column mapping is required");
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const activeSheet = preview.sheets.find((sheet) => sheet.name === selectedSheetName) || preview.sheets[0];
      // Custom field cells are the one thing still checked here: the field types and select option
      // labels were loaded in this component to build the mapping UI, so this is the side that can
      // name the offending field in the message. Everything else — the required title, both
      // duplicate checks, suite creation and the inserts — is decided in the one request below.
      const localErrors: { row: number; message: string }[] = [];
      const rows: ImportTestCaseRow[] = [];

      for (const [index, row] of activeSheet.rows.entries()) {
        // The line the user sees in their own spreadsheet: past the header, and 1-based.
        const rowNumber = activeSheet.headerRowIndex + index + 2;
        const valueFor = (field: string) => {
          const idx = mapping[field];
          return idx != null && idx >= 0 && idx < row.length ? String(row[idx] || "").trim() : "";
        };

        const customFieldValues: Record<string, unknown> = {};
        let customFieldRowError: string | null = null;
        for (const definition of customFieldDefinitions) {
          const colIdx = customFieldMapping[definition.id];
          const raw = colIdx != null && colIdx >= 0 && colIdx < row.length ? String(row[colIdx] || "") : "";
          const { value, error } = coerceCustomFieldImportValue(definition, raw);
          if (error) {
            customFieldRowError = error;
            break;
          }
          if (value !== undefined) customFieldValues[definition.id] = value;
          const requiredError = validateCustomFieldValue(definition, value);
          if (requiredError) {
            customFieldRowError = requiredError;
            break;
          }
        }
        if (customFieldRowError) {
          localErrors.push({ row: rowNumber, message: customFieldRowError });
          continue;
        }

        const stepsText = valueFor("steps");
        const steps = stepsText
          // Each step segment may embed its expected result as "action => expected result" —
          // the same convention Tesbo's own export uses (see exportTestCases on the backend) —
          // so re-importing an exported file round-trips expected results instead of dropping them.
          ? stepsText.split(/\r?\n|(?:\s*\|\s*)/).map((part, stepIndex) => {
              const [actionPart, ...resultParts] = part.split(/\s*=>\s*/);
              return {
                stepNumber: stepIndex + 1,
                action: (actionPart || "").trim(),
                expectedResult: resultParts.join(" => ").trim(),
              };
            }).filter((step) => step.action)
          : [];

        rows.push({
          rowNumber,
          title: valueFor("title"),
          description: valueFor("description"),
          preconditions: valueFor("preconditions"),
          postconditions: valueFor("postconditions"),
          steps,
          testData: valueFor("testData"),
          priority: valueFor("priority") || "P2",
          severity: valueFor("severity") || undefined,
          type: valueFor("type") || "Functional",
          status: valueFor("status") || "Draft",
          suite: valueFor("suite"),
          component: valueFor("component") || undefined,
          estimatedDuration: valueFor("estimatedDuration") || undefined,
          customFieldValues,
        });
      }

      // Skipped rather than sent when every row was rejected above — the endpoint refuses an empty
      // batch, and there is nothing left for it to do anyway.
      const server = rows.length
        ? await importTestCases(projectId, { rows, defaultSuiteId: targetSuiteId || undefined })
        : { imported: 0, errors: [] as { row: number; message: string }[], expandSuiteIds: [] as string[] };

      const res: ImportResult = {
        imported: server.imported,
        // The file's row count, not the batch's: rows rejected here never reached the server, and
        // the result screen reads "N of M total rows in the file".
        total: activeSheet.totalRows,
        errors: [...localErrors, ...server.errors].sort((a, b) => a.row - b.row),
        expandSuiteIds: server.expandSuiteIds ?? [],
      };
      setResult(res);
      setStep("result");
      onImported(res);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : "Import failed";
      // The server re-validates the target suite at request time (it can have been deleted by a
      // teammate after the picker below loaded), and reports it with a raw field name aimed at an
      // API caller. Reframe it in terms the picker's own user actually sees.
      setImportError(
        /defaultSuiteId is not a suite/i.test(rawMessage)
          ? "The suite you selected no longer exists — it may have just been deleted. Pick another suite and try again."
          : rawMessage
      );
    } finally {
      setImporting(false);
    }
  };

  // Rebuilds the skipped rows in the file's own column layout, plus one appended column for why
  // each was rejected, so a user can fix the dozen bad rows offline instead of hunting for them
  // by row number back in the original file.
  const downloadErrorReport = () => {
    if (!result || result.errors.length === 0) return;
    const activeSheet = preview?.sheets.find((sheet) => sheet.name === selectedSheetName) ?? preview?.sheets[0];
    const fileHeaders = activeSheet?.headers ?? [];
    const escapeCsvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const headerLine = [...fileHeaders, "Import Error"].map(escapeCsvCell).join(",");
    const dataLines = result.errors.map((err) => {
      const rowIndex = activeSheet ? err.row - activeSheet.headerRowIndex - 2 : -1;
      const originalRow = activeSheet && rowIndex >= 0 ? activeSheet.rows[rowIndex] ?? [] : [];
      const cells = fileHeaders.map((_, idx) => escapeCsvCell(originalRow[idx] ?? ""));
      return [...cells, escapeCsvCell(err.message)].join(",");
    });
    const blob = new Blob([[headerLine, ...dataLines].join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "import-errors.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const updateMapping = (fieldKey: string, colIdx: number | null) => {
    setMapping((prev) => {
      const next = { ...prev };
      if (colIdx === null) {
        delete next[fieldKey];
      } else {
        next[fieldKey] = colIdx;
      }
      return next;
    });
  };

  const mappedPreviewData = useMemo(() => {
    if (!preview) return [];
    return preview.previewRows.slice(0, 3).map((row) => {
      const mapped: Record<string, string> = {};
      for (const field of IMPORTABLE_FIELDS) {
        const idx = mapping[field.key];
        mapped[field.key] = idx != null && idx >= 0 && idx < row.length ? row[idx] : "";
      }
      return mapped;
    });
  }, [preview, mapping]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFileSelect(f);
  };

  if (!open) return null;

  const isStepComplete = (candidate: ImportStep) =>
    (step === "mapping" && candidate === "upload") || (step === "result" && candidate !== "result");

  // errors.length is the source of truth for whether anything went wrong, not the row count math —
  // if the two ever disagree, trust the errors, since that's what the table below is actually showing.
  const resultStatus: ImportResultStatus = !result
    ? "success"
    : result.total === 0
      ? "empty"
      : result.errors.length === 0
        ? "success"
        : result.imported === 0
          ? "failure"
          : "partial";

  // Same message repeated across many rows (a single missing required field, most often) collapses
  // into one summary line with a count, rather than printing that sentence dozens of times.
  const errorGroups = result
    ? Array.from(
        result.errors.reduce((map, err) => {
          const rows = map.get(err.message) ?? [];
          rows.push(err.row);
          map.set(err.message, rows);
          return map;
        }, new Map<string, number[]>()),
      )
        .map(([message, rows]) => ({ message, rows }))
        .sort((a, b) => b.rows.length - a.rows.length)
    : [];
  const hasRepeatedErrors = !!result && errorGroups.length > 0 && errorGroups.length < result.errors.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay-backdrop)] backdrop-blur-sm">
      <div className="mx-4 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-overlay)] shadow-[var(--shadow-elevated)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">Import Test Cases</h2>
            <p className="text-sm text-[var(--muted)]">
              {step === "upload" && "Upload a CSV or Excel file to import test cases."}
              {step === "mapping" && "Map your file columns to test case fields."}
              {step === "result" && "Import complete."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-6 py-3">
          {(["upload", "mapping", "result"] as ImportStep[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <div className="h-px w-8 bg-[var(--border)]" />}
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium ${
                  step === s
                    ? "border-[var(--confidence-high-border)] bg-[var(--confidence-high-soft)] text-[var(--confidence-high-foreground)]"
                    : isStepComplete(s)
                      ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success-foreground)]"
                      : "border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--muted)]"
                }`}
              >
                {isStepComplete(s) ? (
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                ) : i + 1}
              </div>
              <span
                className={`text-xs font-medium ${
                  step === s
                    ? "text-[var(--confidence-high-foreground)]"
                    : isStepComplete(s)
                      ? "text-[var(--success-foreground)]"
                      : "text-[var(--muted)]"
                }`}
              >
                {s === "upload" ? "Upload" : s === "mapping" ? "Map Columns" : "Results"}
              </span>
            </div>
          ))}
        </div>

        {/* Suite target picker — visible for the whole wizard except the final result screen, so the
            destination is always explicit and confirmable rather than inferred from whichever suite
            happened to be open on the page when Import was clicked. */}
        {step !== "result" && (
          <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-6 py-3">
            <label htmlFor="import-target-suite" className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Import into suite
            </label>
            <select
              id="import-target-suite"
              value={targetSuiteId}
              disabled={!suitesLoaded || importing}
              onChange={(e) => setTargetSuiteId(e.target.value)}
              className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--foreground)] disabled:opacity-60"
            >
              <option value="">No suite (project root)</option>
              {suiteOptions.map((suite) => (
                <option key={suite.id} value={suite.id}>{suiteNameMap.get(suite.id) ?? suite.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {suitesLoaded
                ? "Rows left blank in the Suite/Component columns land directly here; rows that name their own suite or component are created as children of it."
                : "Loading suites…"}
            </p>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* ---- STEP 1: UPLOAD ---- */}
          {step === "upload" && (
            <div>
              <div
                className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition-colors ${
                  uploadError
                    ? "border-[var(--error-border)] bg-[var(--error-soft)]"
                    : dragActive
                      ? "border-[var(--confidence-high)] bg-[color-mix(in_oklab,var(--confidence-high-soft)_60%,transparent)]"
                      : "border-[var(--border-strong)] hover:border-[var(--confidence-high-border)]"
                }`}
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
              >
                <svg
                  className={`mb-3 h-10 w-10 ${uploadError ? "text-[var(--error-foreground)]" : "text-[var(--muted-soft)]"}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p
                  className={`mb-1 text-sm font-medium ${uploadError ? "text-[var(--error-foreground)]" : "text-[var(--foreground)]"}`}
                >
                  {file ? file.name : rejectedFileName || "Drop your CSV or Excel file here"}
                </p>
                <p className={`text-xs text-[var(--muted)] ${uploadError ? "mb-1" : "mb-3"}`}>
                  {file ? `${(file.size / 1024).toFixed(1)} KB` : `Supports .csv, .xlsx, and .xls files (up to ${MAX_FILE_SIZE_LABEL})`}
                </p>
                {uploadError && (
                  <p className="mb-3 text-xs font-medium text-[var(--error-foreground)]">{uploadError}</p>
                )}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--foreground)] shadow-sm transition-colors hover:bg-[var(--surface-secondary)]"
                >
                  Browse Files
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileSelect(f);
                    // Clears the picker's own value so re-selecting the same (still-invalid)
                    // file after an error fires this handler again instead of being a no-op.
                    e.target.value = "";
                  }}
                />
              </div>

              <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-3">
                <svg className="h-5 w-5 shrink-0 text-[var(--muted-soft)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="flex-1 text-xs text-[var(--muted)]">
                  Not sure about the format? Download a{" "}
                  <a href={getTemplateUrl(projectId, "csv")} className="font-medium text-[var(--confidence-high-foreground)] hover:underline" target="_blank" rel="noreferrer">
                    sample CSV
                  </a>{" "}
                  or{" "}
                  <a href={getTemplateUrl(projectId, "xlsx")} className="font-medium text-[var(--confidence-high-foreground)] hover:underline" target="_blank" rel="noreferrer">
                    sample Excel
                  </a>{" "}
                  template to get started.
                </div>
              </div>
            </div>
          )}

          {/* ---- STEP 2: MAPPING ---- */}
          {step === "mapping" && preview && (
            <div>
              <div className="mb-4 rounded-lg border border-[var(--confidence-high-border)] bg-[var(--confidence-high-soft)] px-4 py-2 text-sm text-[var(--confidence-high-foreground)]">
                {preview.totalRows} row{preview.totalRows !== 1 ? "s" : ""} found in {selectedSheetName || "your file"}. Map the columns below.
              </div>

              {preview.sheets.length > 1 && (
                <div className="mb-4">
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                    Worksheet
                  </label>
                  <select
                    value={selectedSheetName}
                    onChange={(e) => selectSheet(e.target.value)}
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)]"
                  >
                    {preview.sheets.map((sheet) => (
                      <option key={sheet.name} value={sheet.name}>
                        {sheet.name} ({sheet.totalRows} row{sheet.totalRows === 1 ? "" : "s"})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-2">
                {IMPORTABLE_FIELDS.map((field) => (
                  <div key={field.key} className="flex items-center gap-3">
                    <label className="w-40 shrink-0 text-sm font-medium text-[var(--foreground)]">
                      {field.label}
                      {field.required && <span className="ml-0.5 text-[var(--error-foreground)]">*</span>}
                    </label>
                    <select
                      value={mapping[field.key] ?? ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        updateMapping(field.key, val === "" ? null : parseInt(val, 10));
                      }}
                      className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--foreground)]"
                    >
                      <option value="">-- Skip --</option>
                      {preview.headers.map((header, idx) => (
                        <option key={idx} value={idx}>{header}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {customFieldDefinitions.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Custom Fields</p>
                  <div className="space-y-2">
                    {customFieldDefinitions.map((definition) => (
                      <div key={definition.id} className="flex items-center gap-3">
                        <label className="w-40 shrink-0 text-sm font-medium text-[var(--foreground)]">
                          {definition.name}
                          {definition.required && <span className="ml-0.5 text-[var(--error-foreground)]">*</span>}
                        </label>
                        <select
                          value={customFieldMapping[definition.id] ?? ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setCustomFieldMapping((prev) => {
                              const next = { ...prev };
                              if (val === "") delete next[definition.id];
                              else next[definition.id] = parseInt(val, 10);
                              return next;
                            });
                          }}
                          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--foreground)]"
                        >
                          <option value="">-- Skip --</option>
                          {preview.headers.map((header, idx) => (
                            <option key={idx} value={idx}>{header}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Preview table */}
              {mappedPreviewData.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Preview (first {mappedPreviewData.length} rows)</p>
                  <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                    <table className="min-w-full text-xs">
                      <thead>
                        <tr className="bg-[var(--surface-secondary)]">
                          {IMPORTABLE_FIELDS.filter((f) => mapping[f.key] != null).map((f) => (
                            <th key={f.key} className="whitespace-nowrap px-3 py-2 text-left font-medium text-[var(--muted)]">
                              {f.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {mappedPreviewData.map((row, i) => (
                          <tr key={i} className="border-t border-[var(--border-subtle)]">
                            {IMPORTABLE_FIELDS.filter((f) => mapping[f.key] != null).map((f) => (
                              <td key={f.key} className="max-w-[200px] truncate whitespace-nowrap px-3 py-1.5 text-[var(--foreground)]">
                                {row[f.key] || <span className="text-[var(--muted-soft)]">--</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {importError && (
                <div className="mt-3 rounded-lg border border-[var(--error-border)] bg-[var(--error-soft)] px-4 py-2 text-sm text-[var(--error-foreground)]">
                  {importError}
                </div>
              )}
            </div>
          )}

          {/* ---- STEP 3: RESULT ---- */}
          {step === "result" && result && (
            <div className="space-y-4">
              <div
                className={`flex items-start gap-3 rounded-xl border p-4 ${RESULT_STATUS_STYLES[resultStatus].containerClass}`}
                role={resultStatus === "failure" ? "alert" : "status"}
              >
                <svg
                  className={`h-7 w-7 shrink-0 ${RESULT_STATUS_STYLES[resultStatus].textClass}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={RESULT_STATUS_STYLES[resultStatus].iconPath} />
                </svg>
                <div className="min-w-0 flex-1">
                  <p className={`break-words font-semibold ${RESULT_STATUS_STYLES[resultStatus].textClass}`}>
                    {resultStatus === "empty" && "No rows to import"}
                    {resultStatus === "failure" && "No test cases were imported"}
                    {resultStatus === "success" && `${result.imported} test case${result.imported !== 1 ? "s" : ""} imported successfully`}
                    {resultStatus === "partial" && `${result.imported} of ${result.total} test case${result.total !== 1 ? "s" : ""} imported`}
                  </p>
                  <p className={`mt-0.5 break-words text-sm ${RESULT_STATUS_STYLES[resultStatus].textClass}`}>
                    {resultStatus === "empty" && "The file did not contain any test case rows."}
                    {resultStatus === "failure" &&
                      `All ${result.total} row${result.total !== 1 ? "s" : ""} in the file had errors. Fix the issues below and try again.`}
                    {resultStatus === "success" && `Out of ${result.total} total row${result.total !== 1 ? "s" : ""} in the file.`}
                    {resultStatus === "partial" &&
                      `${result.errors.length} row${result.errors.length !== 1 ? "s" : ""} had errors and were skipped. See the details below.`}
                  </p>
                  {resultStatus === "partial" && (
                    <div className="mt-2.5 flex h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-[var(--surface-secondary)]">
                      <div className="h-full bg-[var(--success-foreground)]" style={{ width: `${(result.imported / result.total) * 100}%` }} />
                      <div className="h-full bg-[var(--error-foreground)]" style={{ width: `${(result.errors.length / result.total) * 100}%` }} />
                    </div>
                  )}
                  {result.imported > 0 && (
                    <p className={`mt-2 text-xs ${RESULT_STATUS_STYLES[resultStatus].textClass}`}>
                      Imported into:{" "}
                      <span className="font-medium">
                        {targetSuiteId ? suiteNameMap.get(targetSuiteId) ?? "Unknown suite" : "No suite (project root)"}
                      </span>
                    </p>
                  )}
                </div>
              </div>

              {result.errors.length > 0 && (
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-[var(--foreground)]">
                      {result.errors.length} row{result.errors.length !== 1 ? "s" : ""} skipped
                    </p>
                    <button
                      type="button"
                      onClick={downloadErrorReport}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)]"
                    >
                      Download error report
                    </button>
                  </div>

                  {hasRepeatedErrors && !showAllErrorRows ? (
                    <div className="space-y-1.5 rounded-lg border border-[var(--border)] p-3">
                      {errorGroups.map((group) => (
                        <div key={group.message} className="flex items-start gap-2 text-xs">
                          <span className="mt-0.5 shrink-0 rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 font-medium text-[var(--muted)]">
                            {group.rows.length}
                          </span>
                          <span className="min-w-0 flex-1 break-words text-[var(--foreground)]">{group.message}</span>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setShowAllErrorRows(true)}
                        className="pt-1 text-xs font-medium text-[var(--confidence-high-foreground)] hover:underline"
                      >
                        Show all {result.errors.length} rows
                      </button>
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto rounded-lg border border-[var(--border)]">
                      <table className="w-full table-fixed text-xs">
                        <thead>
                          <tr className="bg-[var(--surface-secondary)]">
                            <th className="w-16 px-3 py-1.5 text-left font-medium text-[var(--muted)]">Row</th>
                            <th className="px-3 py-1.5 text-left font-medium text-[var(--muted)]">Error</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.errors.map((err, i) => (
                            <tr key={`${err.row}-${i}`} className="border-t border-[var(--border-subtle)]">
                              <td className="px-3 py-1.5 text-[var(--foreground)]">{err.row}</td>
                              <td className="break-words px-3 py-1.5 text-[var(--foreground)]">{err.message}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {hasRepeatedErrors && (
                        <div className="border-t border-[var(--border-subtle)] px-3 py-1.5">
                          <button
                            type="button"
                            onClick={() => setShowAllErrorRows(false)}
                            className="text-xs font-medium text-[var(--confidence-high-foreground)] hover:underline"
                          >
                            Collapse to summary
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] px-6 py-4">
          {step === "upload" && (
            <>
              <button type="button" onClick={onClose} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleUpload()}
                disabled={!file || uploading}
                className="rounded-lg border border-transparent bg-[var(--brand-primary)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)] disabled:opacity-50"
              >
                {uploading ? "Parsing..." : "Next"}
              </button>
            </>
          )}
          {step === "mapping" && (
            <>
              <button type="button" onClick={() => { setStep("upload"); setPreview(null); }} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]">
                Back
              </button>
              <button
                type="button"
                onClick={() => void handleImport()}
                disabled={importing || mapping.title == null}
                className="rounded-lg border border-transparent bg-[var(--brand-primary)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)] disabled:opacity-50"
              >
                {importing ? "Importing..." : `Import ${preview?.totalRows ?? 0} rows`}
              </button>
            </>
          )}
          {step === "result" && (
            <>
              {resultStatus === "failure" && (
                <button
                  type="button"
                  onClick={() => setStep("mapping")}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                >
                  Edit column mapping
                </button>
              )}
              <button type="button" onClick={onClose} className="rounded-lg border border-transparent bg-[var(--brand-primary)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]">
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
