"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

export default function ProjectRootRedirect() {
  const router = useRouter();
  const params = useParams();
  const projectId = params.id as string;

  useEffect(() => {
    if (projectId) {
      router.replace(`/projects/${projectId}/dashboard`);
    }
  }, [projectId, router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-[var(--muted)]">Opening project…</p>
    </div>
  );
}
