import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

async function createCase(request: import("@playwright/test").APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
    data: { title: `E2E ${Date.now()}`, ...data },
  });
  return res.json();
}

async function deleteCase(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
}

async function createSuite(request: import("@playwright/test").APIRequestContext, name: string) {
  return (await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name } })).json();
}

async function deleteSuite(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/suites/${id}`, { failOnStatusCode: false });
}

test.describe("test case CRUD", () => {
  test("supports the create -> read -> update -> list -> delete lifecycle", { tag: '@tesbo.testId("TES-TC-551")' }, async ({ request }) => {
    const title = `E2E smoke test case ${Date.now()}`;

    const createRes = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
      data: { title },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    expect(created.id).toBeTruthy();
    const testcaseId = created.id;

    const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`);
    expect(getRes.ok()).toBeTruthy();
    expect((await getRes.json()).title).toBe(title);

    const updatedTitle = `${title} (updated)`;
    const putRes = await request.put(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, {
      data: { title: updatedTitle },
    });
    expect(putRes.ok()).toBeTruthy();

    const getAfterUpdateRes = await request.get(
      `/api/projects/${ctx.projectId}/testcases/${testcaseId}`,
    );
    expect((await getAfterUpdateRes.json()).title).toBe(updatedTitle);

    const listRes = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { search: updatedTitle },
    });
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(list.some((tc: { id: string }) => tc.id === testcaseId)).toBeTruthy();

    const deleteRes = await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`);
    expect(deleteRes.ok()).toBeTruthy();

    const getAfterDeleteRes = await request.get(
      `/api/projects/${ctx.projectId}/testcases/${testcaseId}`,
    );
    expect(getAfterDeleteRes.status()).toBe(404);
  });

  // Regression coverage for: severity/component are real testcases columns already returned by
  // the single-testcase GET, but the repository list SELECT (listTestCasesUncached) omitted both,
  // so the frontend's column selector had no data to show even once a column existed for them.
  test("the list endpoint returns severity and component, including as null when unset", { tag: '@tesbo.testId("TES-TC-565")' }, async ({ request }) => {
    const withValues = await createCase(request, { severity: "Critical", component: "Checkout" });
    const withoutValues = await createCase(request);

    try {
      const listRes = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: withValues.title },
      });
      expect(listRes.ok()).toBeTruthy();
      const listed = (await listRes.json()).find((tc: { id: string }) => tc.id === withValues.id);
      expect(listed.severity).toBe("Critical");
      expect(listed.component).toBe("Checkout");

      const listResUnset = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: withoutValues.title },
      });
      const listedUnset = (await listResUnset.json()).find((tc: { id: string }) => tc.id === withoutValues.id);
      expect(listedUnset.severity).toBeNull();
      expect(listedUnset.component).toBeNull();
    } finally {
      await deleteCase(request, withValues.id);
      await deleteCase(request, withoutValues.id);
    }
  });

  test("defaults are applied when optional fields are omitted on create", { tag: '@tesbo.testId("TES-TC-552")' }, async ({ request }) => {
    const created = await createCase(request);
    try {
      expect(created.priority).toBe("P2");
      expect(created.type).toBe("Functional");
      expect(created.status).toBe("Draft");
      expect(created.automationStatus).toBe("Not Automated");
      expect(created.suiteId).toBeNull();
      expect(created.steps).toEqual([]);
      expect(created.externalId).toBeTruthy();
    } finally {
      await deleteCase(request, created.id);
    }
  });

  // Distinct from TES-TC-552 above: that test proves a field OMITTED from the body gets a
  // default. This proves a field explicitly SENT as blank does not — the Create Test Case form
  // always includes suite/type/priority/automationStatus/component/severity in its payload, blank
  // or not (testcases/page.tsx), so an unselected/untouched field on that form arrives here as an
  // explicit "", not a missing key. Before this, insertTestCaseWithClient's `body.x || <default>`
  // treated both cases the same, so a Create submitted without picking these fields silently
  // saved "P2"/"Functional"/"Not Automated"/"No severity" — a real value the user never chose.
  test("explicit blank priority/type/automationStatus/severity/component on create are saved blank, not defaulted", async ({ request }) => {
    const created = await createCase(request, {
      suiteId: undefined,
      priority: "",
      type: "",
      automationStatus: "",
      severity: "",
      component: "",
    });
    try {
      expect(created.priority).toBe("");
      expect(created.type).toBeNull();
      expect(created.automationStatus).toBeNull();
      expect(created.severity).toBeNull();
      expect(created.component).toBeNull();
      expect(created.suiteId).toBeNull();
      // Status is excluded from this optional-field behavior on purpose: the Create form never
      // leaves it blank, so it keeps defaulting to "Draft" the same as before.
      expect(created.status).toBe("Draft");
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("blank title defaults to 'Untitled test case' when omitted entirely, but an explicit empty string is honored", { tag: '@tesbo.testId("TES-TC-553")' }, async ({
    request,
  }) => {
    const withoutTitle = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: {} })
    ).json();
    const withBlankTitle = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: "" } })
    ).json();

    try {
      expect(withoutTitle.title).toBe("Untitled test case");
      // KNOWN GAP: createTestCase uses `body.title || "Untitled test case"` (falsy-check), so an
      // explicit "" also falls back to the default here — unlike updateTestCase's `??` pattern
      // below, which lets "" through as a real (blank) value once the row already exists.
      expect(withBlankTitle.title).toBe("Untitled test case");
    } finally {
      await deleteCase(request, withoutTitle.id);
      await deleteCase(request, withBlankTitle.id);
    }
  });

  test("an explicit empty string clears text fields on update ('?? null' treats '' as provided, unlike bugs' '|| null' pattern)", { tag: '@tesbo.testId("TES-TC-554")' }, async ({
    request,
  }) => {
    const created = await createCase(request, {
      description: "Original description",
      testData: "Original test data",
    });

    try {
      const res = await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { title: "", description: "", testData: "" },
      });
      expect(res.ok()).toBeTruthy();

      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.title).toBe("");
      expect(after.description).toBe("");
      expect(after.testData).toBe("");
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("estimatedDuration is accepted on create/update but silently discarded (dead field)", { tag: '@tesbo.testId("TES-TC-555")' }, async ({
    request,
  }) => {
    // KNOWN GAP: the `estimated_duration` column exists (migrations/V7_testcase_additional_fields.sql)
    // and the manual test-case form / import mapping UI both expose it, but createTestCase and
    // updateTestCase never reference it in their INSERT/UPDATE column lists — anything sent here
    // is silently dropped rather than persisted or rejected. Pinned per
    // FEATURE_DOCUMENTATION.md Appendix C4.
    const created = await createCase(request, { estimatedDuration: 45 });
    try {
      expect(created.estimatedDuration).toBeNull();

      await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { estimatedDuration: 90 },
      });
      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.estimatedDuration).toBeNull();
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("getting, updating, or deleting a nonexistent test case returns 404", { tag: '@tesbo.testId("TES-TC-556")' }, async ({ request }) => {
    const missingId = "00000000-0000-0000-0000-000000000000";

    const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${missingId}`, {
      failOnStatusCode: false,
    });
    expect(getRes.status()).toBe(404);

    const putRes = await request.put(`/api/projects/${ctx.projectId}/testcases/${missingId}`, {
      data: { title: "nope" },
      failOnStatusCode: false,
    });
    expect(putRes.status()).toBe(404);

    const deleteRes = await request.delete(`/api/projects/${ctx.projectId}/testcases/${missingId}`, {
      failOnStatusCode: false,
    });
    expect(deleteRes.status()).toBe(404);
  });

  test("delete is a soft delete — the row disappears from get/list but the external_id isn't recyclable", { tag: '@tesbo.testId("TES-TC-557")' }, async ({
    request,
  }) => {
    const created = await createCase(request);
    const externalId = created.externalId;
    await request.delete(`/api/projects/${ctx.projectId}/testcases/${created.id}`);

    const getAfterDelete = await request.get(
      `/api/projects/${ctx.projectId}/testcases/${created.id}`,
      { failOnStatusCode: false },
    );
    expect(getAfterDelete.status()).toBe(404);

    // (project_id, external_id) is UNIQUE at the DB level with no partial/deleted_at-aware index,
    // so a soft-deleted case's external_id is gone forever — re-creating with the same explicit
    // externalId must fail even though the case is invisible everywhere else.
    const collideRes = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
      data: { title: "Collides with a deleted case's external id", externalId },
      failOnStatusCode: false,
    });
    expect(collideRes.ok()).toBeFalsy();
  });
});

