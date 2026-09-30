import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { tracedEmbeddingCall } from "../observability/embedding-trace";
import { EmbeddingKeyAllocation, embedTexts, resolveEmbeddingAllocation } from "./rag-ai-allocation";
import { RagChunkingService } from "./rag-chunking.service";
import {
  RAG_ANN_CANDIDATES,
  RAG_CONFIDENT_SIMILARITY,
  RAG_CONTEXT_CHAR_BUDGET,
  RAG_FTS_CANDIDATES,
  RAG_FTS_MAX_REQUIRED_TERMS,
  RAG_FTS_MIN_TERM_COVERAGE,
  RAG_MAX_SOURCES,
  RAG_MIN_SIMILARITY,
  RAG_PASSAGE_CHARS,
  RAG_QUERY_BOILERPLATE,
  RAG_RRF_K,
  TESTCASE_SIMILARITY_THRESHOLD
} from "./rag.constants";
import { RagRetrievalConfidence, RagSourceType, RetrievedKnowledgeItem, SimilarTestcaseMatch } from "./rag.types";

interface TestcaseAnnRow {
  testcase_id: string;
  cosine_similarity: number;
}

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
  // Set only for a source that reached fusion through keyword search alone (no ANN chunk): the
  // whole document text, narrowed to its relevant passages by focusSources before budgeting.
  fullText?: string;
}

// The request's content terms, as Postgres 'english' lexemes, and the OR query built from them.
interface KeywordQuery {
  terms: string[];
  tsquery: string;
  minMatchedTerms: number;
}

// Optional Langfuse trace anchor for the query-embedding call this retrieval makes. Both fields
// are best-effort: when neither is set (the default — most callers of this service predate
// tracing and are unaffected), the embeddings call still happens exactly as before, just untraced.
// See tracedEmbeddingCall (observability/embedding-trace.ts) for traceId vs traceSeed precedence.
interface RetrievalTraceOpts {
  traceId?: string | null;
  traceSeed?: string | null;
}

