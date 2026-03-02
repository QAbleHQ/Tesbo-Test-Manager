"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getProject, logout } from "@/lib/api";

const projectNavSections = [
  {
    section: "AI generation",
    items: [
      { href: "ai-test-script", label: "Test Generation", icon: "sparkles" },
      { href: "ai-history", label: "Generation History", icon: "history" },
      { href: "knowledge-base", label: "Knowledge Base", icon: "book" },
    ],
  },
  {
    section: "Test Case Management",
    items: [
      { href: "testcases", label: "Test case Repository", icon: "list" },
      { href: "plans", label: "Test Plan", icon: "clipboard" },
      { href: "cycles", label: "Test Run", icon: "play" },
      { href: "bugs", label: "Bugs", icon: "bug" },
      { href: "reports", label: "Test Reports", icon: "chart" },
    ],
  },
  {
    section: "Utility",
    items: [
      { href: "activity", label: "Activity", icon: "activity" },
    ],
  },
  {
    section: "Automation Reports",
    items: [
      { href: "tesbo-reports/runs", label: "Runs", icon: "runs" },
      { href: "tesbo-reports/specs", label: "Specs", icon: "specs" },
      { href: "tesbo-reports/tests", label: "Tests", icon: "tests" },
      { href: "tesbo-reports/analytics", label: "Analytics", icon: "analytics" },
    ],
  },
] as const;

const workspaceSettingsNavItems = [
  { href: "/settings/members", label: "Members", icon: "users" },
  { href: "/settings/integrations", label: "Integrations", icon: "plug" },
] as const;

type MenuIconName =
  | "home"
  | "dashboard"
  | "project"
  | "sparkles"
  | "history"
  | "book"
  | "list"
  | "clipboard"
  | "play"
  | "bug"
  | "chart"
  | "activity"
  | "runs"
  | "specs"
  | "tests"
  | "analytics"
  | "settings"
  | "users"
  | "plug"
  | "logout"
  | "chevronLeft"
  | "chevronRight";

function MenuIcon({ name, className = "h-4 w-4" }: { name: MenuIconName; className?: string }) {
  const common = {
    className,
    fill: "none",
    stroke: "currentColor",
    viewBox: "0 0 24 24",
  } as const;

  switch (name) {
    case "home":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 11.5l9-7 9 7" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10v10h14V10" />
        </svg>
      );
    case "dashboard":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h7v7H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 13h7v7H4z" />
        </svg>
      );
    case "project":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7h8l2 2h8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
      );
    case "sparkles":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 17l.8 1.9L8 20l-2.2.9L5 23l-.8-2.1L2 20l2.2-1.1L5 17z" />
        </svg>
      );
    case "history":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12a9 9 0 1 0 3-6.7" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4v3h3M12 7v5l3 2" />
        </svg>
      );
    case "book":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V6z" />
        </svg>
      );
    case "list":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 4h6a2 2 0 0 1 2 2v14H7V6a2 2 0 0 1 2-2z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2H9V4z" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5v14l11-7-11-7z" />
        </svg>
      );
    case "bug":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9h8M8 15h8M12 5v14M7 7l-2-2M17 7l2-2M7 17l-2 2M17 17l2 2" />
          <rect x="8" y="7" width="8" height="10" rx="4" strokeWidth={2} />
        </svg>
      );
    case "chart":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 20h16M7 16v-4M12 16V8M17 16v-6" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12h4l2-5 4 10 2-5h6" />
        </svg>
      );
    case "runs":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h16v16H4z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 8v8l7-4-7-4z" />
        </svg>
      );
    case "specs":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4h10v16l-5-3-5 3V4z" />
        </svg>
      );
    case "tests":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 4h8M9 4v4l-4 7a4 4 0 0 0 3.5 6h7a4 4 0 0 0 3.5-6l-4-7V4" />
        </svg>
      );
    case "analytics":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 20V10M10 20V4M16 20v-8M22 20v-4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 1 0 12 8.5z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6H20a2 2 0 1 1 0 4h-.2a1 1 0 0 0-.9.6z" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4zM8 13a3 3 0 1 0-3-3 3 3 0 0 0 3 3zM16 13c-3 0-6 1.5-6 4v2h12v-2c0-2.5-3-4-6-4zM8 15c-2.5 0-5 1.2-5 3.5V20h5" />
        </svg>
      );
    case "plug":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v6M15 3v6M7 9h10v2a5 5 0 0 1-5 5v5" />
        </svg>
      );
    case "logout":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 17l5-5-5-5M15 12H3M13 4h5v16h-5" />
        </svg>
      );
    case "chevronLeft":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 18l-6-6 6-6" />
        </svg>
      );
    case "chevronRight":
      return (
        <svg {...common}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 18l6-6-6-6" />
        </svg>
      );
    default:
      return null;
  }
}

