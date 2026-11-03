import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSnippet,
  chunkPagesForStorage,
  escapeLike,
  isKeywordIndexableType,
  KB_TEXT_MAX_QUERY_LENGTH,
  KB_TEXT_MAX_QUERY_TERMS,
  planTextIndexSync,
  sanitizeSearchQuery,
} from '../../app/utils/kb_text_search.js'

// --- sanitizeSearchQuery ---------------------------------------------------

test('strips every MySQL FULLTEXT operator so input cannot change query meaning', () => {
  const q = sanitizeSearchQuery('+water -filter <boil> (purify) ~bleach* "iodine tablets" @3')
  assert.deepEqual(q.terms, [
    'water',
    'filter',
    'boil',
    'purify',
    'bleach',
    'iodine',
    'tablets',
    '3',
  ])
  assert.doesNotMatch(q.fulltextQuery, /[+\-<>()~*"@]/)
  assert.equal(q.useFulltext, true)
})

test('an operator-only query sanitises to nothing', () => {
  const q = sanitizeSearchQuery('+-*"()<>~@')
  assert.deepEqual(q.terms, [])
  assert.equal(q.fulltextQuery, '')
  assert.equal(q.phrase, '')
  assert.equal(q.useFulltext, false)
})

test('queries with only short tokens skip FULLTEXT (innodb_ft_min_token_size = 3)', () => {
  const q = sanitizeSearchQuery('pH 7')
  assert.equal(q.useFulltext, false)
  assert.equal(q.fulltextQuery, '')
  assert.equal(q.phrase, 'pH 7')
})

test('collapses whitespace and control characters, de-duplicates case-insensitively', () => {
  const q = sanitizeSearchQuery('  Water\t\nwater\u0000  WATER  well ')
  assert.deepEqual(q.terms, ['Water', 'well'])
  assert.equal(q.phrase, 'Water well')
})

test('caps query length and term count', () => {
  const long = sanitizeSearchQuery('a'.repeat(KB_TEXT_MAX_QUERY_LENGTH + 50))
  assert.equal(long.terms[0].length, KB_TEXT_MAX_QUERY_LENGTH)
  const many = sanitizeSearchQuery(Array.from({ length: 40 }, (_, i) => `term${i}`).join(' '))
  assert.equal(many.terms.length, KB_TEXT_MAX_QUERY_TERMS)
})

test('keeps non-ASCII words intact', () => {
  const q = sanitizeSearchQuery('café über')
  assert.deepEqual(q.terms, ['café', 'über'])
  assert.equal(q.useFulltext, true)
})

// --- escapeLike ------------------------------------------------------------

test('escapeLike escapes LIKE wildcards and the escape character itself', () => {
  assert.equal(escapeLike('100%_done\\x'), '100\\%\\_done\\\\x')
  assert.equal(escapeLike('plain'), 'plain')
})

// --- isKeywordIndexableType ------------------------------------------------

test('indexes pdf/docx/text/epub; never zim, images or unknown types', () => {
  for (const t of ['pdf', 'docx', 'text', 'epub']) assert.equal(isKeywordIndexableType(t), true, t)
  for (const t of ['zim', 'image', 'unknown']) assert.equal(isKeywordIndexableType(t), false, t)
})

// --- chunkPagesForStorage --------------------------------------------------

test('keeps one chunk per small page and records the page number', () => {
  const chunks = chunkPagesForStorage([
    { page: 1, text: 'First page text.' },
    { page: 2, text: '   ' },
    { page: 3, text: 'Third page.' },
  ])
  assert.deepEqual(chunks, [
    { page: 1, position: 0, content: 'First page text.' },
    { page: 3, position: 1, content: 'Third page.' },
  ])
})

test('never lets a chunk span pages', () => {
  const chunks = chunkPagesForStorage(
    [
      { page: 1, text: 'aaa' },
      { page: 2, text: 'bbb' },
    ],
    1000
  )
  assert.equal(chunks.length, 2)
  assert.deepEqual(
    chunks.map((c) => c.page),
    [1, 2]
  )
})

test('packs paragraphs up to the cap and splits long paragraphs on word boundaries', () => {
  const para = 'word '.repeat(30).trim() // 149 chars
  const chunks = chunkPagesForStorage([{ page: null, text: `${para}\n\n${para}\n\n${para}` }], 320)
  assert.ok(chunks.every((c) => c.content.length <= 320))
  // Two paragraphs (149 + 2 + 149 = 300) fit together, the third goes alone.
  assert.equal(chunks.length, 2)

  const long = chunkPagesForStorage([{ page: null, text: 'lorem ipsum '.repeat(100) }], 50)
  assert.ok(long.every((c) => c.content.length <= 50 && c.content.length > 0))
  assert.ok(long.every((c) => !c.content.startsWith(' ') && !c.content.endsWith(' ')))
  assert.equal(long.map((c) => c.content).join(' '), 'lorem ipsum '.repeat(100).trim())
})

test('hard-splits a paragraph with no whitespace', () => {
  const chunks = chunkPagesForStorage([{ page: null, text: 'x'.repeat(125) }], 50)
  assert.deepEqual(
    chunks.map((c) => c.content.length),
    [50, 50, 25]
  )
})

test('normalises whitespace and line endings', () => {
  const [chunk] = chunkPagesForStorage([{ page: 1, text: 'a\t\tb\r\n\r\n\r\n\r\nc   d' }])
  assert.equal(chunk.content, 'a b\n\nc d')
})

test('bounds the total characters stored per file', () => {
  const chunks = chunkPagesForStorage([{ page: null, text: 'abcde '.repeat(100) }], 20, 45)
  const total = chunks.reduce((n, c) => n + c.content.length, 0)
  assert.ok(total <= 45)
  assert.ok(total > 0)
})

test('positions are sequential across pages', () => {
  const chunks = chunkPagesForStorage(
    [
      { page: 1, text: 'one '.repeat(20) },
      { page: 2, text: 'two '.repeat(20) },
    ],
    30
  )
  assert.deepEqual(
    chunks.map((c) => c.position),
    chunks.map((_, i) => i)
  )
})

// --- buildSnippet ----------------------------------------------------------

const joined = (segs: { text: string }[]) => segs.map((s) => s.text).join('')

test('highlights every case-insensitive occurrence of each term', () => {
  const segs = buildSnippet('Boil water. Water must boil for a minute.', ['water', 'boil'])
  assert.deepEqual(
    segs.filter((s) => s.match).map((s) => s.text),
    ['Boil', 'water', 'Water', 'boil']
  )
  assert.equal(joined(segs), 'Boil water. Water must boil for a minute.')
})

test('windows long content around the first match with ellipses', () => {
  const content = `${'filler '.repeat(100)}the needle is here ${'tail '.repeat(100)}`
  const segs = buildSnippet(content, ['needle'], 100)
  const text = joined(segs)
  assert.ok(text.startsWith('…'))
  assert.ok(text.endsWith('…'))
  assert.ok(text.length <= 100 + 2)
  assert.ok(segs.some((s) => s.match && s.text === 'needle'))
})

test('falls back to the start of the chunk when no term appears verbatim', () => {
  const segs = buildSnippet('Cafe opening hours are listed below.', ['café'], 240)
  assert.deepEqual(segs, [{ text: 'Cafe opening hours are listed below.', match: false }])
})

test('treats regex metacharacters in terms literally', () => {
  const segs = buildSnippet('Use C++ (or C) here.', ['C++', '(or'])
  assert.deepEqual(
    segs.filter((s) => s.match).map((s) => s.text),
    ['C++', '(or']
  )
})

test('returns no segments for empty content', () => {
  assert.deepEqual(buildSnippet('   ', ['x']), [])
})

// --- planTextIndexSync -----------------------------------------------------

test('indexes new files, re-indexes modified ones, removes deleted ones', () => {
  const plan = planTextIndexSync({
    onDisk: [
      { path: '/kb/new.pdf', mtimeMs: 100 },
      { path: '/kb/same.pdf', mtimeMs: 200 },
      { path: '/kb/changed.pdf', mtimeMs: 301 },
    ],
    indexed: [
      { path: '/kb/same.pdf', mtimeMs: 200 },
      { path: '/kb/changed.pdf', mtimeMs: 300 },
      { path: '/kb/gone.pdf', mtimeMs: 400 },
    ],
    limit: 10,
  })
  assert.deepEqual(plan.toIndex, ['/kb/new.pdf', '/kb/changed.pdf'])
  assert.deepEqual(plan.toRemove, ['/kb/gone.pdf'])
  assert.equal(plan.deferred, 0)
})

test('ignores sub-millisecond mtime differences', () => {
  const plan = planTextIndexSync({
    onDisk: [{ path: '/kb/a.pdf', mtimeMs: 1700000000123.789 }],
    indexed: [{ path: '/kb/a.pdf', mtimeMs: 1700000000123 }],
    limit: 10,
  })
  assert.deepEqual(plan.toIndex, [])
})

test('bounds each pass and reports how many are deferred', () => {
  const onDisk = Array.from({ length: 7 }, (_, i) => ({ path: `/kb/${i}.txt`, mtimeMs: 1 }))
  const plan = planTextIndexSync({ onDisk, indexed: [], limit: 3 })
  assert.equal(plan.toIndex.length, 3)
  assert.equal(plan.deferred, 4)
})

test('an empty disk removes everything indexed (caller guards unreadable dirs)', () => {
  const plan = planTextIndexSync({
    onDisk: [],
    indexed: [{ path: '/kb/a.pdf', mtimeMs: 1 }],
    limit: 10,
  })
  assert.deepEqual(plan.toRemove, ['/kb/a.pdf'])
})
