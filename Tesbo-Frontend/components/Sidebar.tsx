"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import {
  IconHome,
  IconSparkles,
  IconBook,
  IconClipboardList,
  IconFileText,
  IconPlayerPlay,
  IconBug,
  IconChartBar,
  IconActivity,
  IconSettings,
  IconUsers,
  IconPlug,
  IconLogout,
  IconChevronLeft,
  IconChevronRight,
  IconKey,
  IconList,
  IconLayoutDashboard,
  IconFolders,
  IconUserCircle,
} from "@tabler/icons-react";
import { BrandLogo } from "@/components/BrandLogo";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";
import { useAppData } from "@/components/app/AppDataProvider";

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

const projectNavSections: Array<{ section: string; items: NavItemConfig[] }> = [
  {
    section: "Overview",
    items: [
      { href: "", label: "Project home", icon: "home" },
      { href: "activity", label: "Activity stream", icon: "activity" },
    ],
  },
  {
    section: "Test management",
    items: [
      { href: "requirements", label: "Requirements", icon: "list" },
      { href: "testcases", label: "Test cases", icon: "fileText" },
      { href: "plans", label: "Test plans", icon: "clipboard" },
    ],
  },
  {
    section: "Execution",
    items: [
      { href: "cycles", label: "Runs", icon: "play" },
      { href: "bugs", label: "Bugs", icon: "bug" },
      { href: "reports", label: "Insights", icon: "chart" },
    ],
  },
  {
    section: "Assets",
    items: [
      {
        href: "agents",
        label: "Agents",
        icon: "sparkles",
        children: [
          { href: "agents/tasks", label: "Tasks", icon: "clipboard" },
          { href: "agents", label: "Agent list", icon: "settings" },
          { href: "agents/zyra/settings", label: "Zyra settings", icon: "key" },
        ],
      },
      { href: "knowledge-base", label: "Knowledge base", icon: "book" },
    ],
  },
];

type MenuIconName =
  | "home" | "sparkles" | "book" | "list" | "fileText" | "clipboard"
  | "play" | "bug" | "chart" | "activity" | "settings" | "users" | "plug"
  | "logout" | "chevronLeft" | "chevronRight" | "key"
  | "dashboard" | "folders" | "account";

