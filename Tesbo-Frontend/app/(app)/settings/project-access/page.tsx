"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { StandardPageLayout, PageHeader } from "@/components/workflows";

export default function WorkspaceProjectAccessPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings/members");
  }, [router]);

  return (
    <StandardPageLayout header={<PageHeader title="Project access" />}>
      <div className="flex min-h-[200px] items-center justify-center">
        <p className="text-[var(--muted)]">Redirecting to workspace members…</p>
      </div>
    </StandardPageLayout>
  );
}
