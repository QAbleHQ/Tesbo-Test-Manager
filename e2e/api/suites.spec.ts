import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { literal, scalar } from "../utils/psql";

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

/*
 * Zyra context integrity, Phase 3/4 (progress log: "Zyra Workflow Agents/
 * zyra-context-integrity-progress-log.md") — deleteSuite used to issue a real `DELETE FROM
 * testcases WHERE suite_id = $1` (mode=deleteTestcases) and an unconditional `DELETE FROM suites
 * WHERE id = $1`, in both modes. Combined with suites.parent_id's ON DELETE CASCADE
 * (migrations/V2_test_cases_and_suites.sql), that silently hard-deleted the WHOLE descendant
 * subtree and, via the further cascade off `testcases`, every testcase_versions/cycle_items/
 * executions row belonging to a testcase anywhere in it — even though testcase_versions and
 * executions each have their own soft-delete/history mechanism that this path bypassed entirely.
 *
 * migrations/V110_suites_soft_delete.sql adds suites.deleted_at/deleted_by, and deleteSuite now
 * only ever issues UPDATEs. This block proves that directly against the database — not just that
 * the API stops returning a deleted suite (already covered above), but that the underlying rows
 * and their history genuinely survive, which is the actual defect this phase fixes.
 *
 * FAILING-FIRST, STATED RATHER THAN RE-RUN: this suite is written and landing in the SAME change
 * as the fix, so there is no separate "run it against the old code" step available this session
 * (CLAUDE.local.md also suspends automatic e2e runs while iterating locally). The failing direction
 * is not hypothetical, though — it is mechanical: the pre-fix code paths this test's assertions
 * would have hit are `DELETE FROM testcases WHERE suite_id = $1` and an unconditional
 * `DELETE FROM suites WHERE id = $1` (both quoted verbatim above, and both provably the only two
 * call sites for either statement in `src/` before this change — see the progress log's Phase 0
 * report). Postgres's own documented FK CASCADE behavior on `parent_id`/`testcase_id` means every
 * row this test checks for survival (testcase_versions, cycle_items, executions, the descendant
 * suite itself) is mechanically destroyed by those two statements — there is no code path in the
 * pre-fix version of deleteSuite that could have left them in place. Confirmed by reading the git
 * diff of legacy.service.ts for this change, not merely asserted.
 */
