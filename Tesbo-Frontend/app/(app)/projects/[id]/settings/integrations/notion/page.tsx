"use client";

import Link from "next/link";
import { ProjectIntegrationMapping } from "@/components/integrations/ProjectIntegrationMapping";
import { IntegrationAiGenerationSettings } from "@/components/integrations/IntegrationAiGenerationSettings";
import { getNotionStatus, listNotionDatabases, connectNotionDatabase } from "@/lib/api";

// ProjectIntegrationMapping speaks Jira/Linear's { id, key, name } shape; a Notion database has no
// short key, so `key` stays empty and the row simply shows the database title.
async function fetchDatabases(projectId: string) {
  const databases = await listNotionDatabases(projectId);
  return databases.map((db) => ({ id: db.id, key: "", name: db.name || "Untitled database", connected: db.connected }));
}

async function saveDatabase(projectId: string, items: { id: string; name: string }[]) {
  const [item] = items;
  if (!item) throw new Error("Select a Notion database to link.");
  await connectNotionDatabase(projectId, { databaseId: item.id, databaseName: item.name });
}

export default function NotionProjectIntegrationPage() {
  return (
    <ProjectIntegrationMapping
      provider="notion"
      label="Notion"
      remoteUnitLabel="Notion database"
      workspaceConfigHref="/settings/integrations/notion"
      itemNoun="pages"
      fetchStatus={getNotionStatus}
      fetchRemoteList={fetchDatabases}
      saveMapping={saveDatabase}
      emptyMessage={
        <div className="space-y-1">
          <p className="font-medium text-[var(--foreground)]">No databases are shared with Tesbo yet.</p>
          <p>
            Notion only shows Tesbo the content you share with it. In Notion, open the database, click the ... menu, choose
            Connections, and add the Tesbo integration. Then reload this page.
          </p>
          <p>
            Still not listed? Reconnect Notion in{" "}
            <Link href="/settings/integrations/notion" className="text-[var(--accent-light)] hover:underline">
              Workspace Settings
            </Link>{" "}
            and pick the database during authorization.
          </p>
        </div>
      }
      settingsPanel={<IntegrationAiGenerationSettings provider="notion" label="Notion" />}
    />
  );
}
