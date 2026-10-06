"use client";

import { WorkspaceIntegrationConfig } from "@/components/integrations/WorkspaceIntegrationConfig";

export default function NotionWorkspaceIntegrationPage() {
  return (
    <WorkspaceIntegrationConfig
      provider="notion"
      label="Notion"
      consoleName="Notion integrations page (notion.so/profile/integrations, a public integration)"
    />
  );
}
