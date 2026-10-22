import { RAG_EMBEDDING_DIMENSION } from "./rag.constants";

/**
 * Which AI providers can produce embeddings, and with what.
 *
 * Kept here rather than in the PROVIDER_CATALOG in legacy.service.ts on purpose. That catalog
 * is module-private, and this module deliberately does not import from LegacyService — the
 * same circular-dependency boundary rag-embedding.processor.ts documents (LegacyModule needs
 * RagIngestionService/RagRetrievalService, so nothing here may need anything back). Embedding
 * capability is also a RAG concern rather than a chat concern: it is about vector width and
 * index compatibility, not about how a chat request is shaped.
 *
 * The keys below MUST match PROVIDER_CATALOG's keys in legacy.service.ts. A provider absent
 * from this map is not an error — it means "this vendor has no embeddings endpoint", which is
 * the correct and permanent answer for Anthropic, Groq, DeepSeek, xAI and OpenRouter. Those
 * vendors serve chat only; a project using one for chat needs a second key for embeddings, and
 * that is normal rather than a misconfiguration. Nearly every production RAG stack built on
 * Claude pairs it with someone else's embeddings.
 */
export interface EmbeddingCapability {
  /** Embedding model id sent as `model` on the /v1/embeddings request. */
  model: string;
  /**
   * Native output width of `model`. Only meaningful when it differs from
   * RAG_EMBEDDING_DIMENSION — see `sendDimensionParam`.
   */
  nativeDimension: number;
  /**
   * True when the provider honours the OpenAI `dimensions` request parameter, letting a
   * natively-wider model emit exactly RAG_EMBEDDING_DIMENSION. False means the model is
   * already the right width; there is no client-side truncation fallback, because slicing a
   * non-Matryoshka embedding silently destroys its geometry and would poison the index with
   * vectors that look valid and rank nonsensically.
   */
  sendDimensionParam: boolean;
}

export const EMBEDDING_CAPABLE_PROVIDERS: Record<string, EmbeddingCapability> = {
  // 1536 native, but the v3 family is Matryoshka-trained and `dimensions` is a first-class
  // request parameter, so 1024 is a genuine re-projection rather than a truncation.
  openai: { model: "text-embedding-3-small", nativeDimension: 1536, sendDimensionParam: true },

  // Reached through Gemini's OpenAI-compatible base URL already configured in the catalog
  // (generativelanguage.googleapis.com/v1beta/openai), so it needs no wire-specific code.
  google: { model: "gemini-embedding-001", nativeDimension: 3072, sendDimensionParam: true },

  // Natively 1024 and not reducible — which is precisely why the platform standardised on
  // 1024 rather than OpenAI's 1536. See V85_embedding_dimension_1024.sql.
  mistral: { model: "mistral-embed", nativeDimension: 1024, sendDimensionParam: false }
};

// Platform-level embeddings key, read from VOYAGE_API_KEY (see resolveEmbeddingAllocation). Not in the
// map above on purpose: it is not a workspace key and has no PROVIDER_CATALOG entry, so a workspace
// cannot pick "voyage" in the AI keys form. voyage-3.5 is natively 1024 wide; Voyage's width parameter
// is `output_dimension`, not OpenAI's `dimensions`, so none is sent.
export const VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
export const VOYAGE_EMBEDDING: EmbeddingCapability = { model: "voyage-3.5", nativeDimension: 1024, sendDimensionParam: false };

/*
 * Deliberately NOT listed yet, despite having embeddings endpoints: Together AI and Fireworks.
 * Both serve open models whose exact ids and widths need verifying against their live catalogs
 * before being written down here — a wrong id here surfaces as a 404 at embed time, and a wrong
 * width silently drops every vector at the length check in rag-embedding.processor.ts. Adding
 * either is a one-line entry once confirmed.
 *
 * Self-hosted Ollama is a deliberate follow-up, not an omission: mxbai-embed-large and bge-m3
 * are both natively 1024 and would slot straight in, but shipping it means a compose service and
 * a model-pull step, which is its own piece of work.
 */

export function embeddingCapability(provider: string): EmbeddingCapability | null {
  return EMBEDDING_CAPABLE_PROVIDERS[String(provider || "").trim().toLowerCase()] ?? null;
}

export function supportsEmbeddings(provider: string): boolean {
  return embeddingCapability(provider) !== null;
}

/** Provider keys that can embed, lowercase — for SQL filters and user-facing hints. */
export function embeddingCapableProviderKeys(): string[] {
  return Object.keys(EMBEDDING_CAPABLE_PROVIDERS);
}

/**
 * The width a provider will actually emit for our configured model. Used by the processor to
 * reject a vector that does not match, rather than storing one that the HNSW index cannot
 * compare against.
 */
export function expectedDimension(capability: EmbeddingCapability): number {
  return capability.sendDimensionParam ? RAG_EMBEDDING_DIMENSION : capability.nativeDimension;
}
