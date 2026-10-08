import fs from "node:fs";
import path from "node:path";
import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";
import { dbControlAvailable, exec, literal, scalar } from "../utils/psql";

/*
 * Readable URLs: GET /api/route-resolve maps the segments of /projects/LOH/bugs/LOH-BUG-1 to the uuids
 * the rest of the API is addressed by. The frontend's RouteParamsProvider depends on it for every
 * project page, so a wrong answer here is a blank or wrong page, and a too-generous answer is a
 * cross-tenant lookup oracle.
 *
 * `request` (the default fixture) is account A; `asB` is a second, independent account/org/project.
 * No new tenant: nothing here is destructive to the shared workspace, and every fixture is created
 * with a unique name and removed in `finally`.
 */

const ctxA = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const ctxB = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context-b.json"), "utf-8"));

let asB: APIRequestContext;
let anon: APIRequestContext;
let projectKeyA = "";
let projectKeyB = "";

test.beforeAll(async ({ request }) => {
  asB = await playwrightRequest.newContext({
    baseURL: env.apiBaseUrl,
    storageState: path.join(__dirname, "../.auth/state-b.json"),
  });
  anon = await playwrightRequest.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
  projectKeyA = (await (await request.get(`/api/projects/${ctxA.projectId}`)).json()).key;
  projectKeyB = (await (await asB.get(`/api/projects/${ctxB.projectId}`)).json()).key;
});

test.afterAll(async () => {
  await asB.dispose();
  await anon.dispose();
});

function resolve(api: APIRequestContext, params: Record<string, string>) {
  return api.get("/api/route-resolve", { params, failOnStatusCode: false });
}

