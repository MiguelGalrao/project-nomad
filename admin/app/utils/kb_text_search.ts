/**
 * Pure helpers for the AI-free keyword search over knowledge base uploads
 * (#1182). Everything here is side-effect free so it can be unit-tested
 * without MySQL, BullMQ or the filesystem; KbTextSearchService wires it up.
 *
 * Why this exists at all: the only way to search inside an uploaded document
 * used to be the RAG pipeline, which needs Ollama, an embedding model and
 * Qdrant. A user who skipped AI (or runs on hardware too small for a model)
 * had no way to find text in their own PDFs. We already extract the text for
 * embedding; this keeps a copy in MySQL behind a FULLTEXT index.
 */

/**
 * Upper bound on characters stored per chunk row. Small enough that a snippet
 * window and the relevance score stay meaningful for a single passage, large
 * enough that a typical PDF page is one or two rows. Fits comfortably in a
 * TEXT column (64 KB) even at 4 bytes/char under utf8mb4.
 */
export const KB_TEXT_CHUNK_MAX_CHARS = 2000

/**
 * Hard cap on extracted characters retained per file. The issue flags storage
 * cost as the thing to watch; this bounds a single pathological upload (a
 * multi-thousand-page text dump) to a few MB of rows instead of letting it
 * grow without limit. Text past the cap is simply not keyword-searchable.
 */
export const KB_TEXT_MAX_CHARS_PER_FILE = 5_000_000

/** Longest query we accept. Longer input is truncated, not rejected. */
export const KB_TEXT_MAX_QUERY_LENGTH = 200

/** Most search terms we hand to MySQL; the rest are dropped. */
export const KB_TEXT_MAX_QUERY_TERMS = 16

/**
 * innodb_ft_min_token_size defaults to 3 on MySQL 8 InnoDB. A query whose
 * every token is shorter than this can never match through FULLTEXT, so it
 * goes straight to the LIKE fallback (same rule drug_reference_service and
 * condition_service use).
 */
export const KB_TEXT_FT_MIN_TOKEN = 3

/**
 * File types (from utils/fs determineFileType) whose text we keep. ZIMs are
 * deliberately excluded: they are already searchable through Kiwix, and
 * retaining their text would be enormous. Images are excluded because their
 * only text source is OCR, which is minutes of CPU per file on the low-end
 * hardware this feature targets.
 */
const KEYWORD_INDEXABLE_TYPES: ReadonlySet<string> = new Set(['pdf', 'docx', 'text', 'epub'])

export function isKeywordIndexableType(fileType: string): boolean {
  return KEYWORD_INDEXABLE_TYPES.has(fileType)
}

export interface SanitizedSearchQuery {
  /** Individual words, operators stripped, in input order, de-duplicated. */
  terms: string[]
  /** Space-joined terms, safe to bind to MATCH ... AGAINST. Empty when unusable. */
  fulltextQuery: string
  /** The cleaned phrase used for the LIKE fallback (not yet LIKE-escaped). */
  phrase: string
  /** True when at least one term is long enough for FULLTEXT to match it. */
  useFulltext: boolean
}

/**
 * Characters with meaning in MySQL FULLTEXT search syntax. In BOOLEAN MODE
 * these are + - < > ( ) ~ * " @; NATURAL LANGUAGE MODE (which we use, like the
 * other two FULLTEXT searches in the codebase) still honours the double quote
 * as a phrase delimiter. Stripping all of them means user input can never
 * change the query's meaning, whichever mode a future change switches to.
 * The value is always bound as a parameter, so this is about semantics, not
 * SQL injection.
 */