type RetrievalOpts = { maxSources?: number; charBudget?: number } & RetrievalTraceOpts;

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
  // Pure text -> chunks, no dependencies — instantiated directly rather than injected so this
  // service's constructor (and every `new RagRetrievalService(db)` in its specs) stays unchanged.
  private readonly chunker = new RagChunkingService();

  constructor(private readonly db: DatabaseService) {}

  async retrieveKnowledgeContext(projectId: string, query: string, opts: RetrievalOpts = {}): Promise<RetrievedKnowledgeItem[]> {
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
    opts: RetrievalOpts = {}
  ): Promise<{ items: RetrievedKnowledgeItem[]; semanticSearchRan: boolean; reason: string; topScore: number | null; confidence: RagRetrievalConfidence }> {
    let reason = "";
    try {
      const text = String(query || "").trim();
      if (!text) return { items: [], semanticSearchRan: false, reason: "Empty query.", topScore: null, confidence: "none" };

      const [resolved, keyword] = await Promise.all([resolveEmbeddingAllocation(this.db, projectId), this.keywordQuery(text)]);
      reason = resolved.reason;
      const allocation = resolved.allocation;

      const [annRowsRaw, ftsDocRows, ftsFileRows] = await Promise.all([
        allocation ? this.annSearch(projectId, allocation, text, { traceId: opts.traceId, traceSeed: opts.traceSeed }) : Promise.resolve([] as AnnRow[]),
        keyword ? this.ftsSearch(projectId, "knowledge_documents", "content_text", keyword) : Promise.resolve([] as FtsRow[]),
        keyword ? this.ftsSearch(projectId, "knowledge_files", "extracted_text", keyword) : Promise.resolve([] as FtsRow[])
      ]);
      // Reported honestly even when every candidate gets filtered below — "we searched and the best
      // match scored 0.31" is a real, useful signal, distinct from "no candidates existed at all".
      const topScore = annRowsRaw.length ? Math.max(...annRowsRaw.map((row) => row.cosine_similarity)) : null;
      // A keyword match now has to hit a real share of the request's content terms (see ftsSearch),
      // so it is at least a loose match — never "none", which the drafting prompt reads as "nothing
      // was found, write from general practice". That reading is what turned a document that
      // literally stated the requirement into a generic test case: with no embeddings key in any
      // workspace, keyword search is the only retrieval that runs, and it was always graded "none".
      const semanticConfidence = this.confidenceFor(topScore);
      const confidence: RagRetrievalConfidence = semanticConfidence === "none" && (ftsDocRows.length || ftsFileRows.length) ? "weak" : semanticConfidence;
      // The relevance floor: RRF's own score is a rank position, not a magnitude (see
      // RAG_MIN_SIMILARITY's own comment), so a weak candidate pool must be excluded here, before
      // fusion, or it fills the context budget indistinguishably from a strong one.
      const annRows = annRowsRaw.filter((row) => row.cosine_similarity >= RAG_MIN_SIMILARITY);
      if (!annRows.length && !ftsDocRows.length && !ftsFileRows.length) {
        return { items: [], semanticSearchRan: Boolean(allocation), reason, topScore, confidence };
      }

      const maxSources = opts.maxSources ?? RAG_MAX_SOURCES;
      const fused = this.fuse(annRows, [...ftsDocRows, ...ftsFileRows]).slice(0, maxSources);
      await this.focusSources(fused, keyword);
      return {
        items: this.budgetToItems(fused, maxSources, opts.charBudget ?? RAG_CONTEXT_CHAR_BUDGET),
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

  /**
   * Test-case-to-test-case semantic similarity — the ANN half of retrieveWithDiagnostics, aimed
   * at a second collection (testcase_embeddings) instead of knowledge_document_chunks. No FTS
   * half and no RRF fusion: unlike KB retrieval, there is no keyword-search fallback for this
   * (existingTestcaseSnapshot's keyword matching is a separate, pre-existing mechanism — see
   * legacy.service.ts — not something this method fuses with), and there is exactly one
   * candidate collection to rank, so there is nothing to fuse.
   *
   * Called from zyraSimilarityFeedbackForDrafts (legacy.service.ts), which feeds a match back to
   * the drafting model as advisory context (see TESTCASE_SIMILARITY_THRESHOLD, rag.constants.ts) —
   * not yet wired into a backend-side Update-vs-Add reclassification (ZYRA_TICKET_WORKFLOW.md §10),
   * which stays a separate, later step by design.
   *
   * Same never-throws contract as retrieveWithDiagnostics: any failure (no embedding allocation,
   * nothing embedded yet, embeddings API error) resolves to an empty match list.
   */
  async findSimilarTestcases(
    projectId: string,
    queryText: string,
    opts: { excludeTestcaseId?: string; limit?: number } & RetrievalTraceOpts = {}
  ): Promise<{ matches: SimilarTestcaseMatch[]; semanticSearchRan: boolean; reason: string }> {
    let reason = "";
    try {
      const text = String(queryText || "").trim();
      if (!text) return { matches: [], semanticSearchRan: false, reason: "Empty query." };

      const resolved = await resolveEmbeddingAllocation(this.db, projectId);
      reason = resolved.reason;
      if (!resolved.allocation) return { matches: [], semanticSearchRan: false, reason };

      const rows = await this.annSearchTestcases(projectId, resolved.allocation, text, opts.excludeTestcaseId, {
        traceId: opts.traceId,
        traceSeed: opts.traceSeed
      });
      const matches = rows
        .filter((row) => row.cosine_similarity >= TESTCASE_SIMILARITY_THRESHOLD)
        .slice(0, opts.limit ?? RAG_ANN_CANDIDATES)
        .map((row) => ({ testcaseId: row.testcase_id, cosineSimilarity: row.cosine_similarity }));
      return { matches, semanticSearchRan: true, reason };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`findSimilarTestcases failed for project ${projectId}: ${message}`);
      return { matches: [], semanticSearchRan: false, reason: reason || `Retrieval failed: ${message}` };
    }
  }

  private async annSearchTestcases(
    projectId: string,
    allocation: EmbeddingKeyAllocation,
    query: string,
    excludeTestcaseId?: string,
    traceOpts: RetrievalTraceOpts = {}
  ): Promise<TestcaseAnnRow[]> {
    const [queryVector] = await tracedEmbeddingCall(
      {
        traceId: traceOpts.traceId,
        traceSeed: traceOpts.traceSeed,
        name: "testcase-query-embedding",
        projectId,
        provider: allocation.provider,
        model: allocation.model,
        inputCount: 1,
        inputSample: query
      },
      () => embedTexts(allocation, [query])
    );
    if (!queryVector) return [];
    const vectorLiteral = `[${queryVector.join(",")}]`;
    // Same literal `e.project_id = $1` partition-pruning rationale as annSearch() below, and the
    // same reason a soft-deleted test case's embedding row must be excluded via the join rather
    // than relying on testcase_embeddings alone to stay clean (deletes are ON DELETE CASCADE only
    // for a hard delete; soft-delete via deleted_at never touches testcase_embeddings).
    const res = await this.db.query<TestcaseAnnRow>(
      `SELECT e.testcase_id, 1 - (e.embedding <=> $2::vector) AS cosine_similarity
       FROM testcase_embeddings e
       JOIN testcases t ON t.id = e.testcase_id AND t.deleted_at IS NULL
       WHERE e.project_id = $1 ${excludeTestcaseId ? "AND e.testcase_id != $3" : ""}
       ORDER BY e.embedding <=> $2::vector
       LIMIT ${RAG_ANN_CANDIDATES}`,
      excludeTestcaseId ? [projectId, vectorLiteral, excludeTestcaseId] : [projectId, vectorLiteral]
    );
    return res.rows;
  }

  private async annSearch(projectId: string, allocation: EmbeddingKeyAllocation, query: string, traceOpts: RetrievalTraceOpts = {}): Promise<AnnRow[]> {
    const [queryVector] = await tracedEmbeddingCall(
      {
        traceId: traceOpts.traceId,
        traceSeed: traceOpts.traceSeed,
        name: "kb-query-embedding",
        projectId,
        provider: allocation.provider,
        model: allocation.model,
        inputCount: 1,
        inputSample: query
      },
      () => embedTexts(allocation, [query])
    );
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

  /**
   * The request's content terms, stemmed by Postgres itself so they line up exactly with each
   * document's search_vector, minus the words that describe the request rather than the product
   * (RAG_QUERY_BOILERPLATE). Null when nothing is left to search on ("generate test cases").
   *
   * This replaced plainto_tsquery, which ANDs every word of the message: "Generate test cases for
   * session timeout" required a document to contain "generate", "test", "case" AND "timeout", so a
   * doc stating "sessions expire after 20 minutes" was never found and retrieval fell back to the
   * 12 most recently edited documents. Never throws — a failure here just skips keyword search.
   */
  private async keywordQuery(text: string): Promise<KeywordQuery | null> {
    const res = await this.db
      .query<{ terms: string[] | null; boilerplate: string[] | null }>(
        "SELECT tsvector_to_array(to_tsvector('english', $1)) AS terms, tsvector_to_array(to_tsvector('english', $2)) AS boilerplate",
        [text, RAG_QUERY_BOILERPLATE.join(" ")]
      )
      .catch(() => ({ rows: [] as Array<{ terms: string[] | null; boilerplate: string[] | null }> }));
    const boilerplate = new Set(res.rows[0]?.boilerplate ?? []);
    const terms = (res.rows[0]?.terms ?? []).filter((term) => term && !boilerplate.has(term));
    if (!terms.length) return null;
    return {
      terms,
      tsquery: terms.map(RagRetrievalService.quoteLexeme).join(" | "),
      minMatchedTerms: Math.min(RAG_FTS_MAX_REQUIRED_TERMS, Math.max(1, Math.ceil(terms.length * RAG_FTS_MIN_TERM_COVERAGE)))
    };
  }

  // A lexeme as a quoted tsquery operand. Cast with ::tsquery (not to_tsquery) so an already-stemmed
  // lexeme is not stemmed a second time; quotes and backslashes are the only characters that need
  // escaping inside the quotes.
  private static quoteLexeme(term: string): string {
    return `'${term.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }

  private async ftsSearch(projectId: string, table: "knowledge_documents" | "knowledge_files", contentColumn: string, keyword: KeywordQuery): Promise<FtsRow[]> {
    const titleColumn = table === "knowledge_documents" ? "title" : "original_file_name";
    const approvalFilter = table === "knowledge_documents" ? "AND (document_type != 'ai_memory' OR status = 'approved')" : "";
    const sourceType: RagSourceType = table === "knowledge_documents" ? "document" : "file";
    // Any-term match (served by the GIN index), then a coverage floor so one shared common word
    // isn't enough, then ranked — ts_rank on an OR query rewards documents matching more terms.
    const res = await this.db
      .query<{ id: string; title: string; content: string; rank: number }>(
        `SELECT id, ${titleColumn} AS title, ${contentColumn} AS content, ts_rank(search_vector, $2::tsquery) AS rank
         FROM ${table}
         WHERE project_id = $1 AND is_deleted = false ${approvalFilter}
           AND search_vector @@ $2::tsquery
           AND (SELECT count(*) FROM unnest($3::text[]) AS t(term) WHERE search_vector @@ t.term::tsquery) >= $4
         ORDER BY rank DESC LIMIT ${RAG_FTS_CANDIDATES}`,
        [projectId, keyword.tsquery, keyword.terms.map(RagRetrievalService.quoteLexeme), keyword.minMatchedTerms]
      )
      .catch(() => ({ rows: [] as Array<{ id: string; title: string; content: string; rank: number }> }));
    return res.rows.map((row) => ({ source_type: sourceType, source_id: row.id, title: row.title, content: row.content, rank: row.rank }));
  }

  /**
   * Narrows each keyword-only source to the passages that match the request, in place. A source
   * found by ANN already carries its matching chunks and is left alone.
   */
  private async focusSources(sources: FusedSource[], keyword: KeywordQuery | null): Promise<void> {
    const pending = sources.filter((source) => source.fullText !== undefined);
    if (!pending.length) return;
    const passages = await this.selectPassages(pending.map((source) => source.fullText as string), keyword);
    pending.forEach((source, i) => {
      source.chunks = passages[i];
    });
  }

  /**
   * For callers holding whole documents they did not find through search — an explicit picker
   * selection, a folder named in the message: each document narrowed to the passages most
   * relevant to `query`, within RAG_PASSAGE_CHARS. Replaces a flat `content.slice(0, 1500)`, which
   * dropped every requirement stated after a document's opening. Never throws.
   */
  async focusOnQuery(contents: string[], query: string): Promise<string[]> {
    const keyword = String(query || "").trim() ? await this.keywordQuery(String(query).trim()) : null;
    const passages = await this.selectPassages(contents, keyword);
    return passages.map((chosen) => chosen.map((passage) => passage.content).join("\n...\n"));
  }

  /**
   * Splits each text with the same chunker the embedding pipeline uses, scores every chunk against
   * the request in Postgres (same 'english' stemming as the search itself), and keeps the
   * best-scoring chunks up to RAG_PASSAGE_CHARS, back in document order. A text already within
   * that size is passed whole. With no query terms, or no chunk matching any, or a failed scoring
   * query, this degrades to the text's opening — exactly the previous behaviour.
   */
  private async selectPassages(texts: string[], keyword: KeywordQuery | null): Promise<Array<Array<{ content: string; headingPath: string | null }>>> {
    // The chunker strips heading lines into headingPath; they go back in front of the passage because
    // a heading is often what gives a bare value its meaning ("Password rules" over "8 to 64 characters").
    const chunked = texts.map((text) => {
      const value = String(text || "");
      if (value.length <= RAG_PASSAGE_CHARS) return null;
      const chunks = this.chunker.chunk(value).map((chunk) => ({
        headingPath: chunk.headingPath,
        body: chunk.headingPath ? `${chunk.headingPath}\n${chunk.content}` : chunk.content
      }));
      return chunks.length ? chunks : null;
    });
    const opening = (text: string) => [{ content: String(text || "").slice(0, RAG_PASSAGE_CHARS), headingPath: null }];

    const ranks = new Map<string, number>();
    if (keyword && chunked.some(Boolean)) {
      const sourceIdx: number[] = [];
      const chunkIdx: number[] = [];
      const bodies: string[] = [];
      chunked.forEach((chunks, s) => chunks?.forEach((chunk, c) => {
        sourceIdx.push(s);
        chunkIdx.push(c);
        bodies.push(chunk.body);
      }));
      const res = await this.db
        .query<{ s: number; c: number; rank: number }>(
          `SELECT x.s, x.c, ts_rank(to_tsvector('english', x.body), $4::tsquery) AS rank
           FROM unnest($1::int[], $2::int[], $3::text[]) AS x(s, c, body)`,
          [sourceIdx, chunkIdx, bodies, keyword.tsquery]
        )
        .catch((err) => {
          this.logger.warn(`Passage ranking failed, falling back to each document's opening: ${err instanceof Error ? err.message : err}`);
          return { rows: [] as Array<{ s: number; c: number; rank: number }> };
        });
      for (const row of res.rows) ranks.set(`${row.s}:${row.c}`, Number(row.rank));
    }

    return texts.map((text, s) => {
      const chunks = chunked[s];
      if (!chunks) return String(text || "").length <= RAG_PASSAGE_CHARS ? [{ content: String(text || ""), headingPath: null }] : opening(text);
      const scored = chunks.map((chunk, c) => ({ chunk, c, rank: ranks.get(`${s}:${c}`) ?? 0 })).filter((entry) => entry.rank > 0);
      if (!scored.length) return opening(text);
      scored.sort((a, b) => b.rank - a.rank || a.c - b.c);
      const chosen: typeof scored = [];
      let used = 0;
      for (const entry of scored) {
        if (chosen.length && used + entry.chunk.body.length > RAG_PASSAGE_CHARS) continue;
        chosen.push(entry);
        used += entry.chunk.body.length;
      }
      return chosen
        .sort((a, b) => a.c - b.c)
        .map((entry) => ({ content: entry.chunk.body.slice(0, RAG_PASSAGE_CHARS), headingPath: entry.chunk.headingPath }));
    });
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
      // Whole text kept for focusSources to narrow to the matching passages — not the first 1500
      // characters, which is where a requirement stated later in the document used to get dropped.
      if (!existing.chunks.length) existing.fullText = String(row.content || "");
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
