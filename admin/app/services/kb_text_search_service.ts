import db from '@adonisjs/lucid/services/db'
import { inject } from '@adonisjs/core'
import logger from '@adonisjs/core/services/logger'
import { basename, join, resolve, sep } from 'node:path'
import { RagService } from './rag_service.js'
import { DockerService } from './docker_service.js'
import KbIngestState from '#models/kb_ingest_state'
import { SERVICE_NAMES } from '../../constants/service_names.js'
import {
  deleteFileIfExists,
  determineFileType,
  getFileStatsIfExists,
  listDirectoryContentsRecursive,
} from '../utils/fs.js'
import {
  buildSnippet,
  chunkPagesForStorage,
  escapeLike,
  isKeywordIndexableType,
  planTextIndexSync,
  sanitizeSearchQuery,
} from '../utils/kb_text_search.js'
import type {
  KbTextDocument,
  KbTextSearchHit,
  KbTextSearchResponse,
} from '../../types/kb_text_search.js'

/**
 * AI-free keyword search over knowledge base uploads (#1182).
 *
 * Keeps the extracted text of files in storage/kb_uploads in MySQL
 * (kb_documents / kb_document_chunks, FULLTEXT on the chunk text) and searches
 * it with the same FULLTEXT-with-LIKE-fallback pattern as
 * drug_reference_service and condition_service. Nothing here touches Ollama or
 * Qdrant, so it works on a NOMAD that never installed AI.
 *
 * Population is via IndexDocumentTextJob: one job per upload, plus a bounded
 * sync pass (on worker boot, from the KB "Sync" action and from the Documents
 * page) that backfills earlier uploads, picks up files dropped straight into
 * kb_uploads, re-indexes replaced files and drops rows for deleted ones.
 */
@inject()
export class KbTextSearchService {
  /** Files extracted per sync pass; the job chains another pass for the rest. */
  public static SYNC_BATCH_LIMIT = 50
  public static SEARCH_LIMIT = 50
  /** Rows per INSERT when writing chunks, to keep packets well under max_allowed_packet. */
  private static INSERT_BATCH = 100

  constructor(
    private ragService: RagService,
    private dockerService: DockerService
  ) {}

  private static uploadsRoot(): string {
    return resolve(join(process.cwd(), RagService.UPLOADS_STORAGE_PATH))
  }

  /**
   * Resolve a path and require it to be strictly inside kb_uploads (same guard
   * as RagService.resolveUploadPath). Anything else is never indexed or
   * deleted through this service.
   */
  private static resolveUploadPath(filePath: string): string | null {
    const resolved = resolve(filePath)
    return resolved.startsWith(KbTextSearchService.uploadsRoot() + sep) ? resolved : null
  }

  /**
   * Extract and store one file's text, replacing any previous rows for it.
   * A file that yields no text, or fails to parse, still gets a document row
   * (with `last_error` on failure) so the sync doesn't retry it every pass.
   */
  public async indexFile(filePath: string): Promise<{ chunks: number } | null> {
    const resolved = KbTextSearchService.resolveUploadPath(filePath)
    if (!resolved) return null
    if (!isKeywordIndexableType(determineFileType(resolved))) return null

    const stats = await getFileStatsIfExists(resolved)
    if (!stats) {
      await KbTextSearchService.removeFile(resolved)
      return null
    }

    let pages: Array<{ page: number | null; text: string }> = []
    let lastError: string | null = null
    try {
      pages = (await this.ragService.extractTextForKeywordIndex(resolved)) ?? []
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logger.warn(`[KbTextSearch] Text extraction failed for ${resolved}: ${lastError}`)
    }

    const chunks = chunkPagesForStorage(pages)
    const charCount = chunks.reduce((sum, c) => sum + c.content.length, 0)

    // Delete + insert in one transaction so a search never sees a half-written
    // file, and a re-index of a replaced file is atomic.
    await db.transaction(async (trx) => {
      await trx.from('kb_documents').where('file_path', resolved).delete()
      const [documentId] = await trx.table('kb_documents').insert({
        file_path: resolved,
        file_name: basename(resolved).slice(0, 255),
        source_mtime_ms: Math.trunc(stats.modifiedTime.getTime()),
        chunk_count: chunks.length,
        char_count: charCount,
        last_error: lastError,
        indexed_at: new Date(),
      })
      for (let i = 0; i < chunks.length; i += KbTextSearchService.INSERT_BATCH) {
        await trx.table('kb_document_chunks').multiInsert(
          chunks.slice(i, i + KbTextSearchService.INSERT_BATCH).map((c) => ({
            document_id: documentId,
            page: c.page,
            position: c.position,
            content: c.content,
          }))
        )
      }
    })

    logger.info(`[KbTextSearch] Indexed ${chunks.length} text chunks for ${resolved}`)
    return { chunks: chunks.length }
  }

  /**
   * Drop a file's keyword-index rows (chunks cascade). Static and dependency
   * free so RagService.deleteFileBySource can call it without constructing
   * this service (and without a circular import at module load).
   */
  public static async removeFile(filePath: string): Promise<void> {
    await db.from('kb_documents').where('file_path', resolve(filePath)).delete()
  }

