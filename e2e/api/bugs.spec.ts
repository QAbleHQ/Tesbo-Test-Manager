import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  resetRbacMembership,
  type RbacTenant,
} from "../utils/rbac-tenant";
import { exec, literal, scalar } from "../utils/psql";

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
