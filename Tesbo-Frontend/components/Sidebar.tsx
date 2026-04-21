"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { authMe, listProjects, logout, type ProjectSummary } from "@/lib/api";
import ThemeToggle from "@/components/ThemeToggle";

type NavItemConfig = {
  href: string;
  label: string;
  icon: MenuIconName;
  children?: Array<{
    href: string;
    label: string;
    icon: MenuIconName;
  }>;
};

const globalNavItems: NavItemConfig[] = [
  { href: "/projects", label: "Projects", icon: "project" },
  { href: "/dashboard", label: "Workspace Insights", icon: "dashboard" },
];

const projectNavSections: Array<{ section: string; items: NavItemConfig[] }> = [
  {
    section: "Overview",
    items: [
      { href: "", label: "Project Home", icon: "home" },
      { href: "activity", label: "Activity Stream", icon: "activity" },
    ],
  },
  {
    section: "Scenarios",
    items: [
      { href: "suites", label: "Suites", icon: "list" },
      { href: "plans", label: "Execution Plans", icon: "clipboard" },
      { href: "cycles", label: "Runs", icon: "play" },
      { href: "bugs", label: "Bugs", icon: "bug" },
      { href: "reports", label: "Insights", icon: "chart" },
    ],
  },
  {
    section: "Agents",
    items: [
      {
        href: "agents",
        label: "Agents Control Center",
        icon: "agent",
        children: [
          { href: "agents/testcase-generator", label: "Test Case Generator", icon: "agent" },
        ],
      },
    ],
  },
  {
    section: "Assets",
    items: [
      { href: "knowledge-base", label: "Knowledge Base", icon: "book" },
    ],
  },
];


const workspaceSettingsNavItems = [
  { href: "/settings/members", label: "Members", icon: "users" },
  { href: "/settings/integrations", label: "Integrations", icon: "plug" },
] as const;

const workspaceModeNavItems: NavItemConfig[] = [
  ...globalNavItems,
  ...workspaceSettingsNavItems,
];

// Easy rollback switch: set to false to disable
const ENABLE_SCOPE_SWITCHER = true;
type NavScope = "workspace" | "project";

type MenuIconName =
  | "home" | "dashboard" | "project" | "sparkles" | "history"
  | "book" | "list" | "clipboard" | "play" | "bug" | "chart"
  | "activity" | "runs" | "specs" | "tests" | "analytics"
  | "agent" | "settings" | "users" | "plug" | "logout"
  | "chevronLeft" | "chevronRight" | "adminPanel" | "key";

