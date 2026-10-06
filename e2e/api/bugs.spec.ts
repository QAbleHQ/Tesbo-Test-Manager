import fs from "node:fs";
import path from "node:path";
import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  resetRbacMembership,
  type RbacTenant,
} from "../utils/rbac-tenant";
import { exec, literal, scalar } from "../utils/psql";
import { filesForm, filesFormWith, pngFile, sizedFile, textFile, type UploadFile } from "../utils/uploads";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

test.describe("bug CRUD", () => {
  test("supports the create -> read -> update -> list -> delete lifecycle", { tag: '@tesbo.testId("TES-TC-99")' }, async ({ request }) => {
    const title = `E2E Bug ${Date.now()}`;
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title, description: "Created by the e2e suite", severity: "High" },
      })
    ).json();

    try {
      expect(created.id).toBeTruthy();
      expect(created.title).toBe(title);
      expect(created.status).toBe("Open");
      expect(created.severity).toBe("High");
      expect(created.links).toEqual([]);
      expect(created.attachments).toEqual([]);

      const getRes = await request.get(`/api/bugs/${created.id}`);
      expect(getRes.ok()).toBeTruthy();
      expect((await getRes.json()).description).toBe("Created by the e2e suite");

      const updatedTitle = `${title} (updated)`;
      const patchRes = await request.patch(`/api/bugs/${created.id}`, {
        data: { title: updatedTitle, status: "In Progress" },
      });
      expect(patchRes.ok()).toBeTruthy();

      const getAfterUpdateRes = await request.get(`/api/bugs/${created.id}`);
      const afterUpdate = await getAfterUpdateRes.json();
      expect(afterUpdate.title).toBe(updatedTitle);
      expect(afterUpdate.status).toBe("In Progress");

      const listRes = await request.get(`/api/projects/${ctx.projectId}/bugs`);
      const list = await listRes.json();
      expect(list.some((b: { id: string }) => b.id === created.id)).toBeTruthy();

      const filteredListRes = await request.get(`/api/projects/${ctx.projectId}/bugs`, {
        params: { status: "In Progress" },
      });
      const filteredList = await filteredListRes.json();
      expect(filteredList.some((b: { id: string }) => b.id === created.id)).toBeTruthy();
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }

    const getAfterDeleteRes = await request.get(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    expect(getAfterDeleteRes.status()).toBe(404);
  });

  /*
   * Every bug gets a stable per-project key (`<KEY>-BUG-<n>`), the same scheme test cases already
   * have (`<KEY>-TC-<n>`) — so "Bug Key" in the Test Run / Test Case Detail / Bugs page UI always
   * has something real to show, even for a bug that was never linked to Jira/Linear and so has no
   * integrationIssueKey at all.
   */
  test("a created bug gets a per-project sequential external id, even with no external tracker", async ({ request }) => {
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug External Id ${Date.now()}`, severity: "Medium" },
      })
    ).json();
    try {
      expect(created.externalId).toMatch(/^.+-BUG-\d+$/);
      expect(created.integrationIssueKey).toBeNull();

      // Persisted and returned consistently by both single-bug and list reads, not just at
      // creation time.
      const getRes = await request.get(`/api/bugs/${created.id}`);
      expect((await getRes.json()).externalId).toBe(created.externalId);

      const listRes = await request.get(`/api/projects/${ctx.projectId}/bugs`);
      const listed = (await listRes.json()).find((b: { id: string }) => b.id === created.id);
      expect(listed.externalId).toBe(created.externalId);
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("two bugs created back-to-back in the same project get distinct, increasing sequential ids", async ({ request }) => {
    const first = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Seq A ${Date.now()}`, severity: "Low" },
      })
    ).json();
    const second = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Seq B ${Date.now()}`, severity: "Low" },
      })
    ).json();
    try {
      const prefixOf = (externalId: string) => externalId.replace(/-\d+$/, "");
      const seqOf = (externalId: string) => Number(externalId.match(/(\d+)$/)?.[1]);

      expect(prefixOf(second.externalId)).toBe(prefixOf(first.externalId));
      expect(second.externalId).not.toBe(first.externalId);
      expect(seqOf(second.externalId)).toBeGreaterThan(seqOf(first.externalId));
    } finally {
      await request.delete(`/api/bugs/${first.id}`, { failOnStatusCode: false });
      await request.delete(`/api/bugs/${second.id}`, { failOnStatusCode: false });
    }
  });

  test("creating a bug with a link populates it, and addBugLink/removeBugLink manage further links", { tag: '@tesbo.testId("TES-TC-100")' }, async ({
    request,
  }) => {
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Bug Link Cycle ${Date.now()}` },
      })
    ).json();
    const testcaseA = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Bug Link Case A ${Date.now()}` },
      })
    ).json();
    const testcaseB = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Bug Link Case B ${Date.now()}` },
      })
    ).json();
    await request.post(`/api/cycles/${cycle.id}/testcases`, {
      data: { testcaseIds: [testcaseA.id, testcaseB.id] },
    });

    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: {
          title: `E2E Bug With Link ${Date.now()}`,
          links: [{ testcaseId: testcaseA.id, cycleId: cycle.id }],
        },
      })
    ).json();

    try {
      expect(created.links).toHaveLength(1);
      expect(created.links[0].testcaseId).toBe(testcaseA.id);

      const afterAddLink = await (
        await request.post(`/api/bugs/${created.id}/links`, {
          data: { testcaseId: testcaseB.id, cycleId: cycle.id },
        })
      ).json();
      expect(afterAddLink.links).toHaveLength(2);

      const linkToRemove = afterAddLink.links.find((l: { testcaseId: string }) => l.testcaseId === testcaseB.id);
      const afterRemoveLink = await (
        await request.delete(`/api/bugs/${created.id}/links/${linkToRemove.id}`)
      ).json();
      expect(afterRemoveLink.links).toHaveLength(1);
      expect(afterRemoveLink.links[0].testcaseId).toBe(testcaseA.id);
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseA.id}`, {
        failOnStatusCode: false,
      });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseB.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test(
    "listBugs filters by testcaseId, following bug_links rather than the denormalized column",
    { tag: '@tesbo.testId("TES-TC-2015")' },
    async ({ request }) => {
      // Regression: the Test Case Detail page had no way to show the bugs filed against a case
      // because listBugs had no testcaseId filter at all. This also exercises the reason it has to
      // read bug_links rather than bugs.testcase_id: that column is set once at creation and is
      // never touched again when links are edited later (see legacy.service.ts updateBug), so a
      // bug re-linked away from its original test case would otherwise still answer for it.
      const testcaseA = await (
        await request.post(`/api/projects/${ctx.projectId}/testcases`, {
          data: { title: `E2E Bug Filter Case A ${Date.now()}` },
        })
      ).json();
      const testcaseB = await (
        await request.post(`/api/projects/${ctx.projectId}/testcases`, {
          data: { title: `E2E Bug Filter Case B ${Date.now()}` },
        })
      ).json();

      const created = await (
        await request.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: {
            title: `E2E Bug Filter Target ${Date.now()}`,
            integrationProvider: "JIRA",
            integrationIssueKey: "PROJ-4242",
            externalUrl: "https://example.atlassian.net/browse/PROJ-4242",
            links: [{ testcaseId: testcaseA.id }],
          },
        })
      ).json();

      try {
        const listForA = await (
          await request.get(`/api/projects/${ctx.projectId}/bugs`, { params: { testcaseId: testcaseA.id } })
        ).json();
        expect(listForA.some((b: { id: string }) => b.id === created.id), "the bug is linked to A").toBeTruthy();
        // The actual data the Test Case Detail page's Bug Key / Bug URL fields read.
        const found = listForA.find((b: { id: string }) => b.id === created.id);
        expect(found.integrationIssueKey).toBe("PROJ-4242");
        expect(found.externalUrl).toBe("https://example.atlassian.net/browse/PROJ-4242");

        const listForB = await (
          await request.get(`/api/projects/${ctx.projectId}/bugs`, { params: { testcaseId: testcaseB.id } })
        ).json();
        expect(listForB.some((b: { id: string }) => b.id === created.id), "not yet linked to B").toBeFalsy();

        // Re-link away from A to B — only bug_links changes; bugs.testcase_id (set at creation)
        // is left exactly as it was.
        await request.patch(`/api/bugs/${created.id}`, { data: { links: [{ testcaseId: testcaseB.id }] } });

        const listForANow = await (
          await request.get(`/api/projects/${ctx.projectId}/bugs`, { params: { testcaseId: testcaseA.id } })
        ).json();
        expect(
          listForANow.some((b: { id: string }) => b.id === created.id),
          "the stale bugs.testcase_id column must not resurrect the old link",
        ).toBeFalsy();

        const listForBNow = await (
          await request.get(`/api/projects/${ctx.projectId}/bugs`, { params: { testcaseId: testcaseB.id } })
        ).json();
        expect(listForBNow.some((b: { id: string }) => b.id === created.id), "now linked to B").toBeTruthy();
      } finally {
        await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
        await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseA.id}`, { failOnStatusCode: false });
        await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseB.id}`, { failOnStatusCode: false });
      }
    },
  );

  test(
    "listBugs filters by testcaseId+cycleId together, matching only the SAME bug_links row",
    async ({ request }) => {
      // Regression: the exact same staleness the testcaseId test above covers, but for cycleId —
      // and this is the one the Test Case Detail panel's real query (`listBugs({testcaseId,
      // cycleId})`) actually hit. "Link existing bug" (addBugLink) inserts a bug_links row for the
      // new cycle but never touches bugs.cycle_id, which stays at whatever cycle the bug was first
      // created in (or null, if it was filed with no run yet). A `b.cycle_id = $N` filter then
      // silently excluded a bug that a real bug_links row said belonged to this cycle, so a bug
      // that was genuinely just linked never reappeared in the panel that linked it. When both
      // testcaseId and cycleId are given they must be satisfied by the SAME link row, not by two
      // different links on the same bug that happen to each match one side.
      const cycleA = await (
        await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E Bug Cycle Filter A ${Date.now()}` } })
      ).json();
      const cycleB = await (
        await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E Bug Cycle Filter B ${Date.now()}` } })
      ).json();
      const testcase = await (
        await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Bug Cycle Filter Case ${Date.now()}` } })
      ).json();
      await request.post(`/api/cycles/${cycleA.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
      await request.post(`/api/cycles/${cycleB.id}/testcases`, { data: { testcaseIds: [testcase.id] } });

      // Filed with no link at all, so bugs.cycle_id is null from creation — the "log a bug from
      // the Bugs page, link it to a run later" path.
      const created = await (
        await request.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: { title: `E2E Bug Cycle Filter Target ${Date.now()}` },
        })
      ).json();

      try {
        const beforeLink = await (
          await request.get(`/api/projects/${ctx.projectId}/bugs`, { params: { testcaseId: testcase.id, cycleId: cycleA.id } })
        ).json();
        expect(beforeLink.some((b: { id: string }) => b.id === created.id), "not yet linked to cycle A").toBeFalsy();

        // Link it to the test case in cycle A — only bug_links is written; bugs.cycle_id (still
        // null from creation) is left exactly as it was.
        await request.post(`/api/bugs/${created.id}/links`, { data: { testcaseId: testcase.id, cycleId: cycleA.id } });

        const listForA = await (
          await request.get(`/api/projects/${ctx.projectId}/bugs`, { params: { testcaseId: testcase.id, cycleId: cycleA.id } })
        ).json();
        expect(
          listForA.some((b: { id: string }) => b.id === created.id),
          "the stale (null) bugs.cycle_id column must not hide a real bug_links row",
        ).toBeTruthy();

        // Not linked to cycle B, even though the same test case sits in both runs — a match on
        // testcaseId in one link row must not combine with a match on cycleId from a different one.
        const listForB = await (
          await request.get(`/api/projects/${ctx.projectId}/bugs`, { params: { testcaseId: testcase.id, cycleId: cycleB.id } })
        ).json();
        expect(listForB.some((b: { id: string }) => b.id === created.id), "not linked to cycle B").toBeFalsy();
      } finally {
        await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
        await request.delete(`/api/cycles/${cycleA.id}`, { failOnStatusCode: false });
        await request.delete(`/api/cycles/${cycleB.id}`, { failOnStatusCode: false });
        await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
      }
    },
  );

  test(
    "listBugs filters by cycleId alone, following bug_links rather than the denormalized column",
    async ({ request }) => {
      // Regression: unlike the testcaseId filter above (TES-TC-2015), the cycleId filter still
      // matched against bugs.cycle_id -- the "first-link convenience" column set once at creation
      // (V48_bug_links.sql) and never touched by addBugLink afterwards. A bug created with no
      // link at all (bugs.cycle_id stays NULL) and later linked into a cycle via addBugLink --
      // exactly what "Yes, link existing -> Existing Tesbo bug" does -- was then invisible to
      // listBugs(cycleId) even though bug_links was correct, so a bug picked that way silently
      // never showed up in the run drawer/execute page's Bug Key/Title fields.
      const cycleA = await (
        await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E Bug CycleId Filter A ${Date.now()}` } })
      ).json();
      const cycleB = await (
        await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E Bug CycleId Filter B ${Date.now()}` } })
      ).json();
      const testcase = await (
        await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Bug CycleId Filter Case ${Date.now()}` } })
      ).json();

      // Created with no link at all -- bugs.cycle_id stays NULL, same as a bug the picker offers
      // that was originally filed unlinked or against a different cycle entirely.
      const created = await (
        await request.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: { title: `E2E Bug CycleId Filter Target ${Date.now()}`, links: [] },
        })
      ).json();

      try {
        await request.post(`/api/bugs/${created.id}/links`, { data: { testcaseId: testcase.id, cycleId: cycleA.id } });

        const listForA = await (
          await request.get(`/api/projects/${ctx.projectId}/bugs`, { params: { cycleId: cycleA.id } })
        ).json();
        expect(
          listForA.some((b: { id: string }) => b.id === created.id),
          "linked via bug_links to cycle A -- must be found even though bugs.cycle_id is still NULL",
        ).toBeTruthy();

        const listForB = await (
          await request.get(`/api/projects/${ctx.projectId}/bugs`, { params: { cycleId: cycleB.id } })
        ).json();
        expect(listForB.some((b: { id: string }) => b.id === created.id), "not linked to cycle B").toBeFalsy();
      } finally {
        await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
        await request.delete(`/api/cycles/${cycleA.id}`, { failOnStatusCode: false });
        await request.delete(`/api/cycles/${cycleB.id}`, { failOnStatusCode: false });
        await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
      }
    },
  );

  test("sending an empty string to clear a field leaves the old value in place", { tag: '@tesbo.testId("TES-TC-101")' }, async ({ request }) => {
    // KNOWN GAP (documented, not test.fail() — a data-integrity bug, not a security one):
    // updateBug (legacy.service.ts:1958) sends every field as `body.field || null`, so an
    // empty string collapses to null before it ever reaches COALESCE, which then keeps the old
    // value. There is currently no way to blank out these fields via this endpoint. Pinned here
    // so this doesn't get silently "fixed" (or silently regress further) without anyone noticing.
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: {
          title: `E2E Bug Unclearable ${Date.now()}`,
          description: "Original description",
          externalUrl: "https://example.com/original",
        },
      })
    ).json();

    try {
      await request.patch(`/api/bugs/${created.id}`, {
        data: { description: "", externalUrl: "" },
      });

      const afterClearAttempt = await (await request.get(`/api/bugs/${created.id}`)).json();
      expect(afterClearAttempt.description).toBe("Original description");
      expect(afterClearAttempt.externalUrl).toBe("https://example.com/original");
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * GET /api/projects/:projectId/bugs/:bugId — the project-scoped lookup the Bug Details page's
 * shareable URL uses, added so a bug can be addressed by its stable external id (e.g. "PRO-BUG-12")
 * and not only its uuid. Mirrors getTestCaseForUser's dual-key resolution; the project id in the
 * URL is what makes the external id (unique only per project) resolvable without ambiguity.
 */
test.describe("bug details by project-scoped id", () => {
  test("resolves a bug by its external id, scoped to the project, same shape as the flat uuid route", async ({ request }) => {
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Scoped Lookup ${Date.now()}`, description: "Found by external id", severity: "Medium" },
      })
    ).json();
    try {
      const byExternalId = await request.get(`/api/projects/${ctx.projectId}/bugs/${created.externalId}`);
      expect(byExternalId.ok()).toBeTruthy();
      const bodyByExternalId = await byExternalId.json();
      expect(bodyByExternalId.id).toBe(created.id);
      expect(bodyByExternalId.description).toBe("Found by external id");

      // Same route also still resolves by uuid — one endpoint, either key, matching getTestCase's
      // precedent.
      const byUuid = await request.get(`/api/projects/${ctx.projectId}/bugs/${created.id}`);
      expect(byUuid.ok()).toBeTruthy();
      expect((await byUuid.json()).externalId).toBe(created.externalId);
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("a bug's external id does not resolve under a different project", async ({ request }) => {
    const otherProject = await (
      await request.post(`/api/projects`, {
        data: { name: `E2E Bug Scope Other ${Date.now()}`, key: `BSO${Date.now()}`.slice(0, 16), description: "", projectType: "tesbox" },
      })
    ).json();
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Scope Mismatch ${Date.now()}`, severity: "Medium" },
      })
    ).json();
    try {
      const res = await request.get(`/api/projects/${otherProject.id}/bugs/${created.externalId}`, { failOnStatusCode: false });
      expect(res.status()).toBe(404);

      // Same for the uuid: a real bug, but not this project's.
      const resByUuid = await request.get(`/api/projects/${otherProject.id}/bugs/${created.id}`, { failOnStatusCode: false });
      expect(resByUuid.status()).toBe(404);
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${otherProject.id}`, { failOnStatusCode: false });
    }
  });

  test("a deleted bug's external id is not found, and a malformed id 404s rather than 500ing", async ({ request }) => {
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Scope Deleted ${Date.now()}`, severity: "Low" },
      })
    ).json();
    await request.delete(`/api/bugs/${created.id}`);

    const afterDelete = await request.get(`/api/projects/${ctx.projectId}/bugs/${created.externalId}`, { failOnStatusCode: false });
    expect(afterDelete.status()).toBe(404);

    const malformed = await request.get(`/api/projects/${ctx.projectId}/bugs/NOPE-BUG-999999`, { failOnStatusCode: false });
    expect(malformed.status()).toBe(404);
  });
});

/*
 * Edit Bug's Jira/Linear field — previously a plain URL box that always sent
 * integrationIssueKey: null on save, so an already-linked ticket could never actually be changed
 * from the edit screen. The picker itself (Tesbo-Frontend/components/IssuePickerModal.tsx, reused
 * from LogBugDialog's "single" mode) is covered in ui/bugs.spec.ts; this is the part it depends
 * on — that PATCH already accepts a new integrationProvider/integrationIssueKey pair and applies
 * it to the SAME bug row rather than requiring a new one.
 */
test.describe("bug integration link", () => {
  test("changing the linked ticket updates the same bug in place, not a new one", async ({ request }) => {
    const title = `E2E Bug Ticket Switch ${Date.now()}`;
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: {
          title,
          integrationProvider: "JIRA",
          integrationIssueKey: "KAN-9",
          externalUrl: "https://e2e.atlassian.net/browse/KAN-9",
        },
      })
    ).json();

    try {
      expect(created.integrationIssueKey).toBe("KAN-9");

      const updated = await (
        await request.patch(`/api/bugs/${created.id}`, {
          data: {
            integrationProvider: "JIRA",
            integrationIssueKey: "KAN-10",
            externalUrl: "https://e2e.atlassian.net/browse/KAN-10",
          },
        })
      ).json();

      expect(updated.id, "the same bug must be updated, not a new one").toBe(created.id);
      expect(updated.integrationIssueKey).toBe("KAN-10");
      expect(updated.externalUrl).toBe("https://e2e.atlassian.net/browse/KAN-10");

      const fetched = await (await request.get(`/api/bugs/${created.id}`)).json();
      expect(fetched.integrationIssueKey, "the old key must not still be current after the switch").toBe("KAN-10");

      const list = await (await request.get(`/api/projects/${ctx.projectId}/bugs`)).json();
      const matches = list.filter((b: { title: string }) => b.title === title);
      expect(matches, "switching tickets must not leave a second bug behind").toHaveLength(1);
      expect(matches[0].integrationIssueKey).toBe("KAN-10");
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("switching provider from Jira to Linear replaces both the provider and the key together", async ({ request }) => {
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: {
          title: `E2E Bug Provider Switch ${Date.now()}`,
          integrationProvider: "JIRA",
          integrationIssueKey: "KAN-9",
          externalUrl: "https://e2e.atlassian.net/browse/KAN-9",
        },
      })
    ).json();

    try {
      const updated = await (
        await request.patch(`/api/bugs/${created.id}`, {
          data: {
            integrationProvider: "LINEAR",
            integrationIssueKey: "ENG-77",
            externalUrl: "https://linear.app/e2e/issue/ENG-77",
          },
        })
      ).json();

      // A stale Jira key must never survive under integrationProvider: "LINEAR" — the two fields
      // have to change atomically, not leave a mismatched pair.
      expect(updated.integrationProvider).toBe("LINEAR");
      expect(updated.integrationIssueKey).toBe("ENG-77");
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Bug priority — Basecamp 10226247009.
 *
 * A second axis beside severity: severity is how bad the defect is, priority is how soon it is
 * worked on. P0..P3 (the scale testcases already use) rather than repeating severity's words, and
 * nullable, because "nobody has triaged this" is a real state and not the same as P2.
 */
test.describe("bug priority", () => {
  test("a bug can be created with a priority, and one created without stays untriaged", { tag: '@tesbo.testId("TES-TC-1154")' }, async ({ request }) => {
    const withPriority = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Priority ${Date.now()}`, severity: "Low", priority: "P1" },
      })
    ).json();
    const without = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug No Priority ${Date.now()}` },
      })
    ).json();

    try {
      expect(withPriority.priority).toBe("P1");
      // Severity and priority are independent: a Low-severity P1 is the whole point of having both.
      expect(withPriority.severity).toBe("Low");

      // Not defaulted to a middle value — an invented P2 would be indistinguishable from a triage
      // decision someone actually made.
      expect(without.priority).toBeNull();

      const listed = await (await request.get(`/api/projects/${ctx.projectId}/bugs`)).json();
      const found = listed.find((b: { id: string }) => b.id === withPriority.id);
      expect(found.priority, "priority has to survive the list endpoint, not just the create response").toBe("P1");
    } finally {
      for (const bug of [withPriority, without]) {
        await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      }
    }
  });

  test("priority can be set, changed and cleared back to untriaged", { tag: '@tesbo.testId("TES-TC-1155")' }, async ({ request }) => {
    const bug = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Priority Edit ${Date.now()}` },
      })
    ).json();

    try {
      const set = await (await request.patch(`/api/bugs/${bug.id}`, { data: { priority: "P0" } })).json();
      expect(set.priority).toBe("P0");

      const changed = await (await request.patch(`/api/bugs/${bug.id}`, { data: { priority: "P3" } })).json();
      expect(changed.priority).toBe("P3");

      // Omitting the field leaves it alone — the same COALESCE contract every other field has.
      const untouched = await (await request.patch(`/api/bugs/${bug.id}`, { data: { title: `${bug.title} v2` } })).json();
      expect(untouched.priority).toBe("P3");

      // But an explicit null clears it: a bug can go back to untriaged, which COALESCE alone could
      // never express.
      const cleared = await (await request.patch(`/api/bugs/${bug.id}`, { data: { priority: null } })).json();
      expect(cleared.priority).toBeNull();
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("an unknown priority is refused by name, and stores nothing", { tag: '@tesbo.testId("TES-TC-1156")' }, async ({ request }) => {
    const before = (await (await request.get(`/api/projects/${ctx.projectId}/bugs`)).json()).length;

    for (const bad of ["P9", "urgent", "critical", 7]) {
      const res = await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Bad Priority ${Date.now()}`, priority: bad },
        failOnStatusCode: false,
      });
      expect(res.status(), `priority ${JSON.stringify(bad)} should be a clean 400, not a 500`).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("P0");
      expect(body.field).toBe("priority");
    }

    const after = (await (await request.get(`/api/projects/${ctx.projectId}/bugs`)).json()).length;
    expect(after, "a refused create must not leave a bug behind").toBe(before);
  });

  test("priority is matched case-insensitively, the way severity already is", { tag: '@tesbo.testId("TES-TC-1157")' }, async ({ request }) => {
    const bug = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Priority Case ${Date.now()}`, priority: "p2" },
      })
    ).json();
    try {
      expect(bug.priority, "stored canonically whatever case it arrived in").toBe("P2");
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Severity is optional — "Priority and Severity Should Display 'Select' by Default When Logging a New
 * Bug". Severity used to be NOT NULL DEFAULT 'Medium', so a bug nobody had judged was stored, listed
 * and reported as Medium. V130 makes it nullable with the same contract priority already has: absent,
 * null and "" all mean "not selected" on create; on edit an omitted key leaves it alone and an explicit
 * null or "" clears it.
 */
test.describe("bug severity is optional", () => {
  test("BUG-A-SEV-01 a bug created without a severity has none, rather than a defaulted Medium", async ({ request }) => {
    const omitted = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, { data: { title: `E2E Bug No Severity ${Date.now()}` } })
    ).json();
    const blank = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Blank Severity ${Date.now()}`, severity: "" },
      })
    ).json();
    const explicitNull = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Null Severity ${Date.now()}`, severity: null },
      })
    ).json();
    try {
      for (const bug of [omitted, blank, explicitNull]) {
        expect(bug.id, "the create succeeded").toBeTruthy();
        expect(bug.severity).toBeNull();
      }
      const listed = await (await request.get(`/api/projects/${ctx.projectId}/bugs`)).json();
      const found = listed.find((b: { id: string }) => b.id === omitted.id);
      expect(found.severity, "no severity has to survive the list endpoint, not just the create response").toBeNull();
      // And the single-bug read.
      expect((await (await request.get(`/api/bugs/${omitted.id}`)).json()).severity).toBeNull();
    } finally {
      for (const bug of [omitted, blank, explicitNull]) {
        if (bug?.id) await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      }
    }
  });

  test("BUG-A-SEV-02 severity can be set, changed, left alone, and cleared back to not selected", async ({ request }) => {
    const bug = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, { data: { title: `E2E Bug Severity Edit ${Date.now()}` } })
    ).json();
    try {
      const set = await (await request.patch(`/api/bugs/${bug.id}`, { data: { severity: "High" } })).json();
      expect(set.severity).toBe("High");

      const changed = await (await request.patch(`/api/bugs/${bug.id}`, { data: { severity: "low" } })).json();
      expect(changed.severity, "matched case-insensitively and stored canonically").toBe("Low");

      // Omitting the key leaves it alone.
      const untouched = await (await request.patch(`/api/bugs/${bug.id}`, { data: { title: `${bug.title} v2` } })).json();
      expect(untouched.severity).toBe("Low");

      // An explicit null clears it…
      const cleared = await (await request.patch(`/api/bugs/${bug.id}`, { data: { severity: null } })).json();
      expect(cleared.severity).toBeNull();

      // …and so does "", which is what the Edit form's "Not selected" option submits.
      await request.patch(`/api/bugs/${bug.id}`, { data: { severity: "Critical" } });
      const clearedByBlank = await (await request.patch(`/api/bugs/${bug.id}`, { data: { severity: "" } })).json();
      expect(clearedByBlank.severity).toBeNull();
      expect((await (await request.get(`/api/bugs/${bug.id}`)).json()).severity, "persisted, not just echoed").toBeNull();
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-A-SEV-03 an unknown severity is still refused by name on create and on edit, and changes nothing", async ({ request }) => {
    const bug = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E Bug Bad Severity Edit ${Date.now()}`, severity: "High" },
      })
    ).json();
    try {
      for (const bad of ["Trivial", "Not selected", 3]) {
        const createRes = await request.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: { title: `E2E Bug Bad Severity ${Date.now()}`, severity: bad },
          failOnStatusCode: false,
        });
        expect(createRes.status(), `create with severity ${JSON.stringify(bad)}`).toBe(400);
        expect((await createRes.json()).field).toBe("severity");

        const editRes = await request.patch(`/api/bugs/${bug.id}`, { data: { severity: bad }, failOnStatusCode: false });
        expect(editRes.status(), `edit with severity ${JSON.stringify(bad)}`).toBe(400);
        expect((await editRes.json()).field).toBe("severity");
      }
      expect((await (await request.get(`/api/bugs/${bug.id}`)).json()).severity, "a refused edit leaves the stored value").toBe("High");
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Linking a bug marks the execution Failed — Basecamp 10226284379 and 10221755377, the same request
 * from two reporters.
 *
 * The run screen already prompts for a bug when you mark something Failed. This is the reverse path:
 * a bug reported from the Bugs page, or a link added later, used to leave the execution Untested, so
 * the run's own numbers said nothing had gone wrong.
 *
 * Decided behaviour: it ALWAYS sets Failed, including over a result someone already recorded — a bug
 * against a case that currently reads Passed is exactly the case worth flipping. The previous status
 * goes into the activity payload so the override is visible rather than silent.
 */
test.describe("linking a bug fails the execution", () => {
  async function seedRunWithCase(request: any, titleSuffix: string) {
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Bug AutoFail Run ${titleSuffix}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Bug AutoFail Case ${titleSuffix}` },
      })
    ).json();
    await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
    const executions = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
    const execution = (executions.list ?? executions).find(
      (e: { testcaseId: string }) => e.testcaseId === testcase.id,
    );
    return { cycle, testcase, execution };
  }

  async function executionStatus(request: any, cycleId: string, executionId: string): Promise<string> {
    const executions = await (await request.get(`/api/cycles/${cycleId}/executions`)).json();
    const found = (executions.list ?? executions).find((e: { id: string }) => e.id === executionId);
    return found?.status;
  }

  test("reporting a bug against an untested case marks it Failed", { tag: '@tesbo.testId("TES-TC-1158")' }, async ({ request }) => {
    const suffix = `${Date.now()}`;
    const { cycle, testcase, execution } = await seedRunWithCase(request, suffix);
    expect(execution.status, "the fixture has to start untested for this to prove anything").toBe("Untested");

    const bug = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: {
          title: `E2E AutoFail Bug ${suffix}`,
          links: [{ testcaseId: testcase.id, cycleId: cycle.id, executionId: execution.id }],
        },
      })
    ).json();

    try {
      expect(await executionStatus(request, cycle.id, execution.id)).toBe("Failed");
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });

  test("a passed result is overridden, and the override is recorded in the activity stream", { tag: '@tesbo.testId("TES-TC-1159")' }, async ({ request }) => {
    const suffix = `${Date.now()}`;
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const { cycle, testcase, execution } = await seedRunWithCase(request, `override ${suffix}`);
    await request.patch(`/api/cycles/${cycle.id}/executions/${execution.id}`, { data: { status: "Passed" } });
    expect(await executionStatus(request, cycle.id, execution.id)).toBe("Passed");

    const bug = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: {
          title: `E2E AutoFail Override ${suffix}`,
          links: [{ testcaseId: testcase.id, cycleId: cycle.id, executionId: execution.id }],
        },
      })
    ).json();

    try {
      expect(await executionStatus(request, cycle.id, execution.id)).toBe("Failed");

      // Overwriting somebody's recorded result silently would be worse than not doing it at all —
      // the previous value has to be recoverable from the activity stream.
      //
      // Filtered rather than read off page 1: this project is account A's shared fixture, and during
      // a full run it takes ~70 audit rows a minute, so the default 30-row page had scrolled past
      // this entry before the assertion ran. entityType + since + the maximum page size narrows it
      // to the handful of execution events from this test's own window.
      const activity = await (
        await request.get(`/api/projects/${ctx.projectId}/activity`, {
          params: { entityType: "execution", since: startedAt, limit: 100 },
        })
      ).json();
      const rows = activity.list ?? activity.items ?? activity;
      const entry = rows.find(
        (a: { entityId?: string; diff?: any }) => a.entityId === execution.id && a.diff?.reason === "bug_linked",
      );
      expect(entry, "the flip should be logged with its reason").toBeTruthy();
      expect(entry.diff.before.status).toBe("Passed");
      expect(entry.diff.after.status).toBe("Failed");
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });

  test("adding a link to an existing bug fails that execution too", { tag: '@tesbo.testId("TES-TC-1160")' }, async ({ request }) => {
    const suffix = `${Date.now()}`;
    const { cycle, testcase, execution } = await seedRunWithCase(request, `late link ${suffix}`);

    // Reported with no link at all, so nothing can have been failed at create time.
    const bug = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: { title: `E2E AutoFail Late Link ${suffix}` },
      })
    ).json();

    try {
      expect(await executionStatus(request, cycle.id, execution.id)).toBe("Untested");

      await request.post(`/api/bugs/${bug.id}/links`, {
        data: { testcaseId: testcase.id, cycleId: cycle.id, executionId: execution.id },
      });
      expect(await executionStatus(request, cycle.id, execution.id)).toBe("Failed");
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });

  test("a link with no execution behind it changes nothing and does not fail the request", { tag: '@tesbo.testId("TES-TC-1161")' }, async ({ request }) => {
    // Linking a bug to a test case WITHOUT naming a run is legitimate — the case exists, no execution
    // does. The old code path did nothing here; the new one must also do nothing, quietly.
    const suffix = `${Date.now()}`;
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E AutoFail Unlinked Case ${suffix}` },
      })
    ).json();

    const res = await request.post(`/api/projects/${ctx.projectId}/bugs`, {
      data: { title: `E2E AutoFail No Execution ${suffix}`, links: [{ testcaseId: testcase.id }] },
      failOnStatusCode: false,
    });

    try {
      expect(res.status(), await res.text()).toBeLessThan(300);
      expect((await res.json()).links).toHaveLength(1);
    } finally {
      const bug = await res.json().catch(() => null);
      if (bug?.id) await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });

  test("a bogus execution id in the links is ignored rather than 500ing", { tag: '@tesbo.testId("TES-TC-1162")' }, async ({ request }) => {
    // The id travels in the request body, so it can name anything at all — including an execution in
    // a workspace the caller cannot see. The project join is what stops that reaching an UPDATE.
    const suffix = `${Date.now()}`;
    const res = await request.post(`/api/projects/${ctx.projectId}/bugs`, {
      data: {
        title: `E2E AutoFail Bogus Execution ${suffix}`,
        links: [{ executionId: "00000000-0000-0000-0000-000000000000" }],
      },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBeLessThan(300);
    const bug = await res.json();
    await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
  });
});

/*
 * Bug assignee — "[Test Runs] Unable to assign test cases for execution".
 *
 * Bugs had no assignee concept at all before this. Mirrors executions.assignee_id's design and its
 * membership rule: the assignee has to be a member of the bug's own project, or the bug becomes work
 * nobody who holds it can actually open.
 *
 * Its own tenant (unlike the rest of this file) because these tests need a workspace member who is
 * deliberately NOT a project member, to prove that rejection — account A's shared fixture has no
 * such user to reach for.
 */
test.describe("bug assignee", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("bugs-assignee");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
  });

  test.afterAll(async () => {
    if (tenant) resetRbacMembership(tenant);
    await asOwner?.dispose();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test("a bug can be created with an assignee, and it survives the list endpoint", { tag: '@tesbo.testId("TES-TC-1905")' }, async () => {
    const created = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title: `E2E Bug Assignee ${Date.now()}`, assigneeId: tenant!.qa.userId },
      })
    ).json();
    try {
      expect(created.assigneeId).toBe(tenant!.qa.userId);
      expect(created.assigneeName, "the display name has to come back too, not just the id").toBeTruthy();

      const listed = await (await asOwner.get(`/api/projects/${tenant!.mainProjectId}/bugs`)).json();
      const found = listed.find((b: { id: string }) => b.id === created.id);
      expect(found.assigneeId).toBe(tenant!.qa.userId);
    } finally {
      await asOwner.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("a bug created with no assignee is unassigned, not an error", { tag: '@tesbo.testId("TES-TC-1906")' }, async () => {
    const created = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title: `E2E Bug No Assignee ${Date.now()}` },
      })
    ).json();
    try {
      expect(created.assigneeId).toBeNull();
    } finally {
      await asOwner.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("creating with a non-member assignee is refused, and no bug is left behind", { tag: '@tesbo.testId("TES-TC-1907")' }, async () => {
    const before = (await (await asOwner.get(`/api/projects/${tenant!.mainProjectId}/bugs`)).json()).length;

    const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
      data: { title: `E2E Bug Bad Assignee ${Date.now()}`, assigneeId: tenant!.guest.userId },
      failOnStatusCode: false,
    });
    expect(res.status(), `assigning a non-member on create answered ${res.status()}`).toBeGreaterThanOrEqual(400);

    const after = (await (await asOwner.get(`/api/projects/${tenant!.mainProjectId}/bugs`)).json()).length;
    expect(after, "a refused assignee must reject the whole create, not leave an unassigned bug behind").toBe(before);
  });

  test("assigneeId can be set, cleared via null, and an omitted key leaves it alone", { tag: '@tesbo.testId("TES-TC-1908")' }, async () => {
    const bug = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title: `E2E Bug Assignee Edit ${Date.now()}` },
      })
    ).json();

    try {
      const set = await (
        await asOwner.patch(`/api/bugs/${bug.id}`, { data: { assigneeId: tenant!.manager.userId } })
      ).json();
      expect(set.assigneeId).toBe(tenant!.manager.userId);

      // Omitting the field leaves it alone — the same COALESCE contract priority already has.
      const untouched = await (
        await asOwner.patch(`/api/bugs/${bug.id}`, { data: { title: `${bug.title} v2` } })
      ).json();
      expect(untouched.assigneeId).toBe(tenant!.manager.userId);

      // An explicit null clears it, which COALESCE alone could never express.
      const cleared = await (await asOwner.patch(`/api/bugs/${bug.id}`, { data: { assigneeId: null } })).json();
      expect(cleared.assigneeId).toBeNull();
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("updating to a non-member assignee is refused, and the previous value survives", { tag: '@tesbo.testId("TES-TC-1909")' }, async () => {
    const bug = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title: `E2E Bug Assignee Reject ${Date.now()}`, assigneeId: tenant!.qa.userId },
      })
    ).json();

    try {
      const res = await asOwner.patch(`/api/bugs/${bug.id}`, {
        data: { assigneeId: tenant!.guest.userId },
        failOnStatusCode: false,
      });
      expect(res.status(), `assigning a non-member on update answered ${res.status()}`).toBeGreaterThanOrEqual(400);

      const after = await (await asOwner.get(`/api/bugs/${bug.id}`)).json();
      expect(after.assigneeId, "a refused reassignment must not overwrite the existing assignee").toBe(tenant!.qa.userId);
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("a malformed assigneeId is refused by name, and stores nothing", { tag: '@tesbo.testId("TES-TC-1910")' }, async () => {
    const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
      data: { title: `E2E Bug Bad Assignee Format ${Date.now()}`, assigneeId: "not-a-uuid" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(404);
  });

  test("a project with a single member can assign a bug to themself", { tag: '@tesbo.testId("TES-TC-1911")' }, async () => {
    // Boundary: the owner is the only member of secondProjectId in this fixture.
    const created = await (
      await asOwner.post(`/api/projects/${tenant!.secondProjectId}/bugs`, {
        data: { title: `E2E Bug Self Assign ${Date.now()}`, assigneeId: tenant!.owner.userId },
      })
    ).json();
    try {
      expect(created.assigneeId).toBe(tenant!.owner.userId);
    } finally {
      await asOwner.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }
  });

  /*
   * The assignee could be set and read back, but nothing let a caller ask "which bugs are assigned to
   * X" or "which have nobody" — the gap behind the report that assignment "isn't available": it was,
   * but nothing surfaced it. "unassigned" is its own sentinel value (not an omitted/empty param,
   * which means "no filter") because IS NULL has to be reachable as a deliberate choice.
   */
  test("listBugs filters by assigneeId, and by the unassigned sentinel", async () => {
    const suffix = Date.now();
    const assigned = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title: `E2E Bug Filter Assigned ${suffix}`, assigneeId: tenant!.qa.userId },
      })
    ).json();
    const unassigned = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title: `E2E Bug Filter Unassigned ${suffix}` },
      })
    ).json();

    try {
      const byAssignee = await (
        await asOwner.get(`/api/projects/${tenant!.mainProjectId}/bugs`, {
          params: { assigneeId: tenant!.qa.userId },
        })
      ).json();
      expect(byAssignee.some((b: { id: string }) => b.id === assigned.id), "the assignee's own bug must be included").toBeTruthy();
      expect(byAssignee.some((b: { id: string }) => b.id === unassigned.id), "an unassigned bug must not match a real assignee").toBeFalsy();

      const unassignedOnly = await (
        await asOwner.get(`/api/projects/${tenant!.mainProjectId}/bugs`, { params: { assigneeId: "unassigned" } })
      ).json();
      expect(unassignedOnly.some((b: { id: string }) => b.id === unassigned.id), "the unassigned bug must match the sentinel").toBeTruthy();
      expect(unassignedOnly.some((b: { id: string }) => b.id === assigned.id), "an assigned bug must not match \"unassigned\"").toBeFalsy();
    } finally {
      await asOwner.delete(`/api/bugs/${assigned.id}`, { failOnStatusCode: false });
      await asOwner.delete(`/api/bugs/${unassigned.id}`, { failOnStatusCode: false });
    }
  });

  /*
   * bugSelect already did COALESCE(u.name, u.email) for the REPORTER; the assignee join
   * (actor_profiles.display_name) had no such fallback, and users.name is nullable. Once
   * assigneeName is rendered directly in the UI, an email-only signup would have read as "Unknown
   * assignee" despite being a completely valid assignment. Found while adding that display, fixed
   * to match reporter_name's existing COALESCE.
   */
  test("an assignee with no display name set falls back to their email, not a blank name", async () => {
    exec(`UPDATE users SET name = NULL WHERE id = ${literal(tenant!.qa.userId)}`);
    try {
      const created = await (
        await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
          data: { title: `E2E Bug Nameless Assignee ${Date.now()}`, assigneeId: tenant!.qa.userId },
        })
      ).json();
      try {
        expect(created.assigneeName).toBe(tenant!.qa.email);
      } finally {
        await asOwner.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
      }
    } finally {
      exec(`UPDATE users SET name = ${literal(`E2E bugs-assignee QA`)} WHERE id = ${literal(tenant!.qa.userId)}`);
    }
  });
});

/*
 * Hard-delete remediation Phase 2. Two bug-owned sites from the cycles/cycle_items read-path gap
 * sweep: sanitizeBugLinks' cycle-id validation (a soft-deleted cycle must be refused the same way an
 * unknown one already is, not silently accepted into a link) and bugSelect's linked-cycle name (a
 * historical display: the link record should keep saying which run the bug was found in even after
 * that run is gone, marked "(deleted)" rather than dropped — the suites precedent, not the filter
 * precedent the other 15 sites got).
 */
test.describe("bug links and soft-deleted cycles (hard-delete remediation Phase 2)", () => {
  test("sanitizeBugLinks refuses a soft-deleted cycle's id the same way it refuses an unknown one", async ({ request }) => {
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E Bug Link Deleted Cycle ${Date.now()}` } })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Bug Link Deleted Cycle Case ${Date.now()}` } })
    ).json();

    try {
      const deleteRes = await request.delete(`/api/cycles/${cycle.id}`);
      expect(deleteRes.ok(), `deleting the run — ${await deleteRes.text()}`).toBeTruthy();
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM cycles WHERE id = ${literal(cycle.id)};`)).toBe("t");

      // Before this fix, sanitizeBugLinks' cycle lookup had no deleted_at filter, so a soft-deleted
      // run's id still passed validation and the link was accepted, pointing traceability at a run
      // that every other screen already treats as gone.
      const created = await (
        await request.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: {
            title: `E2E Bug Against Deleted Cycle ${Date.now()}`,
            links: [{ testcaseId: testcase.id, cycleId: cycle.id }],
          },
        })
      ).json();

      try {
        expect(created.links).toHaveLength(1);
        expect(created.links[0].testcaseId, "the testcase half of the link is still valid and kept").toBe(testcase.id);
        expect(created.links[0].cycleId, "the soft-deleted cycle id must be dropped, same as an unknown one").toBeNull();
      } finally {
        await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
      }
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });

  test("a bug's linked-cycle name survives the run being deleted, marked rather than blanked", async ({ request }) => {
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E Bug Link Historical Cycle ${Date.now()}` } })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Bug Link Historical Case ${Date.now()}` } })
    ).json();
    await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });

    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: {
          title: `E2E Bug With Historical Link ${Date.now()}`,
          links: [{ testcaseId: testcase.id, cycleId: cycle.id }],
        },
      })
    ).json();

    try {
      expect(created.links[0].cycleName).toBe(cycle.name);

      const deleteRes = await request.delete(`/api/cycles/${cycle.id}`);
      expect(deleteRes.ok(), `deleting the run — ${await deleteRes.text()}`).toBeTruthy();

      // The link record itself (bug_links.cycle_id) is untouched by the run's own soft-delete — no
      // FK cascades it, no fix rewrote it — so the bug still reads as linked to that run, and the
      // GET below is what proves the display survives, not merely the raw column.
      const afterDelete = await (await request.get(`/api/bugs/${created.id}`)).json();
      expect(afterDelete.links).toHaveLength(1);
      expect(afterDelete.links[0].cycleId, "the link itself is untouched by the run's soft-delete").toBe(cycle.id);
      expect(afterDelete.links[0].cycleName, "the name must be marked deleted, not blanked or left stale").toBe(`${cycle.name} (deleted)`);
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Hard-delete remediation Phase 3: `bugs` itself. deleteBug issued a real `DELETE FROM bugs`, and
 * bug_links.bug_id was ON DELETE CASCADE, so deleting a bug destroyed every trace link with no audit
 * trail. V113 converts it to a soft-delete, matching testcases/suites/cycles. These tests prove the
 * row genuinely survives (not just that the API stops showing it), that its links survive alongside
 * it untouched, that the evidence-upload gate now rejects a deleted bug, and that the per-project
 * BUG-n sequence is never reissued.
 */
test.describe("bug soft-delete (hard-delete remediation Phase 3)", () => {
  test("deleting a bug soft-deletes the row and leaves its links physically intact, not cascaded away", async ({ request }) => {
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Bug Soft-Delete Case ${Date.now()}` } })
    ).json();
    try {
      const created = await (
        await request.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: { title: `E2E Bug Soft-Delete ${Date.now()}`, links: [{ testcaseId: testcase.id }] },
        })
      ).json();
      expect(created.links).toHaveLength(1);

      const delRes = await request.delete(`/api/bugs/${created.id}`);
      expect(delRes.ok(), `deleting the bug — ${await delRes.text()}`).toBeTruthy();

      // DB-level proof, not just the API's 404 — the row must still physically exist, soft-deleted,
      // and its bug_links row must survive untouched (RESTRICT on bug_links.bug_id, no cascade fired).
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM bugs WHERE id = ${literal(created.id)};`)).toBe("t");
      expect(scalar(`SELECT COUNT(*)::text FROM bugs WHERE id = ${literal(created.id)};`)).toBe("1");
      expect(scalar(`SELECT COUNT(*)::text FROM bug_links WHERE bug_id = ${literal(created.id)};`)).toBe("1");

      // Every read path 404s/excludes it, exactly as if it were gone.
      const getRes = await request.get(`/api/bugs/${created.id}`, { failOnStatusCode: false });
      expect(getRes.status()).toBe(404);
      const list = await (await request.get(`/api/projects/${ctx.projectId}/bugs`)).json();
      expect(list.some((b: { id: string }) => b.id === created.id)).toBeFalsy();
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });

  test("uploading evidence to a soft-deleted bug is rejected, not silently accepted", async ({ request }) => {
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, { data: { title: `E2E Bug Evidence Gate ${Date.now()}` } })
    ).json();
    const delRes = await request.delete(`/api/bugs/${created.id}`);
    expect(delRes.ok(), `deleting the bug — ${await delRes.text()}`).toBeTruthy();

    const uploadRes = await request.post(`/api/projects/${ctx.projectId}/bugs/${created.id}/attachments`, {
      multipart: { files: { name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from("late evidence") } },
      failOnStatusCode: false,
    });
    expect(uploadRes.status(), "a soft-deleted bug must not accept new evidence").toBe(404);
  });

  test("a deleted bug's external id is never reissued to a later bug", async ({ request }) => {
    const first = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, { data: { title: `E2E Bug Seq A ${Date.now()}` } })
    ).json();
    const delRes = await request.delete(`/api/bugs/${first.id}`);
    expect(delRes.ok(), `deleting the first bug — ${await delRes.text()}`).toBeTruthy();

    const second = await (
      await request.post(`/api/projects/${ctx.projectId}/bugs`, { data: { title: `E2E Bug Seq B ${Date.now()}` } })
    ).json();
    try {
      expect(second.externalId, "the second bug's sequence number must not collide with the deleted first bug's").not.toBe(first.externalId);
    } finally {
      await request.delete(`/api/bugs/${second.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Hard-delete remediation Phase 7: bug_links itself, per Q-BL's ruling ("soft-delete it properly").
 * removeBugLink issued a real DELETE, and replaceBugLinks did a blind delete-all-then-reinsert on
 * every bug edit. V117 converts both to soft-delete via a diff: only rows genuinely absent from the
 * new set are soft-deleted, only genuinely new pairs are inserted, and an unchanged link keeps its
 * original id.
 */
test.describe("bug_links soft-delete (hard-delete remediation Phase 7)", () => {
  test("removing a bug link soft-deletes the row — it is not physically removed", async ({ request }) => {
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Link Soft-Delete Case ${Date.now()}` } })
    ).json();
    try {
      const created = await (
        await request.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: { title: `E2E Link Soft-Delete Bug ${Date.now()}`, links: [{ testcaseId: testcase.id }] },
        })
      ).json();
      const linkId = created.links[0].id;

      const delRes = await request.delete(`/api/bugs/${created.id}/links/${linkId}`);
      expect(delRes.ok(), `removing the link — ${await delRes.text()}`).toBeTruthy();

      // DB-level proof, not just the API excluding it from the response above.
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM bug_links WHERE id = ${literal(linkId)};`)).toBe("t");
      expect(scalar(`SELECT COUNT(*)::text FROM bug_links WHERE id = ${literal(linkId)};`)).toBe("1");

      // Re-linking the same bug to the same test case after removal must not silently no-op
      // (the pre-fix plain UNIQUE constraint would have blocked this forever).
      const relinked = await (
        await request.post(`/api/bugs/${created.id}/links`, { data: { testcaseId: testcase.id } })
      ).json();
      const newLink = relinked.links.find((l: { testcaseId: string }) => l.testcaseId === testcase.id);
      expect(newLink, "re-linking after removal must create a fresh, live link").toBeTruthy();
      expect(newLink.id, "the re-link must be a new row, not the soft-deleted original resurrected").not.toBe(linkId);

      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });

  test("editing a bug's links only touches what changed — an unmodified link keeps its id", async ({ request }) => {
    const testcaseA = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Link Diff Case A ${Date.now()}` } })
    ).json();
    const testcaseB = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Link Diff Case B ${Date.now()}` } })
    ).json();
    try {
      const created = await (
        await request.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: { title: `E2E Link Diff Bug ${Date.now()}`, links: [{ testcaseId: testcaseA.id }] },
        })
      ).json();
      const originalLinkId = created.links[0].id;

      // Replace the whole links array: keep A, drop nothing new, add B.
      const updated = await (
        await request.patch(`/api/bugs/${created.id}`, {
          data: { links: [{ testcaseId: testcaseA.id }, { testcaseId: testcaseB.id }] },
        })
      ).json();

      expect(updated.links).toHaveLength(2);
      const linkA = updated.links.find((l: { testcaseId: string }) => l.testcaseId === testcaseA.id);
      expect(linkA.id, "an unchanged link must not be recreated by a diff-based replace").toBe(originalLinkId);

      // Now drop A, keep only B — A's original row must survive, soft-deleted, not resurrected.
      await request.patch(`/api/bugs/${created.id}`, { data: { links: [{ testcaseId: testcaseB.id }] } });
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM bug_links WHERE id = ${literal(originalLinkId)};`)).toBe("t");

      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseA.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseB.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Comments on a bug (V129) — GET/POST /api/projects/:projectId/bugs/:bugId/comments, and PATCH/DELETE
 * …/comments/:commentId. Chronological, with replies one level deep (V131, `parentCommentId`); no
 * resolve. The body is Markdown, stored
 * exactly as sent; a comment can carry files (multipart, entity_type 'bug_comment' in attachments).
 * Role rules (author edits; author/owner/manager deletes) are in "bug comment permissions" below.
 * The read-only plan lock is covered in billing-lifecycle.spec.ts (BUGC-A-10), which owns the tenant
 * that can be locked.
 */
