"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getProject, listProjectMembers } from "@/lib/api";
import { PageLoader } from "@/components/ui";

type ProjectRecord = Record<string, unknown>;
type ProjectMember = { userId: string; email: string; name: string; role: string; joinedAt: string };

type ProjectData = {
  project: ProjectRecord;
  projectMembers: ProjectMember[];
  refetchProject: () => Promise<ProjectRecord>;
  refetchMembers: () => Promise<ProjectMember[]>;
};

const ProjectDataContext = createContext<ProjectData | null>(null);

/** Throws outside <ProjectDataProvider> on purpose — every projects/[id] page is wrapped by it via the layout. */
export function useProjectData(): ProjectData {
  const ctx = useContext(ProjectDataContext);
  if (!ctx) throw new Error("useProjectData() must be used within ProjectDataProvider");
  return ctx;
}

/**
 * Fetches the project record and member list exactly once per projectId and shares them via
 * context, instead of once per page.
 *
 * Before this, 22 of the 26 pages under projects/[id]/* independently called getProject(projectId)
 * and/or listProjectMembers(projectId) in their own mount effect. Next.js keeps this layout mounted
 * across sibling-route navigation (testcases -> bugs -> plans all share the [id] segment), so
 * clicking between sidebar sections within the same project re-fetched data that hadn't changed on
 * every single click — the same duplicated-round-trip problem AppDataProvider already fixed for
 * workspace-level data, one level down. Fetching once here means only the page's own page-specific
 * data (its test cases, bugs, suites, etc.) still loads on each navigation.
 */
export function ProjectDataProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const router = useRouter();
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [ready, setReady] = useState(false);

  const refetchProject = useCallback(async () => {
    const p = await getProject(projectId);
    setProject(p);
    return p;
  }, [projectId]);

  const refetchMembers = useCallback(async () => {
    const m = await listProjectMembers(projectId).catch(() => []);
    setProjectMembers(m);
    return m;
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setProject(null);
    Promise.all([getProject(projectId), listProjectMembers(projectId).catch(() => [])])
      .then(([p, m]) => {
        if (cancelled) return;
        setProject(p);
        setProjectMembers(m);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/projects");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, router]);

  const value = useMemo<ProjectData | null>(
    () => (project ? { project, projectMembers, refetchProject, refetchMembers } : null),
    [project, projectMembers, refetchProject, refetchMembers]
  );

  if (!ready || !value) {
    return <PageLoader variant="screen" label="Loading project…" />;
  }

  return <ProjectDataContext.Provider value={value}>{children}</ProjectDataContext.Provider>;
}
