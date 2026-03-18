"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authMe } from "@/lib/api";
import { EmptyStateBlock } from "@/components/ui";
import { StandardPageLayout, PageHeader } from "@/components/workflows";

export default function WorkspaceIntegrationsPage() {
  const router = useRouter();
  const [auth, setAuth] = useState<{ userId: string } | null>(null);

  useEffect(() => {
    authMe().then((me) => {
      setAuth(me);
      if (!me) router.replace("/login");
    });
  }, [router]);

  if (!auth) {
    return (
      <StandardPageLayout header={<PageHeader title="Integrations" />}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Integrations"
          subtitle="Connect external tools and services to your workspace."
        />
      }
    >
      <EmptyStateBlock
        title="No integrations yet"
        description="Connect external tools and services when they become available."
      />
    </StandardPageLayout>
  );
}
