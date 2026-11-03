/**
 * Map pin layer constants shared by the server and the maps UI (#1387). Kept
 * free of imports so the browser bundle can use them without pulling in vine;
 * the validation that uses them lives in app/utils/map_marker_layers.ts.
 */

/** The layer existing pins are moved into on upgrade, and the one recreated if none exist. */
export const DEFAULT_MARKER_LAYER_NAME = 'My Pins'

export const MARKER_LAYER_NAME_MAX_LENGTH = 100

/** Identifies a NOMAD pin export so a random JSON file is rejected with a clear message. */
export const MARKER_EXPORT_FORMAT = 'nomad-map-pins'

/**
 * Bump when the file shape changes. Import accepts every version up to this
 * one, so an older export keeps importing after a schema change; a file from a
 * newer NOMAD is refused rather than half-read.
 */
export const MARKER_EXPORT_FORMAT_VERSION = 1

/**
 * Caps on an imported file. The byte cap matches the JSON body parser's
 * default 1 MB limit (config/bodyparser.ts sets none for json), so the UI can
 * refuse an oversized file before uploading it instead of the server answering
 * with an opaque 413. 5,000 pins is far beyond any hand-built layer and keeps a
 * single import to one bounded transaction.
 */
export const MAX_MARKER_IMPORT_BYTES = 1024 * 1024
export const MAX_MARKER_IMPORT_PINS = 5000
export const MAX_MARKER_IMPORT_LAYERS = 100

/**
 * What an import does: `new` adds each file layer as a new layer and never
 * touches existing pins; `merge` adds to a chosen layer, skipping exact
 * duplicates; `replace` empties a chosen layer first.
 */
export const MARKER_IMPORT_MODES = ['new', 'merge', 'replace'] as const
export type MarkerImportMode = (typeof MARKER_IMPORT_MODES)[number]
