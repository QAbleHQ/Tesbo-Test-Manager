"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  previewImport,
  executeImport,
  getTemplateUrl,
  type ImportPreviewResult,
  type ImportResult,
} from "@/lib/api";

type ImportStep = "upload" | "mapping" | "result";

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
  { key: "automationStatus", label: "Automation Status" },
  { key: "status", label: "Status" },
  { key: "suite", label: "Suite" },
  { key: "component", label: "Component" },
  { key: "estimatedDuration", label: "Estimated Duration" },
];

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

export default function ImportTestCasesModal({ projectId, open, onClose, onImported }: Props) {
  const [step, setStep] = useState<ImportStep>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const reset = useCallback(() => {
    setStep("upload");
    setFile(null);
    setUploading(false);
    setUploadError(null);
    setPreview(null);
    setMapping({});
    setImporting(false);
    setResult(null);
    setImportError(null);
    setDragActive(false);
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const autoMap = useCallback((headers: string[]) => {
    const map: Record<string, number> = {};
    const lowerHeaders = headers.map((h) => h.toLowerCase().replace(/[_\s-]+/g, ""));
    for (const field of IMPORTABLE_FIELDS) {
      const normalized = field.key.toLowerCase();
      const labelNormalized = field.label.toLowerCase().replace(/[_\s-]+/g, "");
      const idx = lowerHeaders.findIndex(
        (h) => h === normalized || h === labelNormalized
      );
      if (idx >= 0) map[field.key] = idx;
    }
    return map;
  }, []);

  const handleFileSelect = (f: File) => {
    setFile(f);
    setUploadError(null);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const result = await previewImport(projectId, file);
      setPreview(result);
      setMapping(autoMap(result.headers));
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
      const res = await executeImport(projectId, {
        uploadId: preview.uploadId,
        columnMapping: mapping,
      });
      setResult(res);
      setStep("result");
      if (res.imported > 0) onImported();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* ---- STEP 1: UPLOAD ---- */}
          {step === "upload" && (
            <div>
              <div
                className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition-colors ${
                  dragActive
                    ? "border-[var(--confidence-high)] bg-[color-mix(in_oklab,var(--confidence-high-soft)_60%,transparent)]"
                    : "border-[var(--border-strong)] hover:border-[var(--confidence-high-border)]"
                }`}
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
              >
                <svg className="mb-3 h-10 w-10 text-[var(--muted-soft)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="mb-1 text-sm font-medium text-[var(--foreground)]">
                  {file ? file.name : "Drop your CSV or Excel file here"}
                </p>
                <p className="mb-3 text-xs text-[var(--muted)]">
                  {file ? `${(file.size / 1024).toFixed(1)} KB` : "Supports .csv, .xlsx, and .xls files"}
                </p>
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
                  }}
                />
              </div>

              {uploadError && (
                <div className="mt-3 rounded-lg border border-[var(--error-border)] bg-[var(--error-soft)] px-4 py-2 text-sm text-[var(--error-foreground)]">
                  {uploadError}
                </div>
              )}

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
                {preview.totalRows} row{preview.totalRows !== 1 ? "s" : ""} found in your file. Map the columns below.
              </div>

              <div className="space-y-2">
                {IMPORTABLE_FIELDS.map((field) => (
                  <div key={field.key} className="flex items-center gap-3">
                    <label className="w-40 shrink-0 text-sm font-medium text-[var(--foreground)]">
                      {field.label}
                      {field.required && <span className="ml-0.5 text-[var(--error)]">*</span>}
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
              <div className="flex items-center gap-3 rounded-xl border border-[var(--success-border)] bg-[var(--success-soft)] p-4">
                <svg className="h-8 w-8 shrink-0 text-[var(--success)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="font-semibold text-[var(--success-foreground)]">
                    {result.imported} test case{result.imported !== 1 ? "s" : ""} imported successfully
                  </p>
                  <p className="text-sm text-[var(--success)]">
                    Out of {result.total} total rows in the file.
                  </p>
                </div>
              </div>

              {result.errors.length > 0 && (
                <div>
                  <p className="mb-2 text-sm font-medium text-[var(--error-foreground)]">
                    {result.errors.length} row{result.errors.length !== 1 ? "s" : ""} had errors:
                  </p>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-[var(--error-border)]">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-[var(--error-soft)]">
                          <th className="px-3 py-1.5 text-left font-medium text-[var(--error-foreground)]">Row</th>
                          <th className="px-3 py-1.5 text-left font-medium text-[var(--error-foreground)]">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.errors.map((err, i) => (
                          <tr key={i} className="border-t border-[var(--error-border)]">
                            <td className="px-3 py-1.5 text-[var(--error)]">{err.row}</td>
                            <td className="px-3 py-1.5 text-[var(--error)]">{err.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
            <button type="button" onClick={onClose} className="rounded-lg border border-transparent bg-[var(--brand-primary)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)]">
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