test.describe("move to suite", () => {
  test("creating a test case with a suiteId assigns it to that suite", { tag: '@tesbo.testId("TES-TC-558")' }, async ({ request }) => {
    const suite = await createSuite(request, `E2E Move Create Suite ${Date.now()}`);
    const created = await createCase(request, { suiteId: suite.id });

    try {
      expect(created.suiteId).toBe(suite.id);
    } finally {
      await deleteCase(request, created.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("updating suiteId moves a test case from one suite to another", { tag: '@tesbo.testId("TES-TC-559")' }, async ({ request }) => {
    const suiteA = await createSuite(request, `E2E Move A ${Date.now()}`);
    const suiteB = await createSuite(request, `E2E Move B ${Date.now()}`);
    const created = await createCase(request, { suiteId: suiteA.id });

    try {
      const moveRes = await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { suiteId: suiteB.id },
      });
      expect(moveRes.ok()).toBeTruthy();

      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.suiteId).toBe(suiteB.id);
    } finally {
      await deleteCase(request, created.id);
      await deleteSuite(request, suiteA.id);
      await deleteSuite(request, suiteB.id);
    }
  });

  test("moving back to no suite by sending suiteId: null un-suites the test case", { tag: '@tesbo.testId("TES-TC-560")' }, async ({ request }) => {
    const suite = await createSuite(request, `E2E Move To Null ${Date.now()}`);
    const created = await createCase(request, { suiteId: suite.id });

    try {
      await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { suiteId: null },
      });
      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.suiteId).toBeNull();
    } finally {
      await deleteCase(request, created.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("omitting suiteId on update un-assigns the suite (suite_id is overwritten, not COALESCEd)", { tag: '@tesbo.testId("TES-TC-561")' }, async ({
    request,
  }) => {
    // KNOWN GAP (documented, not test.fail() — mirrors updateSuite's parentId bug in
    // suites.spec.ts): unlike every other column in updateTestCase, `suite_id=$2` is bound
    // directly to `body.suiteId ?? null` instead of COALESCE(...) — so any update that doesn't
    // explicitly resend the current suiteId silently un-suites the test case.
    const suite = await createSuite(request, `E2E Move Unassign ${Date.now()}`);
    const created = await createCase(request, { suiteId: suite.id });

    try {
      await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { description: "unrelated update, no suiteId sent" },
      });

      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.suiteId).toBeNull();
    } finally {
      await deleteCase(request, created.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("bulk-update moves many test cases into a suite in one call", { tag: '@tesbo.testId("TES-TC-562")' }, async ({ request }) => {
    const suite = await createSuite(request, `E2E Bulk Move Suite ${Date.now()}`);
    const a = await createCase(request);
    const b = await createCase(request);

    try {
      const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [a.id, b.id], suiteId: suite.id },
      });
      expect(res.ok()).toBeTruthy();

      for (const id of [a.id, b.id]) {
        const after = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`)).json();
        expect(after.suiteId).toBe(suite.id);
      }
    } finally {
      await deleteCase(request, a.id);
      await deleteCase(request, b.id);
      await deleteSuite(request, suite.id);
    }
  });
});

test.describe("field edits — every editable field", () => {
  test("create accepts the full field set and returns each field verbatim", { tag: '@tesbo.testId("TES-TC-563")' }, async ({ request }) => {
    const suite = await createSuite(request, `E2E Full Fields Suite ${Date.now()}`);
    const me = await (await request.get("/api/auth/me")).json();
    const steps = [
      { stepNumber: 1, action: "Open the login page", expectedResult: "Login form is visible" },
      { stepNumber: 2, action: "Submit valid credentials", expectedResult: "User lands on the dashboard" },
    ];

    const payload = {
      suiteId: suite.id,
      title: `E2E Full Fields ${Date.now()}`,
      description: "Full description",
      preconditions: "User has an account",
      postconditions: "User is logged in",
      steps,
      testData: "user@example.com / Passw0rd!",
      priority: "P1",
      severity: "High",
      type: "Regression",
      automationStatus: "Automated",
      automationRepo: "github.com/org/repo",
      automationPath: "tests/login.spec.ts",
      automationTestName: "logs in with valid credentials",
      automationFramework: "Playwright",
      automationTags: "smoke,auth",
      ownerId: me.userId,
      component: "Auth",
      status: "In Review",
      jiraIssueKey: "PROJ-123",
      jiraUrl: "https://example.atlassian.net/browse/PROJ-123",
      linearIssueKey: "ENG-45",
      linearUrl: "https://linear.app/team/issue/ENG-45",
      attachments: "See PROJ-123 for context",
    };

    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: payload })
    ).json();

    try {
      for (const [key, value] of Object.entries(payload)) {
        if (key === "steps") expect(created.steps).toEqual(steps);
        else expect(created[key as keyof typeof created]).toBe(value);
      }
    } finally {
      await deleteCase(request, created.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("update can change every editable field to a new value", { tag: '@tesbo.testId("TES-TC-564")' }, async ({ request }) => {
    const suiteA = await createSuite(request, `E2E Edit A ${Date.now()}`);
    const suiteB = await createSuite(request, `E2E Edit B ${Date.now()}`);
    const owner = await (await request.get("/api/auth/me")).json();
    const original = await createCase(request, { suiteId: suiteA.id });
    const updatedSteps = [{ stepNumber: 1, action: "Updated action", expectedResult: "Updated result" }];

    const updates = {
      suiteId: suiteB.id,
      title: `E2E Edit Updated ${Date.now()}`,
      description: "Updated description",
      preconditions: "Updated preconditions",
      postconditions: "Updated postconditions",
      steps: updatedSteps,
      testData: "updated test data",
      priority: "P0",
      severity: "Critical",
      type: "Security",
      automationStatus: "Not Automated",
      automationRepo: "github.com/org/updated-repo",
      automationPath: "tests/updated.spec.ts",
      automationTestName: "updated test name",
      automationFramework: "Cypress",
      automationTags: "regression,security",
      ownerId: owner.userId,
      component: "Updated component",
      status: "Deprecated",
      jiraIssueKey: "PROJ-999",
      jiraUrl: "https://example.atlassian.net/browse/PROJ-999",
      linearIssueKey: "ENG-99",
      linearUrl: "https://linear.app/team/issue/ENG-99",
      attachments: "Updated notes",
    };

    try {
      const res = await request.put(`/api/projects/${ctx.projectId}/testcases/${original.id}`, {
        data: updates,
      });
      expect(res.ok()).toBeTruthy();

      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${original.id}`)
      ).json();
      for (const [key, value] of Object.entries(updates)) {
        if (key === "steps") expect(after.steps).toEqual(updatedSteps);
        else expect(after[key as keyof typeof after]).toBe(value);
      }
    } finally {
      await deleteCase(request, original.id);
      await deleteSuite(request, suiteA.id);
      await deleteSuite(request, suiteB.id);
    }
  });
});

