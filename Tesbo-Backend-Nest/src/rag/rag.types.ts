export type RagSourceType = "document" | "file";

export interface EmbeddingJobPayload {
  organizationId: string;
  projectId: string;
  sourceType: RagSourceType;
  sourceId: string;
  reason: "created" | "updated" | "transcribed" | "reindex";
}

// No organizationId — unlike knowledge_documents/knowledge_files, testcases has no
// organization_id column at all (only project_id), and testcase_embeddings mirrors that.
export interface TestcaseEmbeddingJobPayload {
  projectId: string;
  testcaseId: string;
  reason: "created" | "updated" | "reindex";
}

// Returned by RagRetrievalService.findSimilarTestcases — not consumed anywhere yet.
export interface SimilarTestcaseMatch {
  testcaseId: string;
  cosineSimilarity: number;
}

export interface RagChunk {
  chunkIndex: number;
  headingPath: string | null;
  content: string;
  tokenCount: number;
}

export interface RetrievedKnowledgeItem {
  title: string;
  content: string;
  citation: { sourceType: RagSourceType; sourceId: string; headingPath: string | null };
  score: number;
}

// "none": no semantic score to judge by (ANN never ran, or nothing cleared RAG_MIN_SIMILARITY) —
// any items present came from keyword (FTS) matching alone.
// "weak": the top semantic match cleared RAG_MIN_SIMILARITY but not RAG_CONFIDENT_SIMILARITY.
// "strong": the top semantic match cleared RAG_CONFIDENT_SIMILARITY.
export type RagRetrievalConfidence = "none" | "weak" | "strong";
