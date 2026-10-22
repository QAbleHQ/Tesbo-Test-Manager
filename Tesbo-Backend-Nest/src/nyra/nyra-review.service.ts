import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash } from "crypto";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import { resolveEmbeddingAllocation } from "../rag/rag-ai-allocation";
import { NyraClient } from "./nyra.client";
import { NyraService } from "./nyra.service";
import { applyEdit, buildProductDocument, DOC_KINDS, isDocKind, isKind, KIND_LABEL, renderDocument, sameFinding, STORY_KINDS, type DocKind, type NyraKind } from "./nyra-review";

type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = new Set(["queued", "running"]);
const KEY_MAX = 500;
const BULK_MAX = 500;
const FOLDER_NAME = "NYRA";
// The one Knowledge Base document per NYRA project. Rows of any other kind come from the earlier
// one-document-per-kind approach: they are left alone (never deleted, it is a person's Knowledge Base)
// and no longer updated.
const PRODUCT = "product";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bad = (error: string) => new BadRequestException({ error });
const notReviewed = (kind: NyraKind) => `${KIND_LABEL[kind]} are not reviewed: they stay in the report and are not added to the Knowledge Base.`;

/** Findings review and approval into the Knowledge Base. Decisions live in Tesbo; NYRA is only read. */
@Injectable()
export class NyraReviewService {
  private readonly logger = new Logger(NyraReviewService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly client: NyraClient,
    private readonly nyra: NyraService,
    private readonly legacy: LegacyService
  ) {}

  private runId(raw: string): string {
    if (!UUID.test(raw)) throw new NotFoundException({ error: "Run not found" });
    return raw;
  }

  /** NYRA saves a scan's findings only when it ends, so there is nothing to review before then. */
  private async finishedItems(nyraId: string, runId: string): Promise<Row[]> {
    const run = await this.client.json("GET", `/projects/${nyraId}/runs/${runId}`);
    if (!run?.id) throw new NotFoundException({ error: "Run not found" });
    if (ACTIVE.has(String(run.status))) throw new ConflictException({ error: "Findings can be reviewed once the scan has finished." });
    const items = await this.client.json("GET", `/projects/${nyraId}/runs/${runId}/items`);
    return Array.isArray(items) ? items : [];
  }

  /**
   * Whether approved findings will get vectors, by the same rule the embedding job uses: the project's
   * own AI key if it can embed, else any OpenAI, Google or Mistral key in the workspace. The reason the
   * resolver gives is for logs; the page gets only the provider, never a key name or a key.
   */
  private async embeddings(projectId: string): Promise<{ available: boolean; provider: string | null }> {
    try {
      const { allocation } = await resolveEmbeddingAllocation(this.db, projectId);
      return { available: !!allocation, provider: allocation?.provider ?? null };
    } catch (err) {
      this.logger.warn(`Could not resolve an embeddings key for ${projectId}: ${(err as Error).message}`);
      return { available: false, provider: null };
    }
  }

  // ---------------------------------------------------------------- reading

  /** NYRA's findings with this scan's decisions laid over them, and where the scan was last approved. */
  async overlay(projectId: string, nyraId: string, runId: string, items: Row[]) {
    const [decisions, approval, embeddings] = await Promise.all([
      this.db.query(
        `SELECT kind, item_key, status, title, data, original_title, original_data, reviewed_at
         FROM nyra_item_reviews WHERE project_id = $1 AND nyra_project_id = $2 AND run_id = $3`,
        [projectId, nyraId, runId]
      ),
      this.approvalOf(projectId, nyraId, runId),
      this.embeddings(projectId)
    ]);
    const byKey = new Map(decisions.rows.map((d) => [`${d.kind}\u0000${d.item_key}`, d]));
    const list = items.map((i) => {
      const d = byKey.get(`${i.kind}\u0000${i.key}`);
      const edited = d?.status === "edited";
      return {
        kind: i.kind,
        key: i.key,
        title: edited ? d.title : i.title,
        data: edited ? d.data : (i.data ?? {}),
        reviewStatus: d ? (d.status as string) : "waiting",
        reviewedAt: d?.reviewed_at ?? null,
        original: edited ? { title: d.original_title ?? i.title, data: d.original_data ?? i.data ?? {} } : null
      };
    });
    return { list, approval, embeddings };
  }

  private async approvalOf(projectId: string, nyraId: string, runId: string) {
    const a = await this.db.query(
      `SELECT approved_at, item_count FROM nyra_run_approvals WHERE project_id = $1 AND nyra_project_id = $2 AND run_id = $3`,
      [projectId, nyraId, runId]
    );
    if (!a.rows[0]) return null;
    const docs = await this.db.query(
      `SELECT m.kind, m.document_id, d.title FROM nyra_kb_documents m
       JOIN knowledge_documents d ON d.id = m.document_id AND d.is_deleted = false
       WHERE m.project_id = $1 AND m.nyra_project_id = $2 AND m.kind = '${PRODUCT}'`,
      [projectId, nyraId]
    );
    return {
      approvedAt: a.rows[0].approved_at,
      itemCount: a.rows[0].item_count,
      documents: docs.rows.map((r) => ({ kind: r.kind, documentId: r.document_id, title: r.title }))
    };
  }

