"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { PageHeader, ListWorkspaceLayout } from "@/components/workflows";

export default function SuitesPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  useEffect(() => {
    if (!projectId) return;
    router.replace(`/projects/${projectId}/testcases`);
  }, [projectId, router]);

  return (
    <main className="tesbo-page max-w-2xl mx-auto">
      <ListWorkspaceLayout
        header={
          <PageHeader
            title="Suites"
            subtitle="Redirecting to Test case repository..."
          />
        }
      >
        <p className="text-[var(--muted)]">Redirecting to Test case repository...</p>
      </ListWorkspaceLayout>
    </main>
  );
}
