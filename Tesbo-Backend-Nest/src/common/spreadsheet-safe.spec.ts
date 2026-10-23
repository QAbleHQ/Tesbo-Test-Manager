import * as ExcelJS from "exceljs";
import * as fs from "fs";
import * as path from "path";
import { cellValue, csvEscape, neutralizeFormula, restoreNeutralized, rowsToCsv } from "./spreadsheet-safe";

/*
 * A test case title, step or run name is typed by a project member and opened by someone else in a
 * spreadsheet. These pin that nothing a member types becomes a formula there, and that the quote we
 * add in a CSV is exactly undone on the way back in.
 */

/** A minimal RFC 4180 reader, so the assertions below do not share code with the writer under test. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

describe("neutralizeFormula", () => {
  it.each([
    ["=HYPERLINK(\"http://evil\",\"click\")"],
    ["=1+1"],
    ["+1+1"],
    ["-2+3"],
    ["@SUM(1,1)"],
    ["=cmd|' /C calc'!A0"],
    ["\t=1+1"],
    ["\r=1+1"],
    ["\t"],
    ["="],
    ["+"],
    ["-"],
    ["@"],
    ["=1\n=2"],
    ["-1 and more"],
    ["+1 (415) 555-0100"],
    ["@smoke login works"],
    ["=> expected result first"]
  ])("quotes %j so a spreadsheet shows it as text", (value) => {
    expect(neutralizeFormula(value)).toBe(`'${value}`);
  });

  it.each([
    ["Login works"],
    [""],
    [" "],
    [" =1+1"],
    ["a=b"],
    ["a+b"],
    ["email@example.com"],
    ["10m"],
    ["P1"],
    ["0"],
    ["'quoted text"],
    ["'"],
    ["''"],
    ["日本語 =x"],
    ["ＳＵＭ"],
    ["＝1+1"],
    ["​=1+1"],
    ["\n=1+1"]
  ])("leaves %j alone", (value) => {
    expect(neutralizeFormula(value)).toBe(value);
  });

  it.each(["-5", "+5", "-0.5", "+.5", "-5.", "5", "-1e3", "+1.5E-3", "-0", "007", "-007"])(
    "leaves the real number %s alone, so negatives in a numeric column stay numbers",
    (value) => {
      expect(neutralizeFormula(value)).toBe(value);
    }
  );

  it.each(["-2+3", "-5-5", "+1+1", "-1,5", "-5 apples", "--5", "-5e", "-e5", "-.", "+-5", "-5.5.5", "- 5"])(
    "still quotes %s, which is not a plain number",
    (value) => {
      expect(neutralizeFormula(value)).toBe(`'${value}`);
    }
  );

  it("quotes again when the value already begins with a quote and a trigger, so the round trip is exact", () => {
    expect(neutralizeFormula("'=x")).toBe("''=x");
    expect(neutralizeFormula("''-x")).toBe("'''-x");
  });
});

describe("restoreNeutralized", () => {
  it("strips exactly one quote, and only in front of a trigger", () => {
    expect(restoreNeutralized("'=1+1")).toBe("=1+1");
    expect(restoreNeutralized("''=1+1")).toBe("'=1+1");
    expect(restoreNeutralized("'@mention")).toBe("@mention");
    expect(restoreNeutralized("'\t=1")).toBe("\t=1");
  });

  it.each(["'quoted", "'", "''", "=1+1", "plain", "", "it's", "'5", "-5", "'abc=1"])("leaves %j alone", (value) => {
    expect(restoreNeutralized(value)).toBe(value);
  });

  it("is the exact inverse of neutralizeFormula for every value that is not a plain number", () => {
    const alphabet = ["=", "+", "-", "@", "\t", "\r", "'", "'", "a", "1", ".", " ", "e", ",", '"', "\n", "x"];
    // Deterministic, so a failure reproduces: a linear congruential generator, not Math.random.
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    let checked = 0;
    for (let n = 0; n < 20000; n++) {
      let value = "";
      const length = next() % 7;
      for (let i = 0; i < length; i++) value += alphabet[next() % alphabet.length];
      expect(restoreNeutralized(neutralizeFormula(value))).toBe(value);
      checked++;
    }
    expect(checked).toBe(20000);
  });

  it("every neutralised value starts with a quote, never with a trigger (nothing slips through)", () => {
    const triggers = ["=", "+", "-", "@", "\t", "\r"];
    for (const t of triggers) {
      for (const tail of ["", "x", "1+1", "(1)", "|cmd", "'x"]) {
        const out = neutralizeFormula(t + tail);
        if (!/^[+-]?\d/.test(out)) expect(triggers).not.toContain(out[0]);
      }
    }
  });

  it("stays in step with the copy the import screen uses", () => {
    const frontend = fs.readFileSync(path.join(__dirname, "../../../Tesbo-Frontend/lib/spreadsheet.ts"), "utf-8");
    expect(frontend).toContain("const NEUTRALIZED = /^'+[=+\\-@\\t\\r]/;");
  });
});

describe("csvEscape", () => {
  it("quotes first, then escapes, so both rules hold at once", () => {
    expect(csvEscape("=a,b")).toBe(`"'=a,b"`);
    expect(csvEscape('=say "hi"')).toBe(`"'=say ""hi"""`);
    expect(csvEscape("=1\n=2")).toBe(`"'=1\n=2"`);
    expect(csvEscape("\t=1")).toBe("'\t=1");
    expect(csvEscape("\r=1")).toBe(`"'\r=1"`);
  });

  it("writes ordinary values exactly as before", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("handles non-strings without throwing", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape(0)).toBe("0");
    expect(csvEscape(-5)).toBe("-5");
    expect(csvEscape(-0.25)).toBe("-0.25");
    expect(csvEscape(true)).toBe("true");
    expect(() => csvEscape(new Date("2026-01-02T03:04:05.000Z"))).not.toThrow();
    expect(csvEscape(["=a"])).toBe("'=a");
    expect(csvEscape({ toString: () => "=x" })).toBe("'=x");
  });
});

describe("rowsToCsv: the whole file", () => {
  const headers = ["title", "description", "steps"];

  it("neutralises hostile data in every column and keeps the row and column count intact", () => {
    const rows = [
      { title: '=HYPERLINK("http://evil","x")', description: "+1+1", steps: "@SUM(1) => ok | -2+3 => ok" },
      { title: "Normal", description: "a,b", steps: "line1\nline2" }
    ];
    const parsed = parseCsv(rowsToCsv(headers, rows));
    expect(parsed).toHaveLength(3);
    for (const line of parsed) expect(line).toHaveLength(3);
    expect(parsed[1]).toEqual(["'=HYPERLINK(\"http://evil\",\"x\")", "'+1+1", "'@SUM(1) => ok | -2+3 => ok"]);
    expect(parsed[2]).toEqual(["Normal", "a,b", "line1\nline2"]);
    // Nothing a spreadsheet would evaluate sits at the start of any cell.
    for (const line of parsed) for (const cell of line) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
  });

  it("restoreNeutralized turns every cell back into what was exported, including multi-line and quoted ones", () => {
    const original = [
      { title: "=1+1", description: "'=already quoted", steps: "-5" },
      { title: "@a,b", description: '+"x"', steps: "\t=tab" },
      { title: "plain", description: "", steps: "=\n=" }
    ];
    const parsed = parseCsv(rowsToCsv(headers, original)).slice(1);
    original.forEach((row, i) => {
      headers.forEach((h, c) => expect(restoreNeutralized(parsed[i][c])).toBe(String((row as Record<string, string>)[h])));
    });
  });

  it("escapes the header row too: a column named with a comma, quote or formula no longer breaks or arms the file", () => {
    const parsed = parseCsv(rowsToCsv(["Steps, notes", 'He said "hi"', "=cmd"], [{ "Steps, notes": "a", 'He said "hi"': "b", "=cmd": "c" }]));
    expect(parsed[0]).toEqual(["Steps, notes", 'He said "hi"', "'=cmd"]);
    expect(parsed[1]).toEqual(["a", "b", "c"]);
  });

  it("emits just the header for an empty export", () => {
    expect(rowsToCsv(["a", "b"], [])).toBe("a,b");
  });

  it("treats a missing key as an empty cell", () => {
    expect(rowsToCsv(["a", "b"], [{ a: "1" }])).toBe("a,b\n1,");
  });
});

describe("XLSX: strings are text cells a spreadsheet never evaluates, so they are written unchanged", () => {
  const HOSTILE = ['=HYPERLINK("http://evil","x")', "+1+1", "-2+3", "@SUM(1,1)", "\t=1+1", "=cmd|' /C calc'!A0"];

  async function roundTrip(values: unknown[]) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("t");
    sheet.addRow(values.map(cellValue));
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const read = new ExcelJS.Workbook();
    await read.xlsx.load(buffer as unknown as ArrayBuffer);
    return read.getWorksheet("t")!.getRow(1);
  }

  it.each(HOSTILE)("writes %j as a string cell with the same text, not a formula", async (value) => {
    const row = await roundTrip([value]);
    const cell = row.getCell(1);
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe(value);
    expect(typeof cell.value).toBe("string");
    expect(cell.formula).toBeUndefined();
  });

  it("does not let an object or array become a formula or rich-text cell", async () => {
    const row = await roundTrip([{ formula: "1+1" }, ["=1+1"], { richText: [{ text: "=x" }] }]);
    for (let c = 1; c <= 3; c++) {
      expect(row.getCell(c).type).toBe(ExcelJS.ValueType.String);
      expect(row.getCell(c).formula).toBeUndefined();
    }
  });

  it("keeps numbers, booleans and dates typed, and null empty", async () => {
    const date = new Date("2026-01-02T03:04:05.000Z");
    const row = await roundTrip([0, -5, true, date, null, undefined]);
    expect(row.getCell(1).value).toBe(0);
    expect(row.getCell(2).value).toBe(-5);
    expect(row.getCell(3).value).toBe(true);
    expect(row.getCell(4).value).toEqual(date);
    expect(row.getCell(5).value).toBeNull();
  });
});
