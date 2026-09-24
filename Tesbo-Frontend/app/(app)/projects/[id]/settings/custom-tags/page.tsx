"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { IconTag } from "@tabler/icons-react";
import { listCustomTags, type CustomTag } from "@/lib/api";
import { Card } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";
import CustomTagsList from "@/components/customTags/CustomTagsList";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (["manager", "admin", "test_manager"].includes(n)) return "manager";
  return "qa_engineer";
}

export default function CustomTagsSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const { currentUser } = useAppData();
  const { project, projectMembers } = useProjectData();
  const projectName = String(project.name || "");

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [tags, setTags] = useState<CustomTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadTags = useCallback(async () => {
    try {
      const list = await listCustomTags(projectId);
      setTags(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load custom tags.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!currentUser) {
      router.replace("/login");
      return;
    }
    setCurrentUserId(currentUser.userId);
    loadTags().catch(() => {});
  }, [loadTags, projectId, router, currentUser]);

  const currentUserRole = currentUserId
    ? normalizeRole(projectMembers.find((m) => m.userId === currentUserId)?.role ?? "qa_engineer")
    : "qa_engineer";
  const canManage = currentUserRole === "owner" || currentUserRole === "manager";

  const header = (
    <PageHeader
      title={
        <>
          <IconTag size={26} stroke={1.75} />
          Custom Tags
        </>
      }
      subtitle="Curate the tags this project's test cases can be labelled with."
      breadcrumb={
        <Breadcrumbs
          items={[
            { label: "Projects", href: "/projects" },
            { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
            { label: "Settings", href: `/projects/${projectId}/settings?tab=customTags` },
            { label: "Custom Tags" },
          ]}
        />
      }
    />
  );

  if (!canManage) {
    return (
      <StandardPageLayout header={header}>
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)]">Only project owners and managers can manage custom tags.</p>
        </Card>
      </StandardPageLayout>
    );
  }

  // `.ct-fixed-page` pins this page to the viewport (see globals.css), so the app shell's own
  // scrollbar stays still and only the tag list scrolls, however many tags the project has.
  return (
    <div className="ct-fixed-page flex h-full min-h-0 w-full flex-col">
      {header}
      <Card className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <p className="text-sm text-[var(--muted)]">
          Tags created here become selectable on this project&apos;s test cases, and can be used to group and filter
          Insights &rarr; Execution Report.
        </p>
        {loadError && <p className="text-sm text-[var(--error-foreground)]">{loadError}</p>}
        {!loading && <CustomTagsList projectId={projectId} tags={tags} onChanged={() => loadTags()} />}
      </Card>
    </div>
  );
}
