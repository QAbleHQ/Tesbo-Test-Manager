"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useParams as useNextParams } from "next/navigation";
import { api } from "@/lib/api";
import { PageLoader } from "@/components/ui";

/*
 * Readable URLs: /projects/LOH/bugs/LOH-BUG-1 instead of /projects/<uuid>/bugs/<uuid>.
 *
 * The whole API stays addressed by uuid. This provider sits in the projects/[id] layout, resolves
 * whatever the URL carries (a readable key or, for links minted before this existed, a uuid) through
 * GET /api/route-resolve, and hands the pages the uuids through the useParams() exported below — a
 * drop-in for next/navigation's, so a page's `params.id` / `params.bugId` still read as uuids and none
 * of its fetches changed.
 *
 * Once resolved, the address bar is rewritten to the canonical readable form, so a uuid link (every
 * in-app link is still built from uuids) lands on a readable URL without a reload.
 */

// Route param -> route-resolve query name. executionId / planId / documentId stay uuids.
const PARAM_TO_QUERY: Record<string, string> = {
  id: "project",
  bugId: "bug",
  cycleId: "cycle",
  taskId: "task",
  tcId: "testcase",
};

type Resolved = {
  projectId: string;
  projectKey?: string;
  bugId?: string;
  bugRef?: string;
  testcaseId?: string;
  testcaseRef?: string;
  cycleId?: string;
  cycleRef?: string;
  taskId?: string;
  taskRef?: string;
};

type Params = Record<string, string | string[] | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Module-level so navigating between pages of one project never re-resolves a ref it already knows.
const resolvedCache = new Map<string, Resolved>();

function cacheKeyFor(refs: Record<string, string>): string {
  return JSON.stringify(Object.entries(refs).sort(([a], [b]) => a.localeCompare(b))).toLowerCase();
}

function identityFor(refs: Record<string, string>): Resolved | undefined {
  if (!Object.values(refs).every((v) => UUID_RE.test(v))) return undefined;
  return {
    projectId: refs.project,
    bugId: refs.bug,
    cycleId: refs.cycle,
    taskId: refs.task,
    testcaseId: refs.testcase,
  };
}

const RouteParamsContext = createContext<Params | null>(null);

/** Drop-in for next/navigation's useParams: inside a project, ids come back as uuids. */
export function useParams<T extends Params = Params>(): T {
  const raw = useNextParams();
  const resolved = useContext(RouteParamsContext);
  return (resolved ?? raw) as T;
}

function decode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function RouteParamsProvider({ children }: { children: React.ReactNode }) {
  const raw = useNextParams() as Params;

  const refs = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [param, query] of Object.entries(PARAM_TO_QUERY)) {
      const v = raw[param];
      if (typeof v === "string" && v) out[query] = decode(v);
    }
    return out;
  }, [raw]);
  const key = cacheKeyFor(refs);

  const [, setTick] = useState(0);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  const cached = resolvedCache.get(key);
  // A uuid-only URL needs no lookup to render, so it never waits on the network; the lookup still
  // runs below to learn the readable form.
  const effective = cached ?? identityFor(refs);

  useEffect(() => {
    if (cached || !refs.project) return;
    let cancelled = false;
    api<Resolved>(`/api/route-resolve?${new URLSearchParams(refs).toString()}`)
      .then((res) => {
        resolvedCache.set(key, res);
        // Seed the canonical spelling too, so the rewritten URL resolves synchronously.
        const canonical: Record<string, string> = { project: res.projectKey ?? res.projectId };
        if (res.bugId) canonical.bug = res.bugRef ?? res.bugId;
        if (res.cycleId) canonical.cycle = res.cycleRef ?? res.cycleId;
        if (res.taskId) canonical.task = res.taskRef ?? res.taskId;
        if (res.testcaseId) canonical.testcase = res.testcaseRef ?? res.testcaseId;
        resolvedCache.set(cacheKeyFor(canonical), res);
        // The sidebar links to /projects/<KEY>/<section>, so the bare project must resolve instantly too.
        resolvedCache.set(cacheKeyFor({ project: canonical.project }), { projectId: res.projectId, projectKey: res.projectKey });
        if (!cancelled) setTick((n) => n + 1);
      })
      .catch((err) => {
        if (!cancelled) setFailure({ key, message: err instanceof Error ? err.message : "Not found" });
      });
    return () => {
      cancelled = true;
    };
  }, [cached, key, refs]);

  // Rewrite the address bar to the readable form. replaceState rather than router.replace: nothing
  // should re-render or re-fetch, only the visible URL changes.
  useEffect(() => {
    if (!cached || typeof window === "undefined") return;
    const swaps: [string, string | undefined][] = [
      [refs.project, cached.projectKey],
      [refs.bug, cached.bugRef],
      [refs.cycle, cached.cycleRef],
      [refs.task, cached.taskRef],
      [refs.testcase, cached.testcaseRef],
    ];
    const segments = window.location.pathname.split("/");
    let changed = false;
    const next = segments.map((seg) => {
      for (const [from, to] of swaps) {
        if (from && to && decode(seg).toLowerCase() === from.toLowerCase() && seg !== encodeURIComponent(to)) {
          changed = true;
          return encodeURIComponent(to);
        }
      }
      return seg;
    });
    if (changed) {
      window.history.replaceState(window.history.state, "", `${next.join("/")}${window.location.search}${window.location.hash}`);
    }
  }, [cached, refs]);

  const value = useMemo<Params | null>(() => {
    if (!effective) return null;
    const out: Params = { ...raw };
    out.id = effective.projectId;
    if (effective.bugId) out.bugId = effective.bugId;
    if (effective.cycleId) out.cycleId = effective.cycleId;
    if (effective.taskId) out.taskId = effective.taskId;
    if (effective.testcaseId) out.tcId = effective.testcaseId;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(effective), raw]);

  if (!value) {
    if (failure?.key === key) {
      return (
        <div className="p-8 text-center" role="alert">
          <h1 className="text-lg font-semibold">Page not found</h1>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            {failure.message}. The link may be mistyped, or you may not have access to it.
          </p>
        </div>
      );
    }
    return <PageLoader />;
  }
  return <RouteParamsContext.Provider value={value}>{children}</RouteParamsContext.Provider>;
}