  // ---------------------------------------------------------------- deciding

  async review(userId: string | null | undefined, projectId: string, nyraId: string, runIdRaw: string, body: Row) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const runId = this.runId(runIdRaw);
    const kind = body?.kind;
    const key = body?.key;
    const status = body?.status;
    if (!isKind(kind)) throw bad("Unknown kind of finding");
    if (!isDocKind(kind)) throw bad(notReviewed(kind));
    if (typeof key !== "string" || !key || key.length > KEY_MAX) throw bad("Finding key is required");
    if (!["correct", "edited", "rejected", "waiting"].includes(status)) throw bad("Status must be correct, edited, rejected or waiting");

    const found = (await this.finishedItems(nyraId, runId)).find((i) => i.kind === kind && i.key === key);
    if (!found) throw new NotFoundException({ error: "Finding not found in this scan" });
    const original = { title: String(found.title ?? ""), data: (found.data ?? {}) as Record<string, any> };

    if (status === "waiting") {
      await this.db.query(
        `DELETE FROM nyra_item_reviews WHERE project_id = $1 AND nyra_project_id = $2 AND run_id = $3 AND kind = $4 AND item_key = $5`,
        [projectId, nyraId, runId, kind, key]
      );
    } else {
      let final = original;
      let changed = false;
      if (status === "edited") {
        final = applyEdit(kind, original, { title: body.title, data: body.data });
        changed = !sameFinding(final, original);
        if (!changed) throw bad("Nothing was changed. Use Correct to approve the finding as NYRA found it.");
      }
      await this.upsert(userId, projectId, nyraId, runId, [{ kind, key, status, title: final.title, data: final.data, original: changed ? original : null }]);
    }
    const out = (await this.overlay(projectId, nyraId, runId, [found])).list[0];
    return out;
  }

  /** Mark many findings Correct or Rejected, or undo them. Edits are one at a time. */
  async reviewMany(userId: string | null | undefined, projectId: string, nyraId: string, runIdRaw: string, body: Row) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const runId = this.runId(runIdRaw);
    const status = body?.status;
    if (!["correct", "rejected", "waiting"].includes(status)) throw bad("Status must be correct, rejected or waiting");
    const wanted = Array.isArray(body?.items) ? body.items : null;
    if (!wanted || !wanted.length) throw bad("Choose at least one finding");
    if (wanted.length > BULK_MAX) throw bad(`Choose at most ${BULK_MAX} findings at a time`);
    for (const w of wanted) if (!isKind(w?.kind) || typeof w?.key !== "string" || !w.key || w.key.length > KEY_MAX) throw bad("Each finding needs a kind and a key");
    const unreviewed = wanted.find((w: Row) => !isDocKind(w.kind));
    if (unreviewed) throw bad(notReviewed(unreviewed.kind));

    const items = await this.finishedItems(nyraId, runId);
    const index = new Map(items.map((i) => [`${i.kind}\u0000${i.key}`, i]));
    const picked = wanted.map((w: Row) => index.get(`${w.kind}\u0000${w.key}`)).filter(Boolean) as Row[];

    if (status === "waiting") {
      await this.db.query(
        `DELETE FROM nyra_item_reviews WHERE project_id = $1 AND nyra_project_id = $2 AND run_id = $3
           AND (kind, item_key) IN (SELECT * FROM unnest($4::text[], $5::text[]))`,
        [projectId, nyraId, runId, picked.map((i) => i.kind), picked.map((i) => i.key)]
      );
    } else {
      await this.upsert(
        userId,
        projectId,
        nyraId,
        runId,
        picked.map((i) => ({ kind: i.kind, key: i.key, status, title: String(i.title ?? ""), data: i.data ?? {}, original: null }))
      );
    }
    return { updated: picked.length, skipped: wanted.length - picked.length };
  }

  private async upsert(
    userId: string | null | undefined,
    projectId: string,
    nyraId: string,
    runId: string,
    rows: Array<{ kind: string; key: string; status: string; title: string; data: unknown; original: { title: string; data: unknown } | null }>
  ) {
    if (!rows.length) return;
    await this.db.query(
      `INSERT INTO nyra_item_reviews (project_id, nyra_project_id, run_id, kind, item_key, status, title, data, original_title, original_data, reviewed_by)
       SELECT $1, $2, $3, t.kind, t.item_key, t.status, t.title, t.data::jsonb, t.original_title, t.original_data::jsonb, $4
       FROM unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
         AS t(kind, item_key, status, title, data, original_title, original_data)
       ON CONFLICT (project_id, nyra_project_id, run_id, kind, item_key) DO UPDATE SET
         status = EXCLUDED.status, title = EXCLUDED.title, data = EXCLUDED.data,
         original_title = EXCLUDED.original_title, original_data = EXCLUDED.original_data,
         reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()`,
      [
        projectId,
        nyraId,
        runId,
        userId,
        rows.map((r) => r.kind),
        rows.map((r) => r.key),
        rows.map((r) => r.status),
        rows.map((r) => r.title),
        rows.map((r) => JSON.stringify(r.data ?? {})),
        rows.map((r) => r.original?.title ?? null),
        rows.map((r) => (r.original ? JSON.stringify(r.original.data ?? {}) : null))
      ]
    );
  }

  // ---------------------------------------------------------------- approving

  /** The name and address NYRA has for this project, which the document opens with. */
  private async projectInfo(nyraId: string): Promise<{ name: string; appUrl: string | null }> {
    const p = await this.client.json("GET", `/projects/${nyraId}`);
    const env = Array.isArray(p?.environments) ? p.environments[0] : null;
    return { name: String(p?.name ?? "NYRA project"), appUrl: env?.base_url ?? null };
  }

  /** The latest decision per finding across ALL of this NYRA project's scans, kept only when it says Correct or edited. */
  private async approvedFindings(projectId: string, nyraId: string) {
    const latest = await this.db.query(
      `SELECT DISTINCT ON (kind, item_key) kind, status, title, data
       FROM nyra_item_reviews WHERE project_id = $1 AND nyra_project_id = $2 AND kind = ANY($3::text[])
       ORDER BY kind, item_key, reviewed_at DESC`,
      [projectId, nyraId, [...DOC_KINDS]]
    );
    return latest.rows
      .filter((r: Row) => r.status === "correct" || r.status === "edited")
      .map((r: Row) => ({ kind: r.kind as DocKind, title: String(r.title), data: (r.data ?? {}) as Record<string, any> }));
  }

  /** The Knowledge Base document of this NYRA project, and whether a person changed it since Tesbo last wrote it. */
  private async writtenDocument(projectId: string, nyraId: string) {
    const row = (
      await this.db.query<{ document_id: string; content_hash: string | null; content_text: string | null; live: boolean }>(
        `SELECT m.document_id, m.content_hash, d.content_text, (d.id IS NOT NULL AND d.is_deleted = false) AS live
         FROM nyra_kb_documents m LEFT JOIN knowledge_documents d ON d.id = m.document_id
         WHERE m.project_id = $1 AND m.nyra_project_id = $2 AND m.kind = $3`,
        [projectId, nyraId, PRODUCT]
      )
    ).rows[0];
    if (!row) return null;
    const edited = !!row.live && !!row.content_hash && sha(row.content_text ?? "") !== row.content_hash;
    return { documentId: row.document_id, live: !!row.live, edited };
  }

  /**
   * The document as it would be written right now, from the decisions made so far. Built by the same
   * function the approval uses, so what is previewed is what is stored.
   */
  async documentPreview(userId: string | null | undefined, projectId: string, nyraId: string, runIdRaw: string) {
    await this.nyra.requireLinked(userId, projectId, nyraId);
    const runId = this.runId(runIdRaw);
    const run = await this.client.json("GET", `/projects/${nyraId}/runs/${runId}`);
    if (!run?.id) throw new NotFoundException({ error: "Run not found" });
    if (ACTIVE.has(String(run.status))) throw new ConflictException({ error: "Findings can be reviewed once the scan has finished." });
    const [info, approved, written] = await Promise.all([this.projectInfo(nyraId), this.approvedFindings(projectId, nyraId), this.writtenDocument(projectId, nyraId)]);
    const doc = buildProductDocument(info.name, { appUrl: info.appUrl }, approved);
    return {
      ...doc,
      // The document needs at least one of these before it can be approved.
      approvable: STORY_KINDS.reduce((n, k) => n + doc.counts[k], 0),
      documentId: written?.live ? written.documentId : null,
      editedInKb: written?.edited ?? false
    };
  }

  /**
   * Writes everything a person marked Correct or edited into the Knowledge Base as ONE product-understanding
   * document. Idempotent: it rebuilds the document from the latest decision per finding across all of this
   * NYRA project's scans, so approving twice, or approving a newer scan, never duplicates anything.
   * If a person edited that document in the Knowledge Base since, approving would erase their edits, so it
   * is refused until the caller says to replace them (`replaceEdits`).
   */
  async approve(userId: string | null | undefined, projectId: string, nyraId: string, runIdRaw: string, body?: Row) {
    const project = await this.nyra.requireLinked(userId, projectId, nyraId);
    if (this.legacy.normalizeRole(project.caller_role) === "qa_engineer") {
      throw new ForbiddenException({ error: "Only project owners and managers can approve findings into the Knowledge Base." });
    }
    const runId = this.runId(runIdRaw);
    const run = await this.client.json("GET", `/projects/${nyraId}/runs/${runId}`);
    if (!run?.id) throw new NotFoundException({ error: "Run not found" });
    if (ACTIVE.has(String(run.status))) throw new ConflictException({ error: "Approve findings once the scan has finished." });
    const info = await this.projectInfo(nyraId);

    // One approval at a time per NYRA project, so a double click cannot create the document twice.
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`nyra-approve:${projectId}:${nyraId}`]);
      const approved = await this.approvedFindings(projectId, nyraId);
      if (!approved.some((a) => (STORY_KINDS as readonly string[]).includes(a.kind))) {
        throw bad("Mark at least one screen, feature, workflow or business rule Correct before approving.");
      }
      const written = await this.writtenDocument(projectId, nyraId);
      if (written?.edited && body?.replaceEdits !== true) {
        throw new ConflictException({
          error: "The Knowledge Base document was edited after it was last approved. Approving again replaces those edits.",
          code: "kb_document_edited"
        });
      }

      const doc = buildProductDocument(info.name, { appUrl: info.appUrl }, approved);
      const { text, html } = renderDocument(doc);
      const folderId = await this.folder(projectId, userId);
      const documentId = await this.writeDocument(projectId, userId, folderId, nyraId, written?.documentId, doc.title, text, html);

      await this.db.query(
        `INSERT INTO nyra_run_approvals (project_id, nyra_project_id, run_id, approved_by, item_count) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, nyra_project_id, run_id) DO UPDATE SET approved_by = EXCLUDED.approved_by, approved_at = now(), item_count = EXCLUDED.item_count`,
        [projectId, nyraId, runId, userId, approved.length]
      );
      const approval = await this.approvalOf(projectId, nyraId, runId);
      return {
        ...approval,
        itemCount: approved.length,
        documents: [{ kind: PRODUCT, documentId, title: doc.title, count: approved.length, label: "Product knowledge" }],
        clipped: doc.clipped,
        embeddings: await this.embeddings(projectId)
      };
    });
  }

  private async folder(projectId: string, userId: string | null | undefined): Promise<string> {
    const find = async () =>
      (await this.db.query<{ id: string }>(`SELECT id FROM knowledge_folders WHERE project_id = $1 AND name = $2 AND is_root = false AND is_deleted = false LIMIT 1`, [projectId, FOLDER_NAME])).rows[0]?.id;
    const found = await find();
    if (found) return found;
    try {
      return String((await this.legacy.createKnowledgeFolder(projectId, userId, { name: FOLDER_NAME, description: "Findings reviewed and approved from NYRA" })).id);
    } catch (err) {
      // Created by a concurrent approval in the meantime.
      const again = await find();
      if (again) return again;
      throw err;
    }
  }

  private async writeDocument(
    projectId: string,
    userId: string | null | undefined,
    folderId: string,
    nyraId: string,
    existingId: string | undefined,
    title: string,
    text: string,
    html: string
  ): Promise<string> {
    // contentJson null on purpose: the editor prefers it, and a stale copy would hide this new text.
    const body = { title, contentText: text, contentHtml: html, contentJson: null };
    let documentId = existingId;
    if (documentId) {
      try {
        await this.legacy.updateKnowledgeDocument(projectId, userId, documentId, body);
      } catch (err) {
        // The document was deleted from the Knowledge Base since; approving puts it back.
        if (!(err instanceof NotFoundException)) throw err;
        this.logger.warn(`NYRA document ${documentId} is gone; recreating the document for ${nyraId}`);
        documentId = undefined;
      }
    }
    if (!documentId) {
      const created = await this.legacy.createKnowledgeDocument(projectId, userId, { ...body, folderId, documentType: "general" });
      documentId = String(created.id);
      await this.legacy.updateKnowledgeDocument(projectId, userId, documentId, { status: "published" });
    }
    // Hash what the Knowledge Base actually stored, so a later edit by a person is told apart from this write.
    const stored = await this.db.query<{ content_text: string | null }>(`SELECT content_text FROM knowledge_documents WHERE id = $1`, [documentId]);
    await this.db.query(
      `INSERT INTO nyra_kb_documents (project_id, nyra_project_id, kind, document_id, content_hash) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, nyra_project_id, kind) DO UPDATE SET document_id = EXCLUDED.document_id, content_hash = EXCLUDED.content_hash`,
      [projectId, nyraId, PRODUCT, documentId, sha(stored.rows[0]?.content_text ?? "")]
    );
    return documentId;
  }
}
