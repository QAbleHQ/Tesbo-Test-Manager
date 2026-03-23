"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function TesboSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  useEffect(() => {
    if (projectId) {
      router.replace(`/projects/${projectId}/settings`);
    }
  }, [projectId, router]);

  return (
    <main className="tesbo-page max-w-3xl mx-auto">
      <StandardPageLayout
        header={<PageHeader title="Tesbo Settings" subtitle="Opening project settings…" />}
      >
        <p className="text-sm text-[var(--muted)]">Opening project settings…</p>
      </StandardPageLayout>
    </main>
  );
}
