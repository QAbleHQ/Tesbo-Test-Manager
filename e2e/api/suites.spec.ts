import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

test.describe("test suite CRUD", () => {
  test("supports create -> list -> rename -> reposition -> delete", { tag: '@tesbo.testId("TES-TC-527")' }, async ({ request }) => {
    const name = `E2E Suite ${Date.now()}`;
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name } })
    ).json();

    try {
      expect(created.id).toBeTruthy();
      expect(created.parentId).toBeNull();
      expect(created.position).toBe(0);
      expect(created.testCaseCount).toBe(0);

      const listRes = await request.get(`/api/projects/${ctx.projectId}/suites`);
      const list = await listRes.json();
      expect(list.some((s: { id: string }) => s.id === created.id)).toBeTruthy();

      const renamedName = `${name} (renamed)`;
      const renameRes = await request.patch(`/api/suites/${created.id}`, {
        data: { name: renamedName },
      });
      expect(renameRes.ok()).toBeTruthy();

      const repositionRes = await request.patch(`/api/suites/${created.id}`, {
        data: { position: 5 },
      });
      expect(repositionRes.ok()).toBeTruthy();

      const listAfterRes = await request.get(`/api/projects/${ctx.projectId}/suites`);
      const listAfter = await listAfterRes.json();
      const updated = listAfter.find((s: { id: string }) => s.id === created.id);
      expect(updated.name).toBe(renamedName);
      expect(updated.position).toBe(5);
    } finally {
      await request.delete(`/api/suites/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("renaming a child suite without sending parentId silently detaches it to root", { tag: '@tesbo.testId("TES-TC-528")' }, async ({
    request,
  }) => {
    // KNOWN GAP (documented, not test.fail() — this is a data-integrity bug, not a security
    // one): updateSuite (legacy.service.ts:1357) sets parent_id = $3 unconditionally, bound to
    // body.parentId ?? null, instead of COALESCE-ing like the adjacent `name` column does. The
    // rename UI only ever sends {name}, so every plain rename of a nested suite moves it to
    // root. Pinned here so this doesn't get silently "fixed" without anyone noticing the change.
    const parent = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Parent Suite ${Date.now()}` },
      })
    ).json();
    const child = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Child Suite ${Date.now()}`, parentId: parent.id },
      })
    ).json();

    try {
      expect(child.parentId).toBe(parent.id);

      await request.patch(`/api/suites/${child.id}`, { data: { name: "Renamed, no parentId sent" } });

      const listRes = await request.get(`/api/projects/${ctx.projectId}/suites`);
      const list = await listRes.json();
      const afterRename = list.find((s: { id: string }) => s.id === child.id);
      expect(afterRename.parentId).toBeNull();
    } finally {
      await request.delete(`/api/suites/${child.id}`, { failOnStatusCode: false });
      await request.delete(`/api/suites/${parent.id}`, { failOnStatusCode: false });
    }
  });

  test("deleting a suite with mode=moveToDefault un-suites its test cases instead of removing them", { tag: '@tesbo.testId("TES-TC-529")' }, async ({
    request,
  }) => {
    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Suite To Delete ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Suite Delete Test Case ${Date.now()}`, suiteId: suite.id },
      })
    ).json();

    try {
      const deleteRes = await request.delete(`/api/suites/${suite.id}`, {
        params: { mode: "moveToDefault" },
      });
      expect(deleteRes.ok()).toBeTruthy();

      const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`);
      expect(getRes.ok()).toBeTruthy();
      expect((await getRes.json()).suiteId).toBeNull();
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("deleting a suite with mode=deleteTestcases removes its test cases entirely", { tag: '@tesbo.testId("TES-TC-530")' }, async ({
    request,
  }) => {
    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Suite Hard Delete ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Suite Hard Delete Test Case ${Date.now()}`, suiteId: suite.id },
      })
    ).json();

    const deleteRes = await request.delete(`/api/suites/${suite.id}`, {
      params: { mode: "deleteTestcases" },
    });
    expect(deleteRes.ok()).toBeTruthy();

    const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
      failOnStatusCode: false,
    });
    expect(getRes.status()).toBe(404);
  });

  /*
   * The suites.name column is VARCHAR(255); validateBoundedField (legacy.service.ts) rejects
   * an over-length name with a 400 before the INSERT/UPDATE, rather than letting Postgres raise
   * 22001 as an unhandled 500. That check already existed but had no coverage of its own — the
   * UI's inline error display (ui/testcases.spec.ts) surfaces this exact message verbatim, so
   * this pins the contract the frontend fix depends on.
   */
  // No @tesbo.testId tag: minting one would require a matching case to already exist in the
  // live Tesbo project (see docs/playwright-integration.md), which this change doesn't create.
  test("rejects a suite name over 255 characters on both create and rename, and never writes it", async ({
    request,
  }) => {
    const overLong = "x".repeat(256);

    const createRes = await request.post(`/api/projects/${ctx.projectId}/suites`, {
      data: { name: overLong },
      failOnStatusCode: false,
    });
    expect(createRes.status()).toBe(400);
    expect((await createRes.json()).error).toBe("Suite name must be at most 255 characters");

    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Suite Name Length ${Date.now()}` },
      })
    ).json();

    try {
      const renameRes = await request.patch(`/api/suites/${suite.id}`, {
        data: { name: overLong },
        failOnStatusCode: false,
      });
      expect(renameRes.status()).toBe(400);
      expect((await renameRes.json()).error).toBe("Suite name must be at most 255 characters");

      // The rejected rename never reached the row.
      const listRes = await request.get(`/api/projects/${ctx.projectId}/suites`);
      const unchanged = (await listRes.json()).find((s: { id: string }) => s.id === suite.id);
      expect(unchanged.name).not.toBe(overLong);
    } finally {
      await request.delete(`/api/suites/${suite.id}`, { failOnStatusCode: false });
    }
  });
});

test.describe("recursive descendant rollup (parent suites show their sub-suites' test cases)", () => {
  /*
   * Reported bug: "Parent suits not showing test cases even though sub suite has test cases".
   * listTestCases matched `suite_id = $n` exactly, so a parent suite whose cases live entirely on a
   * child returned none of them; the sidebar badge separately summed only one level of children
   * client-side, so a 3rd level (a grandchild) reached neither the list nor the badge.
   *
   * `includeDescendants=true` is opt-in and additive — every assertion below that omits it is
   * pinning the exact pre-existing behavior, not just incidentally exercising it.
   */
  async function createSuite(request: APIRequestContext, name: string, parentId?: string): Promise<{ id: string }> {
    const res = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: parentId ? { name, parentId } : { name },
      })
    ).json();
    return res;
  }

  async function createCase(request: APIRequestContext, title: string, suiteId?: string): Promise<{ id: string }> {
    return (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: suiteId ? { title, suiteId } : { title },
      })
    ).json();
  }

  async function idsFor(request: APIRequestContext, suiteId: string, includeDescendants: boolean): Promise<string[]> {
    const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { suiteId, ...(includeDescendants ? { includeDescendants: "true" } : {}), limit: 500 },
    });
    return (await res.json()).map((tc: { id: string }) => tc.id);
  }

  test("a 3-level suite tree rolls up recursively — the list and listSuites' recursiveTestCaseCount agree at every depth", async ({
    request,
  }) => {
    const stamp = Date.now();
    const root = await createSuite(request, `E2E Rollup Root ${stamp}`);
    const child = await createSuite(request, `E2E Rollup Child ${stamp}`, root.id);
    const grandchild = await createSuite(request, `E2E Rollup Grandchild ${stamp}`, child.id);
    const rootCase = await createCase(request, `E2E Rollup Root Case ${stamp}`, root.id);
    const childCase = await createCase(request, `E2E Rollup Child Case ${stamp}`, child.id);
    const grandchildCase = await createCase(request, `E2E Rollup Grandchild Case ${stamp}`, grandchild.id);

    try {
      // The reported repro, proven at a depth the tree widget can't even render: selecting the root
      // includes the grandchild's case, three levels down.
      expect(new Set(await idsFor(request, root.id, true))).toEqual(
        new Set([rootCase.id, childCase.id, grandchildCase.id]),
      );
      expect(new Set(await idsFor(request, child.id, true))).toEqual(new Set([childCase.id, grandchildCase.id]));
      expect(await idsFor(request, grandchild.id, true)).toEqual([grandchildCase.id]);

      // Without the flag, byte-identical to the pre-fix behavior: exact suite_id match only.
      expect(await idsFor(request, root.id, false)).toEqual([rootCase.id]);
      expect(await idsFor(request, child.id, false)).toEqual([childCase.id]);

      const suites = await (await request.get(`/api/projects/${ctx.projectId}/suites`)).json();
      const byId = new Map(suites.map((s: { id: string }) => [s.id, s]));
      const at = (id: string) => byId.get(id) as { testCaseCount: number; recursiveTestCaseCount: number };
      expect(at(root.id).testCaseCount, "direct count must stay direct-only, unchanged").toBe(1);
      expect(at(root.id).recursiveTestCaseCount).toBe(3);
      expect(at(child.id).recursiveTestCaseCount).toBe(2);
      expect(at(grandchild.id).recursiveTestCaseCount).toBe(1);
    } finally {
      for (const c of [rootCase, childCase, grandchildCase]) {
        await request.delete(`/api/projects/${ctx.projectId}/testcases/${c.id}`, { failOnStatusCode: false });
      }
      for (const s of [grandchild, child, root]) {
        await request.delete(`/api/suites/${s.id}`, { failOnStatusCode: false });
      }
    }
  });

  test("includeDescendants only ever adds rows (monotonic superset) and is a no-op on a leaf suite", async ({ request }) => {
    const stamp = Date.now();
    const parent = await createSuite(request, `E2E Superset Parent ${stamp}`);
    const leaf = await createSuite(request, `E2E Superset Leaf ${stamp}`, parent.id);
    const parentCase = await createCase(request, `E2E Superset Parent Case ${stamp}`, parent.id);
    const leafCase = await createCase(request, `E2E Superset Leaf Case ${stamp}`, leaf.id);

    try {
      const withoutFlag = await idsFor(request, parent.id, false);
      const withFlag = await idsFor(request, parent.id, true);
      expect(withoutFlag.every((id) => withFlag.includes(id)), "flagged result must be a superset").toBeTruthy();
      expect(withFlag.length).toBeGreaterThan(withoutFlag.length);

      // A leaf has no descendants to add — the flag changes nothing.
      expect(await idsFor(request, leaf.id, true)).toEqual(await idsFor(request, leaf.id, false));
      expect(await idsFor(request, leaf.id, true)).toEqual([leafCase.id]);
    } finally {
      for (const c of [parentCase, leafCase]) {
        await request.delete(`/api/projects/${ctx.projectId}/testcases/${c.id}`, { failOnStatusCode: false });
      }
      for (const s of [leaf, parent]) {
        await request.delete(`/api/suites/${s.id}`, { failOnStatusCode: false });
      }
    }
  });

  test("includeDescendants is inert for suiteId=none and for no suiteId at all", async ({ request }) => {
    const stamp = Date.now();
    const suite = await createSuite(request, `E2E Inert Flag Suite ${stamp}`);
    const filed = await createCase(request, `E2E Inert Flag Filed ${stamp}`, suite.id);
    const unfiled = await createCase(request, `E2E Inert Flag Unfiled ${stamp}`);

    try {
      // suiteId=none (unfiled) wins outright — the flag has nothing to expand.
      const unfiledRes = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { suiteId: "none", includeDescendants: "true", limit: 500 },
      });
      const unfiledIds = (await unfiledRes.json()).map((tc: { id: string }) => tc.id);
      expect(unfiledIds).toContain(unfiled.id);
      expect(unfiledIds).not.toContain(filed.id);

      // No suiteId at all ("All test cases") — the loop never reaches the suite column.
      const allRes = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { includeDescendants: "true", search: `E2E Inert Flag ${stamp}`, limit: 500 },
      });
      const allIds = (await allRes.json()).map((tc: { id: string }) => tc.id);
      expect(new Set(allIds)).toEqual(new Set([filed.id, unfiled.id]));
    } finally {
      for (const c of [filed, unfiled]) {
        await request.delete(`/api/projects/${ctx.projectId}/testcases/${c.id}`, { failOnStatusCode: false });
      }
      await request.delete(`/api/suites/${suite.id}`, { failOnStatusCode: false });
    }
  });

  test("a malformed suiteId still 400s, and a well-formed but nonexistent one resolves to empty — with or without the flag", async ({
    request,
  }) => {
    for (const includeDescendants of [undefined, "true"]) {
      const malformed = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { suiteId: "not-a-uuid", ...(includeDescendants ? { includeDescendants } : {}) },
        failOnStatusCode: false,
      });
      expect(malformed.status()).toBe(400);

      const nonexistent = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: {
          suiteId: "00000000-0000-0000-0000-000000000000",
          ...(includeDescendants ? { includeDescendants } : {}),
          limit: 10,
        },
      });
      expect(nonexistent.ok()).toBeTruthy();
      expect(await nonexistent.json()).toEqual([]);
    }
  });
});