test.describe("bulk operations", () => {
  test("bulk-update changes priority, status and ownerId for every selected test case", { tag: '@tesbo.testId("TES-TC-565")' }, async ({ request }) => {
    const me = await (await request.get("/api/auth/me")).json();
    const a = await createCase(request, { priority: "P3", status: "Draft" });
    const b = await createCase(request, { priority: "P3", status: "Draft" });

    try {
      const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [a.id, b.id], priority: "P0", status: "Approved", ownerId: me.userId },
      });
      expect(res.ok()).toBeTruthy();

      for (const id of [a.id, b.id]) {
        const after = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`)).json();
        expect(after.priority).toBe("P0");
        expect(after.status).toBe("Approved");
        expect(after.ownerId).toBe(me.userId);
      }
    } finally {
      await deleteCase(request, a.id);
      await deleteCase(request, b.id);
    }
  });

  test("bulk-update sending an empty string leaves that field unchanged (falsy-check, unlike single-update's blank-out gap)", { tag: '@tesbo.testId("TES-TC-566")' }, async ({
    request,
  }) => {
    const created = await createCase(request, { priority: "P1" });

    try {
      await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [created.id], priority: "" },
      });
      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.priority).toBe("P1");
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("bulk-update no-ops silently on an empty testcaseIds array", { tag: '@tesbo.testId("TES-TC-567")' }, async ({ request }) => {
    const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
      data: { testcaseIds: [], priority: "P0" },
    });
    expect(res.ok()).toBeTruthy();
  });

  test("bulk-delete soft-deletes every selected test case", { tag: '@tesbo.testId("TES-TC-568")' }, async ({ request }) => {
    const a = await createCase(request);
    const b = await createCase(request);

    const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-delete`, {
      data: { testcaseIds: [a.id, b.id] },
    });
    expect(res.ok()).toBeTruthy();

    for (const id of [a.id, b.id]) {
      const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`, {
        failOnStatusCode: false,
      });
      expect(getRes.status()).toBe(404);
    }
  });

  test("bulk-delete no-ops silently on an empty testcaseIds array", { tag: '@tesbo.testId("TES-TC-569")' }, async ({ request }) => {
    const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-delete`, {
      data: { testcaseIds: [] },
    });
    expect(res.ok()).toBeTruthy();
  });

  test("archiving sets status to Archived; restoring a prior status is just another update", { tag: '@tesbo.testId("TES-TC-570")' }, async ({
    request,
  }) => {
    const created = await createCase(request, { status: "Approved" });

    try {
      await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { status: "Archived" },
      });
      const archived = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(archived.status).toBe("Archived");

      // The frontend's "Unarchive" button always sends status:"Draft" regardless of what the
      // status was before archiving, rather than restoring "Approved" (see
      // FEATURE_DOCUMENTATION.md Section B5) — a UI-level gap, not a backend one. The backend
      // itself has no opinion on the prior value and accepts whatever status a direct PUT sends,
      // which is what this asserts.
      await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { status: "Approved" },
      });
      const restored = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(restored.status).toBe("Approved");
    } finally {
      await deleteCase(request, created.id);
    }
  });
});

test.describe("search", () => {
  test("matches by title substring, case-insensitively", { tag: '@tesbo.testId("TES-TC-571")' }, async ({ request }) => {
    const marker = `E2E Search Title ${Date.now()}`;
    const created = await createCase(request, { title: marker });

    try {
      const res = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker.toUpperCase() },
        })
      ).json();
      expect(res.some((tc: { id: string }) => tc.id === created.id)).toBeTruthy();
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("matches by external ID substring", { tag: '@tesbo.testId("TES-TC-572")' }, async ({ request }) => {
    const created = await createCase(request);

    try {
      const idFragment = created.externalId.slice(-4);
      const res = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { search: idFragment } })
      ).json();
      expect(res.some((tc: { id: string }) => tc.id === created.id)).toBeTruthy();
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("matches by type substring, excluding other types", { tag: '@tesbo.testId("TES-TC-573")' }, async ({ request }) => {
    const marker = Date.now();
    const regression = await createCase(request, { title: `E2E Search Type A ${marker}`, type: "Regression" });
    const smoke = await createCase(request, { title: `E2E Search Type B ${marker}`, type: "Smoke" });

    try {
      const res = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { search: "regression" } })
      ).json();
      expect(res.some((tc: { id: string }) => tc.id === regression.id)).toBeTruthy();
      expect(res.some((tc: { id: string }) => tc.id === smoke.id)).toBeFalsy();
    } finally {
      await deleteCase(request, regression.id);
      await deleteCase(request, smoke.id);
    }
  });

  test("returns an empty list when nothing matches", { tag: '@tesbo.testId("TES-TC-574")' }, async ({ request }) => {
    const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { search: `no-such-testcase-${Date.now()}` },
    });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual([]);
  });

  test("an unescaped LIKE wildcard in the search term over-matches instead of being treated literally", { tag: '@tesbo.testId("TES-TC-575")' }, async ({
    request,
  }) => {
    // KNOWN GAP: listTestCases() wraps `search` in %...% but never escapes a literal % or _
    // within it, so a search term containing those characters keeps acting as a SQL LIKE
    // wildcard rather than matching them literally. Not a security bug — the value is still
    // bound as a query parameter, so injection isn't possible — just an over-matching precision
    // gap, pinned so a future fix that adds escaping is a deliberate, visible change.
    const marker = Date.now();
    const withPercent = await createCase(request, { title: `E2E Wildcard 100% Done ${marker}` });
    const withoutPercent = await createCase(request, { title: `E2E Wildcard 100X Done ${marker}` });

    try {
      const res = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: `100% Done ${marker}` },
        })
      ).json();
      expect(res.some((tc: { id: string }) => tc.id === withPercent.id)).toBeTruthy();
      expect(res.some((tc: { id: string }) => tc.id === withoutPercent.id)).toBeTruthy();
    } finally {
      await deleteCase(request, withPercent.id);
      await deleteCase(request, withoutPercent.id);
    }
  });
});

