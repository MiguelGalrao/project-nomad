/**
 * Language filtering for ZIM entries that ship translations as subpages (#1453).
 *
 * Some wiki exports publish machine translations of every article at
 * `<Title>/<lang>` paths inside an archive whose `Language` metadata declares a
 * single language. WikEM (`wikem_en_all_maxi`, Language `eng`) is the motivating
 * case: 4,492 English articles plus translations into 15 languages, i.e. ~96% of
 * its 101k HTML entries are not English. Embedding all of them costs ~25x the
 * disk/time the user expects and floods retrieval with text the (English-only)
 * embedding model and the user cannot use.
 *
 * `<html lang>` is "en" on every page of that archive, so the path suffix is the
 * only cheap signal. The rule here is deliberately narrow so it leaves ordinary
 * archives untouched:
 * - it only applies when the archive declares exactly one language that we can
 *   map to ISO 639-1 (comma-separated multi-language archives are left alone);
 * - the last path segment must be a lowercase ISO 639-1 code from a fixed list
 *   of common languages (optionally with a lowercase region/script subtag such
 *   as `pt-br` or `zh-hans`), so English titles like `Vitamin/C`, `AC/DC` or a
 *   capitalised `Foo/It` never match;
 * - the parent segment must be non-empty (a bare `de` entry is not a subpage);
 * - entries in the archive's own language (`/en` for `eng`) are kept.
 */

/**
 * ISO 639-1 codes recognised as a translation subpage suffix. Kept to common,
 * widely-translated languages; codes that read like English words or units
 * (`no`, `is`, `ha`, `am`, `as`, `be`, ...) are intentionally left out so an
 * English article whose last segment happens to be one is not dropped.
 */
const TRANSLATION_SUBPAGE_CODES = new Set(
  (
    'ar bg bn ca cs da de el en es et fa fi fr he hi hr hu id it ja ' +
    'ko lt lv ms nl pl pt ro ru sk sl sr sv sw th tl tr uk ur vi zh'
  ).split(' ')
)

/**
 * ISO 639-3 (and the 639-2/B variants some archives use) -> ISO 639-1 for the
 * languages above. An archive language outside this table disables filtering.
 */
const ISO_639_3_TO_1 = new Map(
  (
    'ara:ar bul:bg ben:bn cat:ca ces:cs cze:cs dan:da deu:de ger:de ell:el gre:el eng:en ' +
    'spa:es est:et fas:fa per:fa fin:fi fra:fr fre:fr heb:he hin:hi hrv:hr hun:hu ind:id ' +
    'ita:it jpn:ja kor:ko lit:lt lav:lv msa:ms may:ms nld:nl dut:nl pol:pl por:pt ron:ro ' +
    'rum:ro rus:ru slk:sk slo:sk slv:sl srp:sr swe:sv swa:sw tha:th tgl:tl tur:tr ukr:uk ' +
    'urd:ur vie:vi zho:zh chi:zh'
  )
    .split(' ')
    .map((pair) => pair.split(':') as [string, string])
)

const SUBPAGE_SUFFIX = /^([a-z]{2})(?:-[a-z]{2,4})?$/

/**
 * Resolves a ZIM `Language` metadata value to the ISO 639-1 code used for
 * filtering, or null when filtering must not apply (missing, multi-language,
 * or a language not in the table).
 */
export function resolveArchiveLanguageCode(language: string | null | undefined): string | null {
  if (!language) return null
  const value = language.trim().toLowerCase()
  if (!value || value.includes(',')) return null
  const mapped = ISO_639_3_TO_1.get(value)
  if (mapped) return mapped
  if (value.length === 2 && TRANSLATION_SUBPAGE_CODES.has(value)) return value
  return null
}

/**
 * True when `path` is a translation subpage (`<Title>/<lang>`) in a language
 * other than `archiveLanguageCode` (an ISO 639-1 code from
 * `resolveArchiveLanguageCode`). Always false when that code is null.
 */
export function isOtherLanguageSubpage(path: string, archiveLanguageCode: string | null): boolean {
  if (!archiveLanguageCode) return false
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return false
  // Require a non-empty parent segment (rejects `//de` and `A//de`)
  const parentStart = path.lastIndexOf('/', slash - 1) + 1
  if (parentStart >= slash) return false
  const match = SUBPAGE_SUFFIX.exec(path.slice(slash + 1))
  if (!match) return false
  const code = match[1]
  return TRANSLATION_SUBPAGE_CODES.has(code) && code !== archiveLanguageCode
}
