import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Keyword search over knowledge base uploads without AI (#1182).
 *
 * The RAG pipeline extracts text from every upload but only ever stores it as
 * vectors in Qdrant, so a NOMAD without Ollama/Qdrant had no way to search
 * inside its own documents. These two tables retain the extracted text of
 * files in storage/kb_uploads (never ZIMs, which Kiwix already searches) with a
 * FULLTEXT index, populated independently of whether embedding happens.
 *
 * kb_documents       one row per indexed file. Also written when a file
 *                    yielded no text (e.g. a scanned PDF) or failed to parse,
 *                    so the backfill sync doesn't retry it on every pass;
 *                    `source_mtime_ms` lets the sync notice a replaced file.
 * kb_document_chunks the text, split per page (PDF) and capped per row, so a
 *                    hit can name its page. Cascades with its document.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('kb_documents', (table) => {
      table.increments('id').primary()
      // Same width/uniqueness as kb_ingest_state.file_path (see that migration
      // for the utf8mb4 index-length reasoning).
      table.string('file_path', 512).notNullable().unique()
      table.string('file_name', 255).notNullable()
      table.bigInteger('source_mtime_ms').notNullable().defaultTo(0)
      table.integer('chunk_count').notNullable().defaultTo(0)
      table.integer('char_count').notNullable().defaultTo(0)
      table.text('last_error').nullable()
      table.timestamp('indexed_at').notNullable()
    })

    this.schema.createTable('kb_document_chunks', (table) => {
      table.bigIncrements('id').primary()
      table
        .integer('document_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('kb_documents')
        .onDelete('CASCADE')
      // 1-based page for paginated formats (PDF); null for docx/txt/md/epub.
      table.integer('page').nullable()
      table.integer('position').notNullable()
      table.text('content').notNullable()
      table.index(['document_id', 'position'], 'idx_kb_document_chunks_doc_pos')
    })

    // FULLTEXT index, guarded exactly like the drug_labels one
    // (1778600000004): an engine without FULLTEXT support must not brick the
    // migration runner, and KbTextSearchService falls back to LIKE when MATCH()
    // fails. Deferred so it runs after createTable has actually executed.
    this.defer(async (db) => {
      try {
        await db.rawQuery(
          `ALTER TABLE kb_document_chunks ADD FULLTEXT INDEX ft_kb_document_chunks_content (content)`
        )
      } catch {
        // Non-InnoDB or FULLTEXT unsupported — search falls back to LIKE.
      }
    })
  }

  async down() {
    this.schema.dropTable('kb_document_chunks')
    this.schema.dropTable('kb_documents')
  }
}