test.describe("filters", () => {
  test("filters by status, priority, and type independently", { tag: '@tesbo.testId("TES-TC-576")' }, async ({ request }) => {
    const marker = Date.now();
    const a = await createCase(request, {
      title: `E2E Filter A ${marker}`,
      status: "In Review",
      priority: "P0",
      type: "Regression",
    });
    const b = await createCase(request, {
      title: `E2E Filter B ${marker}`,
      status: "Approved",
      priority: "P3",
      type: "Smoke",
    });

    try {
      const byStatus = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { status: "In Review" } })
      ).json();
      expect(byStatus.some((tc: { id: string }) => tc.id === a.id)).toBeTruthy();
      expect(byStatus.some((tc: { id: string }) => tc.id === b.id)).toBeFalsy();

      const byPriority = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { priority: "P3" } })
      ).json();
      expect(byPriority.some((tc: { id: string }) => tc.id === b.id)).toBeTruthy();
      expect(byPriority.some((tc: { id: string }) => tc.id === a.id)).toBeFalsy();

      const byType = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { type: "Smoke" } })
      ).json();
      expect(byType.some((tc: { id: string }) => tc.id === b.id)).toBeTruthy();
      expect(byType.some((tc: { id: string }) => tc.id === a.id)).toBeFalsy();
    } finally {
      await deleteCase(request, a.id);
      await deleteCase(request, b.id);
    }
  });

  test("filters by suiteId, automationStatus, jiraIssueKey and linearIssueKey", { tag: '@tesbo.testId("TES-TC-577")' }, async ({ request }) => {
    const suite = await createSuite(request, `E2E Filter Suite ${Date.now()}`);
    const marker = Date.now();
    const inSuite = await createCase(request, {
      title: `E2E Filter InSuite ${marker}`,
      suiteId: suite.id,
      automationStatus: "Automated",
      jiraIssueKey: `JIRA${marker}`,
      linearIssueKey: `LIN${marker}`,
    });
    const outOfSuite = await createCase(request, { title: `E2E Filter OutOfSuite ${marker}` });

    try {
      const bySuite = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { suiteId: suite.id } })
      ).json();
      expect(bySuite.some((tc: { id: string }) => tc.id === inSuite.id)).toBeTruthy();
      expect(bySuite.some((tc: { id: string }) => tc.id === outOfSuite.id)).toBeFalsy();

      const byAutomation = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { automationStatus: "Automated" },
        })
      ).json();
      expect(byAutomation.some((tc: { id: string }) => tc.id === inSuite.id)).toBeTruthy();
      expect(byAutomation.some((tc: { id: string }) => tc.id === outOfSuite.id)).toBeFalsy();

      const byJira = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { jiraIssueKey: inSuite.jiraIssueKey },
        })
      ).json();
      expect(byJira.some((tc: { id: string }) => tc.id === inSuite.id)).toBeTruthy();

      const byLinear = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { linearIssueKey: inSuite.linearIssueKey },
        })
      ).json();
      expect(byLinear.some((tc: { id: string }) => tc.id === inSuite.id)).toBeTruthy();
    } finally {
      await deleteCase(request, inSuite.id);
      await deleteCase(request, outOfSuite.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("suiteId=none filters to test cases with no suite assigned", { tag: '@tesbo.testId("TES-TC-1208")' }, async ({ request }) => {
    const suite = await createSuite(request, `E2E NoSuite Filter Suite ${Date.now()}`);
    const marker = Date.now();
    const inSuite = await createCase(request, { title: `E2E NoSuite InSuite ${marker}`, suiteId: suite.id });
    const unassigned = await createCase(request, { title: `E2E NoSuite Unassigned ${marker}` });

    try {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { suiteId: "none" },
      });
      expect(res.ok()).toBeTruthy();
      const rows = await res.json();
      expect(rows.some((tc: { id: string }) => tc.id === unassigned.id)).toBeTruthy();
      expect(rows.some((tc: { id: string }) => tc.id === inSuite.id)).toBeFalsy();

      // Moving the unassigned case into the suite must remove it from the "no suite" filter —
      // proves the sentinel isn't just matching a literal suite_id of "none".
      await request.put(`/api/projects/${ctx.projectId}/testcases/${unassigned.id}`, {
        data: { suiteId: suite.id },
      });
      const afterMove = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { suiteId: "none" } })
      ).json();
      expect(afterMove.some((tc: { id: string }) => tc.id === unassigned.id)).toBeFalsy();
    } finally {
      await deleteCase(request, inSuite.id);
      await deleteCase(request, unassigned.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("combining status and priority filters applies AND logic", { tag: '@tesbo.testId("TES-TC-578")' }, async ({ request }) => {
    const marker = Date.now();
    const match = await createCase(request, { title: `E2E Combo Match ${marker}`, status: "In Review", priority: "P0" });
    const wrongPriority = await createCase(request, {
      title: `E2E Combo WrongPriority ${marker}`,
      status: "In Review",
      priority: "P3",
    });
    const wrongStatus = await createCase(request, {
      title: `E2E Combo WrongStatus ${marker}`,
      status: "Approved",
      priority: "P0",
    });

    try {
      const res = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { status: "In Review", priority: "P0" },
        })
      ).json();
      expect(res.some((tc: { id: string }) => tc.id === match.id)).toBeTruthy();
      expect(res.some((tc: { id: string }) => tc.id === wrongPriority.id)).toBeFalsy();
      expect(res.some((tc: { id: string }) => tc.id === wrongStatus.id)).toBeFalsy();
    } finally {
      await deleteCase(request, match.id);
      await deleteCase(request, wrongPriority.id);
      await deleteCase(request, wrongStatus.id);
    }
  });
});

