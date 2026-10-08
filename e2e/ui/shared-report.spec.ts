import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from "@playwright/test";
import { env } from "../utils/env";
import { dbControlAvailable } from "../utils/psql";
import { addRunCases, listRunExecutions, purgeProject, seedProject, seedRun, seedTestCase, setExecutionResults } from "../utils/seed";

/*
 * The public shared-run report at /share/<token> — Tesbo-Frontend/app/share/[token]/page.tsx.
 *
 * Its own file rather than an addition to ui/executions.spec.ts because this route is the one screen
 * in the product that must render for a caller with NO session at all. playwright.config.ts hands
 * every ui test the smoke account's storageState, so the anonymity that IS the feature here has to
 * be arranged at file scope, and doing that inside an authenticated spec file would silently log the
 * rest of its tests out.
 *
 * Regression origin (Basecamp 10194584390, BetterBugs 6a7c37ed348f2acda5cd1fdf, reported against a
 * 15-case run): DonutChart paired `strokeDasharray = "${pct*C} ${C}"` with
 * `strokeDashoffset = C - cumulative*C`. That offset only lands a segment at `cumulative` when the
 * dash pattern's period equals C, and `pct*C + C` does not — so every segment rendered shifted
 * forward by its own length. The reported run painted nothing from 12 o'clock to ~4:30 ("displays as
 * a half circle"), drew Failed and Skipped on top of each other ("results overlap"), and dropped
 * Pending entirely, its dash landing past the end of the path.
 *
 * SRP-01 is the regression test and fails against that code on all three counts.
 *
 * The assertions sample what is actually PAINTED on the ring with elementFromPoint rather than
 * reading stroke-dasharray back out. Parsing the attributes would only re-state whichever formula
 * the component happens to use, and would go green again for any future rewrite that is
 * self-consistent but still leaves a hole in the ring. Colour under the cursor at a given angle is
 * the thing the reporter saw.
 */

const STATE_PATH = path.join(__dirname, "../.auth/state.json");
const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

// The share link is deliberately unauthenticated — that is what a share link is for. An empty
// storageState (not the config's smoke session) is therefore part of what these tests assert.
test.use({ storageState: { cookies: [], origins: [] } });

/** The five buckets the page charts, in the order DonutChart receives them, with their colours. */
const BUCKETS = [
  { label: "Passed", color: "#22c55e", status: "Passed" },
  { label: "Failed", color: "#ef4444", status: "Failed" },
  { label: "Skipped", color: "#eab308", status: "Skipped" },
  { label: "Blocked", color: "#f97316", status: "Blocked" },
  // page.tsx counts Untested and Retest together as "Pending". Untested is what adding a case to a
  // run produces, so it needs no result recorded at all.
  { label: "Pending", color: "#a1a1aa", status: "Untested" },
] as const;

type BucketLabel = (typeof BUCKETS)[number]["label"];

interface SharedRun {
  projectId: string;
  cycleId: string;
  token: string;
  total: number;
}

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
});

test.afterAll(async () => {
  await api?.dispose();
});

test.beforeEach(() => {
  // setExecutionResults writes results straight to Postgres: PATCH stamps executed_at = now() and
  // these fixtures need a specific status mix, not a specific time. No DB control, no fixture.
  test.skip(!dbControlAvailable(), "needs psql access to the .env database to arrange result mixes");
});

