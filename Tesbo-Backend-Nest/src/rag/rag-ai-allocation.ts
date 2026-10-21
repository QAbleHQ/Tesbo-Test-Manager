import { safeFetch } from "../common/safe-fetch";
import { DatabaseService } from "../database/database.service";
import { EmbeddingCapability, embeddingCapability, embeddingCapableProviderKeys, expectedDimension } from "./rag-embedding-providers";
import { RAG_EMBEDDING_DIMENSION } from "./rag.constants";

export interface EmbeddingKeyAllocation {
  provider: string;
  api_key: string;
  base_url: string | null;
  auth_header_name: string | null;
  auth_scheme: string | null;
  /** Embedding model id for this provider, from the capability registry — not the chat model. */
  model: string;
  /** Width this allocation will emit. Checked against every returned vector before storage. */
  dimension: number;
  /** Whether to send the OpenAI `dimensions` parameter to reduce a natively-wider model. */
  sendDimensionParam: boolean;
}

/**
 * Why retrieval could or could not embed. Returned instead of a bare null because a bare null
 * was indistinguishable from "the knowledge base had nothing relevant" — which is how semantic
 * retrieval stayed switched off in production, across every project, without a single alert.
 *
 * Mirrors the { key, reason } shape LegacyService.zyraAiAllocation already uses for chat keys,
 * so both allocation failures explain themselves the same way.
 */
export interface EmbeddingAllocationResult {
  allocation: EmbeddingKeyAllocation | null;
  reason: string;
}

interface KeyRow {
  provider: string;
  api_key: string;
  base_url: string | null;
  auth_header_name: string | null;
  auth_scheme: string | null;
  is_active: boolean;
}

function toAllocation(row: KeyRow, capability: EmbeddingCapability): EmbeddingKeyAllocation {
  return {
    provider: row.provider,
    api_key: row.api_key,
    base_url: row.base_url,
    auth_header_name: row.auth_header_name,
    auth_scheme: row.auth_scheme,
    model: capability.model,
    dimension: expectedDimension(capability),
    sendDimensionParam: capability.sendDimensionParam
  };
}

/**
 * Resolves a key capable of producing embeddings for this project, in three tiers:
 *
 *   1. The project's own allocated AI key, when its provider can embed. Nothing is asked of
 *      the user — the common case for an OpenAI/Gemini/Mistral project.
 *   2. Any other active embeddings-capable key in the same organization. This is what makes an
 *      Anthropic-for-chat project work: Claude keeps answering, and a second key — added once,
 *      at workspace level — supplies the vectors. Embeddings and chat are independent services
 *      and never had to come from the same vendor.
 *   3. Nothing available. Returns a reason for the caller to surface, never silence.
 *
 * Tier 2 deliberately reads the organization's keys rather than requiring a second explicit
 * per-project allocation: the allocation table exists to choose which *chat* model a project
 * talks to, a decision that has no bearing on which vector space its documents live in. Adding
 * a second allocation UI to express "and use this one for maths" would be ceremony, not safety.
 */
export async function resolveEmbeddingAllocation(db: DatabaseService, projectId: string): Promise<EmbeddingAllocationResult> {
  // Tier 1 — the project's own allocated key.
  const allocatedRes = await db.query<KeyRow & { name: string }>(
    `SELECT k.name, k.provider, k.api_key, k.base_url, k.auth_header_name, k.auth_scheme, k.is_active
     FROM project_ai_key_allocations a
     JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
     WHERE a.project_id = $1`,
    [projectId]
  );
  const allocated = allocatedRes.rows[0];
  if (allocated?.is_active) {
    const capability = embeddingCapability(allocated.provider);
    if (capability) {
      return { allocation: toAllocation(allocated, capability), reason: `Using the project's ${allocated.provider} key for embeddings.` };
    }
  }

  // Tier 2 — any other embeddings-capable key in the same organization.
  const orgRes = await db.query<{ organization_id: string }>("SELECT organization_id FROM projects WHERE id = $1", [projectId]);
  const organizationId = orgRes.rows[0]?.organization_id;
  if (!organizationId) {
    return { allocation: null, reason: "Project was not found while resolving an embeddings key." };
  }

  const capableProviders = embeddingCapableProviderKeys();
  const fallbackRes = await db.query<KeyRow>(
    `SELECT k.provider, k.api_key, k.base_url, k.auth_header_name, k.auth_scheme, k.is_active
     FROM workspace_ai_keys k
     WHERE k.organization_id = $1
       AND k.is_active = true
       AND lower(k.provider) = ANY($2::text[])
     ORDER BY k.created_at ASC
     LIMIT 1`,
    [organizationId, capableProviders]
  );
  const fallback = fallbackRes.rows[0];
  if (fallback) {
    const capability = embeddingCapability(fallback.provider);
    if (capability) {
      return {
        allocation: toAllocation(fallback, capability),
        reason: `The project's chat provider cannot embed, so the workspace ${fallback.provider} key is supplying embeddings.`
      };
    }
  }

  // Tier 3 — nothing available. Say which, and say what would fix it.
  const capableLabel = capableProviders.join(", ");
  if (allocated && !allocated.is_active) {
    return { allocation: null, reason: `The AI key "${allocated.name}" allocated to this project is inactive, and no other embeddings-capable key is available. Semantic search is off; Zyra is searching by keyword only.` };
  }
  if (allocated) {
    return {
      allocation: null,
      reason: `${allocated.provider} does not provide an embeddings endpoint, and this workspace has no embeddings-capable key. Add one (${capableLabel}) in Workspace → AI keys to turn on semantic search. Until then Zyra searches by keyword only.`
    };
  }
  return {
    allocation: null,
    reason: `No AI key is allocated to this project and this workspace has no embeddings-capable key (${capableLabel}). Semantic search is off; Zyra is searching by keyword only.`
  };
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function normalizeEmbeddingsUrl(baseUrl?: string | null): string {
  const value = String(baseUrl || "").trim();
  if (!value) return "https://api.openai.com/v1/embeddings";
  const trimmed = trimTrailingSlashes(value);
  if (trimmed.endsWith("/embeddings")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/embeddings`;
  return `${trimmed}/v1/embeddings`;
}

export async function embedTexts(allocation: EmbeddingKeyAllocation, inputs: string[]): Promise<number[][]> {
  const authHeader = String(allocation.auth_header_name || "Authorization");
  const scheme = String(allocation.auth_scheme || "Bearer").trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers[authHeader] = scheme ? `${scheme} ${allocation.api_key}` : String(allocation.api_key);

  const body: Record<string, unknown> = { model: allocation.model, input: inputs };
  // Only sent where the provider honours it. Sending it to a provider that does not (Mistral)
  // is not harmlessly ignored everywhere — some reject an unknown field outright.
  if (allocation.sendDimensionParam) body.dimensions = RAG_EMBEDDING_DIMENSION;

  const res = await safeFetch(normalizeEmbeddingsUrl(allocation.base_url), {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
    const rawMessage = typeof errBody.error === "string" ? errBody.error : errBody.error?.message || String(res.status);
    throw new Error(rawMessage);
  }
  const data = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
  return data.data.sort((a, b) => a.index - b.index).map((row) => row.embedding);
}