test.describe("pagination", () => {
  test("limit controls page size while X-Total-Count reports the full filtered total", { tag: '@tesbo.testId("TES-TC-579")' }, async ({ request }) => {
    const marker = `E2E Pagination ${Date.now()}`;
    const created: string[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        created.push((await createCase(request, { title: `${marker} ${i}` })).id);
      }

      const pageRes = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, limit: 2 },
      });
      expect(pageRes.ok()).toBeTruthy();
      const page = await pageRes.json();
      expect(page).toHaveLength(2);
      expect(pageRes.headers()["x-total-count"]).toBe("5");
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });

  test("offset pages through results with no overlap, covering every fixture row exactly once", { tag: '@tesbo.testId("TES-TC-580")' }, async ({
    request,
  }) => {
    const marker = `E2E Offset ${Date.now()}`;
    const created: string[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        created.push((await createCase(request, { title: `${marker} ${i}` })).id);
      }

      const page1 = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, limit: 2, offset: 0 },
        })
      ).json();
      const page2 = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, limit: 2, offset: 2 },
        })
      ).json();

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      const ids1 = page1.map((tc: { id: string }) => tc.id);
      const ids2 = page2.map((tc: { id: string }) => tc.id);
      expect(ids1.some((id: string) => ids2.includes(id))).toBeFalsy();
      expect(new Set([...ids1, ...ids2])).toEqual(new Set(created));
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });

  test("limit=0 returns an empty page without affecting the reported total", { tag: '@tesbo.testId("TES-TC-581")' }, async ({ request }) => {
    const marker = `E2E ZeroLimit ${Date.now()}`;
    const created = await createCase(request, { title: marker });

    try {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, limit: 0 },
      });
      expect(res.ok()).toBeTruthy();
      expect(await res.json()).toEqual([]);
      expect(res.headers()["x-total-count"]).toBe("1");
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("a negative limit or offset is floored instead of reaching the database", { tag: '@tesbo.testId("TES-TC-582")' }, async ({ request }) => {
    /*
     * REWRITTEN, and this is the narrow case the tracker's §3 rule allows: the expectation itself was
     * documenting a defect. This test used to be titled "...is passed straight to the database with no
     * floor validation" and asserted that both requests FAIL, pinning the gap so it could not change
     * silently. It has now changed on purpose.
     *
     * `Number(query.limit || 100)` with no floor sent a negative straight into a LIMIT clause, and
     * `Number("abc")` sent NaN — Postgres rejects both, so a word or a minus sign in a query string was
     * a 500 on every paginated endpoint. pageNumber() in legacy.service.ts now corrects a non-number
     * and floors a negative, which is what this asserts.
     */
    const negatives: Array<Record<string, number>> = [{ limit: -1 }, { offset: -1 }, { limit: -50, offset: -50 }];
    for (const params of negatives) {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params,
        failOnStatusCode: false,
      });
      expect(res.status(), `${JSON.stringify(params)} answered ${res.status()}: ${await res.text()}`).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    }

    // A non-numeric page falls back to the default rather than erroring.
    const nonNumeric: Array<Record<string, string>> = [{ limit: "abc" }, { offset: "abc" }, { limit: "1e999" }];
    for (const params of nonNumeric) {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params,
        failOnStatusCode: false,
      });
      expect(res.status(), `${JSON.stringify(params)} answered ${res.status()}: ${await res.text()}`).toBe(200);
    }

    // And the ceiling still holds, so a caller cannot ask for the whole table.
    const huge = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { limit: 100000 },
      failOnStatusCode: false,
    });
    expect(huge.status()).toBe(200);
    expect((await huge.json()).length).toBeLessThanOrEqual(500);
  });
  test("the list stays in ID sequence after a bulk action, and pages stay stable", { tag: '@tesbo.testId("TES-TC-958")' }, async ({ request }) => {
    /*
     * Basecamp 10212941059 / BetterBugs 6a8428b9 — "Test Case ID Sequence Is Incorrect After
     * Performing Bulk Actions". The reported screen read AIP-TC-33, then 25, 26, 27, 28, 29, 30.
     *
     * The list was `ORDER BY updated_at DESC` with no tiebreaker. A bulk update writes
     * `updated_at = now()` to every selected row in a single statement, so those rows all carry one
     * identical timestamp and an ORDER BY on a non-unique key leaves them in whatever order the plan
     * emits. Two consequences, and this test covers both:
     *
     *   1. the freshly bulk-updated rows jump ahead of untouched newer ones, so the ID column is no
     *      longer a sequence — the reported symptom;
     *   2. each page is its own query, so under LIMIT/OFFSET a tied row could come back on two pages
     *      while another was never returned at all. That is silent data loss in a list, not cosmetics.
     *
     * Ordering is now created_at DESC, id DESC. external_id is assigned sequentially at creation, so
     * that IS the ID sequence, and no edit reshuffles it.
     *
     * Deliberately bulk-updates the two OLDEST cases: under the old ordering they are exactly the two
     * that jump to the front, so this fails on the unfixed code rather than relying on how Postgres
     * happens to break a tie.
     */
    const marker = `E2E Order ${Date.now()}`;
    const created: string[] = [];
    try {
      // Sequential, not Promise.all — creation order is what defines the expected order.
      for (let i = 0; i < 6; i++) {
        created.push((await createCase(request, { title: `${marker} ${String(i).padStart(2, "0")}` })).id);
      }
      const newestFirst = [...created].reverse();

      const listIds = async (params: Record<string, unknown> = {}) => {
        const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, limit: 100, ...params },
        });
        expect(res.ok(), `listing — ${await res.text()}`).toBeTruthy();
        return (await res.json()).map((tc: { id: string }) => tc.id);
      };

      expect(await listIds(), "the list should start in ID sequence, newest first").toEqual(newestFirst);

      // The bulk action from the report, over the two oldest cases.
      const bulk = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [created[0], created[1]], priority: "P1" },
        failOnStatusCode: false,
      });
      expect(bulk.status(), `bulk-update — ${await bulk.text()}`).toBeLessThan(400);
      // The bulk really did land, so the ordering assertion below is not passing on a no-op.
      const afterBulk = await request.get(`/api/projects/${ctx.projectId}/testcases/${created[0]}`);
      expect((await afterBulk.json()).priority).toBe("P1");

      expect(await listIds(), "a bulk action must not reorder the list").toEqual(newestFirst);

      // Every page of the same result set, walked in slices of 2.
      const paged: string[] = [];
      for (let offset = 0; offset < 6; offset += 2) {
        const page = await listIds({ limit: 2, offset });
        expect(page, `page at offset ${offset} should be full`).toHaveLength(2);
        paged.push(...page);
      }
      // No row repeated, none missing, and the pages reassemble the unpaged order exactly.
      expect(new Set(paged).size, `paging returned a duplicate: ${paged.join(", ")}`).toBe(6);
      expect(paged, "the pages do not reassemble the unpaged order").toEqual(newestFirst);
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });
  test("suiteId=none returns exactly the cases that belong to no suite", { tag: '@tesbo.testId("TES-TC-959")' }, async ({ request }) => {
    /*
     * Basecamp 10212879823 / 10212867874 — "Test Case Counts Are Inconsistent Between Test Case
     * Repository and Test Suite" / "Test Cases Created Through Zyra AI Are Missing from Test Suite".
     * The reported project held 33 cases while the suite tree totalled 26: the other 7 had a null
     * suite_id, and there was no way to ask for them. The filter loop only ever built
     * `suite_id = $n`, and `if (query[param])` skipped an empty value, so unfiled cases matched no
     * suite filter at all and the repository's new "No suites" node had nothing to select with.
     *
     * Cases land unfiled routinely — the create form defaults to no suite, an import with no suite
     * column mapped leaves it null, and Zyra's chat only files a case when the model names a suite.
     */
    const marker = `E2E Unfiled ${Date.now()}`;
    const suite = await createSuite(request, `${marker} suite`);
    const filed: string[] = [];
    const unfiled: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        filed.push((await createCase(request, { title: `${marker} filed ${i}`, suiteId: suite.id })).id);
      }
      for (let i = 0; i < 3; i++) {
        unfiled.push((await createCase(request, { title: `${marker} unfiled ${i}` })).id);
      }

      const listIds = async (params: Record<string, unknown>) => {
        const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, limit: 100, ...params },
        });
        expect(res.ok(), `listing — ${await res.text()}`).toBeTruthy();
        return new Set((await res.json()).map((tc: { id: string }) => tc.id));
      };

      // The sentinel returns the unfiled cases and nothing else.
      expect(await listIds({ suiteId: "none" })).toEqual(new Set(unfiled));
      // The real suite still returns only its own, so the sentinel did not weaken the normal path.
      expect(await listIds({ suiteId: suite.id })).toEqual(new Set(filed));
      // And unfiltered still returns both, so the two views partition the project.
      expect(await listIds({})).toEqual(new Set([...filed, ...unfiled]));

      // The repository summary's Unassigned bucket is what the "No suites" badge counts, so it has to
      // agree with the rows the sentinel returns.
      const summary = await (
        await request.get(`/api/projects/${ctx.projectId}/reports/repository-summary`)
      ).json();
      const unassigned = summary.bySuite.find((b: { name: string }) => b.name === "Unassigned");
      expect(unassigned, "the summary reports no Unassigned bucket").toBeTruthy();
      expect(unassigned.count).toBeGreaterThanOrEqual(unfiled.length);

      // "none" is a sentinel, not a uuid — it must not reach the column as one and 500. `suite_id`
      // is a uuid column, so anything else that is not the sentinel raised 22P02 (`invalid input
      // syntax for type uuid`) and answered 500 on what is a malformed query parameter: a stale id
      // pasted from a URL, or a truncated copy/paste, reading to the caller as a server fault.
      for (const bad of ["not-a-uuid", "123", " "]) {
        const bogus = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, suiteId: bad },
          failOnStatusCode: false,
        });
        expect(bogus.status(), `suiteId=${JSON.stringify(bad)} — ${await bogus.text()}`).toBeLessThan(500);
      }
      // A non-empty malformed value is a bad request, stated as one.
      const bogus = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, suiteId: "not-a-uuid" },
        failOnStatusCode: false,
      });
      expect(bogus.status(), `a malformed suiteId answered ${bogus.status()}`).toBe(400);

      // An id that is well-formed but belongs to nothing is not malformed — it is a filter that
      // matches no rows, and must still answer 200 with an empty list rather than 400.
      const unknown = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, suiteId: "00000000-0000-4000-8000-000000000000" },
        failOnStatusCode: false,
      });
      expect(unknown.status(), `an unknown but well-formed suiteId — ${await unknown.text()}`).toBe(200);
      expect((await unknown.json()).list).toEqual([]);
    } finally {
      for (const id of [...filed, ...unfiled]) await deleteCase(request, id);
      await deleteSuite(request, suite.id);
    }
  });
  test("archived cases are out of the default list but still reachable and still counted", { tag: '@tesbo.testId("TES-TC-960")' }, async ({
    request,
  }) => {
    /*
     * Basecamp 10212766570 — "Test Case Edit, Update, and Delete Actions via Zyra Are Not Properly
     * Reflected in Test Case Repository", reported as duplicates and incorrect repository data.
     *
     * Zyra has no delete operation: "remove these test cases" maps to its `archive` op, which sets
     * status = "Archived". listTestCases only excluded `deleted_at IS NULL`, so those rows stayed in
     * the working list looking exactly like live ones — the user concluded nothing had happened, asked
     * again, and ended up with duplicates. Archiving itself is correct and stays as it is; what
     * changed is that an archived case is no longer in the default list.
     *
     * Deliberately pins all three halves of the contract, because hiding rows by default is the kind
     * of change that quietly loses data if it goes too far: excluded by default, reachable on request,
     * and still counted by the summary the DEPRECATED tile reads.
     */
    const marker = `E2E Archived ${Date.now()}`;
    const live: string[] = [];
    let archived = "";
    try {
      for (let i = 0; i < 2; i++) {
        live.push((await createCase(request, { title: `${marker} live ${i}` })).id);
      }
      archived = (await createCase(request, { title: `${marker} archived`, status: "Archived" })).id;

      const list = async (params: Record<string, unknown> = {}) => {
        const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, limit: 100, ...params },
        });
        expect(res.ok(), `listing — ${await res.text()}`).toBeTruthy();
        return { ids: new Set((await res.json()).map((tc: { id: string }) => tc.id)), res };
      };

      // 1. Out of the default list, and out of the reported total with it — the "N results" footer
      //    has to agree with the rows, or the screen is inconsistent in the other direction.
      const dflt = await list();
      expect(dflt.ids, "an archived case is still in the default list").toEqual(new Set(live));
      expect(dflt.res.headers()["x-total-count"]).toBe("2");

      // 2. Reachable two ways, so nothing becomes unreachable.
      expect((await list({ status: "Archived" })).ids).toEqual(new Set([archived]));
      expect((await list({ includeArchived: "true" })).ids).toEqual(new Set([...live, archived]));

      // 3. Another status filter must not accidentally re-admit archived rows.
      expect((await list({ status: "Draft" })).ids).toEqual(new Set(live));

      // 4. Still counted by the summary — the DEPRECATED tile is Deprecated + Archived, so hiding the
      //    rows must not remove them from the repository's own accounting.
      const summary = await (
        await request.get(`/api/projects/${ctx.projectId}/reports/repository-summary`)
      ).json();
      const archivedBucket = summary.byStatus.find((b: { name: string }) => b.name === "Archived");
      expect(archivedBucket, "the summary lost its Archived bucket").toBeTruthy();
      expect(archivedBucket.count).toBeGreaterThanOrEqual(1);
    } finally {
      for (const id of [...live, archived].filter(Boolean)) await deleteCase(request, id);
    }
  });
  test("bulk-move can take a case out of its suite, not only into another one", { tag: '@tesbo.testId("TES-TC-961")' }, async ({ request }) => {
    /*
     * Basecamp 10194174342 — "test cases count and test cases discrepancy after suite move". The
     * reported screen showed TOTAL 136 against a suite tree summing to 108.
     *
     * Two causes, and this test covers the one specific to moving. The repository's bulk-move modal
     * offers "Unassigned (no suite)" as its FIRST option, which sent `suiteId: ""` -> `undefined`, and
     * the API's `suite_id = COALESCE($3, suite_id)` then wrote the case's existing suite straight back.
     * Choosing it reported success and moved nothing, so the counts never changed — a silent no-op on
     * the default option of a destructive-looking action.
     *
     * COALESCE cannot distinguish "not supplied" from "set to nothing", so an explicit sentinel does:
     * `suiteId: "none"` clears it, and it is the same value listTestCases reads as `suite_id IS NULL`.
     * (The other cause was the repository counters ignoring unfiled cases — see TCR-08.)
     */
    const marker = `E2E MoveOut ${Date.now()}`;
    const from = await createSuite(request, `${marker} from`);
    const to = await createSuite(request, `${marker} to`);
    const caseId = (await createCase(request, { title: `${marker} case`, suiteId: from.id })).id;

    const suiteOf = async (): Promise<string | null> => {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases/${caseId}`);
      expect(res.ok(), `reading the case — ${await res.text()}`).toBeTruthy();
      return (await res.json()).suiteId ?? null;
    };

    try {
      expect(await suiteOf()).toBe(from.id);

      // Moving into another suite always worked — kept here so the sentinel cannot regress it.
      const moved = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [caseId], suiteId: to.id },
        failOnStatusCode: false,
      });
      expect(moved.status(), `moving into a suite — ${await moved.text()}`).toBeLessThan(400);
      expect(await suiteOf()).toBe(to.id);

      // The reported case: move it out of every suite.
      const cleared = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [caseId], suiteId: "none" },
        failOnStatusCode: false,
      });
      expect(cleared.status(), `unassigning — ${await cleared.text()}`).toBeLessThan(400);
      expect(await suiteOf(), "the case is still filed — unassigning was a silent no-op").toBeNull();

      // It is now reachable exactly where the repository's "No suites" node looks for it.
      const unfiled = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, suiteId: "none", limit: 50 },
      });
      expect((await unfiled.json()).map((tc: { id: string }) => tc.id)).toContain(caseId);

      // And an omitted suiteId must still leave the suite alone — the behaviour COALESCE was there for.
      await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [caseId], suiteId: to.id },
        failOnStatusCode: false,
      });
      await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [caseId], priority: "P1" },
        failOnStatusCode: false,
      });
      expect(await suiteOf(), "a bulk edit with no suiteId moved the case anyway").toBe(to.id);
    } finally {
      await deleteCase(request, caseId);
      await deleteSuite(request, from.id);
      await deleteSuite(request, to.id);
    }
  });
  test("an over-long field is a field-level 400, never an Internal Server Error", { tag: '@tesbo.testId("TES-TC-1209")' }, async ({ request }) => {
    /*
     * Basecamp 10226376787 — "Internal Server Error When Adding a Long Description to Test Case Details".
     *
     * The title is misleading and the screenshot settles it: `description` is TEXT and cannot overflow;
     * the long lorem-ipsum was in the TITLE, which is VARCHAR(512). Nothing bounded it, so Postgres
     * raised 22001 (string_data_right_truncation), no handler caught that code, and the create answered
     * 500 with "Internal server error" — telling the reporter nothing about which field to shorten.
     *
     * Title was just the field they happened to use. `testcases` has fourteen length-bounded columns and
     * none were validated, so each was its own latent 500. Same defect class as the Knowledge Base
     * folder rename (Basecamp 10199204536).
     */
    const marker = `E2E Bounded ${Date.now()}`;
    const created: string[] = [];
    try {
      // The reported case, and the boundary either side of it.
      const tooLongTitle = "T".repeat(513);
      const overLong = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: tooLongTitle },
        failOnStatusCode: false,
      });
      expect(
        overLong.status(),
        `a 513-character title answered ${overLong.status()} — a 500 here is the reported bug`,
      ).toBe(400);
      const message = await overLong.text();
      expect(message, "the error must name the field and its limit").toMatch(/title/i);
      expect(message).toMatch(/512/);

      // 512 exactly is a legal title, so the guard must be off-by-none.
      const atLimit = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: "A".repeat(512) },
        failOnStatusCode: false,
      });
      expect(atLimit.status(), `a 512-character title was refused — ${await atLimit.text()}`).toBe(201);
      created.push((await atLimit.json()).id);

      // The other bounded columns, each reachable through the API with its own width.
      const base = await createCase(request, { title: `${marker} base` });
      created.push(base.id);
      for (const [field, max] of [
        ["component", 255],
        ["automationFramework", 64],
        ["priority", 8],
        ["severity", 32],
        ["automationTags", 512],
      ] as const) {
        const res = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
          data: { title: `${marker} ${field}`, [field]: "x".repeat(max + 1) },
          failOnStatusCode: false,
        });
        expect(res.status(), `an over-long ${field} answered ${res.status()}: ${await res.text()}`).toBe(400);

        // And the same field on UPDATE, which writes the same column.
        const patched = await request.put(`/api/projects/${ctx.projectId}/testcases/${base.id}`, {
          data: { [field]: "x".repeat(max + 1) },
          failOnStatusCode: false,
        });
        expect(patched.status(), `an over-long ${field} on update answered ${patched.status()}`).toBe(400);
      }

      // Nothing was written by any of the refused calls.
      const listed = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, limit: 50 },
      });
      const titles = (await listed.json()).map((tc: { title: string }) => tc.title);
      expect(titles.filter((t: string) => t.startsWith(`${marker} `)).length, "a refused create still wrote a row").toBe(1);
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });

  test("a bulk import names the row and field that is too long instead of failing with a 500", { tag: '@tesbo.testId("TES-TC-1210")' }, async ({
    request,
  }) => {
    /*
     * The bulk path casts each text column to its varchar width, so one over-long value anywhere in the
     * batch raised 22001 and rolled the whole transaction back — an import of many rows died with
     * nothing written and no indication which row or field was at fault.
     */
    const marker = `E2E BulkBounded ${Date.now()}`;
    const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-create`, {
      data: {
        testcases: [
          { title: `${marker} fine 1` },
          { title: `${marker} fine 2` },
          { title: "T".repeat(513) },
        ],
      },
      failOnStatusCode: false,
    });
    expect(res.status(), `an over-long row answered ${res.status()}: ${await res.text()}`).toBe(400);
    const body = await res.text();
    // The row number is what makes a 500-row import diagnosable.
    expect(body, "the error should name the offending row").toMatch(/row 3/i);
    expect(body).toMatch(/title/i);

    // The batch is all-or-nothing, so the two valid rows must not have landed either.
    const listed = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { search: marker, limit: 50 },
    });
    expect((await listed.json()).length, "a refused batch partially imported").toBe(0);
  });

  test("estimatedDuration is persisted, returned, and format-validated", { tag: '@tesbo.testId("TES-TC-1211")' }, async ({ request }) => {
    /*
     * Basecamp 10226363759 — "Estimated Time Field Accepts Invalid Text and Special Characters".
     *
     * It was worse than the report: the frontend has always sent `estimatedDuration` on create and
     * update, and the backend had NO reference to it at all, so the V7 `estimated_duration VARCHAR(64)`
     * column was dead and every value typed was silently discarded. It accepted anything because it
     * stored nothing — so the first thing asserted here is that it round-trips at all.
     */
    const created: string[] = [];
    try {
      // Round-trips on create.
      const withDuration = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Duration ${Date.now()}`, estimatedDuration: "2h 30m" },
        failOnStatusCode: false,
      });
      expect(withDuration.status(), `creating with a duration — ${await withDuration.text()}`).toBe(201);
      const id = (await withDuration.json()).id;
      created.push(id);
      const read = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`)).json();
      expect(read.estimatedDuration, "the estimate was silently discarded").toBe("2h 30m");

      // And on update.
      const patched = await request.put(`/api/projects/${ctx.projectId}/testcases/${id}`, {
        data: { estimatedDuration: "90" },
        failOnStatusCode: false,
      });
      expect(patched.status()).toBeLessThan(400);
      expect((await (await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`)).json()).estimatedDuration).toBe("90");

      // The forms the field is meant to take.
      for (const value of ["45m", "3h", "12h 5m", "600"]) {
        const res = await request.put(`/api/projects/${ctx.projectId}/testcases/${id}`, {
          data: { estimatedDuration: value },
          failOnStatusCode: false,
        });
        expect(res.status(), `"${value}" should be a valid duration — ${await res.text()}`).toBeLessThan(400);
      }

      // The reported complaint: free text and special characters are refused now.
      for (const value of ["abc", "2 hours-ish", "!!!", "-5", "2h 30x", "<script>"]) {
        const res = await request.put(`/api/projects/${ctx.projectId}/testcases/${id}`, {
          data: { estimatedDuration: value },
          failOnStatusCode: false,
        });
        expect(res.status(), `"${value}" was accepted as a duration`).toBe(400);
      }

      // Over 64 characters is refused by the length guard, not by a truncation 500.
      const long = await request.put(`/api/projects/${ctx.projectId}/testcases/${id}`, {
        data: { estimatedDuration: "9".repeat(65) },
        failOnStatusCode: false,
      });
      expect(long.status()).toBe(400);

      // The last valid value survived every refusal above.
      expect((await (await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`)).json()).estimatedDuration).toBe("600");
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });
});