function stamp(label: string): string {
  return `E2E SharedReport ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

/**
 * A shared run holding exactly `counts` executions per bucket, in its own project.
 *
 * Its own project every time: the donut's arcs are proportions of the run's total, so a case another
 * spec seeds into a project this one is counting would change the expected angles mid-assertion, and
 * spec files run concurrently across workers.
 */
async function seedSharedRun(counts: Partial<Record<BucketLabel, number>>): Promise<SharedRun> {
  const projectId = await seedProject(api, stamp("project"));
  // Completed is applied after the cases are added: the API refuses to complete a run with none.
  const run = await seedRun(api, projectId, { name: stamp("run") });

  const wanted: { status: string; label: BucketLabel }[] = [];
  for (const bucket of BUCKETS) {
    for (let i = 0; i < (counts[bucket.label] ?? 0); i++) {
      wanted.push({ status: bucket.status, label: bucket.label });
    }
  }

  if (wanted.length > 0) {
    const caseIds: string[] = [];
    for (const [i, want] of wanted.entries()) {
      caseIds.push((await seedTestCase(api, projectId, { title: stamp(`${want.label} ${i + 1}`) })).id);
    }
    await addRunCases(api, run.id, caseIds);

    // Adding a case creates its execution Untested, so the Pending bucket is already correct and
    // only the other four need a result written.
    const executions = await listRunExecutions(api, run.id);
    const byCase = new Map(executions.map((e) => [e.testcaseId, e.id]));
    const results = wanted
      .map((want, i) => ({ executionId: byCase.get(caseIds[i])!, status: want.status }))
      .filter((r) => r.executionId && r.status !== "Untested");
    setExecutionResults(results);

    const completed = await api.patch(`/api/cycles/${run.id}`, { data: { status: "Completed" }, failOnStatusCode: false });
    expect(completed.ok(), `completing the run — ${await completed.text()}`).toBeTruthy();
  }

  const shared = await api.post(`/api/cycles/${run.id}/share`, { data: { enabled: true }, failOnStatusCode: false });
  expect(shared.status(), `enabling sharing — ${await shared.text()}`).toBeLessThan(400);
  const token = (await shared.json()).shareToken;
  expect(token, "sharing produced no token").toBeTruthy();

  return { projectId, cycleId: run.id, token, total: wanted.length };
}

async function tearDown(seeded: SharedRun | null): Promise<void> {
  if (!seeded) return;
  await api.post(`/api/cycles/${seeded.cycleId}/share`, { data: { enabled: false }, failOnStatusCode: false });
  purgeProject(seeded.projectId);
}

/** Waits for the report body — the page fetches run + executions client-side before it can chart. */
async function openReport(page: Page, token: string): Promise<void> {
  await page.goto(`/share/${token}`);
  await expect(page.getByText("Shared Test Run Report")).toBeVisible();
  await expect(page.locator("svg circle[stroke-dasharray]").first()).toBeVisible();
}

const SAMPLES = 360;

/**
 * Walks the ring one degree at a time and reports the bucket painted at each angle.
 *
 * Hit-testing rather than geometry maths: `fill="none"` with a stroke makes the default
 * `pointer-events: visiblePainted` hit only the stroked band, so elementFromPoint at a point on the
 * ring returns the segment whose paint is on top there — exactly what the eye reports. An arc drawn
 * over another therefore costs the lower one samples, and a hole returns no segment at all.
 *
 * Index 0 is 12 o'clock and the walk is clockwise, matching the component's `rotate(-90 18 18)`.
 */
async function sampleRing(page: Page): Promise<(BucketLabel | null)[]> {
  const colours = Object.fromEntries(BUCKETS.map((b) => [b.color, b.label]));
  const raw = await page.evaluate(
    ({ samples }) => {
      const first = document.querySelector("svg circle[stroke-dasharray]");
      if (!first) return null;
      const svg = first.closest("svg")!;
      const box = svg.getBoundingClientRect();
      // viewBox is "0 0 36 36" with the ring at cx/cy 18, r 15.915 — convert to screen px.
      const scale = box.width / 36;
      const cx = box.left + 18 * scale;
      const cy = box.top + 18 * scale;
      const r = 15.915 * scale;

      const out: (string | null)[] = [];
      for (let i = 0; i < samples; i++) {
        const turn = (i / samples) * 2 * Math.PI;
        const x = cx + r * Math.sin(turn);
        const y = cy - r * Math.cos(turn);
        const hit = document.elementFromPoint(x, y);
        const stroke = hit && hit.tagName.toLowerCase() === "circle" ? hit.getAttribute("stroke") : null;
        out.push(stroke);
      }
      return out;
    },
    { samples: SAMPLES },
  );

  expect(raw, "no donut segment was rendered at all").not.toBeNull();
  // The track circle behind the "No data" state is #e4e4e7 and is not one of the five buckets, so it
  // maps to null here the same way a hole does.
  return raw!.map((stroke) => (stroke && colours[stroke] ? (colours[stroke] as BucketLabel) : null));
}

/** How many samples each bucket won, and where the colour changes going clockwise. */
function describeRing(ring: (BucketLabel | null)[]) {
  const spans = new Map<BucketLabel | null, number>();
  for (const s of ring) spans.set(s, (spans.get(s) ?? 0) + 1);

  const runs: { bucket: BucketLabel | null; length: number }[] = [];
  for (const s of ring) {
    const last = runs[runs.length - 1];
    if (last && last.bucket === s) last.length++;
    else runs.push({ bucket: s, length: 1 });
  }
  // The ring is a loop: a bucket straddling 12 o'clock would otherwise read as two runs.
  if (runs.length > 1 && runs[0].bucket === runs[runs.length - 1].bucket) {
    runs[0].length += runs.pop()!.length;
  }
  return { spans, runs };
}

test.describe("public shared run report", () => {
  test("SRP-01 the donut closes the full ring, one arc per bucket, sized to its share", { tag: '@tesbo.testId("TES-TC-1067")' }, async ({ page }) => {
    // The reported mix: 15 cases as 6 Passed / 2 Failed / 1 Skipped / 2 Blocked / 4 Pending.
    const counts = { Passed: 6, Failed: 2, Skipped: 1, Blocked: 2, Pending: 4 } as const;
    let seeded: SharedRun | null = null;
    try {
      seeded = await seedSharedRun(counts);
      await openReport(page, seeded.token);

      const ring = await sampleRing(page);
      const { spans, runs } = describeRing(ring);

      // 1. No hole. This is the "half circle": the unfixed code left 0%–40% unpainted.
      const unpainted = ring.filter((s) => s === null).length;
      expect(
        unpainted,
        `${unpainted} of ${SAMPLES} points on the ring are unpainted — the donut does not close`,
      ).toBe(0);

      // 2. Every non-zero bucket is actually drawn. Pending vanished entirely in the unfixed code.
      for (const bucket of BUCKETS) {
        expect(spans.get(bucket.label) ?? 0, `${bucket.label} has no arc on the ring`).toBeGreaterThan(0);
      }

      // 3. One contiguous arc per bucket, in the component's order. Overlapping segments split the
      //    covered bucket into two runs, which is what "results overlap" looked like.
      expect(
        runs.map((r) => r.bucket),
        "the ring is not five contiguous arcs in bucket order",
      ).toEqual(BUCKETS.map((b) => b.label));

      // 4. Each arc is proportional. ±4 samples absorbs antialiasing at the four boundaries; it is
      //    far tighter than the ~11%-for-7% a round linecap produced (1.75u of overdraw per end on a
      //    100u circumference), so the cap regression cannot hide inside the tolerance.
      for (const bucket of BUCKETS) {
        const expected = ((counts[bucket.label] ?? 0) / seeded.total) * SAMPLES;
        expect(
          spans.get(bucket.label) ?? 0,
          `${bucket.label} should span ~${Math.round(expected)} of ${SAMPLES} samples`,
        ).toBeGreaterThan(expected - 5);
        expect(spans.get(bucket.label) ?? 0, `${bucket.label} spans more of the ring than it owns`).toBeLessThan(
          expected + 5,
        );
      }

      // 5. The centre total, the legend and the table still agree with the fixture — a chart fix
      //    must not have moved the numbers, which were never wrong.
      await expect(page.locator("svg text").filter({ hasText: String(seeded.total) }).first()).toBeVisible();
      for (const bucket of BUCKETS) {
        const n = counts[bucket.label] ?? 0;
        const pct = Math.round((n / seeded.total) * 100);
        await expect(
          page.getByText(`${bucket.label} (${n}, ${pct}%)`),
          `legend entry for ${bucket.label}`,
        ).toBeVisible();
      }
      await expect(page.getByText(`Test Cases (${seeded.total})`)).toBeVisible();
    } finally {
      await tearDown(seeded);
    }
  });

  test("SRP-02 a run with one status paints the whole ring in that colour", { tag: '@tesbo.testId("TES-TC-1068")' }, async ({ page }) => {
    // The boundary the buggy formula came closest to getting right, and the one where a fix that
    // computes the gap as C - dash has to cope with a zero-length gap.
    let seeded: SharedRun | null = null;
    try {
      seeded = await seedSharedRun({ Passed: 5 });
      await openReport(page, seeded.token);

      const { spans, runs } = describeRing(await sampleRing(page));
      expect(spans.get(null) ?? 0, "a single-status run left part of the ring unpainted").toBe(0);
      expect(runs.map((r) => r.bucket), "a single-status run should be one arc").toEqual(["Passed"]);
      expect(spans.get("Passed")).toBe(SAMPLES);

      // Zero-value buckets must not appear in the legend either.
      for (const bucket of BUCKETS.filter((b) => b.label !== "Passed")) {
        await expect(page.getByText(new RegExp(`${bucket.label} \\(0,`)), `${bucket.label} listed at 0`).toHaveCount(0);
      }
    } finally {
      await tearDown(seeded);
    }
  });

  test("SRP-03 a single case out of fifteen gets a proportional arc, not an inflated one", { tag: '@tesbo.testId("TES-TC-1069")' }, async ({ page }) => {
    // 1/15 = 6.67% = 24 of 360 samples. With strokeLinecap="round" this slice painted ~11% of the
    // ring and ate into its neighbour, so this is the cap regression on its own.
    let seeded: SharedRun | null = null;
    try {
      seeded = await seedSharedRun({ Passed: 14, Failed: 1 });
      await openReport(page, seeded.token);

      const { spans, runs } = describeRing(await sampleRing(page));
      expect(spans.get(null) ?? 0, "the ring did not close").toBe(0);
      expect(runs.map((r) => r.bucket)).toEqual(["Passed", "Failed"]);
      expect(spans.get("Failed") ?? 0, "the 1-of-15 slice is drawn wider than 1/15 of the ring").toBeLessThan(29);
      expect(spans.get("Failed") ?? 0, "the 1-of-15 slice is drawn narrower than 1/15 of the ring").toBeGreaterThan(19);
    } finally {
      await tearDown(seeded);
    }
  });

  test("SRP-04 a shared run with no cases shows the No data ring and charts nothing", { tag: '@tesbo.testId("TES-TC-1070")' }, async ({ page }) => {
    let seeded: SharedRun | null = null;
    try {
      seeded = await seedSharedRun({});
      await page.goto(`/share/${seeded.token}`);
      await expect(page.getByText("Shared Test Run Report")).toBeVisible();

      await expect(page.getByText("No data")).toBeVisible();
      // total === 0 takes the early-return branch, which draws the grey track and no segments.
      await expect(page.locator("svg circle[stroke-dasharray]")).toHaveCount(0);
      await expect(page.getByText("Test Cases (0)")).toBeVisible();
      await expect(page.getByText("No test cases in this test run.")).toBeVisible();
    } finally {
      await tearDown(seeded);
    }
  });

  test("SRP-05 a revoked or unknown token shows the unavailable message and no chart", { tag: '@tesbo.testId("TES-TC-1071")' }, async ({ page }) => {
    let seeded: SharedRun | null = null;
    try {
      seeded = await seedSharedRun({ Passed: 2, Failed: 1 });
      await openReport(page, seeded.token);

      const revoked = await api.post(`/api/cycles/${seeded.cycleId}/share`, {
        data: { enabled: false },
        failOnStatusCode: false,
      });
      expect(revoked.status(), `revoking the link — ${await revoked.text()}`).toBeLessThan(400);

      for (const token of [seeded.token, "not-a-real-token"]) {
        await page.goto(`/share/${token}`);
        await expect(page.getByText(/This shared link is not available/i)).toBeVisible();
        await expect(page.locator("svg circle[stroke-dasharray]")).toHaveCount(0);
      }
    } finally {
      await tearDown(seeded);
    }
  });
});
