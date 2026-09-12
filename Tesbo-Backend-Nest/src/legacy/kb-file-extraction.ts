import ExcelJS from "exceljs";
import pdfParse from "pdf-parse";
import * as mammoth from "mammoth";

export type HeavyExtractableExt = "xlsx" | "pdf" | "docx";

// Moved out of LegacyService verbatim, alongside the extraction logic that's its only caller — see
// LegacyService.extractKnowledgeFileText's own comment for why full column count (not just the
// cells that exist) matters here: a row with a gap in the middle would otherwise shift every later
// column one to the left.
function worksheetToCsv(sheet: ExcelJS.Worksheet): string {
  const lines: string[] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    for (let column = 1; column <= sheet.columnCount; column += 1) {
      // `.text` flattens every shape a cell value can take - rich text, a hyperlink, a formula's
      // cached result, a date - into the string a reader would see in Excel.
      const text = row.getCell(column).text ?? "";
      cells.push(/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    lines.push(cells.join(","));
  });
  return lines.join("\n");
}

/**
 * The CPU/WASM-bound half of knowledge-base upload text extraction (XLSX/PDF/DOCX) - the three
 * formats that used to run synchronously on the main event loop inside the upload request, blocking
 * every other concurrent request on the process, not just the uploader's own.
 *
 * A plain, side-effect-free function so it behaves identically whichever thread runs it: the same
 * code executes inline (KbExtractionRunnerService's fallback path) and inside the worker_threads
 * entry point (kb-file-extraction.worker.ts) - there is exactly one implementation to keep in sync,
 * never two that could drift.
 *
 * Deliberately does NOT handle plain-text extensions (a trivial buffer.toString slice, not worth a
 * worker round trip) or image OCR (LegacyService.ocrImageText already runs inside its own
 * tesseract.js worker and is out of scope for this change).
 */
export async function extractHeavyKnowledgeFileText(buffer: Buffer, ext: HeavyExtractableExt, textLimit: number): Promise<string> {
  if (ext === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    // See LegacyService's original comment: exceljs's own .d.ts shadows Buffer with an incompatible
    // local stub, so `any` is required here, not a shortcut around real type safety.
    await workbook.xlsx.load(buffer as any);
    const text = workbook.worksheets.map((sheet) => `Sheet: ${sheet.name}\n${worksheetToCsv(sheet)}`).join("\n\n");
    return text.slice(0, textLimit);
  }
  if (ext === "pdf") {
    const data = await pdfParse(buffer);
    return String(data.text || "").slice(0, textLimit);
  }
  const result = await mammoth.extractRawText({ buffer });
  return String(result.value || "").slice(0, textLimit);
}