function NavLink({
  href,
  label,
  icon,
  collapsed = false,
  active = false,
}: {
  href: string;
  label: string;
  icon: MenuIconName;
  collapsed?: boolean;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-label={label}
      className={`group flex items-center rounded-lg py-2 text-sm transition-colors ${
        collapsed ? "justify-center px-2" : "gap-2 px-3"
      } ${
        active
          ? "bg-[#e8f5eb] dark:bg-zinc-700 text-[var(--primary)] dark:text-zinc-100 font-medium"
          : "text-[var(--muted)] dark:text-zinc-400 hover:bg-[#eef7f0] dark:hover:bg-zinc-800 hover:text-[var(--primary)] dark:hover:text-zinc-100"
      }`}
    >
      <MenuIcon name={icon} className="h-4 w-4 shrink-0" />
      {collapsed ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
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
  const router = useRouter();
  const projectMatch = pathname?.match(/^\/projects\/([^/]+)/);
  const projectId = projectMatch?.[1] ?? null;
  const isInProject = Boolean(projectId);
  const projectPathPrefix = projectId ? `/projects/${projectId}` : "/projects";

  const [projectName, setProjectName] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
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
  const onLogout = async () => {
    if (isLoggingOut) return;
    setLogoutError(null);
    setIsLoggingOut(true);
    try {
      await logout();
      if (typeof window !== "undefined") {
        localStorage.removeItem("token");
      }
      router.replace("/login");
      router.refresh();
    } catch {
      setLogoutError("Could not log out. Please try again.");
      setIsLoggingOut(false);
    }
  };

  return (
    <aside
      className={`shrink-0 border-r border-[var(--border)] bg-[var(--surface)] dark:bg-zinc-900 flex flex-col min-h-screen transition-[width] duration-200 ${
        isCollapsed ? "w-20" : "w-56"
      }`}
    >
      <div className="p-3 border-b border-[var(--border)] flex items-center justify-between gap-2">
        <Link
          href="/projects"
          className={`font-semibold text-[var(--primary)] dark:text-zinc-100 hover:opacity-80 truncate ${
            isCollapsed ? "sr-only" : ""
          }`}
        >
          BetterCases
        </Link>
        <button
          type="button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          className="rounded-lg p-2 text-[var(--muted)] dark:text-zinc-300 hover:bg-[#eef7f0] dark:hover:bg-zinc-800 hover:text-[var(--primary)] dark:hover:text-zinc-100"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <MenuIcon name={isCollapsed ? "chevronRight" : "chevronLeft"} className="h-4 w-4" />
        </button>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {/* 1. Home - project listing (default) */}
        <NavLink href="/projects" label="Home" icon="home" active={isHomeActive} collapsed={isCollapsed} />

        {/* 2. Dashboard - workspace-level analytics */}
        <NavLink
          href="/dashboard"
          label="Dashboard"
          icon="dashboard"
          active={isDashboardActive}
          collapsed={isCollapsed}
        />

        {/* 3. Projects (when on home) OR Project name + sub-items (inside a project) */}
        <div className="pt-2">
          {isInProject && projectId ? (
            <>
              <div className="flex items-center gap-1">
                <NavLink
                  href={`/projects/${projectId}`}
                  label={projectName ?? "Project"}
                  icon="project"
                  active={isOnProjectRoot}
                  collapsed={isCollapsed}
                />
                {!isCollapsed && <Chevron open />}
              </div>
              <div
                className={`mt-1 max-h-[calc(100vh-18rem)] overflow-y-auto ${
                  isCollapsed ? "space-y-1" : "ml-3 border-l border-[var(--border)] pl-2 pr-1"
                }`}
              >
                {projectNavSections.map(({ section, items }) => (
                  <div key={section} className="mb-3 last:mb-2">
                    <p
                      className={`px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)] dark:text-zinc-300 ${
                        isCollapsed ? "hidden" : ""
                      }`}
                    >
                      {section}
                    </p>
                    <div className={`mx-3 mb-1 border-t border-[var(--border)] ${isCollapsed ? "hidden" : ""}`} />
                    <ul className="space-y-0.5">
                      {items.map(({ href, label, icon }) => {
                        const fullHref = `${projectPathPrefix}/${href}`;
                        const active =
                          pathname === fullHref || (pathname?.startsWith(fullHref + "/") ?? false);
                        return (
                          <li key={href}>
                            <NavLink
                              href={fullHref}
                              label={label}
                              icon={icon}
                              active={active}
                              collapsed={isCollapsed}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                <ul className="space-y-0.5 pt-1 border-t border-[var(--border)]">
                  <li>
                    <NavLink
                      href={`${projectPathPrefix}/settings`}
                      label="Project settings"
                      icon="settings"
                      active={
                        pathname === `${projectPathPrefix}/settings` ||
                        (pathname?.startsWith(`${projectPathPrefix}/settings/`) ?? false)
                      }
                      collapsed={isCollapsed}
                    />
                  </li>
                </ul>
              </div>
            </>
          ) : (
            <NavLink
              href="/projects"
              label="Projects"
              icon="project"
              active={isProjectsListActive}
              collapsed={isCollapsed}
            />
          )}
        </div>

        {/* Workspace settings */}
        <div className="pt-4 mt-4 border-t border-[var(--border)]">
          <div className="flex items-center gap-1">
            <NavLink
              href="/settings/members"
              label="Workspace settings"
              icon="settings"
              active={isWorkspaceSettingsActive}
              collapsed={isCollapsed}
            />
            {!isCollapsed && <Chevron open={isInWorkspaceSettings} />}
          </div>
          {isInWorkspaceSettings && (
            <ul
              className={`mt-1 space-y-0.5 ${
                isCollapsed ? "" : "ml-3 border-l border-[var(--border)] pl-2"
              }`}
            >
              {workspaceSettingsNavItems.map(({ href, label, icon }) => {
                const active = pathname === href;
                return (
                  <li key={href}>
                    <NavLink href={href} label={label} icon={icon} active={active} collapsed={isCollapsed} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </nav>
      <div className="p-3 border-t border-[var(--border)]">
        <button
          type="button"
          onClick={onLogout}
          disabled={isLoggingOut}
          className={`w-full rounded-lg py-2 text-sm text-[var(--muted)] dark:text-zinc-300 hover:bg-[#eef7f0] dark:hover:bg-zinc-800 hover:text-[var(--primary)] dark:hover:text-zinc-100 disabled:opacity-60 ${
            isCollapsed ? "flex justify-center px-2" : "flex items-center gap-2 px-3 text-left"
          }`}
          aria-label={isLoggingOut ? "Logging out" : "Log out"}
          title={isCollapsed ? (isLoggingOut ? "Logging out..." : "Log out") : undefined}
        >
          <MenuIcon name="logout" className="h-4 w-4 shrink-0" />
          {isCollapsed ? (
            <span className="sr-only">{isLoggingOut ? "Logging out..." : "Log out"}</span>
          ) : (
            <span>{isLoggingOut ? "Logging out..." : "Log out"}</span>
          )}
        </button>
        {logoutError && !isCollapsed && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">{logoutError}</p>
        )}
      </div>
    </aside>
  );
}