  /**
   * One bounded backfill/reconcile pass over kb_uploads. See
   * planTextIndexSync for the decision rules.
   */
  public async sync(): Promise<{ indexed: number; removed: number; deferred: number }> {
    const root = KbTextSearchService.uploadsRoot()
    let entries: Awaited<ReturnType<typeof listDirectoryContentsRecursive>> = []
    try {
      entries = await listDirectoryContentsRecursive(root)
    } catch (error: any) {
      // A fresh install has no kb_uploads until the first upload. Any other
      // error means we can't see the disk, and treating that as "everything
      // was deleted" would wipe the index, so bail instead.
      if (error?.code !== 'ENOENT') throw error
    }

    const onDisk: Array<{ path: string; mtimeMs: number }> = []
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      if (!isKeywordIndexableType(determineFileType(entry.key))) continue
      const stats = await getFileStatsIfExists(entry.key)
      if (stats) onDisk.push({ path: resolve(entry.key), mtimeMs: stats.modifiedTime.getTime() })
    }

    const indexedRows = await db.from('kb_documents').select('file_path', 'source_mtime_ms')
    const plan = planTextIndexSync({
      onDisk,
      indexed: indexedRows.map((r: any) => ({
        path: r.file_path,
        mtimeMs: Number(r.source_mtime_ms),
      })),
      limit: KbTextSearchService.SYNC_BATCH_LIMIT,
    })

    if (plan.toRemove.length > 0) {
      await db.from('kb_documents').whereIn('file_path', plan.toRemove).delete()
    }

    let indexed = 0
    for (const path of plan.toIndex) {
      try {
        await this.indexFile(path)
        indexed++
      } catch (error) {
        logger.error({ err: error }, `[KbTextSearch] Failed to index ${path}`)
      }
    }

    logger.info(
      `[KbTextSearch] Sync pass: indexed ${indexed}, removed ${plan.toRemove.length}, ${plan.deferred} remaining`
    )
    return { indexed, removed: plan.toRemove.length, deferred: plan.deferred }
  }

  /**
   * Keyword search. FULLTEXT (natural language mode) when the query has a
   * token of at least innodb_ft_min_token_size, else LIKE. Also falls back to
   * LIKE when FULLTEXT errors (index missing) or finds nothing, which covers
   * all-stopword queries and fragments like part numbers that FULLTEXT's
   * whole-word matching misses.
   */
  public async search(query: string): Promise<KbTextSearchResponse> {
    const sanitized = sanitizeSearchQuery(query)
    if (sanitized.terms.length === 0) return { results: [], mode: 'fulltext' }

    const limit = KbTextSearchService.SEARCH_LIMIT

    if (sanitized.useFulltext) {
      try {
        const result = await db.rawQuery(
          `
          SELECT d.file_path, d.file_name, c.page,
            c.content,
            MATCH(c.content) AGAINST(? IN NATURAL LANGUAGE MODE) AS relevance
          FROM kb_document_chunks c
          JOIN kb_documents d ON d.id = c.document_id
          WHERE MATCH(c.content) AGAINST(? IN NATURAL LANGUAGE MODE)
          ORDER BY relevance DESC
          LIMIT ?
          `,
          [sanitized.fulltextQuery, sanitized.fulltextQuery, limit]
        )
        const rows = result[0] as any[]
        if (rows.length > 0) {
          return { results: this.mapHits(rows, sanitized.terms), mode: 'fulltext' }
        }
      } catch (err) {
        logger.warn(
          `[KbTextSearch] FULLTEXT search failed, falling back to LIKE: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }

    const result = await db.rawQuery(
      `
      SELECT d.file_path, d.file_name, c.page, c.content
      FROM kb_document_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      WHERE c.content LIKE ?
      ORDER BY d.file_name ASC, c.position ASC
      LIMIT ?
      `,
      [`%${escapeLike(sanitized.phrase)}%`, limit]
    )
    return { results: this.mapHits(result[0] as any[], sanitized.terms), mode: 'like' }
  }

  private mapHits(rows: any[], terms: string[]): KbTextSearchHit[] {
    return rows.map((row) => ({
      source: row.file_path,
      fileName: row.file_name,
      page: row.page === null || row.page === undefined ? null : Number(row.page),
      snippet: buildSnippet(String(row.content ?? ''), terms),
    }))
  }

  public async listDocuments(): Promise<KbTextDocument[]> {
    const rows = await db
      .from('kb_documents')
      .select('file_path', 'file_name', 'chunk_count', 'char_count', 'last_error', 'indexed_at')
      .orderBy('file_name', 'asc')
    return rows.map((row: any) => ({
      source: row.file_path,
      fileName: row.file_name,
      chunkCount: Number(row.chunk_count),
      charCount: Number(row.char_count),
      lastError: row.last_error ?? null,
      indexedAt: new Date(row.indexed_at).toISOString(),
    }))
  }

  /**
   * Delete an uploaded document from the Documents page. When the AI
   * knowledge base is installed, defer to RagService.deleteFileBySource so the
   * file's vectors go too (it also removes the keyword rows). Without Qdrant
   * there are no vectors, and deleteFileBySource would fail trying to reach
   * it, so remove the file, its keyword rows and any ingest-state row here.
   */
  public async deleteDocument(source: string): Promise<{ success: boolean; message: string }> {
    const resolved = KbTextSearchService.resolveUploadPath(source)
    if (!resolved) {
      return { success: false, message: 'Only uploaded documents can be deleted.' }
    }

    const qdrantInstalled = !!(await this.dockerService.getServiceURL(SERVICE_NAMES.QDRANT))
    if (qdrantInstalled) {
      return await this.ragService.deleteFileBySource(resolved)
    }

    try {
      await deleteFileIfExists(resolved)
      await KbTextSearchService.removeFile(resolved)
      await KbIngestState.remove(resolved)
      return { success: true, message: 'Document deleted.' }
    } catch (error) {
      logger.error({ err: error }, `[KbTextSearch] Failed to delete ${resolved}`)
      return { success: false, message: 'Error deleting document.' }
    }
  }
}
