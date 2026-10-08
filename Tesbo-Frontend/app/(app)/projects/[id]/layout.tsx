"use client";

import { RouteParamsProvider, useParams } from "@/lib/routeParams";
import { ProjectDataProvider } from "@/components/project/ProjectDataProvider";

function ProjectShell({ children }: { children: React.ReactNode }) {
  // Resolved by RouteParamsProvider: a uuid even when the URL carries the project key.
  const params = useParams();
  const projectId = params.id as string;
  return <ProjectDataProvider projectId={projectId}>{children}</ProjectDataProvider>;
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return (
    <RouteParamsProvider>
      <ProjectShell>{children}</ProjectShell>
    </RouteParamsProvider>
  );
}
