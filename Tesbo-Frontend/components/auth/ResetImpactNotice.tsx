import { IconInfoCircle } from "@tabler/icons-react";

/**
 * What completing a password reset does beyond changing the password, shown before the user commits
 * to it. Revoking API tokens is not something people expect from a reset, and it takes a CI pipeline
 * or an MCP client offline, so it is stated up front rather than discovered from a failing build.
 *
 * Must stay in step with PasswordResetService.resetPassword, which deletes the user's sessions and
 * every API token they hold.
 */
export function ResetImpactNotice({ className = "" }: { className?: string }) {
  return (
    <div
      role="note"
      data-testid="reset-impact-notice"
      className={`flex gap-3 rounded-[8px] border border-[var(--border)] bg-[var(--surface-secondary)] p-3 ${className}`}
    >
      <IconInfoCircle size={18} stroke={1.5} className="mt-0.5 shrink-0 text-[var(--brand-primary)]" aria-hidden />
      <div className="text-[12.5px] leading-relaxed text-[var(--muted)]">
        <p className="mb-1 font-medium text-[var(--foreground)]">What happens when you complete this</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>You are signed out of every device.</li>
          <li>All API tokens issued under your account are revoked.</li>
        </ul>
        <p className="mt-1.5">
          Integrations that use those tokens, such as CI pipelines, MCP clients and the Playwright reporter, stop working
          until you create new tokens under Project Settings, API tokens.
        </p>
      </div>
    </div>
  );
}