test.describe("sort", () => {
  /*
   * The repository table's ID/Test case title/Priority column sort (frontend: RepositoryTestCaseTable,
   * toggled from testcases/page.tsx and backed by legacy.service.ts listTestCases's new `sortBy`/
   * `sortDir` params). Added to give the repository the same sort affordance the Test Runs table
   * already had — see cycles/[cycleId]/page.tsx's SortableColumnHeader/toggleRunSort for the pattern
   * this mirrors. Unlike the Test Runs table (which sorts a fully-loaded, unpaginated list
   * client-side), the repository is server-paginated, so the sort has to be a real ORDER BY, not a
   * client-side re-sort of whatever page happened to load — these tests exercise the query params
   * directly rather than the screen.
   */
  const numericSuffix = (externalId: string): number => {
    const match = String(externalId).match(/(\d+)(?!.*\d)/);
    return match ? parseInt(match[1], 10) : NaN;
  };

  test("sortBy=id orders by the numeric ID sequence in both directions, and the two directions are exact reverses", async ({ request }) => {
    const marker = `E2E Sort Id ${Date.now()}`;
    const created: string[] = [];
    try {
      for (let i = 0; i < 5; i++) created.push((await createCase(request, { title: `${marker} ${i}` })).id);

      const listExternalIds = async (sortDir: "asc" | "desc") => {
        const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, sortBy: "id", sortDir },
        });
        expect(res.ok(), `sortBy=id&sortDir=${sortDir} — ${await res.text()}`).toBeTruthy();
        return (await res.json()).map((tc: { externalId: string }) => tc.externalId);
      };

      const ascending = await listExternalIds("asc");
      const descending = await listExternalIds("desc");
      expect(ascending, "should return every fixture row").toHaveLength(5);

      // A true ID sequence, not a lexical string sort — the numeric suffix must be non-decreasing.
      const ascNumbers = ascending.map(numericSuffix);
      for (let i = 1; i < ascNumbers.length; i++) {
        expect(ascNumbers[i], `row ${i} (${ascending[i]}) is out of numeric sequence after ${ascending[i - 1]}`).toBeGreaterThan(
          ascNumbers[i - 1]
        );
      }
      // desc is exactly asc reversed, not an independently-computed (and possibly divergent) order.
      expect(descending).toEqual([...ascending].reverse());
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });

  test("sortBy=title sorts alphabetically, case-insensitively, independent of creation order", async ({ request }) => {
    const marker = `e2e-sort-title-${Date.now()}`;
    // Deliberately created out of alphabetical order, and mixed-case, so a passing sort can only be
    // the result of actually sorting rather than happening to match insertion order.
    const titles = [`${marker} Zebra`, `${marker} apple`, `${marker} Mango`, `${marker} banana`];
    const created: string[] = [];
    try {
      for (const title of titles) created.push((await createCase(request, { title })).id);

      const listTitles = async (sortDir: "asc" | "desc") => {
        const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, sortBy: "title", sortDir },
        });
        expect(res.ok(), `sortBy=title&sortDir=${sortDir} — ${await res.text()}`).toBeTruthy();
        return (await res.json()).map((tc: { title: string }) => tc.title);
      };

      const expectedAscending = [...titles].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      expect(await listTitles("asc")).toEqual(expectedAscending);
      expect(await listTitles("desc")).toEqual([...expectedAscending].reverse());
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });

  test("sortBy=priority ranks P0 (Critical) through P3 (Low), with no priority sorting last regardless of direction", async ({
    request,
  }) => {
    const marker = `E2E Sort Priority ${Date.now()}`;
    const created: string[] = [];
    try {
      // Created in a deliberately scrambled order, and one row left with no priority at all — the
      // canonical rank must win over both creation order and plain alphabetical priority order
      // (which would put "P3" before "P0" only by coincidence, so this also covers that).
      const noPriority = (await createCase(request, { title: `${marker} none` })).id;
      const p2 = (await createCase(request, { title: `${marker} p2`, priority: "P2" })).id;
      const p0 = (await createCase(request, { title: `${marker} p0`, priority: "P0" })).id;
      const p3 = (await createCase(request, { title: `${marker} p3`, priority: "P3" })).id;
      const p1 = (await createCase(request, { title: `${marker} p1`, priority: "P1" })).id;
      created.push(noPriority, p2, p0, p3, p1);

      const listIds = async (sortDir: "asc" | "desc") => {
        const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, sortBy: "priority", sortDir },
        });
        expect(res.ok(), `sortBy=priority&sortDir=${sortDir} — ${await res.text()}`).toBeTruthy();
        return (await res.json()).map((tc: { id: string }) => tc.id);
      };

      expect(await listIds("asc")).toEqual([p0, p1, p2, p3, noPriority]);
      // Descending flips the canonical ranking, but "no priority" still sorts last, not first —
      // it is excluded from the field being reversed, the same way the frontend's comparePriority()
      // ranks a missing priority one past the end of the canonical set in both directions.
      expect(await listIds("desc")).toEqual([p3, p2, p1, p0, noPriority]);
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });

  test("omitting sortBy, or sending an unrecognized one, falls back to the existing default order rather than erroring", async ({
    request,
  }) => {
    const marker = `E2E Sort Default ${Date.now()}`;
    const created: string[] = [];
    try {
      created.push((await createCase(request, { title: `${marker} a` })).id);
      created.push((await createCase(request, { title: `${marker} b` })).id);
      const newestFirst = [...created].reverse();

      const noSortBy = await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { search: marker } });
      expect(noSortBy.ok()).toBeTruthy();
      expect((await noSortBy.json()).map((tc: { id: string }) => tc.id)).toEqual(newestFirst);

      // An unrecognized column name is not forwarded into SQL (see the allow-list in
      // legacy.service.ts) — it degrades to the default order instead of a 500 or a 400.
      const bogus = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, sortBy: "'; DROP TABLE testcases; --" },
        failOnStatusCode: false,
      });
      expect(bogus.status(), `an unrecognized sortBy should not error — ${await bogus.text()}`).toBe(200);
      expect((await bogus.json()).map((tc: { id: string }) => tc.id)).toEqual(newestFirst);
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });
});