function MenuIcon({ name, className = "h-[18px] w-[18px]" }: { name: MenuIconName; className?: string }) {
  const common = { className, fill: "none", stroke: "currentColor", strokeWidth: 1.75, viewBox: "0 0 24 24" } as const;
  switch (name) {
    case "home": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M3 11.5l9-7 9 7" /><path strokeLinecap="round" strokeLinejoin="round" d="M5 10v10h14V10" /></svg>;
    case "dashboard": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4h7v7H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 13h7v7H4z" /></svg>;
    case "project": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M3 7h8l2 2h8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>;
    case "sparkles": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" /><path strokeLinecap="round" strokeLinejoin="round" d="M5 17l.8 1.9L8 20l-2.2.9L5 23l-.8-2.1L2 20l2.2-1.1L5 17z" /></svg>;
    case "history": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 1 0 3-6.7" /><path strokeLinecap="round" strokeLinejoin="round" d="M3 4v3h3M12 7v5l3 2" /></svg>;
    case "book": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V6z" /></svg>;
    case "list": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" /></svg>;
    case "clipboard": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M9 4h6a2 2 0 0 1 2 2v14H7V6a2 2 0 0 1 2-2z" /><path strokeLinecap="round" strokeLinejoin="round" d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2H9V4z" /></svg>;
    case "play": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M8 5v14l11-7-11-7z" /></svg>;
    case "bug": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M8 9h8M8 15h8M12 5v14M7 7l-2-2M17 7l2-2M7 17l-2 2M17 17l2 2" /><rect x="8" y="7" width="8" height="10" rx="4" /></svg>;
    case "chart": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M4 20h16M7 16v-4M12 16V8M17 16v-6" /></svg>;
    case "activity": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4l2-5 4 10 2-5h6" /></svg>;
    case "runs": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4h16v16H4z" /><path strokeLinecap="round" strokeLinejoin="round" d="M9 8v8l7-4-7-4z" /></svg>;
    case "specs": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M7 4h10v16l-5-3-5 3V4z" /></svg>;
    case "tests": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M8 4h8M9 4v4l-4 7a4 4 0 0 0 3.5 6h7a4 4 0 0 0 3.5-6l-4-7V4" /></svg>;
    case "analytics": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10M10 20V4M16 20v-8M22 20v-4" /></svg>;
    case "agent": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M12 2L3 7v6c0 5.25 3.75 10 9 11 5.25-1 9-5.75 9-11V7l-9-5z" /><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>;
    case "settings": return <svg {...common}><circle cx="12" cy="12" r="3" /><path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.1a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.1a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.1a1 1 0 0 0 .6.9h.1a1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6H20a2 2 0 1 1 0 4h-.1a1 1 0 0 0-.9.6z" /></svg>;
    case "users": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path strokeLinecap="round" strokeLinejoin="round" d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
    case "plug": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M9 3v6M15 3v6M7 9h10v2a5 5 0 0 1-5 5v5" /></svg>;
    case "logout": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>;
    case "chevronLeft": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" /></svg>;
    case "chevronRight": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6" /></svg>;
    case "adminPanel": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M12 2L3 7v6c0 5.25 3.75 10 9 11 5.25-1 9-5.75 9-11V7l-9-5z" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /></svg>;
    case "key": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>;
    default: return null;
  }
}

