"use client";

import { ProjectIntegrationMapping } from "@/components/integrations/ProjectIntegrationMapping";
import { IntegrationAiGenerationSettings } from "@/components/integrations/IntegrationAiGenerationSettings";
import { getLinearStatus, listLinearTeams, connectLinearTeams } from "@/lib/api";

export default function LinearProjectIntegrationPage() {
  return (
    <ProjectIntegrationMapping
      provider="linear"
      label="Linear"
      remoteUnitLabel="Linear team"
      workspaceConfigHref="/settings/integrations/linear"
      fetchStatus={getLinearStatus}
      fetchRemoteList={listLinearTeams}
      saveMapping={connectLinearTeams}
      settingsPanel={<IntegrationAiGenerationSettings provider="linear" label="Linear" />}
    />
  );
}