const FULLTEXT_OPERATOR_CHARS = /[+\-<>()~*"@]/g

/**
 * Normalise free-text user input into something safe for both the FULLTEXT
 * and the LIKE path.
 */
export function sanitizeSearchQuery(input: string): SanitizedSearchQuery {
  const cleaned = String(input ?? '')
    .slice(0, KB_TEXT_MAX_QUERY_LENGTH)
    .replace(FULLTEXT_OPERATOR_CHARS, ' ')
    // Collapse control characters and any whitespace run to a single space.
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()

  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of cleaned.split(' ')) {
    if (!raw) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(raw)
    if (terms.length >= KB_TEXT_MAX_QUERY_TERMS) break
  }

  const useFulltext = terms.some((t) => [...t].length >= KB_TEXT_FT_MIN_TOKEN)
  return {
    terms,
    fulltextQuery: useFulltext ? terms.join(' ') : '',
    phrase: terms.join(' '),
    useFulltext,
  }
}

/**
 * Escape LIKE wildcards so user input matches literally. Relies on MySQL's
 * default LIKE escape character (backslash) and must be used with a bound
 * parameter. Same contract as the escapeLike helper proposed upstream for the
 * other search surfaces (PR #1491); kept local so the two changes don't
 * collide, and trivially swappable once that lands.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

export interface ExtractedPage {
  /** 1-based page number for paginated formats (PDF); null otherwise. */
  page: number | null
  text: string
}

export interface StorageChunk {
  page: number | null
  /** 0-based ordinal of the chunk within the file, stable for a given input. */
  position: number
  content: string
}

/** Collapse runs of spaces/tabs, trim each line, and drop blank-line runs. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v \u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Split extracted pages into rows for the kb_document_chunks table.
 *
 * Chunks never span a page boundary, so every hit can say which page it is
 * on. Within a page we pack paragraphs up to `maxChars`; a paragraph longer
 * than that is split on the last whitespace before the limit (or hard-split
 * if it has none, e.g. a long base64 blob) so no row exceeds the cap.
 * Total retained text is bounded by `maxTotalChars`.
 */
export function chunkPagesForStorage(
  pages: ExtractedPage[],
  maxChars: number = KB_TEXT_CHUNK_MAX_CHARS,
  maxTotalChars: number = KB_TEXT_MAX_CHARS_PER_FILE
): StorageChunk[] {
  const chunks: StorageChunk[] = []
  let total = 0
  let position = 0

  const push = (page: number | null, content: string): boolean => {
    const remaining = maxTotalChars - total
    if (remaining <= 0) return false
    const kept = content.length > remaining ? content.slice(0, remaining) : content
    chunks.push({ page, position: position++, content: kept })
    total += kept.length
    return kept.length === content.length
  }

  for (const { page, text } of pages) {
    const normalized = normalizeWhitespace(text ?? '')
    if (!normalized) continue

    let buffer = ''
    const paragraphs = normalized.split(/\n\n/)
    for (const paragraph of paragraphs) {
      let rest = paragraph
      while (rest.length > 0) {
        const joiner = buffer ? '\n\n' : ''
        if (buffer.length + joiner.length + rest.length <= maxChars) {
          buffer += joiner + rest
          rest = ''
          break
        }
        // Doesn't fit. Flush what we have first so the paragraph starts fresh.
        if (buffer) {
          if (!push(page, buffer)) return chunks
          buffer = ''
          continue
        }
        // A single paragraph longer than maxChars: cut at a word boundary.
        let cut = rest.lastIndexOf(' ', maxChars)
        if (cut <= 0) cut = rest.lastIndexOf('\n', maxChars)
        if (cut <= 0) cut = maxChars
        if (!push(page, rest.slice(0, cut).trim())) return chunks
        rest = rest.slice(cut).trim()
      }
    }
    if (buffer && !push(page, buffer)) return chunks
  }

  return chunks
}

