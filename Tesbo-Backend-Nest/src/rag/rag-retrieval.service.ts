import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { EmbeddingKeyAllocation, embedTexts, resolveEmbeddingAllocation } from "./rag-ai-allocation";
import {
  RAG_ANN_CANDIDATES,
  RAG_CONFIDENT_SIMILARITY,
  RAG_CONTEXT_CHAR_BUDGET,
  RAG_FTS_CANDIDATES,
  RAG_MAX_SOURCES,
  RAG_MIN_SIMILARITY,
  RAG_RRF_K
} from "./rag.constants";
import { RagRetrievalConfidence, RagSourceType, RetrievedKnowledgeItem } from "./rag.types";

interface AnnRow {
  source_type: RagSourceType;
  source_id: string;
  heading_path: string | null;
  content: string;
  title: string;
  cosine_similarity: number;
}

interface FtsRow {
  source_type: RagSourceType;
  source_id: string;
  title: string;
  content: string;
  rank: number;
}

interface FusedSource {
  key: string;
  sourceType: RagSourceType;
  sourceId: string;
  title: string;
  score: number;
  chunks: Array<{ content: string; headingPath: string | null }>;
}

// Hybrid retrieval for Zyra's free-text chat path: vector similarity (ANN) fused with keyword
// full-text search. Does NOT replace knowledgeSnapshot() (that stays for the explicit-picker
// task-generation flow — a named-document lookup, not semantic search).
//
// Never throws: any failure (no embedding allocation, nothing embedded yet, embeddings API
// error) resolves to [] so the caller's existing knowledgeSnapshot() fallback stays clean. Note
// that only the ANN half depends on an embeddings key — the FTS half runs regardless, so a
// workspace with no embeddings key degrades to keyword-only matching rather than to nothing.
// That degradation is invisible through retrieveKnowledgeContext() by design; use
// retrieveWithDiagnostics() when a human needs to know which half ran.
@Injectable()
export class RagRetrievalService {
  private readonly logger = new Logger(RagRetrievalService.name);

  constructor(private readonly db: DatabaseService) {}

  async retrieveKnowledgeContext(projectId: string, query: string, opts: { maxSources?: number; charBudget?: number } = {}): Promise<RetrievedKnowledgeItem[]> {
    return (await this.retrieveWithDiagnostics(projectId, query, opts)).items;
  }

  /**
   * Same retrieval, but says whether the semantic half actually ran.
   *
   * retrieveKnowledgeContext() returns [] for every failure mode, which is right for callers
   * that just want context and wrong for anyone trying to understand the system: "no embeddings
   * key in the workspace" and "the knowledge base has nothing on this topic" produced an
   * identical empty array. That is how semantic search stayed off across every project in
   * production without a single alert. Callers that surface state to a human should use this.
   */
  async retrieveWithDiagnostics(
    projectId: string,
    query: string,
    opts: { maxSources?: number; charBudget?: number } = {}
  ): Promise<{ items: RetrievedKnowledgeItem[]; semanticSearchRan: boolean; reason: string; topScore: number | null; confidence: RagRetrievalConfidence }> {
    let reason = "";
    try {
      const text = String(query || "").trim();
      if (!text) return { items: [], semanticSearchRan: false, reason: "Empty query.", topScore: null, confidence: "none" };

      const resolved = await resolveEmbeddingAllocation(this.db, projectId);
      reason = resolved.reason;
      const allocation = resolved.allocation;

      const [annRowsRaw, ftsDocRows, ftsFileRows] = await Promise.all([
        allocation ? this.annSearch(projectId, allocation, text) : Promise.resolve([] as AnnRow[]),
        this.ftsSearch(projectId, "knowledge_documents", "content_text", text),
        this.ftsSearch(projectId, "knowledge_files", "extracted_text", text)
      ]);
      // Reported honestly even when every candidate gets filtered below — "we searched and the best
      // match scored 0.31" is a real, useful signal, distinct from "no candidates existed at all".
      const topScore = annRowsRaw.length ? Math.max(...annRowsRaw.map((row) => row.cosine_similarity)) : null;
      const confidence = this.confidenceFor(topScore);
      // The relevance floor: RRF's own score is a rank position, not a magnitude (see
      // RAG_MIN_SIMILARITY's own comment), so a weak candidate pool must be excluded here, before
      // fusion, or it fills the context budget indistinguishably from a strong one.
      const annRows = annRowsRaw.filter((row) => row.cosine_similarity >= RAG_MIN_SIMILARITY);
      if (!annRows.length && !ftsDocRows.length && !ftsFileRows.length) {
        return { items: [], semanticSearchRan: Boolean(allocation), reason, topScore, confidence };
      }

      const fused = this.fuse(annRows, [...ftsDocRows, ...ftsFileRows]);
      return {
        items: this.budgetToItems(fused, opts.maxSources ?? RAG_MAX_SOURCES, opts.charBudget ?? RAG_CONTEXT_CHAR_BUDGET),
        semanticSearchRan: Boolean(allocation),
        reason,
        topScore,
        confidence
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`retrieveKnowledgeContext failed for project ${projectId}: ${message}`);
      return { items: [], semanticSearchRan: false, reason: reason || `Retrieval failed: ${message}`, topScore: null, confidence: "none" };
    }
  }

