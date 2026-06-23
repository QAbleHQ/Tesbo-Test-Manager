"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
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
  IconShield,
  IconKey,
  IconList,
} from "@tabler/icons-react";
import { authMe, logout } from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";
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
        ],
      },
      { href: "knowledge-base", label: "Knowledge base", icon: "book" },
    ],
  },
];

type MenuIconName =
  | "home" | "sparkles" | "book" | "list" | "fileText" | "clipboard"
  | "play" | "bug" | "chart" | "activity" | "settings" | "users" | "plug"
  | "logout" | "chevronLeft" | "chevronRight" | "adminPanel" | "key";

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
    case "adminPanel":   return <IconShield {...props} />;
    case "key":          return <IconKey {...props} />;
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
          : "tesbo-nav-item tesbo-nav-item-idle text-[var(--ink-400)] hover:text-[var(--ink-800)]"
      }`}
    >
      <MenuIcon
        name={icon}
        className={`h-[18px] w-[18px] shrink-0 ${
          active ? "text-[var(--denim)]" : "text-[var(--ink-300)]"
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
      className={`group flex items-center rounded-[6px] py-2 text-[13px] transition-colors duration-150 tesbo-nav-item tesbo-nav-item-idle text-[var(--ink-400)] hover:text-[var(--ink-800)] ${
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectMatch = pathname?.match(/^\/projects\/([^/]+)/);
  const projectId = projectMatch?.[1] ?? null;
  const isInProject = Boolean(projectId);
  const projectPathPrefix = projectId ? `/projects/${projectId}` : "/projects";

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

  const isInSettings = Boolean(
    pathname?.startsWith("/settings") || pathname?.startsWith("/admin")
  );

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

  const showProjectNav = !isInSettings && isInProject && Boolean(projectId);
  const showSettingsNav = isInSettings;

  return (
    <aside
      className={`tesbo-sidebar sticky top-0 shrink-0 flex h-screen flex-col border-r transition-[width] duration-200 ${
        isCollapsed ? "w-[52px]" : "w-[260px]"
      }`}
    >
      {/* Header */}
      <div className="flex h-16 items-center justify-between gap-2 border-b border-[var(--glass-border)] px-3">
        <Link href="/projects" className={`flex items-center ${isCollapsed ? "justify-center" : ""}`} aria-label="Tesbo Test Manager">
          {isCollapsed ? (
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--glass-border)] bg-[var(--glass-surface-strong)] shadow-sm">
              <BrandLogo decorative className="h-7 w-auto object-contain" />
            </span>
          ) : (
            <BrandLogo className="h-10 max-w-[150px] object-contain" />
          )}
        </Link>
        <button
          type="button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          className="rounded-xl border border-transparent p-1.5 text-[var(--muted-soft)] transition-colors hover:border-[var(--glass-border)] hover:bg-[var(--glass-surface-muted)] hover:text-[var(--foreground)]"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <MenuIcon name={isCollapsed ? "chevronRight" : "chevronLeft"} className="h-[16px] w-[16px]" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-3 overflow-y-auto px-2.5 pb-3 pt-3">

        {/* Settings mode */}
        {showSettingsNav && (
          <div className="space-y-3">
            <div className="space-y-0.5">
              <BackToProjects collapsed={isCollapsed} />
            </div>

            <div>
              {!isCollapsed && (
                <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--ink-300)]">Workspace</p>
              )}
              <div className="space-y-0.5">
                <NavLink href="/settings/members" label="Members" icon="users" active={isPathActive("/settings/members")} collapsed={isCollapsed} />
                <NavLink href="/settings/integrations" label="Integrations" icon="plug" active={isPathActive("/settings/integrations")} collapsed={isCollapsed} />
              </div>
            </div>

            {isPlatformAdmin && (
              <div>
                {!isCollapsed && (
                  <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--ink-300)]">Platform Admin</p>
                )}
                <div className="space-y-0.5">
                  <NavLink href="/admin" label="System Health" icon="activity" active={pathname === "/admin"} collapsed={isCollapsed} />
                  <NavLink href="/admin/admins" label="Manage Admins" icon="users" active={isPathActive("/admin/admins")} collapsed={isCollapsed} />
                </div>
              </div>
            )}
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

            <NavLink
              href={`${projectPathPrefix}/settings`}
              label="Settings"
              icon="settings"
              active={pathname === `${projectPathPrefix}/settings` || (pathname?.startsWith(`${projectPathPrefix}/settings/`) ?? false)}
              collapsed={isCollapsed}
            />
          </div>
        )}
      </nav>

      {/* Footer */}
      <div className="space-y-1 border-t border-[var(--glass-border)] p-2.5">
        {isPlatformAdmin && !isInSettings && (
          <NavLink
            href="/admin"
            label="Admin Panel"
            icon="adminPanel"
            active={pathname?.startsWith("/admin") ?? false}
            collapsed={isCollapsed}
          />
        )}
        <div className={`flex items-center ${isCollapsed ? "flex-col gap-1" : "gap-2"}`}>
          <ThemeToggle />
          <button
            type="button"
            onClick={onLogout}
            disabled={isLoggingOut}
            className={`flex items-center rounded-[6px] border border-transparent py-1.5 text-[13px] text-[var(--muted)] transition-colors hover:border-[var(--glass-border)] hover:bg-[var(--glass-surface-muted)] hover:text-[var(--foreground)] disabled:opacity-60 ${
              isCollapsed ? "justify-center px-2" : "flex-1 gap-2 px-2"
            }`}
            aria-label={isLoggingOut ? "Logging out" : "Log out"}
          >
            <MenuIcon name="logout" className="h-[18px] w-[18px] shrink-0 text-[var(--ink-300)]" />
            {!isCollapsed && <span>{isLoggingOut ? "Logging out..." : "Log out"}</span>}
            {isCollapsed && <span className="sr-only">{isLoggingOut ? "Logging out..." : "Log out"}</span>}
          </button>
        </div>
        {logoutError && !isCollapsed && (
          <p className="mt-1 px-2 text-xs text-[var(--error)]">{logoutError}</p>
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