function NavLink({
  href,
  label,
  icon,
  collapsed = false,
  active = false,
  nested = false,
}: {
  href: string;
  label: string;
  icon: MenuIconName;
  collapsed?: boolean;
  active?: boolean;
  nested?: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-label={label}
      className={`group relative flex items-center overflow-hidden rounded-xl py-2 text-[14px] font-medium transition-colors duration-150 ${
        collapsed
          ? "justify-center px-2"
          : nested
            ? "gap-2.5 pl-10 pr-3.5"
            : "gap-2.5 pl-4 pr-3.5"
      } ${
        active
          ? "border border-[var(--brand-border)] bg-[var(--brand-surface)] text-[var(--foreground)] shadow-sm"
          : "border border-transparent text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
      }`}
    >
      {active && <span className="absolute inset-y-1 left-0 w-[3px] rounded-r-full bg-[var(--brand-primary)]" aria-hidden />}
      <MenuIcon
        name={icon}
        className={`h-[18px] w-[18px] shrink-0 ${
          active ? "text-[var(--brand-primary)]" : "text-[var(--muted-soft)]"
        }`}
      />
      {collapsed ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
    </Link>
  );
}

function SidebarContent() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectMatch = pathname?.match(/^\/projects\/([^/]+)/);
  const projectId = projectMatch?.[1] ?? null;
  const isInProject = Boolean(projectId);
  const projectPathPrefix = projectId ? `/projects/${projectId}` : "/projects";

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    authMe().then((data) => {
      if (active && data?.isPlatformAdmin) setIsPlatformAdmin(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!ENABLE_SCOPE_SWITCHER) return;
    let active = true;
    listProjects()
      .then((items) => {
        if (active) setProjects(Array.isArray(items) ? items : []);
      })
      .catch(() => {
        if (active) setProjects([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const isOnProjectRoot = projectId != null && pathname === `/projects/${projectId}`;
  const isPathActive = (href: string) => {
    if (!pathname) return false;
    const [cleanHref, queryStr] = href.split("?");
    const pathMatch = pathname === cleanHref || pathname.startsWith(`${cleanHref}/`);
    if (!pathMatch) return false;
    if (queryStr) {
      const hrefParams = new URLSearchParams(queryStr);
      for (const [k, v] of hrefParams.entries()) {
        if (searchParams.get(k) !== v) return false;
      }
    }
    return true;
  };

  const onLogout = async () => {
    if (isLoggingOut) return;
    setLogoutError(null);
    setIsLoggingOut(true);
    try {
      await logout();
      if (typeof window !== "undefined") localStorage.removeItem("token");
      router.replace("/login");
      router.refresh();
    } catch {
      setLogoutError("Could not log out. Please try again.");
      setIsLoggingOut(false);
    }
  };

  const onScopeChange = (scope: NavScope) => {
    if (scope === "workspace" && isInProject) {
      router.push("/projects");
      return;
    }
    if (scope === "project" && !isInProject) {
      const fallbackProjectId = projects[0]?.id;
      if (fallbackProjectId) router.push(`/projects/${fallbackProjectId}`);
    }
  };

  const onProjectSelect = (nextProjectId: string) => {
    if (!nextProjectId) return;
    router.push(`/projects/${nextProjectId}`);
  };

  const navScope: NavScope = isInProject ? "project" : "workspace";
  const showGlobalNavigation = !ENABLE_SCOPE_SWITCHER || !isInProject;
  const showProjectNavigation = isInProject && Boolean(projectId);

  return (
    <aside
      className={`sticky top-0 shrink-0 flex h-screen flex-col border-r border-[var(--border)] bg-[var(--app-shell)] transition-[width] duration-200 ${
        isCollapsed ? "w-[72px]" : "w-[248px]"
      }`}
    >
      <div className="flex h-14 items-center justify-between gap-2 border-b border-[var(--border)] px-3">
        <Link href="/projects" className={`flex items-center ${isCollapsed ? "justify-center" : ""}`} aria-label="TesboX">
          {isCollapsed ? (
            <span className="text-base font-bold text-[var(--foreground)]">TX</span>
          ) : (
            <Image src="/tesbox-logo-transparent.png" alt="TesboX" width={110} height={30} priority className="h-7 w-auto" />
          )}
        </Link>
        <button
          type="button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          className="rounded-lg p-1.5 text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <MenuIcon name={isCollapsed ? "chevronRight" : "chevronLeft"} className="h-4 w-4" />
        </button>
      </div>

      {ENABLE_SCOPE_SWITCHER && !isCollapsed && (
        <div className="border-b border-[var(--border)] px-3 py-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">Scope Lock</p>
          <div className="mt-2 grid grid-cols-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-1 shadow-[var(--shadow-card)]">
            <button
              type="button"
              onClick={() => onScopeChange("workspace")}
              className={`rounded-lg px-2 py-1.5 text-[12px] font-semibold transition-colors ${
                navScope === "workspace"
                  ? "bg-[var(--brand-surface)] text-[var(--foreground)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              Workspace
            </button>
            <button
              type="button"
              onClick={() => onScopeChange("project")}
              className={`rounded-lg px-2 py-1.5 text-[12px] font-semibold transition-colors ${
                navScope === "project"
                  ? "bg-[var(--brand-surface)] text-[var(--foreground)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              Project
            </button>
          </div>
          {navScope === "project" && (
            <div className="mt-2">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                Project Switcher
              </label>
              <select
                value={projectId ?? ""}
                onChange={(e) => onProjectSelect(e.target.value)}
                className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--foreground)] shadow-[var(--shadow-card)]"
              >
                <option value="" disabled>
                  Select project
                </option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      <nav className="flex-1 space-y-3 overflow-y-auto px-2 pb-3 pt-3">
        {showGlobalNavigation && (
          <div className="space-y-0.5">
            {(ENABLE_SCOPE_SWITCHER ? workspaceModeNavItems : globalNavItems).map(({ href, label, icon }) => (
              <NavLink key={href} href={href} label={label} icon={icon} active={isPathActive(href)} collapsed={isCollapsed} />
            ))}
          </div>
        )}

        {showProjectNavigation ? (
          <>
            <div className="space-y-3">
              {projectNavSections.map(({ section, items }) => (
                <div key={section}>
                  {!isCollapsed && (
                    <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                      {section}
                    </p>
                  )}
                  <div className="space-y-0.5">
                    {items.map(({ href, label, icon, children }) => {
                      const fullHref = href ? `${projectPathPrefix}/${href}` : projectPathPrefix;
                      const active = isPathActive(fullHref) || (href === "" && isOnProjectRoot);
                      const isParentOpen = Boolean(children && active);

                      return (
                        <div key={href || label}>
                          <NavLink href={fullHref} label={label} icon={icon} active={active} collapsed={isCollapsed} />
                          {!isCollapsed && isParentOpen && children ? (
                            <div className="mt-0.5 space-y-0.5">
                              {children.map((child) => {
                                const childHref = `${projectPathPrefix}/${child.href}`;
                                return (
                                  <NavLink
                                    key={child.href}
                                    href={childHref}
                                    label={child.label}
                                    icon={child.icon}
                                    active={isPathActive(childHref)}
                                    collapsed={isCollapsed}
                                    nested
                                  />
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              <NavLink
                href={`${projectPathPrefix}/settings`}
                label="Settings"
                icon="settings"
                active={pathname === `${projectPathPrefix}/settings` || (pathname?.startsWith(`${projectPathPrefix}/settings/`) ?? false)}
                collapsed={isCollapsed}
              />
            </div>
          </>
        ) : null}

        {/* Workspace settings */}
        {showGlobalNavigation && !ENABLE_SCOPE_SWITCHER && (
          <div>
            {!isCollapsed && (
              <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                Workspace
              </p>
            )}
            {workspaceSettingsNavItems.map(({ href, label, icon }) => {
              const active = pathname === href || pathname?.startsWith(`${href}/`);
              return <NavLink key={href} href={href} label={label} icon={icon} active={active} collapsed={isCollapsed} />;
            })}
          </div>
        )}
      </nav>

      <div className="space-y-2 border-t border-[var(--border)] p-2">
        {!isCollapsed && (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-2">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
              Theme
            </p>
            <ThemeToggle />
          </div>
        )}
        {isPlatformAdmin && (
          <NavLink
            href="/admin"
            label="Admin Panel"
            icon="adminPanel"
            active={pathname?.startsWith("/admin") ?? false}
            collapsed={isCollapsed}
          />
        )}
        <button
          type="button"
          onClick={onLogout}
          disabled={isLoggingOut}
          className={`w-full rounded-xl border border-transparent py-2 text-[14px] text-[var(--muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--foreground)] disabled:opacity-60 ${
            isCollapsed ? "flex justify-center px-2" : "flex items-center gap-2.5 px-2.5 text-left"
          }`}
          aria-label={isLoggingOut ? "Logging out" : "Log out"}
        >
          <MenuIcon name="logout" className="h-[18px] w-[18px] shrink-0 text-[var(--muted-soft)]" />
          {isCollapsed ? (
            <span className="sr-only">{isLoggingOut ? "Logging out..." : "Log out"}</span>
          ) : (
            <span>{isLoggingOut ? "Logging out..." : "Log out"}</span>
          )}
        </button>
        {logoutError && !isCollapsed && (
          <p className="mt-1.5 px-2.5 text-xs text-[var(--error)]">{logoutError}</p>
        )}
      </div>
    </aside>
  );
}

export default function Sidebar() {
  return (
    <Suspense>
      <SidebarContent />
    </Suspense>
  );
}