test.describe("suite soft-delete (Zyra context integrity, Phase 3/4)", () => {
  test("mode=deleteTestcases soft-deletes a leaf suite and its testcase, preserving version and execution history in the database", async ({
    request,
  }) => {
    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Soft-Delete Leaf Suite ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Soft-Delete Leaf Case ${Date.now()}`, suiteId: suite.id },
      })
    ).json();
    // Generates a testcase_versions row (V63's BEFORE UPDATE trigger) — history that must survive.
    await request.patch(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
      data: { title: `${testcase.title} (revised)` },
    });
    // Real execution history, not merely a version row — the cascade this phase closes off runs
    // through cycle_items to executions too (see the module doc comment above).
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Soft-Delete Leaf Cycle ${Date.now()}` },
      })
    ).json();
    await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
    const cycleItemId = scalar(`SELECT id FROM cycle_items WHERE cycle_id = ${literal(cycle.id)} AND testcase_id = ${literal(testcase.id)};`);
    expect(cycleItemId, "the execution fixture must actually exist before the suite is deleted").toBeTruthy();

    try {
      const deleteRes = await request.delete(`/api/suites/${suite.id}`, { params: { mode: "deleteTestcases" } });
      expect(deleteRes.ok(), `deleting the suite — ${await deleteRes.text()}`).toBeTruthy();

      // API-visible: gone from every list, same as before this fix (unchanged observable behavior).
      const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
      expect(getRes.status()).toBe(404);
      const listRes = await request.get(`/api/projects/${ctx.projectId}/suites`);
      expect((await listRes.json()).some((s: { id: string }) => s.id === suite.id)).toBe(false);

      // Database-visible: the rows genuinely still exist — this is the actual fix, not the API
      // surface (which looked the same whether the rows were hard- or soft-deleted).
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM suites WHERE id = ${literal(suite.id)};`), "the suite row itself must still exist, now soft-deleted").toBe("t");
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM testcases WHERE id = ${literal(testcase.id)};`), "the testcase row must still exist, now soft-deleted").toBe("t");
      const versionCount = Number(scalar(`SELECT COUNT(*) FROM testcase_versions WHERE testcase_id = ${literal(testcase.id)};`));
      expect(versionCount, "the PATCH's version row, plus a new one for the soft-delete itself, must both survive").toBeGreaterThanOrEqual(2);
      expect(scalar(`SELECT COUNT(*) FROM cycle_items WHERE id = ${literal(cycleItemId)};`), "the cycle_item must survive").toBe("1");
      expect(scalar(`SELECT COUNT(*) FROM executions WHERE cycle_item_id = ${literal(cycleItemId)};`), "the execution must survive").toBe("1");
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
    }
  });

  test("mode=deleteTestcases is subtree-wide: a child suite's testcase is soft-deleted too, not just the named suite's own", async ({ request }) => {
    const parent = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: `E2E Soft-Delete Subtree Parent ${Date.now()}` } })
    ).json();
    const child = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: `E2E Soft-Delete Subtree Child ${Date.now()}`, parentId: parent.id } })
    ).json();
    const parentCase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Subtree Parent Case ${Date.now()}`, suiteId: parent.id } })
    ).json();
    const childCase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Subtree Child Case ${Date.now()}`, suiteId: child.id } })
    ).json();

    const deleteRes = await request.delete(`/api/suites/${parent.id}`, { params: { mode: "deleteTestcases" } });
    expect(deleteRes.ok(), `deleting the parent suite — ${await deleteRes.text()}`).toBeTruthy();

    for (const id of [parentCase.id, childCase.id]) {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      expect(res.status(), `testcase ${id} must be soft-deleted too, not left dangling on a ghost suite`).toBe(404);
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM testcases WHERE id = ${literal(id)};`)).toBe("t");
    }
    for (const id of [parent.id, child.id]) {
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM suites WHERE id = ${literal(id)};`), `suite ${id} must be soft-deleted`).toBe("t");
    }
  });

  test("mode=moveToDefault is subtree-wide: a child suite's testcase is unassigned (not deleted), the child suite itself is soft-deleted", async ({
    request,
  }) => {
    const parent = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: `E2E MoveDefault Subtree Parent ${Date.now()}` } })
    ).json();
    const child = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: `E2E MoveDefault Subtree Child ${Date.now()}`, parentId: parent.id } })
    ).json();
    const parentCase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E MoveDefault Parent Case ${Date.now()}`, suiteId: parent.id } })
    ).json();
    const childCase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E MoveDefault Child Case ${Date.now()}`, suiteId: child.id } })
    ).json();

    try {
      // Deleting the PARENT with mode=moveToDefault — the case named in Q9: a literal port of the
      // old one-line SQL would only unassign the parent's own direct children, leaving the child
      // suite's testcase pointing at a suite_id that just vanished from every list. Subtree-wide is
      // the fix; this is the test that would catch a regression back to the narrower reading.
      const deleteRes = await request.delete(`/api/suites/${parent.id}`, { params: { mode: "moveToDefault" } });
      expect(deleteRes.ok(), `deleting the parent suite — ${await deleteRes.text()}`).toBeTruthy();

      for (const id of [parentCase.id, childCase.id]) {
        const res = await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`);
        expect(res.ok(), `testcase ${id} must survive moveToDefault, active`).toBeTruthy();
        expect((await res.json()).suiteId, `testcase ${id} must be unassigned, not left pointing at a soft-deleted suite`).toBeNull();
      }
      for (const id of [parent.id, child.id]) {
        expect(scalar(`SELECT deleted_at IS NOT NULL FROM suites WHERE id = ${literal(id)};`), `suite ${id} must be soft-deleted`).toBe("t");
      }
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${parentCase.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${childCase.id}`, { failOnStatusCode: false });
    }
  });

  test("requireSuiteAccess 404s on an already-soft-deleted suite — rename and re-delete alike", async ({ request }) => {
    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: `E2E Already Deleted Suite ${Date.now()}` } })
    ).json();

    const firstDelete = await request.delete(`/api/suites/${suite.id}`, { params: { mode: "moveToDefault" } });
    expect(firstDelete.ok(), `first delete — ${await firstDelete.text()}`).toBeTruthy();

    // A second delete of the same (now soft-deleted) suite must read as "not found", the same
    // answer a truly nonexistent id gets — not a silent success, and not a 500 from acting on a
    // row requireSuiteAccess should have already refused.
    const secondDelete = await request.delete(`/api/suites/${suite.id}`, {
      params: { mode: "moveToDefault" },
      failOnStatusCode: false,
    });
    expect(secondDelete.status()).toBe(404);

    const renameRes = await request.patch(`/api/suites/${suite.id}`, {
      data: { name: "should not apply" },
      failOnStatusCode: false,
    });
    expect(renameRes.status()).toBe(404);
  });

  test("resolveOrCreateSuiteByName's underlying filter: a soft-deleted suite is not returned by name-based lookup", async ({ request }) => {
    // Exercised directly at the API surface via CSV import's defaultSuiteId ownership check (a
    // mechanical site sharing the same `deleted_at IS NULL` filter this phase adds throughout), so
    // this doesn't need a Zyra chat round trip to prove the underlying database-level guarantee:
    // once soft-deleted, a suite id is genuinely unusable as an import/reuse target.
    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: `E2E Import Target Suite ${Date.now()}` } })
    ).json();
    const deleteRes = await request.delete(`/api/suites/${suite.id}`, { params: { mode: "moveToDefault" } });
    expect(deleteRes.ok()).toBeTruthy();

    const importRes = await request.post(`/api/projects/${ctx.projectId}/testcases/import`, {
      data: { defaultSuiteId: suite.id, rows: [{ title: `E2E Import Into Deleted Suite ${Date.now()}` }] },
      failOnStatusCode: false,
    });
    expect(importRes.status(), "a soft-deleted suite must not be a usable import target").toBe(400);
    expect((await importRes.json()).error).toBe("defaultSuiteId is not a suite in this project");
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

  test("pagination across a recursively-expanded parent has no duplicates and no gaps", async ({ request }) => {
    // The WHERE-clause change is the only thing that differs from the pre-fix query — ORDER BY
    // created_at DESC, id DESC and LIMIT/OFFSET are untouched — but this proves that composition
    // rather than assuming it, since a parent suite can now legitimately span far more rows per
    // page than direct-only matching ever produced.
    const stamp = Date.now();
    const parent = await createSuite(request, `E2E Pagination Parent ${stamp}`);
    const child = await createSuite(request, `E2E Pagination Child ${stamp}`, parent.id);
    const cases = [];
    for (let i = 0; i < 5; i++) {
      // Alternate direct/descendant so both contribute rows to the same paginated walk.
      cases.push(await createCase(request, `E2E Pagination Case ${stamp} ${i}`, i % 2 === 0 ? parent.id : child.id));
    }

    try {
      const pageSize = 2;
      const seen: string[] = [];
      for (let offset = 0; offset < cases.length + pageSize; offset += pageSize) {
        const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { suiteId: parent.id, includeDescendants: "true", limit: pageSize, offset },
        });
        const page = (await res.json()).map((tc: { id: string }) => tc.id);
        if (!page.length) break;
        seen.push(...page);
      }
      expect(new Set(seen), "every case must be reachable exactly once across pages").toEqual(
        new Set(cases.map((c) => c.id)),
      );
      expect(seen.length, "no row should be repeated across two pages").toBe(cases.length);
    } finally {
      for (const c of cases) {
        await request.delete(`/api/projects/${ctx.projectId}/testcases/${c.id}`, { failOnStatusCode: false });
      }
      for (const s of [child, parent]) {
        await request.delete(`/api/suites/${s.id}`, { failOnStatusCode: false });
      }
    }
  });
});
