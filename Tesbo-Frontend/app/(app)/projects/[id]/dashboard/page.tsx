"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  IconFileText,
  IconFolders,
  IconClipboardList,
  IconPlayerPlay,
  IconChartBar,
  IconBug,
  IconArrowRight,
} from "@tabler/icons-react";
import {
  authMe,
  getProject,
  listTestCases,
  listSuites,
  listPlans,
  listCycles,
} from "@/lib/api";
import { Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function ProjectDashboardPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [stats, setStats] = useState<{
    testCaseCount: number;
    suiteCount: number;
    planCount: number;
    cycleCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getProject(projectId)
        .then((p) => {
          setProject(p);
          return Promise.all([
            listTestCases(projectId, { limit: 1 }),
            listSuites(projectId),
            listPlans(projectId),
            listCycles(projectId),
          ]);
        })
        .then(([tcRes, suites, plans, cycles]) => {
          setStats({
            testCaseCount: tcRes.total,
            suiteCount: suites.length,
            planCount: Array.isArray(plans) ? plans.length : 0,
            cycleCount: Array.isArray(cycles) ? cycles.length : 0,
          });
        })
        .catch(() => router.replace("/projects"))
        .finally(() => setLoading(false));
    });
  }, [projectId, router]);

  if (loading || !project) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--ink-200)] border-t-[var(--denim)]" />
          <p className="text-[13px] text-[var(--ink-400)]">Loading project…</p>
        </div>
      </div>
    );
  }

  const name = (project.name as string) ?? "";
  const key = (project.key as string) ?? "";
  const description = (project.description as string) ?? "";

  const statCards = [
    {
      label: "Test cases",
      value: stats?.testCaseCount ?? 0,
      Icon: IconFileText,
      color: "var(--denim)",
      bg: "var(--denim-50)",
      href: `/projects/${projectId}/testcases`,
    },
    {
      label: "Suites",
      value: stats?.suiteCount ?? 0,
      Icon: IconFolders,
      color: "#7C5FCC",
      bg: "#F5F0FF",
      href: `/projects/${projectId}/testcases`,
    },
    {
      label: "Plans",
      value: stats?.planCount ?? 0,
      Icon: IconClipboardList,
      color: "var(--status-blocked-dot)",
      bg: "var(--status-blocked-fill)",
      href: `/projects/${projectId}/plans`,
    },
    {
      label: "Test runs",
      value: stats?.cycleCount ?? 0,
      Icon: IconPlayerPlay,
      color: "var(--status-pass-dot)",
      bg: "var(--status-pass-fill)",
      href: `/projects/${projectId}/cycles`,
    },
  ];

  const quickLinks = [
    {
      label: "Test cases",
      desc: "Browse, create and organise test cases",
      Icon: IconFileText,
      href: `/projects/${projectId}/testcases`,
    },
    {
      label: "Test plans",
      desc: "Organise coverage by release milestone",
      Icon: IconClipboardList,
      href: `/projects/${projectId}/plans`,
    },
    {
      label: "Test runs",
      desc: "Execute cycles and track progress",
      Icon: IconPlayerPlay,
      href: `/projects/${projectId}/cycles`,
    },
    {
      label: "Bugs",
      desc: "Bugs raised during test execution",
      Icon: IconBug,
      href: `/projects/${projectId}/bugs`,
    },
    {
      label: "Insights",
      desc: "Pass rates, trends and coverage",
      Icon: IconChartBar,
      href: `/projects/${projectId}/reports`,
    },
  ];

  return (
    <StandardPageLayout
      header={(
        <PageHeader
          title={name}
          subtitle={description || undefined}
          breadcrumb={(
            <div className="flex items-center gap-1.5 text-[13px]">
              <Link href="/projects" className="text-[var(--ink-400)] hover:text-[var(--ink-800)] transition-colors">
                Projects
              </Link>
              <span className="text-[var(--ink-300)]">/</span>
              <span className="font-mono text-[var(--ink-300)]">{key}</span>
            </div>
          )}
          actions={(
            <>
              <Link
                href={`/projects/${projectId}/cycles?create=1`}
                className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-[var(--ink-200)] px-4 text-[13px] font-medium text-[var(--ink-600)] transition-colors hover:bg-[var(--ink-100)]"
              >
                <IconPlayerPlay size={15} stroke={1.75} />
                New run
              </Link>
              <Link
                href={`/projects/${projectId}/plans?create=1`}
                className="inline-flex h-9 items-center gap-2 rounded-[6px] bg-[var(--denim)] px-4 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-[var(--denim-400)]"
              >
                New test plan
              </Link>
            </>
          )}
        />
      )}
    >
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {statCards.map(({ label, value, Icon, color, bg, href }) => (
          <Link key={label} href={href} className="group">
            <Card className="flex flex-col p-5 transition-colors hover:border-[var(--border-strong)]">
              <div
                className="mb-4 inline-flex w-fit rounded-[8px] p-2"
                style={{ background: bg }}
              >
                <Icon size={18} stroke={1.75} style={{ color }} />
              </div>
              <p className="text-[30px] font-semibold leading-none tracking-[-0.03em] text-[var(--ink-800)]">
                {value}
              </p>
              <p className="mt-1.5 text-[13px] text-[var(--ink-400)]">{label}</p>
            </Card>
          </Link>
        ))}
      </div>

      {/* Quick navigation */}
      <div>
        <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--ink-300)]">
          Quick access
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {quickLinks.map(({ label, desc, Icon, href }) => (
            <Link
              key={label}
              href={href}
              className="group flex items-center gap-3 rounded-[10px] border border-[var(--ink-200)] bg-white p-4 transition-colors hover:border-[var(--denim-200)] hover:bg-[var(--denim-50)]"
            >
              <div className="shrink-0 rounded-[8px] border border-[var(--ink-100)] bg-[var(--ink-50)] p-2 transition-colors group-hover:border-[var(--denim-200)] group-hover:bg-white">
                <Icon
                  size={16}
                  stroke={1.75}
                  className="text-[var(--ink-400)] transition-colors group-hover:text-[var(--denim)]"
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-[var(--ink-800)]">{label}</p>
                <p className="truncate text-[12px] text-[var(--ink-400)]">{desc}</p>
              </div>
              <IconArrowRight
                size={14}
                stroke={1.75}
                className="ml-auto shrink-0 text-[var(--ink-300)] transition-colors group-hover:text-[var(--denim)]"
              />
            </Link>
          ))}
        </div>
      </div>
    </StandardPageLayout>
  );
}
