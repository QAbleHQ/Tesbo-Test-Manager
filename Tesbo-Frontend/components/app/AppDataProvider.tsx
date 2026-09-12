"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { authMe, getWorkspace, listProjects, type ProjectSummary, type WorkspaceInfo } from "@/lib/api";

type CurrentUser = Awaited<ReturnType<typeof authMe>>;

type AppData = {
  currentUser: CurrentUser;
  workspace: WorkspaceInfo | null;
  projects: ProjectSummary[];
  refetchProjects: () => Promise<ProjectSummary[]>;
  refetchCurrentUser: () => void;
};

const AppDataContext = createContext<AppData | null>(null);

/** Throws outside <AppDataProvider> on purpose — every app/(app) page is wrapped by it via the layout. */
export function useAppData(): AppData {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData() must be used within AppDataProvider");
  return ctx;
}

type Status = "checking" | "authenticated";

/**
 * Gates everything under app/(app) behind a confirmed session, and fetches the data almost every
 * page and the app shell need (current user, workspace, project list) exactly once instead of
 * once each.
 *
 * Before this, Sidebar, TopBar, and each page independently called authMe()/getWorkspace()/
 * listProjects() in their own effects — six separate authMe() calls and four listProjects() calls
 * were observed loading a single settings page. Each is a full round trip to a database that can
 * take seconds to respond cold (Neon), so the duplication wasn't just wasteful, it was the actual
 * reason pages felt slow. Fetching once here and sharing the result via context fixes that at the
 * root instead of shaving one call at a time off individual pages.
 *
 * Absorbs what used to be a separate AuthGuard: the session cookie can't be read server-side to
 * redirect before this reaches the browser (it's set by the API host with no shared Domain, so
 * it's never attached to a request aimed at the frontend's own origin — see lib/redirect.ts for
 * the staging incident where an edge rule tried exactly that and looped). authMe() reaching the
 * API cross-origin with credentials is the only thing that can actually see the session, so this
 * still has to be a client-side effect, and nothing protected renders while it's in flight.
 */
export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [currentUser, setCurrentUser] = useState<CurrentUser>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  // Awaitable and state-returning (mirrors ProjectDataProvider's refetchProject/refetchMembers) so a
  // caller can await the refreshed list before navigating away — e.g. creating or deleting a project
  // and then routing off this page, where a fire-and-forget refresh would leave the TopBar project
  // switcher showing stale data until some later, unrelated remount happened to re-fetch it.
  const refetchProjects = useCallback(async () => {
    const list = await listProjects().catch(() => undefined);
    if (list) setProjects(list);
    return list ?? projects;
  }, [projects]);

  // Only currentUser is ever mutated after this provider's initial load (the Account page's
  // PATCH /api/auth/me) — projects and workspace change through the create/update/delete flows in
  // projects/page.tsx and projects/[id]/settings/page.tsx, which call refetchProjects()/
  // refetchProject() themselves after a successful write. Without this, a saved profile edit would
  // look right on /account until the next navigation, then silently revert to the stale pre-edit
  // name/mobile number (and the TopBar/Sidebar avatar initials would keep showing the old name the
  // whole time) because currentUser is otherwise fetched once, on mount, and never again.
  const refetchCurrentUser = useCallback(() => {
    authMe().then((me) => {
      if (me) setCurrentUser(me);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([authMe(), getWorkspace().catch(() => null), listProjects().catch(() => [])]).then(
      ([me, ws, projectList]) => {
        if (cancelled) return;
        if (!me) {
          const target = `${window.location.pathname}${window.location.search}`;
          router.replace(`/login?redirect=${encodeURIComponent(target)}`);
          return;
        }
        setCurrentUser(me);
        setWorkspace(ws);
        setProjects(projectList);
        setStatus("authenticated");
      }
    );
    return () => {
      cancelled = true;
    };
  }, [router]);

  const value = useMemo<AppData>(
    () => ({ currentUser, workspace, projects, refetchProjects, refetchCurrentUser }),
    [currentUser, workspace, projects, refetchProjects, refetchCurrentUser]
  );

  if (status !== "authenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--background)]">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}
