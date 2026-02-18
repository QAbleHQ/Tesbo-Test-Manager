"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getProject } from "@/lib/api";

const projectNavSections = [
  {
    section: "AI generation",
    items: [
      { href: "ai-test-script", label: "Test Generation" },
      { href: "ai-history", label: "Generation History" },
      { href: "knowledge-base", label: "Knowledge Base" },
    ],
  },
  {
    section: "Test Case Management",
    items: [
      { href: "testcases", label: "Test case Repository" },
      { href: "plans", label: "Test Plan" },
      { href: "cycles", label: "Test Run" },
      { href: "bugs", label: "Bugs" },
      { href: "reports", label: "Test Reports" },
    ],
  },
  {
    section: "Utility",
    items: [
      { href: "activity", label: "Activity" },
    ],
  },
] as const;

const workspaceSettingsNavItems = [
  { href: "/settings", label: "General" },
  { href: "/settings/members", label: "Members" },
  { href: "/settings/integrations", label: "Integrations" },
] as const;

function NavLink({
  href,
  children,
  active = false,
}: {
  href: string;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`block rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-medium"
          : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
      }`}
    >
      {children}
    </Link>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const projectMatch = pathname?.match(/^\/projects\/([^/]+)/);
  const projectId = projectMatch?.[1] ?? null;
  const isInProject = Boolean(projectId);
  const projectPathPrefix = projectId ? `/projects/${projectId}` : "/projects";

  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    getProject(projectId)
      .then((p) => {
        if (active) setProjectName((p.name as string) ?? "Project");
      })
      .catch(() => {
        if (active) setProjectName("Project");
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const isOnProjectRoot = projectId != null && pathname === `/projects/${projectId}`;
  const isDashboardActive = pathname === "/dashboard";
  const isHomeActive = pathname === "/projects";
  const isProjectsListActive = pathname === "/projects";
  const isWorkspaceSettingsActive = pathname?.startsWith("/settings");
  const isInWorkspaceSettings = pathname?.startsWith("/settings");

  return (
    <aside className="w-56 shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col min-h-screen">
      <div className="p-4 border-b border-zinc-200 dark:border-zinc-800">
        <Link
          href="/projects"
          className="font-semibold text-zinc-900 dark:text-zinc-100 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          BetterCases
        </Link>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {/* 1. Home - project listing (default) */}
        <NavLink href="/projects" active={isHomeActive}>
          Home
        </NavLink>

        {/* 2. Dashboard - workspace-level analytics */}
        <NavLink href="/dashboard" active={isDashboardActive}>
          Dashboard
        </NavLink>

        {/* 3. Projects (when on home) OR Project name + sub-items (inside a project) */}
        <div className="pt-2">
          {isInProject && projectId ? (
            <>
              <div className="flex items-center gap-1">
                <Link
                  href={`/projects/${projectId}`}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm transition-colors truncate ${
                    isOnProjectRoot
                      ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-medium"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
                  }`}
                  title={projectName ?? undefined}
                >
                  {projectName ?? "Project"}
                </Link>
                <Chevron open />
              </div>
              <div className="mt-1 ml-3 border-l border-zinc-200 dark:border-zinc-700 pl-2">
                {projectNavSections.map(({ section, items }) => (
                  <div key={section} className="mb-3 last:mb-2">
                    <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      {section}
                    </p>
                    <div className="mx-3 mb-1 border-t border-zinc-200 dark:border-zinc-700" />
                    <ul className="space-y-0.5">
                      {items.map(({ href, label }) => {
                        const fullHref = `${projectPathPrefix}/${href}`;
                        const active =
                          pathname === fullHref || (pathname?.startsWith(fullHref + "/") ?? false);
                        return (
                          <li key={href}>
                            <NavLink href={fullHref} active={active}>
                              {label}
                            </NavLink>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                <ul className="space-y-0.5 pt-1 border-t border-zinc-200 dark:border-zinc-700">
                  <li>
                    <NavLink
                      href={`${projectPathPrefix}/settings`}
                      active={
                        pathname === `${projectPathPrefix}/settings` ||
                        (pathname?.startsWith(`${projectPathPrefix}/settings/`) ?? false)
                      }
                    >
                      Project settings
                    </NavLink>
                  </li>
                </ul>
              </div>
            </>
          ) : (
            <NavLink href="/projects" active={isProjectsListActive}>
              Projects
            </NavLink>
          )}
        </div>

        {/* Workspace settings */}
        <div className="pt-4 mt-4 border-t border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-1">
            <Link
              href="/settings"
              className={`flex-1 rounded-lg px-3 py-2 text-sm transition-colors ${
                isWorkspaceSettingsActive
                  ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-medium"
                  : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              Workspace settings
            </Link>
            <Chevron open={isInWorkspaceSettings} />
          </div>
          {isInWorkspaceSettings && (
            <ul className="mt-1 ml-3 space-y-0.5 border-l border-zinc-200 dark:border-zinc-700 pl-2">
              {workspaceSettingsNavItems.map(({ href, label }) => {
                const active = pathname === href;
                return (
                  <li key={href}>
                    <NavLink href={href} active={active}>
                      {label}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </nav>
    </aside>
  );
}
