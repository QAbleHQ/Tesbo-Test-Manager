import { applyEdit, buildProductDocument, DOC_KINDS, isDocKind, kbTitle, renderDocument, sameFinding } from "./nyra-review";

const workflow = { title: "Sign in", data: { goal: "Get in", steps: ["Open /login", "Submit"], screens: ["/login"], status: "inferred" } };

describe("applyEdit", () => {
  it("replaces only the editable fields and keeps what is NYRA's", () => {
    const out = applyEdit("workflow", workflow, {
      title: "  Log in  ",
      data: { goal: "Reach the dashboard", steps: [" Open /login ", "", "Submit"], screens: ["/hijacked"], url: "x" }
    });
    expect(out.title).toBe("Log in");
    expect(out.data).toMatchObject({ goal: "Reach the dashboard", steps: ["Open /login", "Submit"], screens: ["/login"], status: "inferred" });
    expect(out.data).not.toHaveProperty("url");
  });

  it("keeps the title when none is sent, and reports no change for an identical edit", () => {
    const out = applyEdit("workflow", workflow, { data: { goal: "Get in" } });
    expect(sameFinding(out, workflow)).toBe(true);
  });

  it("lets a kind with no editable fields change its title only", () => {
    const form = { title: "Sign in", data: { method: "post", fields: [] } };
    expect(applyEdit("form", form, { title: "Login form", data: { method: "get" } })).toEqual({ title: "Login form", data: form.data });
  });

  it.each([
    ["a blank title", { title: "   " }],
    ["a non-string title", { title: 7 }],
    ["a title over 300 characters", { title: "t".repeat(301) }],
    ["text that is not text", { data: { goal: 5 } }],
    ["steps that are not a list", { data: { steps: "Open" } }],
    ["a step that is not text", { data: { steps: [1] } }],
    ["more than 50 steps", { data: { steps: Array.from({ length: 51 }, () => "x") } }],
    ["a step over 1000 characters", { data: { steps: ["s".repeat(1001)] } }],
    ["text over 2000 characters", { data: { goal: "e".repeat(2001) } }]
  ])("rejects %s", (_label, edit) => {
    expect(() => applyEdit("workflow", workflow, edit)).toThrow();
  });
});

describe("what is reviewed", () => {
  it("is the product-understanding kinds and the appendix, not QA data", () => {
    expect([...DOC_KINDS].sort()).toEqual(["business_rule", "feature", "form", "screen", "tech", "workflow"]);
    for (const kind of ["test_case", "api_call", "issue", "page", 7, undefined]) expect(isDocKind(kind)).toBe(false);
  });
});

const item = (kind: string, title: string, data: Record<string, any> = {}) => ({ kind: kind as any, title, data });

const FULL = [
  item("screen", "Dashboard", { url_pattern: "/dashboard", purpose: "See status", headings: ["Dashboard", "Overview"] }),
  item("feature", "Theme switcher", { module: "Global UI", description: "Light or dark", screens: ["/dashboard"] }),
  item("feature", "Create project", { module: "Projects", description: "Add a project", screens: ["/projects"] }),
  item("feature", "Search", { description: "No module given" }),
  item("workflow", "Create project", { goal: "Add a project", steps: ["Open /projects", "Click Create"], screens: ["/projects"] }),
  item("business_rule", "Names are at most 255 characters", { category: "validation", confidence: "verified", explanation: "maxlength=255", screens: ["/settings"] }),
  item("form", "Login", { method: "post", action: "/api/login", fields: [{ label: "Email", required: true }, { name: "pw" }] }),
  item("tech", "Technical profile", { frameworks: { next: "15" }, missing_security_headers: ["csp"] })
];

describe("buildProductDocument", () => {
  const doc = buildProductDocument("Shop", { appUrl: "https://shop.example" }, FULL);
  const { text, html } = renderDocument(doc);

  it("is titled for the project and counts what it holds", () => {
    expect(doc.title).toBe("NYRA · Shop · Product knowledge");
    expect(kbTitle("Shop")).toBe(doc.title);
    expect(doc.counts).toMatchObject({ screen: 1, feature: 3, workflow: 1, business_rule: 1, form: 1, tech: 1 });
    expect(text).toContain("https://shop.example");
  });

  it("tells the product story in order: overview, features, journeys, screens, rules, then the appendix", () => {
    const at = (s: string) => text.indexOf(`## ${s}`);
    const order = ["Overview", "Features", "Journeys", "Screens", "Business rules", "Appendix: forms", "Appendix: technical profile"].map(at);
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("groups features by module, and puts those with none under General", () => {
    expect(text).toContain("### Global UI");
    expect(text).toContain("### Projects");
    expect(text).toContain("### General");
    expect(text.indexOf("### Projects")).toBeLessThan(text.indexOf("### General"));
  });

  it("groups business rules by category and keeps each rule's reason and confidence", () => {
    expect(text).toContain("### Validation");
    expect(text).toContain("Why: maxlength=255");
    expect(text).toContain("Confidence: verified");
  });

  it("writes journeys with numbered steps, and forms with required fields marked", () => {
    expect(text).toContain("Steps:\n1. Open /projects\n2. Click Create");
    expect(text).toContain("Fields: Email (required), pw");
  });

  it("leaves out a section that has nothing in it", () => {
    const small = renderDocument(buildProductDocument("Shop", {}, [item("screen", "Home", { url_pattern: "/" })]));
    expect(small.text).toContain("## Screens");
    for (const gone of ["## Features", "## Journeys", "## Business rules", "## Appendix"]) expect(small.text).not.toContain(gone);
  });

  it("is the same document whatever order the findings arrive in", () => {
    const reversed = renderDocument(buildProductDocument("Shop", { appUrl: "https://shop.example" }, [...FULL].reverse()));
    expect(reversed.text).toBe(text);
    expect(reversed.html).toBe(html);
  });

  it("escapes everything a scanned site could put in a finding, in the HTML", () => {
    const out = renderDocument(
      buildProductDocument("Shop <b>", { appUrl: "https://x/?a=1&b=2" }, [item("feature", "<script>alert(1)</script>", { module: "A&B", description: '"quoted"' })])
    );
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out.html).toContain("A&amp;B");
    expect(out.html).toContain("Shop &lt;b&gt;");
    expect(out.html).not.toMatch(/<b>/);
    expect(out.text).toContain("<script>alert(1)</script>");
  });

  it("does not invent facts for a finding with no data", () => {
    const out = renderDocument(buildProductDocument("Shop", {}, [item("business_rule", "Rule")]));
    expect(out.text).toContain("#### Rule");
    expect(out.text).not.toContain("Why:");
  });

  it("clips a very long value, and says it did", () => {
    const long = buildProductDocument("Shop", {}, [item("screen", "Home", { purpose: "p".repeat(5000) })]);
    expect(long.clipped).toBe(true);
    expect(renderDocument(long).text.length).toBeLessThan(3000);
    expect(doc.clipped).toBe(false);
  });

  it("copes with odd shapes NYRA might send", () => {
    const odd = buildProductDocument("Shop", { appUrl: null }, [
      item("workflow", "W", { steps: "not a list", screens: null, goal: 7 }),
      item("form", "F", { fields: "none" }),
      item("tech", "T", { frameworks: null, missing_security_headers: "csp" })
    ]);
    expect(() => renderDocument(odd)).not.toThrow();
  });
});

describe("kbTitle", () => {
  it("stays within the document title limit", () => {
    expect(kbTitle("x".repeat(600)).length).toBe(512);
  });
});
