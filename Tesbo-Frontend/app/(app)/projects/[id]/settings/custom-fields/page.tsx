"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { IconStack2 } from "@tabler/icons-react";
import {
  authMe,
  getBillingInfo,
  getProject,
  listCustomFieldDefinitions,
  listProjectMembers,
  type BillingInfo,
  type CustomFieldDefinition,
} from "@/lib/api";
import { Button, Card } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";
import CustomFieldDefinitionList from "@/components/customFields/CustomFieldDefinitionList";
import CustomFieldDefinitionFormModal from "@/components/customFields/CustomFieldDefinitionFormModal";
import PricingModal from "@/components/PricingModal";

type ProjectMember = { userId: string; email: string; name: string; role: string; joinedAt: string };

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (["manager", "admin", "test_manager"].includes(n)) return "manager";
  return "qa_engineer";
}

export default function CustomFieldsSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [definitions, setDefinitions] = useState<CustomFieldDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CustomFieldDefinition | null>(null);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [projectName, setProjectName] = useState("");

  const loadDefinitions = useCallback(async () => {
    try {
      const list = await listCustomFieldDefinitions(projectId);
      setDefinitions(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load custom fields.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      setCurrentUserId(me.userId);
      listProjectMembers(projectId).then(setProjectMembers).catch(() => {});
      getBillingInfo().then(setBillingInfo).catch(() => {});
      getProject(projectId).then((p) => setProjectName(String(p.name || ""))).catch(() => setProjectName(""));
      loadDefinitions().catch(() => {});
    });
  }, [loadDefinitions, projectId, router]);

  const currentUserRole = currentUserId
    ? normalizeRole(projectMembers.find((m) => m.userId === currentUserId)?.role ?? "qa_engineer")
    : "qa_engineer";
  const canManage = currentUserRole === "owner" || currentUserRole === "manager";
  const isPro = billingInfo?.enabled === false || billingInfo?.plan === "pro";

  const header = (
    <PageHeader
      title={
        <>
          <IconStack2 size={26} stroke={1.75} />
          Custom Fields
        </>
      }
      subtitle="Capture additional test case metadata specific to this project."
      breadcrumb={
        <Breadcrumbs
          items={[
            { label: "Projects", href: "/projects" },
            { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
            { label: "Settings", href: `/projects/${projectId}/settings?tab=customFields` },
            { label: "Custom Fields" },
          ]}
        />
      }
    />
  );

  if (!canManage) {
    return (
      <StandardPageLayout header={header}>
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)]">Only project owners and managers can manage custom fields.</p>
        </Card>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout header={header}>
      {!isPro && definitions.length === 0 && (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--foreground)]">Custom fields are a Pro plan feature</h2>
          <p className="mt-1.5 text-sm text-[var(--muted)]">
            Create project-specific fields — risk level, automation candidate, supported platforms, and more — to capture the metadata your testing process needs.
          </p>
          <Button type="button" className="mt-3" onClick={() => setPricingOpen(true)}>
            Upgrade to Pro
          </Button>
        </Card>
      )}

      {!isPro && definitions.length > 0 && (
        <Card className="border-[var(--warning-border)] bg-[var(--warning-soft)] p-4">
          <p className="text-sm text-[var(--warning-foreground)]">
            This workspace is on the Launch plan. Existing custom fields and their values remain visible, but creating or editing custom fields requires Pro.{" "}
            <button type="button" onClick={() => setPricingOpen(true)} className="font-medium underline">
              Upgrade to Pro
            </button>
          </p>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--muted)]">Fields appear on this project&apos;s test cases in the order shown below.</p>
        <Button
          type="button"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
          disabled={!isPro}
        >
          Add custom field
        </Button>
      </div>

      {loadError && <p className="text-sm text-[var(--error-foreground)]">{loadError}</p>}

      {!loading && (
        <CustomFieldDefinitionList
          projectId={projectId}
          definitions={definitions}
          onEdit={(definition) => {
            setEditing(definition);
            setFormOpen(true);
          }}
          onChanged={() => loadDefinitions()}
        />
      )}

      <CustomFieldDefinitionFormModal
        open={formOpen}
        projectId={projectId}
        definition={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          loadDefinitions();
        }}
      />

      <PricingModal open={pricingOpen} onClose={() => setPricingOpen(false)} billingInfo={billingInfo} />
    </StandardPageLayout>
  );
}