async function createBug(request: APIRequestContext, title: string) {
  const res = await request.post(`/api/projects/${ctxA.projectId}/bugs`, { data: { title, severity: "Low" } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

async function createCycle(request: APIRequestContext, name: string) {
  const res = await request.post(`/api/projects/${ctxA.projectId}/cycles`, { data: { name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

test.describe("route-resolve: project", () => {
  test("a project key resolves to its uuid, case-insensitively", async ({ request }) => {
    const res = await resolve(request, { project: projectKeyA });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.projectId).toBe(ctxA.projectId);
    expect(body.projectKey).toBe(projectKeyA);

    const lower = await (await resolve(request, { project: projectKeyA.toLowerCase() })).json();
    expect(lower.projectId, "key lookup is case-insensitive").toBe(ctxA.projectId);
  });

  test("a uuid still resolves and answers with the readable key, so old links can be rewritten", async ({ request }) => {
    const body = await (await resolve(request, { project: ctxA.projectId })).json();
    expect(body.projectId).toBe(ctxA.projectId);
    expect(body.projectKey).toBe(projectKeyA);
  });

  test("a missing project param is a 400, an unknown key or uuid is a 404", async ({ request }) => {
    expect((await resolve(request, {})).status()).toBe(400);
    expect((await resolve(request, { project: "   " })).status()).toBe(400);
    expect((await resolve(request, { project: "NOPE-DOES-NOT-EXIST" })).status()).toBe(404);
    expect((await resolve(request, { project: "00000000-0000-4000-8000-000000000000" })).status()).toBe(404);
  });
});

test.describe("route-resolve: bugs and test cases (stored per-project ids)", () => {
  test("a bug resolves by its <KEY>-BUG-<n> id and by uuid, with the same canonical ref", async ({ request }) => {
    const bug = await createBug(request, `E2E readable bug ${Date.now()}`);
    try {
      expect(bug.externalId).toMatch(/-BUG-\d+$/);
      const byRef = await (await resolve(request, { project: projectKeyA, bug: bug.externalId })).json();
      expect(byRef.bugId).toBe(bug.id);
      expect(byRef.bugRef).toBe(bug.externalId);

      const byLowerRef = await (await resolve(request, { project: projectKeyA, bug: bug.externalId.toLowerCase() })).json();
      expect(byLowerRef.bugId).toBe(bug.id);

      const byUuid = await (await resolve(request, { project: ctxA.projectId, bug: bug.id })).json();
      expect(byUuid.bugRef, "a uuid link learns its readable form").toBe(bug.externalId);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("a deleted bug no longer resolves", async ({ request }) => {
    const bug = await createBug(request, `E2E deleted bug ${Date.now()}`);
    await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    expect((await resolve(request, { project: projectKeyA, bug: bug.externalId })).status()).toBe(404);
    expect((await resolve(request, { project: projectKeyA, bug: bug.id })).status()).toBe(404);
  });

  test("an unknown bug ref is a 404", async ({ request }) => {
    expect((await resolve(request, { project: projectKeyA, bug: "ZZZ-BUG-999999" })).status()).toBe(404);
    expect((await resolve(request, { project: projectKeyA, bug: "not-a-ref" })).status()).toBe(404);
  });

  test("a test case resolves by its <KEY>-TC-<n> id and by uuid", async ({ request }) => {
    const created = await request.post(`/api/projects/${ctxA.projectId}/testcases`, {
      data: { title: `E2E readable case ${Date.now()}`, steps: [] },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const tc = await created.json();
    try {
      expect(tc.externalId).toMatch(/-TC-\d+$/);
      const byRef = await (await resolve(request, { project: projectKeyA, testcase: tc.externalId })).json();
      expect(byRef.testcaseId).toBe(tc.id);
      const byUuid = await (await resolve(request, { project: projectKeyA, testcase: tc.id })).json();
      expect(byUuid.testcaseRef).toBe(tc.externalId);
    } finally {
      await request.delete(`/api/projects/${ctxA.projectId}/testcases/${tc.id}`, { failOnStatusCode: false });
    }
  });
});

test.describe("route-resolve: runs (<KEY>-RUN-<n>)", () => {
  test("a run gets a per-project number, resolves by ref and uuid, and the numbers are sequential", async ({ request }) => {
    const first = await createCycle(request, `E2E readable run A ${Date.now()}`);
    const second = await createCycle(request, `E2E readable run B ${Date.now()}`);
    try {
      expect(first.seq).toBeGreaterThan(0);
      expect(second.seq).toBe(first.seq + 1);

      const byUuid = await (await resolve(request, { project: projectKeyA, cycle: first.id })).json();
      expect(byUuid.cycleId).toBe(first.id);
      expect(byUuid.cycleRef).toMatch(new RegExp(`-RUN-${first.seq}$`));

      const byRef = await (await resolve(request, { project: projectKeyA, cycle: byUuid.cycleRef })).json();
      expect(byRef.cycleId).toBe(first.id);

      // The prefix is cosmetic: a link minted before the project's id prefix was renamed still lands.
      const staleRef = await (await resolve(request, { project: projectKeyA, cycle: `OLD-RUN-${second.seq}` })).json();
      expect(staleRef.cycleId).toBe(second.id);
      expect(staleRef.cycleRef).toMatch(new RegExp(`-RUN-${second.seq}$`));
    } finally {
      await request.delete(`/api/cycles/${first.id}`, { failOnStatusCode: false });
      await request.delete(`/api/cycles/${second.id}`, { failOnStatusCode: false });
    }
  });

  test("a deleted run's number is never handed to a later run", async ({ request }) => {
    const gone = await createCycle(request, `E2E readable run gone ${Date.now()}`);
    await request.delete(`/api/cycles/${gone.id}`, { failOnStatusCode: false });
    const later = await createCycle(request, `E2E readable run later ${Date.now()}`);
    try {
      expect(later.seq, "soft-deleted rows keep their number").toBeGreaterThan(gone.seq);
      expect((await resolve(request, { project: projectKeyA, cycle: `${projectKeyA}-RUN-${gone.seq}` })).status()).toBe(404);
    } finally {
      await request.delete(`/api/cycles/${later.id}`, { failOnStatusCode: false });
    }
  });

  test("runs created at the same instant get distinct numbers", async ({ request }) => {
    const stamp = Date.now();
    const made = await Promise.all(Array.from({ length: 6 }, (_, i) => createCycle(request, `E2E parallel run ${i} ${stamp}`)));
    try {
      const seqs = made.map((c) => c.seq);
      expect(new Set(seqs).size, `seqs ${seqs.join(",")}`).toBe(made.length);
    } finally {
      for (const c of made) await request.delete(`/api/cycles/${c.id}`, { failOnStatusCode: false });
    }
  });

  test("malformed or unknown run refs are a 404, not a 500", async ({ request }) => {
    for (const cycle of ["RUN-1", "LOH-RUN-", "LOH-RUN-abc", `${projectKeyA}-RUN-99999999`, "x".repeat(300)]) {
      const res = await resolve(request, { project: projectKeyA, cycle });
      expect(res.status(), `cycle=${cycle.slice(0, 30)}`).toBe(404);
    }
  });
});

test.describe("route-resolve: tasks (<KEY>-TASK-<n>)", () => {
  test.skip(!dbControlAvailable(), "seeding an ai_generation_requests row needs the DB helpers");

  test("a Zyra task gets a per-project number by trigger and resolves by ref and uuid", async ({ request }) => {
    const userId = scalar(`SELECT id FROM users WHERE email = ${literal(ctxA.email)};`);
    const insert = (story: string, agent: string) =>
      scalar(
        `INSERT INTO ai_generation_requests (project_id, requested_by, provider, user_story, agent_name, task_status)
         VALUES (${literal(ctxA.projectId)}, ${literal(userId)}, 'openai', ${literal(story)}, ${literal(agent)}, 'in_review')
         RETURNING id;`
      );
    const taskA = insert(`E2E readable task A ${Date.now()}`, "Zyra the Test Generator");
    const taskB = insert(`E2E readable task B ${Date.now()}`, "Zyra the Test Generator");
    const other = insert(`E2E not a zyra task ${Date.now()}`, "Some Other Agent");
    try {
      const seqA = Number(scalar(`SELECT seq FROM ai_generation_requests WHERE id = ${literal(taskA)};`));
      const seqB = Number(scalar(`SELECT seq FROM ai_generation_requests WHERE id = ${literal(taskB)};`));
      expect(seqA).toBeGreaterThan(0);
      expect(seqB).toBeGreaterThan(seqA);

      const byUuid = await (await resolve(request, { project: projectKeyA, task: taskA })).json();
      expect(byUuid.taskRef).toMatch(new RegExp(`-TASK-${seqA}$`));
      const byRef = await (await resolve(request, { project: projectKeyA, task: byUuid.taskRef })).json();
      expect(byRef.taskId).toBe(taskA);

      // The task detail endpoint, addressed by the resolved uuid, is the one the page then calls.
      const detail = await request.get(`/api/projects/${ctxA.projectId}/agents/zyra/tasks/${byRef.taskId}`, { failOnStatusCode: false });
      expect(detail.ok(), await detail.text()).toBeTruthy();

      // Only Zyra tasks are tasks: a row from another agent must not resolve under /agents/tasks.
      expect((await resolve(request, { project: projectKeyA, task: other })).status()).toBe(404);
    } finally {
      exec(`DELETE FROM ai_generation_requests WHERE id IN (${[taskA, taskB, other].map(literal).join(", ")});`);
    }
  });
});

test.describe("route-resolve: several segments at once", () => {
  test("bug + run + project resolve in one call, and a wrong segment fails the whole call", async ({ request }) => {
    const bug = await createBug(request, `E2E multi bug ${Date.now()}`);
    const cycle = await createCycle(request, `E2E multi run ${Date.now()}`);
    try {
      const body = await (await resolve(request, { project: projectKeyA, bug: bug.externalId, cycle: cycle.id })).json();
      expect(body).toMatchObject({ projectId: ctxA.projectId, bugId: bug.id, cycleId: cycle.id });

      const bad = await resolve(request, { project: projectKeyA, bug: bug.externalId, cycle: "ZZZ-RUN-99999999" });
      expect(bad.status()).toBe(404);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
    }
  });
});

test.describe("route-resolve: authorization", () => {
  test("an unauthenticated caller is refused", async () => {
    const res = await resolve(anon, { project: projectKeyA });
    expect([400, 401, 403]).toContain(res.status());
    const body = await res.text();
    expect(body).not.toContain(ctxA.projectId);
  });

  test("another tenant cannot resolve this project by key or by uuid", async () => {
    const byKey = await resolve(asB, { project: projectKeyA });
    // Keys are only unique per workspace, so B having a project with the same key resolves to B's own.
    if (projectKeyA.toLowerCase() === projectKeyB.toLowerCase()) {
      expect((await byKey.json()).projectId).toBe(ctxB.projectId);
    } else {
      expect(byKey.status()).toBe(404);
    }
    expect((await resolve(asB, { project: ctxA.projectId })).status()).toBe(404);
  });

  test("another tenant cannot resolve this project's bug or run by ref or uuid", async ({ request }) => {
    const bug = await createBug(request, `E2E private bug ${Date.now()}`);
    const cycle = await createCycle(request, `E2E private run ${Date.now()}`);
    try {
      for (const params of <Record<string, string>[]>[
        { project: ctxA.projectId, bug: bug.id },
        { project: ctxA.projectId, bug: bug.externalId },
        { project: ctxA.projectId, cycle: cycle.id },
      ]) {
        const res = await resolve(asB, params);
        expect(res.status(), JSON.stringify(params)).toBe(404);
      }
      // Own project, someone else's bug: the ref is only meaningful inside the project it belongs to.
      const own = await resolve(asB, { project: projectKeyB, bug: bug.id });
      expect(own.status()).toBe(404);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
    }
  });
});