  private confidenceFor(topScore: number | null): RagRetrievalConfidence {
    if (topScore === null) return "none";
    if (topScore >= RAG_CONFIDENT_SIMILARITY) return "strong";
    if (topScore >= RAG_MIN_SIMILARITY) return "weak";
    return "none";
  }

  private async annSearch(projectId: string, allocation: EmbeddingKeyAllocation, query: string): Promise<AnnRow[]> {
    const [queryVector] = await embedTexts(allocation, [query]);
    if (!queryVector) return [];
    const vectorLiteral = `[${queryVector.join(",")}]`;
    // The literal `c.project_id = $1` equality is what lets Postgres prune straight to one
    // of the 64 hash partitions before touching that partition's HNSW index.
    const res = await this.db.query<AnnRow>(
      `SELECT c.source_type, c.source_id, c.heading_path, c.content,
              COALESCE(d.title, f.original_file_name) AS title,
              1 - (c.embedding <=> $2::vector) AS cosine_similarity
       FROM knowledge_document_chunks c
       LEFT JOIN knowledge_documents d ON c.source_type = 'document' AND d.id = c.source_id
         AND d.is_deleted = false AND (d.document_type != 'ai_memory' OR d.status = 'approved')
       LEFT JOIN knowledge_files f ON c.source_type = 'file' AND f.id = c.source_id AND f.is_deleted = false
       WHERE c.project_id = $1 AND (d.id IS NOT NULL OR f.id IS NOT NULL)
       ORDER BY c.embedding <=> $2::vector
       LIMIT ${RAG_ANN_CANDIDATES}`,
      [projectId, vectorLiteral]
    );
    return res.rows;
  }

  private async ftsSearch(projectId: string, table: "knowledge_documents" | "knowledge_files", contentColumn: string, query: string): Promise<FtsRow[]> {
    const titleColumn = table === "knowledge_documents" ? "title" : "original_file_name";
    const approvalFilter = table === "knowledge_documents" ? "AND (document_type != 'ai_memory' OR status = 'approved')" : "";
    const sourceType: RagSourceType = table === "knowledge_documents" ? "document" : "file";
    const res = await this.db
      .query<{ id: string; title: string; content: string; rank: number }>(
        `SELECT id, ${titleColumn} AS title, ${contentColumn} AS content, ts_rank(search_vector, plainto_tsquery('english', $2)) AS rank
         FROM ${table}
         WHERE project_id = $1 AND is_deleted = false ${approvalFilter}
           AND search_vector @@ plainto_tsquery('english', $2)
         ORDER BY rank DESC LIMIT ${RAG_FTS_CANDIDATES}`,
        [projectId, query]
      )
      .catch(() => ({ rows: [] as Array<{ id: string; title: string; content: string; rank: number }> }));
    return res.rows.map((row) => ({ source_type: sourceType, source_id: row.id, title: row.title, content: row.content, rank: row.rank }));
  }

  // Reciprocal rank fusion in application code (not SQL — ANN rows are chunk-level, FTS rows
  // are document-level, so reconciling in a UNION/CTE would be messier than a few lines here).
  private fuse(annRows: AnnRow[], ftsRows: FtsRow[]): FusedSource[] {
    const bySource = new Map<string, FusedSource>();

    const annRanked = [...annRows].sort((a, b) => b.cosine_similarity - a.cosine_similarity);
    annRanked.forEach((row, rank) => {
      const key = `${row.source_type}:${row.source_id}`;
      const existing = bySource.get(key) || { key, sourceType: row.source_type, sourceId: row.source_id, title: row.title, score: 0, chunks: [] };
      existing.score += 1 / (RAG_RRF_K + rank + 1);
      existing.chunks.push({ content: row.content, headingPath: row.heading_path });
      bySource.set(key, existing);
    });

    ftsRows.forEach((row, rank) => {
      const key = `${row.source_type}:${row.source_id}`;
      const existing = bySource.get(key) || { key, sourceType: row.source_type, sourceId: row.source_id, title: row.title, score: 0, chunks: [] };
      existing.score += 1 / (RAG_RRF_K + rank + 1);
      if (!existing.chunks.length) existing.chunks.push({ content: row.content.slice(0, 1500), headingPath: null });
      bySource.set(key, existing);
    });

    return Array.from(bySource.values()).sort((a, b) => b.score - a.score);
  }

  private budgetToItems(fused: FusedSource[], maxSources: number, charBudget: number): RetrievedKnowledgeItem[] {
    const items: RetrievedKnowledgeItem[] = [];
    let used = 0;
    for (const source of fused.slice(0, maxSources)) {
      const content = source.chunks.map((c) => c.content).join("\n...\n");
      if (used >= charBudget) break;
      const remaining = charBudget - used;
      const trimmed = content.length > remaining ? `${content.slice(0, remaining)}...` : content;
      used += trimmed.length;
      items.push({
        title: source.title || "Untitled",
        content: trimmed,
        citation: { sourceType: source.sourceType, sourceId: source.sourceId, headingPath: source.chunks[0]?.headingPath ?? null },
        score: source.score
      });
    }
    return items;
  }
}