function MenuIcon({ name, className = "h-[20px] w-[20px]" }: { name: MenuIconName; className?: string }) {
  const props = { className, size: 20, stroke: 1.75 } as const;
  switch (name) {
    case "home":         return <IconHome {...props} />;
    case "sparkles":     return <IconSparkles {...props} />;
    case "book":         return <IconBook {...props} />;
    case "list":         return <IconList {...props} />;
    case "fileText":     return <IconFileText {...props} />;
    case "clipboard":    return <IconClipboardList {...props} />;
    case "play":         return <IconPlayerPlay {...props} />;
    case "bug":          return <IconBug {...props} />;
    case "chart":        return <IconChartBar {...props} />;
    case "activity":     return <IconActivity {...props} />;
    case "settings":     return <IconSettings {...props} />;
    case "users":        return <IconUsers {...props} />;
    case "plug":         return <IconPlug {...props} />;
    case "logout":       return <IconLogout {...props} />;
    case "chevronLeft":  return <IconChevronLeft {...props} />;
    case "chevronRight": return <IconChevronRight {...props} />;
    case "key":          return <IconKey {...props} />;
    case "dashboard":    return <IconLayoutDashboard {...props} />;
    case "folders":      return <IconFolders {...props} />;
    case "account":      return <IconUserCircle {...props} />;
    default:             return null;
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
      className={`group relative flex items-center overflow-hidden rounded-[6px] py-2 text-[13px] transition-colors duration-150 ${
        collapsed
          ? "justify-center px-2"
          : nested
            ? "gap-2 pl-10 pr-3"
            : "gap-2 pl-3 pr-3"
      } ${
        active
          ? "tesbo-nav-item tesbo-nav-item-active"
          : "tesbo-nav-item tesbo-nav-item-idle"
      }`}
    >
      <MenuIcon
        name={icon}
        className={`h-[18px] w-[18px] shrink-0 ${
          active ? "text-[var(--denim)]" : "text-[var(--ink-400)]"
        }`}
      />
      {collapsed ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
    </Link>
  );
}

function BackToProjects({ collapsed }: { collapsed: boolean }) {
  return (
    <Link
      href="/projects"
      className={`group flex items-center rounded-[6px] py-2 text-[13px] transition-colors duration-150 tesbo-nav-item tesbo-nav-item-idle ${
        collapsed ? "justify-center px-2" : "gap-2 pl-3 pr-3"
      }`}
    >
      <MenuIcon name="chevronLeft" className="h-[18px] w-[18px] shrink-0 text-[var(--ink-300)]" />
      {collapsed ? <span className="sr-only">All Projects</span> : <span className="truncate font-medium">All Projects</span>}
    </Link>
  );
}

function SidebarContent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectMatch = pathname?.match(/^\/projects\/([^/]+)/);
  const projectId = projectMatch?.[1] ?? null;
  const isInProject = Boolean(projectId);
  const projectPathPrefix = projectId ? `/projects/${projectId}` : "/projects";

  const [isCollapsed, setIsCollapsed] = useState(false);
  const { workspace } = useAppData();
  const isWorkspaceOwner = (workspace?.role ?? "").trim().toLowerCase() === "owner";

  const isInSettings = Boolean(pathname?.startsWith("/settings"));

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

  const showProjectNav = !isInSettings && isInProject && Boolean(projectId);
  const showSettingsNav = isInSettings;
  const showWorkspaceNav = !isInSettings && !isInProject;

  return (
    <aside
      className={`tesbo-sidebar sticky top-0 shrink-0 flex h-screen flex-col border-r transition-[width] duration-200 ${
        isCollapsed ? "w-[60px]" : "w-[260px]"
      }`}
    >
      {/*
        Header. The collapsed rail is far too narrow to fit the brand mark and the
        toggle side by side, so they stack. Keeping them on one row overflowed the
        rail and pushed the toggle underneath the sticky TopBar (z-20), which left
        the sidebar collapsed with no reachable way to expand it again.
      */}
      <div
        className={`flex h-16 items-center border-b border-[var(--glass-border)] ${
          isCollapsed ? "flex-col justify-center gap-1 px-2" : "justify-between gap-2 px-3"
        }`}
      >
        <Link href="/projects" className="flex shrink-0 items-center justify-center" aria-label="Tesbo Test Manager">
          {isCollapsed ? (
            <span className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--glass-border)] bg-[var(--glass-surface-strong)] shadow-sm">
              <BrandLogo mark decorative className="h-6 w-auto object-contain" />
            </span>
          ) : (
            <BrandLogo className="h-10 max-w-[150px] object-contain" />
          )}
        </Link>
        <button
          type="button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          className={`shrink-0 rounded-xl border border-transparent text-[var(--muted-soft)] transition-colors hover:border-[var(--glass-border)] hover:bg-[var(--glass-surface-muted)] hover:text-[var(--foreground)] ${
            isCollapsed ? "p-1" : "p-1.5"
          }`}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <MenuIcon name={isCollapsed ? "chevronRight" : "chevronLeft"} className="h-[16px] w-[16px]" />
        </button>
      </div>

      <WorkspaceSwitcher isCollapsed={isCollapsed} />

      {/* Navigation */}
      <nav className="flex-1 space-y-3 overflow-y-auto px-2.5 pb-3 pt-3">

        {/* Settings mode */}
        {showSettingsNav && (
          <div className="space-y-3">
            <div className="space-y-0.5">
              <BackToProjects collapsed={isCollapsed} />
            </div>
          </div>
        )}

        {/* Workspace top-level mode */}
        {showWorkspaceNav && (
          <div className="space-y-3">
            <div>
              {!isCollapsed && (
                <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--ink-300)]">Overview</p>
              )}
              <div className="space-y-0.5">
                <NavLink href="/dashboard" label="Dashboard" icon="dashboard" active={pathname === "/dashboard"} collapsed={isCollapsed} />
                <NavLink href="/projects" label="Projects" icon="folders" active={pathname === "/projects"} collapsed={isCollapsed} />
                {isWorkspaceOwner && (
                  <NavLink href="/activity" label="Activity" icon="activity" active={pathname === "/activity"} collapsed={isCollapsed} />
                )}
              </div>
            </div>
          </div>
        )}

        {/* Project mode */}
        {showProjectNav && (
          <div className="space-y-3">
            <div className="space-y-0.5">
              <BackToProjects collapsed={isCollapsed} />
            </div>

            {projectNavSections.map(({ section, items }) => (
              <div key={section}>
                {!isCollapsed && (
                  <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--ink-300)]">
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
                              const childActive =
                                child.href === "agents"
                                  ? pathname === childHref
                                  : isPathActive(childHref);
                              return (
                                <NavLink
                                  key={child.href}
                                  href={childHref}
                                  label={child.label}
                                  icon={child.icon}
                                  active={childActive}
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
          </div>
        )}
      </nav>

      {/*
       * Footer — Project/Workspace settings only. My Account, the theme toggle, and Logout used
       * to live here too, but they're duplicates of the top-right user menu (TopBar.tsx) now that
       * it exists, so they were removed from this second location rather than kept in both places.
       */}
      <div className="space-y-1 border-t border-[var(--glass-border)] p-2.5">
        {!isInSettings && !isInProject && (
          <NavLink
            href="/settings"
            label="Workspace settings"
            icon="settings"
            collapsed={isCollapsed}
          />
        )}
        {!isInSettings && isInProject && (
          <NavLink
            href={`${projectPathPrefix}/settings`}
            label="Project settings"
            icon="settings"
            active={pathname === `${projectPathPrefix}/settings` || (pathname?.startsWith(`${projectPathPrefix}/settings/`) ?? false)}
            collapsed={isCollapsed}
          />
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
