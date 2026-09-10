"use client";

import { useParams } from "next/navigation";
import { ProjectDataProvider } from "@/components/project/ProjectDataProvider";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const projectId = params.id as string;
  return <ProjectDataProvider projectId={projectId}>{children}</ProjectDataProvider>;
}
