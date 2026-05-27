"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function ProjectMembersPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  useEffect(() => {
    router.replace(`/projects/${projectId}/settings?tab=members`);
  }, [projectId, router]);

  return (
    <StandardPageLayout
      header={<PageHeader title="Members" subtitle="Redirecting to project settings…" />}
    >
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-[var(--muted)]">Redirecting to project settings…</p>
      </div>
    </StandardPageLayout>
  );
}