export interface SnippetSegment {
  text: string
  match: boolean
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a short excerpt around the first matching term and split it into
 * plain/matched segments. Returning segments (rather than HTML with <mark>
 * tags) lets the UI highlight without dangerouslySetInnerHTML, so text from
 * an uploaded document can never inject markup.
 *
 * Matching is case-insensitive substring, which is close to (not identical
 * to) what MySQL FULLTEXT matched; when no term is found verbatim (e.g. an
 * accent-insensitive collation match) the snippet is the start of the chunk
 * with no highlight, which is still the right passage.
 */
export function buildSnippet(
  content: string,
  terms: string[],
  maxLength: number = 240
): SnippetSegment[] {
  const text = content.replace(/\s+/g, ' ').trim()
  if (!text) return []

  const usable = terms.filter((t) => t.length > 0)
  const pattern = usable.length
    ? new RegExp(
        usable
          .slice()
          // Longest first so "water filter" style overlaps highlight the longer term.
          .sort((a, b) => b.length - a.length)
          .map(escapeRegExp)
          .join('|'),
        'gi'
      )
    : null

  let start = 0
  if (pattern) {
    const first = pattern.exec(text)
    pattern.lastIndex = 0
    if (first && text.length > maxLength) {
      // Put the match roughly a third of the way into the window so there is
      // leading context but most of the excerpt follows it.
      start = Math.max(0, first.index - Math.floor(maxLength / 3))
      if (start + maxLength > text.length) start = Math.max(0, text.length - maxLength)
      // Don't start mid-word.
      if (start > 0) {
        const space = text.indexOf(' ', start)
        if (space !== -1 && space < first.index) start = space + 1
      }
    }
  }

  let end = Math.min(text.length, start + maxLength)
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    if (space > start) end = space
  }

  const window = text.slice(start, end)
  const segments: SnippetSegment[] = []
  const pushSeg = (segText: string, match: boolean) => {
    if (!segText) return
    const last = segments[segments.length - 1]
    if (last && last.match === match) last.text += segText
    else segments.push({ text: segText, match })
  }

  if (start > 0) pushSeg('…', false)
  if (pattern) {
    let cursor = 0
    for (const m of window.matchAll(pattern)) {
      pushSeg(window.slice(cursor, m.index), false)
      pushSeg(m[0], true)
      cursor = m.index! + m[0].length
    }
    pushSeg(window.slice(cursor), false)
  } else {
    pushSeg(window, false)
  }
  if (end < text.length) pushSeg('…', false)

  return segments
}

export interface TextIndexDiskFile {
  path: string
  mtimeMs: number
}

export interface TextIndexIndexedFile {
  path: string
  mtimeMs: number
}

export interface TextIndexSyncPlan {
  /** Files new on disk or modified since they were indexed, capped at `limit`. */
  toIndex: string[]
  /** Indexed files that no longer exist on disk. */
  toRemove: string[]
  /** How many files still need indexing beyond this batch. */
  deferred: number
}

/**
 * Decide what a keyword-index sync pass should do. This is the backfill for
 * files uploaded before the feature existed, for files dropped straight into
 * storage/kb_uploads, and the self-heal for files deleted or replaced outside
 * the app (#1170 is the same lifecycle problem for the vector store).
 *
 * A file is (re)indexed when it is on disk and either has no index row or its
 * modification time changed. Files that were indexed but yielded no text keep
 * their row, so a scanned PDF isn't re-extracted on every pass. `limit` keeps
 * one pass bounded; the caller schedules another pass for `deferred` files.
 */
export function planTextIndexSync(params: {
  onDisk: TextIndexDiskFile[]
  indexed: TextIndexIndexedFile[]
  limit: number
}): TextIndexSyncPlan {
  const { onDisk, indexed, limit } = params
  const indexedByPath = new Map(indexed.map((f) => [f.path, f.mtimeMs]))
  const onDiskPaths = new Set(onDisk.map((f) => f.path))

  const pending: string[] = []
  for (const file of onDisk) {
    const indexedMtime = indexedByPath.get(file.path)
    // Compare at whole-millisecond precision: the DB column is an integer, and
    // some filesystems report fractional mtimes that would otherwise never match.
    if (indexedMtime === undefined || Math.trunc(indexedMtime) !== Math.trunc(file.mtimeMs)) {
      pending.push(file.path)
    }
  }

  const toRemove = indexed.filter((f) => !onDiskPaths.has(f.path)).map((f) => f.path)
  const cap = Math.max(0, Math.floor(limit))
  return {
    toIndex: pending.slice(0, cap),
    toRemove,
    deferred: Math.max(0, pending.length - cap),
  }
}
