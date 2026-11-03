import type { SnippetSegment } from '../app/utils/kb_text_search.js'

export type { SnippetSegment }

/** One keyword-search hit: a passage of an uploaded document (#1182). */
export type KbTextSearchHit = {
  /** Absolute path, same `source` key the RAG endpoints (download etc.) take. */
  source: string
  fileName: string
  /** 1-based page for PDFs; null for formats without pages. */
  page: number | null
  snippet: SnippetSegment[]
}

export type KbTextSearchResponse = {
  results: KbTextSearchHit[]
  /** Which path answered: FULLTEXT, or the LIKE fallback. Informational. */
  mode: 'fulltext' | 'like'
}

/** A file known to the keyword index, for the Documents page list. */
export type KbTextDocument = {
  source: string
  fileName: string
  chunkCount: number
  charCount: number
  /** Set when text extraction failed; the file is listed but not searchable. */
  lastError: string | null
  indexedAt: string
}
