import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms and Conditions | TesboX",
  description: "Terms and Conditions for TesboX and Jira integration.",
};

export default function TermsAndConditionsPage() {
  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-3xl font-semibold">Terms and Conditions</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Last updated: February 23, 2026</p>

        <div className="mt-8 space-y-6 text-sm leading-7 text-[var(--muted)]">
          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">1. Acceptance</h2>
            <p className="mt-2">
              By using TesboX, you agree to these Terms and Conditions. If you do not agree, do not use the
              service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">2. Service Overview</h2>
            <p className="mt-2">
              TesboX is a test management and collaboration platform that includes project workspaces, test case
              management, planning and execution workflows, reporting, optional AI-assisted features, and Jira
              integration.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">3. Accounts</h2>
            <p className="mt-2">
              You are responsible for maintaining the confidentiality of your account access and for all activity under
              your account. You must provide accurate information and use the service in compliance with applicable
              laws.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              4. Customer Data and Ownership
            </h2>
            <p className="mt-2">
              You retain ownership of the data you submit to TesboX, including test artifacts and Jira-linked
              records. You grant TesboX a limited right to process this data only as needed to operate and improve
              the service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">5. Jira Integration</h2>
            <p className="mt-2">
              If you connect Jira, you authorize TesboX to access and process Jira data that you permit through
              Atlassian OAuth. You are responsible for ensuring your use of integration features complies with your
              organization&apos;s policies and Atlassian terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">6. Acceptable Use</h2>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              <li>Do not use the service for unlawful, harmful, or abusive activities.</li>
              <li>Do not attempt to disrupt, probe, or bypass service security controls.</li>
              <li>Do not upload or share content that infringes intellectual property rights.</li>
              <li>Do not misuse API features in ways that degrade service availability.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              7. Availability and Changes
            </h2>
            <p className="mt-2">
              We may modify, suspend, or discontinue parts of TesboX from time to time. We aim to maintain
              reliable availability but do not guarantee uninterrupted operation.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">8. Disclaimers</h2>
            <p className="mt-2">
              TesboX is provided on an &quot;as is&quot; and &quot;as available&quot; basis to the fullest extent permitted by
              law. We disclaim all implied warranties, including merchantability, fitness for a particular purpose, and
              non-infringement.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              9. Limitation of Liability
            </h2>
            <p className="mt-2">
              To the maximum extent permitted by law, TesboX and its affiliates are not liable for indirect,
              incidental, special, consequential, or punitive damages, or for loss of profits, revenues, or data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">10. Termination</h2>
            <p className="mt-2">
              We may suspend or terminate access for violations of these terms or security concerns. You may stop using
              the service at any time.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">11. Updates to Terms</h2>
            <p className="mt-2">
              We may update these terms periodically. Continued use of TesboX after updates means you accept the
              revised terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">12. Contact</h2>
            <p className="mt-2">
              For legal or terms-related questions, contact{" "}
              <a href="mailto:support@bettercases.ai" className="text-[var(--brand-primary)] hover:underline">
                support@bettercases.ai
              </a>
              .
            </p>
          </section>
        </div>

        <div className="mt-10 text-sm">
          <Link href="/privacy-policy" className="text-[var(--brand-primary)] hover:underline">
            View Privacy Policy
          </Link>
        </div>
      </div>
    </main>
  );
}
