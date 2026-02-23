"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

export default function ProjectMembersPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  useEffect(() => {
    router.replace(`/projects/${projectId}/settings?tab=members`);
  }, [projectId, router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-zinc-500">Redirecting to project settings…</p>
    </div>
  );
}
