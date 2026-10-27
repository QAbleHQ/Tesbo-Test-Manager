import { BadRequestException } from "@nestjs/common";
import { addDays, assertDateRange, assertStartNotInPast, duePhase, formatDay, hourIn, isValidTimezone, parseDay, resolveDateChange, todayIn } from "./due-dates";

describe("parseDay", () => {
  it("treats absent, null and empty as no date", () => {
    expect(parseDay(undefined, "dueDate", "Due date")).toBeNull();
    expect(parseDay(null, "dueDate", "Due date")).toBeNull();
    expect(parseDay("", "dueDate", "Due date")).toBeNull();
  });
  it("accepts a real calendar day", () => {
    expect(parseDay("2026-10-25", "dueDate", "Due date")).toBe("2026-10-25");
    expect(parseDay("2028-02-29", "dueDate", "Due date")).toBe("2028-02-29");
  });
  it.each(["2026-02-30", "2027-02-29", "25/10/2026", "2026-1-5", "tomorrow", 20261025, {}])("refuses %p", (value) => {
    expect(() => parseDay(value, "dueDate", "Due date")).toThrow(BadRequestException);
  });
});

describe("timezone handling", () => {
  it("validates IANA names", () => {
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("America/Los_Angeles")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone(undefined)).toBe(false);
  });
  it("puts the same instant on different days in different zones", () => {
    const instant = new Date("2026-10-24T20:00:00Z");
    expect(todayIn("UTC", instant)).toBe("2026-10-24");
    expect(todayIn("Asia/Kolkata", instant)).toBe("2026-10-25");
    expect(todayIn("America/Los_Angeles", instant)).toBe("2026-10-24");
    expect(hourIn("Asia/Kolkata", instant)).toBe(1);
  });
  it("falls back to the default zone for a bad name rather than throwing", () => {
    expect(todayIn("nope", new Date("2026-10-24T20:00:00Z"))).toBe("2026-10-25");
  });
});

describe("duePhase", () => {
  const today = "2026-10-25";
  it("has no phase without a due date", () => expect(duePhase(null, today)).toBeNull());
  it("is overdue once the day has passed", () => expect(duePhase("2026-10-24", today)).toBe("overdue"));
  it("is due today on the day itself, not overdue", () => expect(duePhase("2026-10-25", today)).toBe("due_today"));
  it("is due soon one day before", () => expect(duePhase("2026-10-26", today)).toBe("due_soon"));
  it("is quiet further out", () => expect(duePhase("2026-10-27", today)).toBeNull());
  it("rolls over month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(duePhase("2027-01-01", "2026-12-31")).toBe("due_soon");
  });
});

describe("date range", () => {
  it("allows due on or after start, and either side missing", () => {
    expect(() => assertDateRange("2026-10-25", "2026-10-25")).not.toThrow();
    expect(() => assertDateRange("2026-10-25", "2026-11-01")).not.toThrow();
    expect(() => assertDateRange("2026-10-25", null)).not.toThrow();
    expect(() => assertDateRange(null, "2026-10-01")).not.toThrow();
  });
  it("refuses due before start", () => {
    expect(() => assertDateRange("2026-10-25", "2026-10-24")).toThrow(BadRequestException);
  });
});

describe("assertStartNotInPast", () => {
  it("refuses a day before today, naming the field", () => {
    expect(() => assertStartNotInPast("2026-10-24", "2026-10-25")).toThrow(BadRequestException);
    try {
      assertStartNotInPast("2026-10-24", "2026-10-25");
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({ field: "startDate" });
    }
  });
  it("allows today, a future day, and no date", () => {
    expect(() => assertStartNotInPast("2026-10-25", "2026-10-25")).not.toThrow();
    expect(() => assertStartNotInPast("2026-10-26", "2026-10-25")).not.toThrow();
    expect(() => assertStartNotInPast(null, "2026-10-25")).not.toThrow();
  });
});

describe("resolveDateChange", () => {
  const current = { startDate: "2026-10-10", dueDate: "2026-10-20" };
  const today = "2026-10-05";
  it("leaves both alone when the body names neither", () => {
    expect(resolveDateChange({ name: "x" }, current, today)).toEqual({ startDate: null, dueDate: null, clearsDueDate: false });
  });
  it("clears the due date on null or empty string", () => {
    expect(resolveDateChange({ dueDate: null }, current, today).clearsDueDate).toBe(true);
    expect(resolveDateChange({ dueDate: "" }, current, today).clearsDueDate).toBe(true);
  });
  it("checks a new due date against the stored start date", () => {
    expect(() => resolveDateChange({ dueDate: "2026-10-09" }, current, today)).toThrow(BadRequestException);
    expect(resolveDateChange({ dueDate: "2026-10-10" }, current, today).dueDate).toBe("2026-10-10");
  });
  it("checks a new start date against the stored due date", () => {
    expect(() => resolveDateChange({ startDate: "2026-10-21" }, current, today)).toThrow(BadRequestException);
  });
  it("lets both move together even when each alone would cross the stored other", () => {
    expect(resolveDateChange({ startDate: "2026-11-01", dueDate: "2026-11-05" }, current, today)).toEqual({ startDate: "2026-11-01", dueDate: "2026-11-05", clearsDueDate: false });
  });
  it("lets a start date move past a due date that is being cleared in the same call", () => {
    expect(() => resolveDateChange({ startDate: "2026-12-01", dueDate: null }, current, today)).not.toThrow();
  });
  it("refuses removing the start date", () => {
    expect(() => resolveDateChange({ startDate: null }, current, today)).toThrow(BadRequestException);
    expect(() => resolveDateChange({ startDate: "" }, current, today)).toThrow(BadRequestException);
  });
  it("refuses moving the start to a day before today", () => {
    expect(() => resolveDateChange({ startDate: "2026-10-04" }, current, today)).toThrow(BadRequestException);
    expect(() => resolveDateChange({ startDate: "2026-10-04", dueDate: "2026-10-30" }, current, today)).toThrow(BadRequestException);
  });
  it("accepts a start of today or later", () => {
    expect(resolveDateChange({ startDate: "2026-10-05" }, current, today).startDate).toBe("2026-10-05");
    expect(resolveDateChange({ startDate: "2026-10-06" }, current, today).startDate).toBe("2026-10-06");
  });
  it("lets an already-started row re-send its own past start, and refuses a different past one", () => {
    const started = { startDate: "2026-09-01", dueDate: "2026-10-20" };
    expect(resolveDateChange({ startDate: "2026-09-01", dueDate: "2026-10-25" }, started, today).startDate).toBe("2026-09-01");
    expect(() => resolveDateChange({ startDate: "2026-09-02" }, started, today)).toThrow(BadRequestException);
  });
  it("does not range-check a legacy row with no start date", () => {
    expect(() => resolveDateChange({ dueDate: "2020-01-01" }, { startDate: null, dueDate: null }, today)).not.toThrow();
  });
});

describe("formatDay", () => {
  it("renders DD Mon YYYY", () => {
    expect(formatDay("2026-10-05")).toBe("05 Oct 2026");
  });
});