test.describe("bug comments", () => {
  let asB: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    asB = await playwrightRequest.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    // The request fixture inherits account A's storageState; clear it for a truly anonymous caller.
    anon = await playwrightRequest.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
  });

  test.afterAll(async () => {
    await asB?.dispose();
    await anon?.dispose();
  });

  function commentsUrl(bugId: string, projectId: string = ctx.projectId) {
    return `/api/projects/${projectId}/bugs/${bugId}/comments`;
  }

  async function newBug(request: APIRequestContext, label: string): Promise<{ id: string; title: string }> {
    const res = await request.post(`/api/projects/${ctx.projectId}/bugs`, {
      data: { title: `E2E Bug Comments ${label} ${Date.now()}` },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  }

  test("BUGC-A-01 a bug with no comments lists an empty set", async ({ request }) => {
    const bug = await newBug(request, "Empty");
    try {
      const res = await request.get(commentsUrl(bug.id));
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ list: [], total: 0 });
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-02 adding a comment returns it with its author and timestamp, trimmed, and it is listed", async ({ request }) => {
    const bug = await newBug(request, "Add");
    const me = await (await request.get("/api/auth/me")).json();
    try {
      const startedAt = Date.now();
      const res = await request.post(commentsUrl(bug.id), { data: { body: "  Reproduced on staging too.  " } });
      expect(res.status(), await res.text()).toBe(201);
      const created = await res.json();
      expect(created).toMatchObject({ bugId: bug.id, authorId: me.userId, body: "Reproduced on staging too." });
      expect(typeof created.id).toBe("string");
      expect(created.authorName).toBeTruthy();
      expect(created.authorName).not.toBe("Unknown");
      expect(Date.parse(created.createdAt)).toBeGreaterThanOrEqual(startedAt - 60_000);

      const listed = await (await request.get(commentsUrl(bug.id))).json();
      expect(listed.total).toBe(1);
      expect(listed.list).toEqual([created]);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-03 comments list oldest first, and an identical body posted twice is kept twice", async ({ request }) => {
    const bug = await newBug(request, "Order");
    try {
      for (const body of ["first", "second", "second"]) {
        expect((await request.post(commentsUrl(bug.id), { data: { body } })).ok()).toBeTruthy();
      }
      const listed = await (await request.get(commentsUrl(bug.id))).json();
      expect(listed.total).toBe(3);
      expect(listed.list.map((c: { body: string }) => c.body)).toEqual(["first", "second", "second"]);
      expect(new Set(listed.list.map((c: { id: string }) => c.id)).size).toBe(3);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-04 an empty, whitespace-only, missing or non-text body is refused and nothing is stored", async ({ request }) => {
    const bug = await newBug(request, "Invalid");
    try {
      for (const data of [{ body: "" }, { body: "   \n\t " }, {}, { body: null }]) {
        const res = await request.post(commentsUrl(bug.id), { data, failOnStatusCode: false });
        expect(res.status(), JSON.stringify(data)).toBe(400);
        expect((await res.json()).error).toBe("Comment cannot be empty.");
      }
      for (const data of [{ body: 42 }, { body: { text: "hi" } }, { body: ["hi"] }]) {
        const res = await request.post(commentsUrl(bug.id), { data, failOnStatusCode: false });
        expect(res.status(), JSON.stringify(data)).toBe(400);
        expect((await res.json()).error).toBe("Comment must be text.");
      }
      expect((await (await request.get(commentsUrl(bug.id))).json()).total).toBe(0);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-05 10,000 characters is accepted and 10,001 is refused", async ({ request }) => {
    const bug = await newBug(request, "Length");
    try {
      const atLimit = await request.post(commentsUrl(bug.id), { data: { body: "x".repeat(10_000) } });
      expect(atLimit.status()).toBe(201);
      expect((await atLimit.json()).body).toHaveLength(10_000);

      const over = await request.post(commentsUrl(bug.id), { data: { body: "x".repeat(10_001) }, failOnStatusCode: false });
      expect(over.status()).toBe(400);
      expect((await over.json()).error).toContain("10,000");
      expect((await (await request.get(commentsUrl(bug.id))).json()).total).toBe(1);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-06 an unknown, malformed, deleted or other-project bug is a 404 for both list and add", async ({ request }) => {
    const deleted = await newBug(request, "Deleted");
    await request.delete(`/api/bugs/${deleted.id}`);
    const live = await newBug(request, "Mismatch");
    const other = await (
      await request.post("/api/projects", {
        data: { name: `E2E Bug Comments Other ${Date.now()}`, projectKey: `BC${Date.now().toString(36).toUpperCase()}`, projectType: "tesbox" },
      })
    ).json();
    try {
      const cases: Array<[string, string]> = [
        ["unknown", commentsUrl("00000000-0000-0000-0000-000000000000")],
        ["malformed", commentsUrl("not-a-uuid")],
        ["deleted", commentsUrl(deleted.id)],
        // A real, reachable bug addressed through a different project the caller also belongs to.
        ["other project", commentsUrl(live.id, other.id)],
      ];
      for (const [label, url] of cases) {
        const list = await request.get(url, { failOnStatusCode: false });
        expect(list.status(), `list: ${label}`).toBe(404);
        const add = await request.post(url, { data: { body: "hello" }, failOnStatusCode: false });
        expect(add.status(), `add: ${label}`).toBe(404);
      }
      expect((await (await request.get(commentsUrl(live.id))).json()).total).toBe(0);
    } finally {
      await request.delete(`/api/bugs/${live.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${other.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-07 another workspace and an anonymous caller can neither read nor add comments", async ({ request }) => {
    const bug = await newBug(request, "Authz");
    try {
      await request.post(commentsUrl(bug.id), { data: { body: "Account A only" } });
      for (const [label, caller] of [["account B", asB], ["anonymous", anon]] as const) {
        const list = await caller.get(commentsUrl(bug.id), { failOnStatusCode: false });
        expect([401, 403, 404], `${label} list`).toContain(list.status());
        const add = await caller.post(commentsUrl(bug.id), { data: { body: `From ${label}` }, failOnStatusCode: false });
        expect([401, 403, 404], `${label} add`).toContain(add.status());
      }
      const listed = await (await request.get(commentsUrl(bug.id))).json();
      expect(listed.list.map((c: { body: string }) => c.body)).toEqual(["Account A only"]);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-08 adding a comment is recorded in the project's activity feed", async ({ request }) => {
    const bug = await newBug(request, "Activity");
    try {
      await request.post(commentsUrl(bug.id), { data: { body: "Logged" } });
      const feed = await (await request.get(`/api/projects/${ctx.projectId}/activity`, { params: { limit: "100" } })).json();
      const entry = feed.list.find(
        (i: { action?: string; entityType?: string; entityId?: string }) =>
          i.action === "commented" && i.entityType === "bug" && i.entityId === bug.id,
      );
      expect(entry, "no 'commented' entry for the bug in the activity feed").toBeTruthy();
      expect(entry.entityName).toBe(bug.title);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-09 comments are not returned for a bug once it is deleted", async ({ request }) => {
    const bug = await newBug(request, "Cascade");
    await request.post(commentsUrl(bug.id), { data: { body: "Before delete" } });
    await request.delete(`/api/bugs/${bug.id}`);
    const res = await request.get(commentsUrl(bug.id), { failOnStatusCode: false });
    expect(res.status()).toBe(404);
  });

  function commentUrl(bugId: string, commentId: string, projectId: string = ctx.projectId) {
    return `${commentsUrl(bugId, projectId)}/${commentId}`;
  }

  function downloadUrl(attachmentId: string) {
    return `/api/projects/${ctx.projectId}/bugs/attachments/${attachmentId}/download`;
  }

  /** A comment posted as multipart with these files, the way the comment box sends one. */
  async function commentWithFiles(request: APIRequestContext, bugId: string, body: string, files: UploadFile[]) {
    const res = await request.post(commentsUrl(bugId), { multipart: filesFormWith({ body }, files) });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  }

  test("BUGC-A-11 a comment posted with files carries them, they download byte-for-byte, and they are not bug evidence", async ({ request }) => {
    const bug = await newBug(request, "Files");
    try {
      const png = pngFile("screen.png");
      const log = textFile("console.log.txt", "TypeError: x is undefined");
      const created = await commentWithFiles(request, bug.id, "See the **screenshot** and log.", [png, log]);
      expect(created.body).toBe("See the **screenshot** and log.");
      expect(created.isEdited).toBe(false);
      expect(created.attachments.map((a: { fileName: string }) => a.fileName)).toEqual(["screen.png", "console.log.txt"]);
      expect(created.attachments[0]).toMatchObject({ contentType: "image/png", fileSize: png.body.length });
      expect(created.attachments[0].storagePath, "the storage key must not leave the server").toBeUndefined();

      const listed = await (await request.get(commentsUrl(bug.id))).json();
      expect(listed.list).toEqual([created]);

      for (const [att, file] of [[created.attachments[0], png], [created.attachments[1], log]] as const) {
        const download = await request.get(downloadUrl(att.id));
        expect(download.ok(), `download ${att.fileName}: ${download.status()}`).toBeTruthy();
        expect(Buffer.from(await download.body()).equals(file.body)).toBeTruthy();
      }

      // The bug's own Attachments list is evidence filed with the bug; a comment's files stay with the comment.
      expect((await (await request.get(`/api/bugs/${bug.id}`)).json()).attachments).toEqual([]);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-12 a rejected file, or files with no text, refuses the whole comment and stores nothing", async ({ request }) => {
    const bug = await newBug(request, "Files Invalid");
    try {
      const cases: Array<[string, Record<string, string>, UploadFile[], string]> = [
        ["unsupported type", { body: "With an exe" }, [pngFile("ok.png"), { name: "setup.exe", mimeType: "application/octet-stream", body: Buffer.from("MZ") }], "aren't supported"],
        ["empty file", { body: "With an empty file" }, [{ name: "empty.txt", mimeType: "text/plain", body: Buffer.alloc(0) }], "empty"],
        ["no text", { body: "   " }, [pngFile("alone.png")], "Comment cannot be empty."],
        // A comment's files share a bug's 20MB ceiling, not test-run evidence's 25MB.
        ["over 20MB", { body: "Too big" }, [sizedFile("big.png", 20 * 1024 * 1024 + 1024, "image/png")], "20.0MB"],
      ];
      for (const [label, fields, files, error] of cases) {
        const res = await request.post(commentsUrl(bug.id), { multipart: filesFormWith(fields, files), failOnStatusCode: false });
        expect(res.status(), label).toBe(400);
        expect((await res.json()).error, label).toContain(error);
      }
      expect((await (await request.get(commentsUrl(bug.id))).json()).total).toBe(0);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-13 the author edits a comment's text: it is saved, marked edited, and listed; validation matches create", async ({ request }) => {
    const bug = await newBug(request, "Edit");
    try {
      const created = await (await request.post(commentsUrl(bug.id), { data: { body: "Fails on *Chrome*" } })).json();

      // Saving the same text is not an edit.
      const same = await request.patch(commentUrl(bug.id, created.id), { data: { body: "  Fails on *Chrome*  " } });
      expect(same.status()).toBe(200);
      expect(await same.json()).toEqual(created);

      const res = await request.patch(commentUrl(bug.id, created.id), { data: { body: "  Fails on *Chrome* and **Firefox**\n- v126\n- v127  " } });
      expect(res.status(), await res.text()).toBe(200);
      const edited = await res.json();
      expect(edited).toMatchObject({ id: created.id, authorId: created.authorId, body: "Fails on *Chrome* and **Firefox**\n- v126\n- v127", isEdited: true });
      expect(edited.createdAt).toBe(created.createdAt);
      expect(Date.parse(edited.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
      expect((await (await request.get(commentsUrl(bug.id))).json()).list).toEqual([edited]);

      for (const [data, error] of [
        [{ body: "" }, "Comment cannot be empty."],
        [{ body: " \n " }, "Comment cannot be empty."],
        [{ body: null }, "Comment cannot be empty."],
        [{ body: 7 }, "Comment must be text."],
        [{ body: { text: "x" } }, "Comment must be text."],
        [{ body: "x".repeat(10_001) }, "10,000"],
      ] as const) {
        const bad = await request.patch(commentUrl(bug.id, created.id), { data, failOnStatusCode: false });
        expect(bad.status(), JSON.stringify(data).slice(0, 60)).toBe(400);
        expect((await bad.json()).error).toContain(error);
      }
      expect((await (await request.get(commentsUrl(bug.id))).json()).list[0].body, "a refused edit changes nothing").toBe(edited.body);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-14 editing adds and removes a comment's files; only its own files can be removed, and at most ten kept", async ({ request }) => {
    const bug = await newBug(request, "Edit Files");
    try {
      const evidence = await request.post(`/api/projects/${ctx.projectId}/bugs/${bug.id}/attachments`, { multipart: filesForm([textFile("bug-evidence.txt")]) });
      const evidenceId = (await evidence.json()).list[0].id;
      const other = await commentWithFiles(request, bug.id, "Another comment", [textFile("other.txt")]);
      const created = await commentWithFiles(request, bug.id, "Two files", [textFile("keep.txt"), textFile("drop.txt")]);
      const [keep, drop] = created.attachments;

      // Ids that belong to the bug's evidence, to another comment, or to nothing are not this comment's.
      for (const id of [evidenceId, other.attachments[0].id, "00000000-0000-0000-0000-000000000000", "not-a-uuid"]) {
        const res = await request.patch(commentUrl(bug.id, created.id), { data: { removeAttachmentIds: [id] }, failOnStatusCode: false });
        expect(res.status(), id).toBe(404);
      }
      const malformed = await request.patch(commentUrl(bug.id, created.id), { data: { removeAttachmentIds: [42] }, failOnStatusCode: false });
      expect(malformed.status()).toBe(400);
      expect((await request.get(downloadUrl(evidenceId))).ok(), "bug evidence is untouched").toBeTruthy();

      const res = await request.patch(commentUrl(bug.id, created.id), {
        multipart: filesFormWith({ removeAttachmentIds: JSON.stringify([drop.id]) }, [pngFile("added.png")]),
      });
      expect(res.status(), await res.text()).toBe(200);
      const edited = await res.json();
      expect(edited.body, "files-only edit keeps the text").toBe("Two files");
      expect(edited.isEdited).toBe(true);
      expect(edited.attachments.map((a: { fileName: string }) => a.fileName)).toEqual(["keep.txt", "added.png"]);
      expect(edited.attachments[0].id).toBe(keep.id);
      expect((await request.get(downloadUrl(drop.id), { failOnStatusCode: false })).status(), "a removed file is gone").toBe(404);

      // Two kept + nine new is eleven: refused whole, nothing added.
      const tooMany = Array.from({ length: 9 }, (_, i) => textFile(`extra-${i}.txt`));
      const over = await request.patch(commentUrl(bug.id, created.id), { multipart: filesFormWith({}, tooMany), failOnStatusCode: false });
      expect(over.status()).toBe(400);
      expect((await over.json()).error).toContain("at most 10");
      const after = (await (await request.get(commentsUrl(bug.id))).json()).list.find((c: { id: string }) => c.id === created.id);
      expect(after.attachments).toHaveLength(2);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-15 deleting a comment removes it and its files; a second delete or a later edit is a 404", async ({ request }) => {
    const bug = await newBug(request, "Delete");
    try {
      const kept = await (await request.post(commentsUrl(bug.id), { data: { body: "Stays" } })).json();
      const doomed = await commentWithFiles(request, bug.id, "Goes", [textFile("goes.txt")]);

      const res = await request.delete(commentUrl(bug.id, doomed.id));
      expect(res.status(), await res.text()).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      const listed = await (await request.get(commentsUrl(bug.id))).json();
      expect(listed.list.map((c: { id: string }) => c.id)).toEqual([kept.id]);
      expect((await request.get(downloadUrl(doomed.attachments[0].id), { failOnStatusCode: false })).status()).toBe(404);

      expect((await request.delete(commentUrl(bug.id, doomed.id), { failOnStatusCode: false })).status()).toBe(404);
      expect((await request.patch(commentUrl(bug.id, doomed.id), { data: { body: "Back" }, failOnStatusCode: false })).status()).toBe(404);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-16 a comment's file cannot be deleted through the bug-evidence delete route", async ({ request }) => {
    const bug = await newBug(request, "Evidence Route");
    try {
      const created = await commentWithFiles(request, bug.id, "Mine", [textFile("mine.txt")]);
      const res = await request.delete(`/api/bugs/attachments/${created.attachments[0].id}`, { failOnStatusCode: false });
      expect(res.status()).toBe(404);
      expect((await request.get(downloadUrl(created.attachments[0].id))).ok()).toBeTruthy();
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-17 edit and delete 404 for an unknown, malformed or other bug's comment, and through another project", async ({ request }) => {
    const bug = await newBug(request, "Edit 404");
    const otherBug = await newBug(request, "Edit 404 Other");
    const otherProject = await (
      await request.post("/api/projects", {
        data: { name: `E2E Bug Comments Edit Other ${Date.now()}`, projectKey: `BE${Date.now().toString(36).toUpperCase()}`, projectType: "tesbox" },
      })
    ).json();
    try {
      const comment = await (await request.post(commentsUrl(bug.id), { data: { body: "Original" } })).json();
      const cases: Array<[string, string]> = [
        ["unknown", commentUrl(bug.id, "00000000-0000-0000-0000-000000000000")],
        ["malformed", commentUrl(bug.id, "not-a-uuid")],
        ["addressed through another bug", commentUrl(otherBug.id, comment.id)],
        ["addressed through another project", commentUrl(bug.id, comment.id, otherProject.id)],
      ];
      for (const [label, url] of cases) {
        expect((await request.patch(url, { data: { body: "Changed" }, failOnStatusCode: false })).status(), `edit: ${label}`).toBe(404);
        expect((await request.delete(url, { failOnStatusCode: false })).status(), `delete: ${label}`).toBe(404);
      }
      const listed = await (await request.get(commentsUrl(bug.id))).json();
      expect(listed.list.map((c: { body: string }) => c.body)).toEqual(["Original"]);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await request.delete(`/api/bugs/${otherBug.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${otherProject.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-18 another workspace and an anonymous caller can neither edit nor delete a comment, nor download its files", async ({ request }) => {
    const bug = await newBug(request, "Edit Authz");
    try {
      const comment = await commentWithFiles(request, bug.id, "Account A only", [textFile("a-only.txt")]);
      for (const [label, caller] of [["account B", asB], ["anonymous", anon]] as const) {
        const edit = await caller.patch(commentUrl(bug.id, comment.id), { data: { body: `From ${label}` }, failOnStatusCode: false });
        expect([401, 403, 404], `${label} edit`).toContain(edit.status());
        const del = await caller.delete(commentUrl(bug.id, comment.id), { failOnStatusCode: false });
        expect([401, 403, 404], `${label} delete`).toContain(del.status());
        const download = await caller.get(downloadUrl(comment.attachments[0].id), { failOnStatusCode: false });
        expect([401, 403, 404], `${label} download`).toContain(download.status());
      }
      const listed = await (await request.get(commentsUrl(bug.id))).json();
      expect(listed.list).toEqual([comment]);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-22 the author can edit for an hour after posting; after that every edit is refused and changes nothing, but delete still works", async ({ request }) => {
    const bug = await newBug(request, "Edit Window");
    // Only created_at moves: the window is measured from posting, by the database clock.
    const postedMinutesAgo = (commentId: string, minutes: number) =>
      exec(`UPDATE bug_comments SET created_at = now() - make_interval(mins => ${minutes}) WHERE id = ${literal(commentId)};`);
    try {
      const created = await commentWithFiles(request, bug.id, "Posted a while ago", [textFile("kept.txt")]);
      expect(Date.parse(created.editableUntil) - Date.parse(created.createdAt)).toBe(60 * 60_000);

      postedMinutesAgo(created.id, 59);
      const inside = await request.patch(commentUrl(bug.id, created.id), { data: { body: "Edited at 59 minutes" } });
      expect(inside.status(), await inside.text()).toBe(200);

      postedMinutesAgo(created.id, 61);
      const attempts: Array<[string, Parameters<APIRequestContext["patch"]>[1]]> = [
        ["new text", { data: { body: "Edited at 61 minutes" } }],
        ["the same text", { data: { body: "Edited at 59 minutes" } }],
        ["removing a file", { data: { removeAttachmentIds: [created.attachments[0].id] } }],
        ["adding a file", { multipart: filesFormWith({}, [textFile("late.txt")]) }],
      ];
      for (const [label, options] of attempts) {
        const res = await request.patch(commentUrl(bug.id, created.id), { ...options, failOnStatusCode: false });
        expect(res.status(), label).toBe(403);
        expect((await res.json()).error, label).toBe("Comments can only be edited within 1 hour of posting.");
      }

      const after = (await (await request.get(commentsUrl(bug.id))).json()).list[0];
      expect(after.body).toBe("Edited at 59 minutes");
      expect(after.attachments.map((a: { fileName: string }) => a.fileName)).toEqual(["kept.txt"]);
      expect(Date.parse(after.editableUntil)).toBeLessThan(Date.now());

      // The limit is on rewriting, not on removing: the author can still delete it.
      expect((await request.delete(commentUrl(bug.id, created.id))).status()).toBe(200);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  async function reply(request: APIRequestContext, bugId: string, parentCommentId: string, body: string) {
    const res = await request.post(commentsUrl(bugId), { data: { body, parentCommentId } });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  }

  test("BUGC-A-23 replies attach to their comment, several per comment, and the flat list keeps every thread in date order", async ({ request }) => {
    const bug = await newBug(request, "Replies");
    try {
      const a = await (await request.post(commentsUrl(bug.id), { data: { body: "Comment A" } })).json();
      const b = await (await request.post(commentsUrl(bug.id), { data: { body: "Comment B" } })).json();
      expect(a.parentCommentId).toBeNull();
      // Interleaved across threads on purpose: order is by time, grouping is by parent.
      const a1 = await reply(request, bug.id, a.id, "Reply A1");
      const b1 = await reply(request, bug.id, b.id, "Reply B1");
      const a2 = await reply(request, bug.id, a.id, "Reply A2");
      expect(a1).toMatchObject({ parentCommentId: a.id, body: "Reply A1", isEdited: false, attachments: [] });

      const listed = (await (await request.get(commentsUrl(bug.id))).json()) as { list: Array<{ id: string; parentCommentId: string | null }>; total: number };
      expect(listed.total, "total counts replies too").toBe(5);
      expect(listed.list.map((c) => c.id)).toEqual([a.id, b.id, a1.id, b1.id, a2.id]);
      expect(listed.list.filter((c) => c.parentCommentId === a.id).map((c) => c.id)).toEqual([a1.id, a2.id]);
      expect(listed.list.filter((c) => c.parentCommentId === b.id).map((c) => c.id)).toEqual([b1.id]);

      const feed = await (await request.get(`/api/projects/${ctx.projectId}/activity`, { params: { entityType: "bug", entityId: bug.id, limit: "100" } })).json();
      const replied = feed.list.filter((r: { action: string }) => r.action === "replied");
      expect(replied).toHaveLength(3);
      expect(replied.map((r: { diff: string }) => JSON.parse(r.diff)).find((d: { commentId: string }) => d.commentId === a1.id)).toEqual({
        commentId: a1.id,
        parentCommentId: a.id,
      });
      expect(feed.list.filter((r: { action: string }) => r.action === "commented"), "a reply is not logged as a new comment").toHaveLength(2);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-24 a reply to a missing, deleted, other-bug or malformed comment is a 404; to a reply, a 400 — and nothing is stored", async ({ request }) => {
    const bug = await newBug(request, "Reply Invalid");
    const otherBug = await newBug(request, "Reply Invalid Other");
    try {
      const top = await (await request.post(commentsUrl(bug.id), { data: { body: "Top" } })).json();
      const child = await reply(request, bug.id, top.id, "Child");
      const deleted = await (await request.post(commentsUrl(bug.id), { data: { body: "Deleted" } })).json();
      await request.delete(commentUrl(bug.id, deleted.id));
      const elsewhere = await (await request.post(commentsUrl(otherBug.id), { data: { body: "On another bug" } })).json();

      const gone = "The comment you're replying to no longer exists.";
      const cases: Array<[string, unknown, number, string]> = [
        ["unknown", "00000000-0000-0000-0000-000000000000", 404, gone],
        ["malformed", "not-a-uuid", 404, gone],
        ["deleted", deleted.id, 404, gone],
        ["another bug's comment", elsewhere.id, 404, gone],
        ["a reply", child.id, 400, "Reply to the top comment of the thread instead of to another reply."],
        ["not text", 42, 400, "parentCommentId must be a comment id."],
      ];
      for (const [label, parentCommentId, status, error] of cases) {
        const res = await request.post(commentsUrl(bug.id), { data: { body: `Reply to ${label}`, parentCommentId }, failOnStatusCode: false });
        expect(res.status(), label).toBe(status);
        expect((await res.json()).error, label).toBe(error);
      }
      // Same rule through multipart, the route a reply with files takes.
      const viaForm = await request.post(commentsUrl(bug.id), {
        multipart: filesFormWith({ body: "Nested with a file", parentCommentId: child.id }, [textFile("nested.txt")]),
        failOnStatusCode: false,
      });
      expect(viaForm.status()).toBe(400);

      expect((await (await request.get(commentsUrl(bug.id))).json()).total).toBe(2);
      expect((await (await request.get(commentsUrl(otherBug.id))).json()).total).toBe(1);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await request.delete(`/api/bugs/${otherBug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-25 a reply carries Markdown and files like a comment, under the same validation", async ({ request }) => {
    const bug = await newBug(request, "Reply Files");
    try {
      const top = await (await request.post(commentsUrl(bug.id), { data: { body: "Top" } })).json();
      const res = await request.post(commentsUrl(bug.id), {
        multipart: filesFormWith({ body: "Retested: **still fails**\n- on v127", parentCommentId: top.id }, [pngFile("retest.png")]),
      });
      expect(res.status(), await res.text()).toBe(201);
      const created = await res.json();
      expect(created).toMatchObject({ parentCommentId: top.id, body: "Retested: **still fails**\n- on v127" });
      expect(created.attachments.map((a: { fileName: string }) => a.fileName)).toEqual(["retest.png"]);
      expect((await request.get(downloadUrl(created.attachments[0].id))).ok()).toBeTruthy();

      for (const [data, error] of [
        [{ body: "  ", parentCommentId: top.id }, "Comment cannot be empty."],
        [{ body: "x".repeat(10_001), parentCommentId: top.id }, "10,000"],
      ] as const) {
        const bad = await request.post(commentsUrl(bug.id), { data, failOnStatusCode: false });
        expect(bad.status()).toBe(400);
        expect((await bad.json()).error).toContain(error);
      }
      expect((await (await request.get(commentsUrl(bug.id))).json()).total).toBe(2);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-26 the author edits a reply (marked edited, still in its thread, an hour at most); deleting a reply leaves the rest of the thread", async ({ request }) => {
    const bug = await newBug(request, "Reply Edit");
    try {
      const top = await (await request.post(commentsUrl(bug.id), { data: { body: "Top" } })).json();
      const other = await (await request.post(commentsUrl(bug.id), { data: { body: "Other top" } })).json();
      const first = await reply(request, bug.id, top.id, "First reply");
      const second = await reply(request, bug.id, top.id, "Second reply");

      // An edit can't move a reply to another thread: parentCommentId is not an editable field.
      const res = await request.patch(commentUrl(bug.id, first.id), { data: { body: "First reply, corrected", parentCommentId: other.id } });
      expect(res.status(), await res.text()).toBe(200);
      expect(await res.json()).toMatchObject({ id: first.id, parentCommentId: top.id, body: "First reply, corrected", isEdited: true });

      exec(`UPDATE bug_comments SET created_at = now() - interval '61 minutes' WHERE id = ${literal(second.id)};`);
      const late = await request.patch(commentUrl(bug.id, second.id), { data: { body: "Too late" }, failOnStatusCode: false });
      expect(late.status()).toBe(403);
      expect((await late.json()).error).toBe("Comments can only be edited within 1 hour of posting.");

      expect((await request.delete(commentUrl(bug.id, first.id))).status()).toBe(200);
      const listed = (await (await request.get(commentsUrl(bug.id))).json()).list as Array<{ id: string; body: string }>;
      expect(listed.map((c) => c.id)).toEqual([top.id, other.id, second.id]);
      expect(listed.find((c) => c.id === second.id)!.body).toBe("Second reply");

      const feed = await (await request.get(`/api/projects/${ctx.projectId}/activity`, { params: { entityType: "bug", entityId: bug.id, limit: "100" } })).json();
      const deletion = feed.list.find((r: { action: string }) => r.action === "comment_deleted");
      expect(JSON.parse(deletion.diff)).toMatchObject({ commentId: first.id, parentCommentId: top.id });
      expect(JSON.parse(deletion.diff).repliesDeleted, "deleting a reply deletes nothing else").toBeUndefined();
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-27 deleting a comment deletes its replies and their files; the thread can then be neither replied to nor edited", async ({ request }) => {
    const bug = await newBug(request, "Reply Cascade");
    try {
      const top = await commentWithFiles(request, bug.id, "Top with a file", [textFile("top.txt")]);
      const kept = await (await request.post(commentsUrl(bug.id), { data: { body: "Unrelated thread" } })).json();
      const keptReply = await reply(request, bug.id, kept.id, "Unrelated reply");
      const withFile = await (
        await request.post(commentsUrl(bug.id), { multipart: filesFormWith({ body: "Reply with a file", parentCommentId: top.id }, [textFile("reply.txt")]) })
      ).json();
      const plain = await reply(request, bug.id, top.id, "Plain reply");

      expect((await request.delete(commentUrl(bug.id, top.id))).status()).toBe(200);

      const listed = (await (await request.get(commentsUrl(bug.id))).json()).list as Array<{ id: string }>;
      expect(listed.map((c) => c.id)).toEqual([kept.id, keptReply.id]);
      for (const att of [top.attachments[0], withFile.attachments[0]]) {
        expect((await request.get(downloadUrl(att.id), { failOnStatusCode: false })).status(), att.fileName).toBe(404);
      }
      expect(scalar(`SELECT COUNT(*)::text FROM bug_comments WHERE id IN (${literal(withFile.id)}, ${literal(plain.id)}) AND is_deleted`)).toBe("2");

      expect((await request.post(commentsUrl(bug.id), { data: { body: "Late reply", parentCommentId: top.id }, failOnStatusCode: false })).status()).toBe(404);
      expect((await request.patch(commentUrl(bug.id, plain.id), { data: { body: "Edit after cascade" }, failOnStatusCode: false })).status()).toBe(404);

      const feed = await (await request.get(`/api/projects/${ctx.projectId}/activity`, { params: { entityType: "bug", entityId: bug.id, limit: "100" } })).json();
      const deletion = feed.list.find((r: { action: string; diff: string }) => r.action === "comment_deleted" && JSON.parse(r.diff).commentId === top.id);
      expect(JSON.parse(deletion.diff).repliesDeleted).toBe(2);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-28 another workspace and an anonymous caller can't reply", async ({ request }) => {
    const bug = await newBug(request, "Reply Authz");
    try {
      const top = await (await request.post(commentsUrl(bug.id), { data: { body: "Account A only" } })).json();
      for (const [label, caller] of [["account B", asB], ["anonymous", anon]] as const) {
        const res = await caller.post(commentsUrl(bug.id), { data: { body: `From ${label}`, parentCommentId: top.id }, failOnStatusCode: false });
        expect([401, 403, 404], label).toContain(res.status());
      }
      expect((await (await request.get(commentsUrl(bug.id))).json()).total).toBe(1);
    } finally {
      await request.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Who may change a bug comment: only its author edits it (a manager rewriting someone's words would
 * misattribute them), while the author or a project owner/manager may delete it. Same tenant as
 * "bug activity" — owner, manager and QA all in one project, plus a guest outside it — so each rule
 * is exercised by a real second account rather than inferred.
 */
test.describe("bug comment permissions", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;

  type Activity = { action: string; actorId: string | null; diff: string | null };

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("bugs-assignee");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
  });

  test.afterAll(async () => {
    if (tenant) resetRbacMembership(tenant);
    await asOwner?.dispose();
    await asManager?.dispose();
    await asQa?.dispose();
    await asGuest?.dispose();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  const commentsUrl = (bugId: string) => `/api/projects/${tenant!.mainProjectId}/bugs/${bugId}/comments`;
  const commentUrl = (bugId: string, commentId: string) => `${commentsUrl(bugId)}/${commentId}`;

  async function newBug(label: string): Promise<{ id: string; title: string }> {
    const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
      data: { title: `E2E Bug Comment Perms ${label} ${Date.now()}` },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  }

  async function comment(as: APIRequestContext, bugId: string, body: string): Promise<{ id: string; body: string }> {
    const res = await as.post(commentsUrl(bugId), { data: { body } });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  }

  async function activityOf(bugId: string): Promise<Activity[]> {
    const res = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/activity`, {
      params: { entityType: "bug", entityId: bugId, limit: "100" },
    });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()).list as Activity[]).slice().reverse();
  }

  const diffOf = (row: Activity) => JSON.parse(row.diff || "{}");

  test("BUGC-A-19 only the author may edit; QA and even the owner or a manager are refused, and nothing changes", async () => {
    const bug = await newBug("Edit");
    try {
      const byQa = await comment(asQa, bug.id, "QA's words");
      for (const [label, as] of [["owner", asOwner], ["manager", asManager]] as const) {
        const res = await as.patch(commentUrl(bug.id, byQa.id), { data: { body: `Rewritten by ${label}` }, failOnStatusCode: false });
        expect(res.status(), label).toBe(403);
        expect((await res.json()).error).toContain("your own comments");
      }
      const byOwner = await comment(asOwner, bug.id, "Owner's words");
      expect((await asQa.patch(commentUrl(bug.id, byOwner.id), { data: { body: "Rewritten by QA" }, failOnStatusCode: false })).status()).toBe(403);
      // A guest outside the project does not learn the comment exists.
      expect((await asGuest.patch(commentUrl(bug.id, byOwner.id), { data: { body: "x" }, failOnStatusCode: false })).status()).toBe(404);

      const own = await asQa.patch(commentUrl(bug.id, byQa.id), { data: { body: "QA's words, revised" } });
      expect(own.status()).toBe(200);

      const listed = (await (await asOwner.get(commentsUrl(bug.id))).json()).list;
      expect(listed.map((c: { body: string }) => c.body)).toEqual(["QA's words, revised", "Owner's words"]);
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-20 the author, the owner or a manager may delete; another QA engineer's or a guest's attempt is refused", async () => {
    const bug = await newBug("Delete");
    try {
      const byOwner = await comment(asOwner, bug.id, "Owner's comment");
      const res = await asQa.delete(commentUrl(bug.id, byOwner.id), { failOnStatusCode: false });
      expect(res.status()).toBe(403);
      expect((await asGuest.delete(commentUrl(bug.id, byOwner.id), { failOnStatusCode: false })).status()).toBe(404);

      const forManager = await comment(asQa, bug.id, "Removed by the manager");
      const forOwner = await comment(asQa, bug.id, "Removed by the owner");
      const forSelf = await comment(asQa, bug.id, "Removed by its author");
      expect((await asManager.delete(commentUrl(bug.id, forManager.id))).status()).toBe(200);
      expect((await asOwner.delete(commentUrl(bug.id, forOwner.id))).status()).toBe(200);
      expect((await asQa.delete(commentUrl(bug.id, forSelf.id))).status()).toBe(200);

      const listed = (await (await asOwner.get(commentsUrl(bug.id))).json()).list;
      expect(listed.map((c: { id: string }) => c.id)).toEqual([byOwner.id]);

      // A moderator's delete is attributed to the moderator, and names whose comment it was.
      const deletions = (await activityOf(bug.id)).filter((r) => r.action === "comment_deleted");
      const byManager = deletions.find((r) => diffOf(r).commentId === forManager.id)!;
      expect(byManager.actorId).toBe(tenant!.manager.userId);
      expect(diffOf(byManager).authorId).toBe(tenant!.qa.userId);
      expect(deletions).toHaveLength(3);
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-21 an edit logs comment_edited, and @mentions only the people it newly names — once", async () => {
    const bug = await newBug("Mentions");
    try {
      const created = await comment(asOwner, bug.id, "Looping in @E2E bugs-assignee QA");
      await asOwner.patch(commentUrl(bug.id, created.id), {
        data: { body: `Looping in @E2E bugs-assignee QA and @${tenant!.manager.email}` },
      });
      // Re-saving with only formatting changed names nobody new.
      await asOwner.patch(commentUrl(bug.id, created.id), {
        data: { body: `Looping in **@E2E bugs-assignee QA** and @${tenant!.manager.email}` },
      });

      const rows = await activityOf(bug.id);
      const edits = rows.filter((r) => r.action === "comment_edited");
      expect(edits).toHaveLength(2);
      expect(edits.every((r) => r.actorId === tenant!.owner.userId && diffOf(r).commentId === created.id)).toBe(true);

      const mentioned = rows.filter((r) => r.action === "bug_mentioned").map((r) => diffOf(r).mentionedUserId);
      expect(mentioned.sort()).toEqual([tenant!.manager.userId, tenant!.qa.userId].sort());
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGC-A-29 replies follow the comment rules: any member replies, only the author edits, author/owner/manager deletes — and a thread's author deletes everyone's replies", async () => {
    const bug = await newBug("Replies");
    try {
      const reply = async (as: APIRequestContext, parentCommentId: string, body: string) => {
        const res = await as.post(commentsUrl(bug.id), { data: { body, parentCommentId } });
        expect(res.status(), await res.text()).toBe(201);
        return res.json() as Promise<{ id: string }>;
      };
      const byOwner = await comment(asOwner, bug.id, "Owner's thread");
      const qaReply = await reply(asQa, byOwner.id, "QA replies");
      const managerReply = await reply(asManager, byOwner.id, "Manager replies");
      expect((await asGuest.post(commentsUrl(bug.id), { data: { body: "Guest", parentCommentId: byOwner.id }, failOnStatusCode: false })).status()).toBe(404);

      expect((await asOwner.patch(commentUrl(bug.id, qaReply.id), { data: { body: "Owner rewrites" }, failOnStatusCode: false })).status()).toBe(403);
      expect((await asQa.patch(commentUrl(bug.id, qaReply.id), { data: { body: "QA revises" } })).status()).toBe(200);
      expect((await asQa.delete(commentUrl(bug.id, managerReply.id), { failOnStatusCode: false })).status()).toBe(403);
      expect((await asManager.delete(commentUrl(bug.id, qaReply.id))).status()).toBe(200);

      // Decided: a thread goes with its top comment, as in the Knowledge Base — even when the one
      // deleting it wrote only the top comment and others wrote the replies.
      const byQa = await comment(asQa, bug.id, "QA's thread");
      await reply(asOwner, byQa.id, "Owner replies to QA");
      expect((await asQa.delete(commentUrl(bug.id, byQa.id))).status()).toBe(200);

      const listed = (await (await asOwner.get(commentsUrl(bug.id))).json()).list as Array<{ body: string }>;
      expect(listed.map((c) => c.body)).toEqual(["Owner's thread", "Manager replies"]);
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Bug Details' Activity section. Every meaningful bug change writes one audit_logs row with the
 * caller as actor, read back through the project activity feed filtered by entityId. The tenant is
 * the "bugs-assignee" one because attribution needs a second project member: the owner files each
 * bug and the QA member changes it, so a row credited to the reporter (what the old synthetic
 * "bug updated" row did) fails these tests rather than passing by coincidence.
 */
test.describe("bug activity", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;

  type Activity = {
    id: string;
    action: string;
    actorId: string | null;
    actorName: string | null;
    entityType: string;
    entityId: string;
    entityName: string | null;
    diff: string | null;
    createdAt: string;
  };

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("bugs-assignee");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
  });

  test.afterAll(async () => {
    if (tenant) resetRbacMembership(tenant);
    await asOwner?.dispose();
    await asQa?.dispose();
    await asGuest?.dispose();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  async function newBug(label: string, data: Record<string, unknown> = {}): Promise<{ id: string; title: string }> {
    const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
      data: { title: `E2E Bug Activity ${label} ${Date.now()}`, ...data },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  }

  /** This bug's activity, oldest first — the order Bug Details shows it in. */
  async function activityOf(bugId: string, as: APIRequestContext = asOwner): Promise<Activity[]> {
    const res = await as.get(`/api/projects/${tenant!.mainProjectId}/activity`, {
      params: { entityType: "bug", entityId: bugId, limit: "100" },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    return (body.list as Activity[]).slice().reverse();
  }

  const diffOf = (row: Activity) => JSON.parse(row.diff || "{}");
  const actions = (rows: Activity[]) => rows.map((r) => r.action);

  test("BUGA-A-01 filing a bug logs one bug_created row for the reporter, scoped to that bug only", async () => {
    const other = await newBug("Other");
    const bug = await newBug("Create", { severity: "High", priority: "P1", assigneeId: tenant!.qa.userId });
    try {
      const rows = await activityOf(bug.id);
      expect(actions(rows)).toEqual(["bug_created"]);
      expect(rows.every((r) => r.entityId === bug.id), "entityId must scope the feed to this bug alone").toBe(true);
      expect(rows[0].actorId).toBe(tenant!.owner.userId);
      expect(rows[0].actorName).toBe("E2E bugs-assignee Owner");
      expect(rows[0].entityName).toBe(bug.title);
      expect(diffOf(rows[0])).toMatchObject({ status: "Open", severity: "High", priority: "P1", assigneeId: tenant!.qa.userId });
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await asOwner.delete(`/api/bugs/${other.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGA-A-02 a status change is credited to whoever changed it, not the reporter, and Closed is logged", async () => {
    const bug = await newBug("Status");
    try {
      expect((await asQa.patch(`/api/bugs/${bug.id}`, { data: { status: "In Progress" } })).ok()).toBeTruthy();
      expect((await asQa.patch(`/api/bugs/${bug.id}`, { data: { status: "Closed" } })).ok()).toBeTruthy();

      const rows = (await activityOf(bug.id)).filter((r) => r.action === "bug_status_changed");
      expect(rows.map(diffOf)).toEqual([
        { from: "Open", to: "In Progress" },
        { from: "In Progress", to: "Closed" },
      ]);
      for (const row of rows) {
        expect(row.actorId, "the QA member made this change").toBe(tenant!.qa.userId);
        expect(row.actorName).toBe("E2E bugs-assignee QA");
      }
      // The synthetic reporter-attributed "updated" row must not appear alongside the real history.
      expect(actions(await activityOf(bug.id))).not.toContain("updated");
      expect(actions(await activityOf(bug.id))).not.toContain("created");
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGA-A-03 severity and priority changes are logged with from/to, and an unchanged re-save logs nothing", async () => {
    const bug = await newBug("Severity", { severity: "Low" });
    try {
      await asQa.patch(`/api/bugs/${bug.id}`, { data: { severity: "Critical", priority: "P0" } });
      const afterChange = await activityOf(bug.id);
      expect(diffOf(afterChange.find((r) => r.action === "bug_severity_changed")!)).toEqual({ from: "Low", to: "Critical" });
      expect(diffOf(afterChange.find((r) => r.action === "bug_priority_changed")!)).toEqual({ from: null, to: "P0" });

      // The edit form re-sends every field; only a real difference is history.
      const current = await (await asOwner.get(`/api/bugs/${bug.id}`)).json();
      await asQa.patch(`/api/bugs/${bug.id}`, {
        data: { title: current.title, description: current.description, status: current.status, severity: current.severity, priority: current.priority },
      });
      expect((await activityOf(bug.id)).length).toBe(afterChange.length);

      await asQa.patch(`/api/bugs/${bug.id}`, { data: { priority: null } });
      const cleared = (await activityOf(bug.id)).filter((r) => r.action === "bug_priority_changed");
      expect(diffOf(cleared[cleared.length - 1])).toEqual({ from: "P0", to: null });
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGA-A-04 assigning and unassigning name both the actor and the assignee", async () => {
    const bug = await newBug("Assign");
    try {
      await asOwner.patch(`/api/bugs/${bug.id}`, { data: { assigneeId: tenant!.qa.userId } });
      await asQa.patch(`/api/bugs/${bug.id}`, { data: { assigneeId: tenant!.manager.userId } });
      await asQa.patch(`/api/bugs/${bug.id}`, { data: { assigneeId: null } });

      const rows = (await activityOf(bug.id)).filter((r) => r.action === "bug_assignee_changed");
      expect(rows.map((r) => r.actorId)).toEqual([tenant!.owner.userId, tenant!.qa.userId, tenant!.qa.userId]);
      expect(rows.map(diffOf)).toEqual([
        { fromId: null, fromName: null, toId: tenant!.qa.userId, toName: "E2E bugs-assignee QA" },
        { fromId: tenant!.qa.userId, fromName: "E2E bugs-assignee QA", toId: tenant!.manager.userId, toName: "E2E bugs-assignee Manager" },
        { fromId: tenant!.manager.userId, fromName: "E2E bugs-assignee Manager", toId: null, toName: null },
      ]);
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGA-A-05 editing other fields logs one bug_updated naming exactly the fields that changed", async () => {
    const bug = await newBug("Edit", { description: "before" });
    try {
      const renamed = `${bug.title} renamed`;
      await asQa.patch(`/api/bugs/${bug.id}`, { data: { title: renamed, description: "after", status: "Open" } });
      const rows = await activityOf(bug.id);
      const edits = rows.filter((r) => r.action === "bug_updated");
      expect(edits).toHaveLength(1);
      expect(diffOf(edits[0])).toEqual({ fields: ["title", "description"] });
      expect(edits[0].actorId).toBe(tenant!.qa.userId);
      expect(edits[0].entityName, "entity name is the title after the edit").toBe(renamed);
      expect(actions(rows), "status was re-sent unchanged, so no status row").not.toContain("bug_status_changed");
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGA-A-06 adding and deleting an attachment are both logged with the file name and actor", async () => {
    const bug = await newBug("Attachment");
    try {
      const upload = await asQa.post(`/api/projects/${tenant!.mainProjectId}/bugs/${bug.id}/attachments`, {
        multipart: { files: { name: "repro-steps.txt", mimeType: "text/plain", buffer: Buffer.from("steps") } },
      });
      expect(upload.ok(), await upload.text()).toBeTruthy();
      const attachmentId = (await upload.json()).list[0].id;
      expect((await asOwner.delete(`/api/bugs/attachments/${attachmentId}`)).ok()).toBeTruthy();

      const rows = await activityOf(bug.id);
      const added = rows.find((r) => r.action === "bug_attachment_added")!;
      const deleted = rows.find((r) => r.action === "bug_attachment_deleted")!;
      expect(added.actorId).toBe(tenant!.qa.userId);
      expect(diffOf(added)).toEqual({ attachmentId, fileName: "repro-steps.txt" });
      expect(deleted.actorId).toBe(tenant!.owner.userId);
      expect(diffOf(deleted)).toEqual({ attachmentId, fileName: "repro-steps.txt" });

      // Deleting it again is a 404, and must not log a second deletion.
      await asOwner.delete(`/api/bugs/attachments/${attachmentId}`, { failOnStatusCode: false });
      expect((await activityOf(bug.id)).filter((r) => r.action === "bug_attachment_deleted")).toHaveLength(1);
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGA-A-07 a comment logs 'commented', and each project member it @mentions once", async () => {
    const bug = await newBug("Mention");
    try {
      const body = [
        "@E2E bugs-assignee QA can you retry this? @E2E bugs-assignee QA ping.",
        `cc @${tenant!.manager.email}.`,
        `Not a mention: mail ${tenant!.owner.email} or ask @E2E bugs-assignee Guest (not in the project).`,
      ].join("\n");
      const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs/${bug.id}/comments`, { data: { body } });
      expect(res.status(), await res.text()).toBe(201);
      const comment = await res.json();
      expect(comment.body, "the comment itself is stored unchanged").toBe(body);

      const rows = await activityOf(bug.id);
      const commented = rows.filter((r) => r.action === "commented");
      expect(commented).toHaveLength(1);
      expect(commented[0].actorId).toBe(tenant!.owner.userId);

      const mentions = rows.filter((r) => r.action === "bug_mentioned");
      expect(mentions.every((r) => r.actorId === tenant!.owner.userId)).toBe(true);
      expect(mentions.map(diffOf).sort((a, b) => a.mentionedName.localeCompare(b.mentionedName))).toEqual([
        { commentId: comment.id, mentionedUserId: tenant!.manager.userId, mentionedName: "E2E bugs-assignee Manager" },
        { commentId: comment.id, mentionedUserId: tenant!.qa.userId, mentionedName: "E2E bugs-assignee QA" },
      ]);
    } finally {
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUGA-A-08 deleting a bug logs bug_deleted, and the whole life reads in order", async () => {
    const bug = await newBug("Lifecycle");
    await asQa.patch(`/api/bugs/${bug.id}`, { data: { status: "In Progress", assigneeId: tenant!.qa.userId } });
    await asQa.post(`/api/projects/${tenant!.mainProjectId}/bugs/${bug.id}/comments`, { data: { body: "Fixed in build 42" } });
    await asQa.patch(`/api/bugs/${bug.id}`, { data: { status: "Closed" } });
    expect((await asOwner.delete(`/api/bugs/${bug.id}`)).ok()).toBeTruthy();

    // The bug is gone, but its history is still readable from the project feed.
    const rows = await activityOf(bug.id);
    expect(actions(rows)).toEqual([
      "bug_created",
      "bug_status_changed",
      "bug_assignee_changed",
      "commented",
      "bug_status_changed",
      "bug_deleted",
    ]);
    expect(rows[rows.length - 1].actorId).toBe(tenant!.owner.userId);
  });

  test("BUGA-A-09 a bug's activity is not readable outside its project, and a bad entityId is a 400", async () => {
    const bug = await newBug("Access");
    const anon = await playwrightRequest.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
    try {
      const url = `/api/projects/${tenant!.mainProjectId}/activity`;
      const params = { entityType: "bug", entityId: bug.id };
      const guest = await asGuest.get(url, { params, failOnStatusCode: false });
      expect([403, 404], `a non-member read the bug's activity: ${guest.status()}`).toContain(guest.status());
      const unauthenticated = await anon.get(url, { params, failOnStatusCode: false });
      expect([401, 403], `an anonymous caller read the bug's activity: ${unauthenticated.status()}`).toContain(unauthenticated.status());

      const tooLong = await asOwner.get(url, { params: { entityId: "x".repeat(256) }, failOnStatusCode: false });
      expect(tooLong.status()).toBe(400);
      const unknown = await (await asOwner.get(url, { params: { entityId: "no-such-entity" } })).json();
      expect(unknown).toEqual({ list: [], total: 0 });
    } finally {
      await anon.dispose();
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });
});
