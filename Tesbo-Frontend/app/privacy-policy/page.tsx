import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy | Tesbo",
  description: "Privacy Policy for Tesbo and Jira integration.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-3xl font-semibold">Privacy Policy</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Last updated: February 23, 2026</p>

        <div className="mt-8 space-y-6 text-sm leading-7 text-[var(--muted)]">
          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">1. Scope</h2>
            <p className="mt-2">
              This Privacy Policy explains how Tesbo collects, uses, stores, and shares information when you use
              the Tesbo web application, including Jira integration features made available through Atlassian.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              2. Information We Collect
            </h2>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              <li>Account and identity data, such as your email address and profile name.</li>
              <li>Authentication data, including one-time password (OTP) requests and session identifiers.</li>
              <li>
                Workspace and project content, such as test cases, plans, runs, bugs, comments, knowledge-base notes,
                and uploaded files.
              </li>
              <li>
                Jira integration data, including Jira site URL, project metadata, issue metadata, and mapped links
                between Jira issues and Tesbo records.
              </li>
              <li>Operational logs and audit activity required for security, troubleshooting, and product operation.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">3. How We Use Data</h2>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              <li>To provide account access, maintain sessions, and secure authentication.</li>
              <li>To operate core test management workflows and collaboration features.</li>
              <li>To connect to Jira, sync selected Jira tickets, and enable linking/comment workflows.</li>
              <li>To provide analytics, reports, notifications, and product reliability monitoring.</li>
              <li>
                To support optional AI-assisted generation features when enabled by your workspace administrators.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              4. Jira and Atlassian Data Handling
            </h2>
            <p className="mt-2">
              When a workspace administrator connects Jira, Tesbo receives and stores OAuth credentials and
              selected Jira project and issue data needed for integration features. We use this data only to provide
              Jira-related functionality inside Tesbo, such as synchronization and issue linking.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              5. Third-Party Processors
            </h2>
            <p className="mt-2">Depending on configuration, Tesbo may use third-party providers for:</p>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              <li>Email delivery (for OTP and notification messages).</li>
              <li>Atlassian APIs for Jira integration.</li>
              <li>AI model providers for optional AI-generation features.</li>
              <li>Cloud object storage for uploaded artifacts, where configured.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">6. Data Sharing</h2>
            <p className="mt-2">
              We do not sell personal information. We share data only with service providers as required to operate
              Tesbo, to comply with legal obligations, or based on your workspace configuration and user actions.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">7. Retention</h2>
            <p className="mt-2">
              We retain data while your workspace remains active and as needed for security, legal compliance, and
              legitimate business purposes. You may request deletion of workspace data by contacting us.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">8. Security</h2>
            <p className="mt-2">
              Tesbo applies technical and organizational controls designed to protect stored information. No
              method of transmission or storage is completely secure, and absolute security cannot be guaranteed.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">9. Your Choices</h2>
            <p className="mt-2">
              You may update account information through the product and request access, correction, or deletion of
              personal data where applicable by contacting us.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">10. Contact</h2>
            <p className="mt-2">
              For privacy requests or questions, contact us at{" "}
              <a href="mailto:support@tesbo.io" className="text-[var(--brand-primary)] hover:underline">
                support@tesbo.io
              </a>
              .
            </p>
          </section>
        </div>

        <div className="mt-10 text-sm">
          <Link href="/terms-and-conditions" className="text-[var(--brand-primary)] hover:underline">
            View Terms and Conditions
          </Link>
        </div>
      </div>
    </main>
  );
}
