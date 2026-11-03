import vine, { errors } from '@vinejs/vine'
import {
  DEFAULT_MARKER_LAYER_NAME,
  MARKER_EXPORT_FORMAT,
  MARKER_EXPORT_FORMAT_VERSION,
  MARKER_LAYER_NAME_MAX_LENGTH,
  MAX_MARKER_IMPORT_LAYERS,
  MAX_MARKER_IMPORT_PINS,
} from '../../constants/map_marker_layers.js'

export * from '../../constants/map_marker_layers.js'

/**
 * Map pin layers and their NOMAD JSON export/import format (#1387).
 *
 * Pins are grouped into named layers so a user can keep "Water sources" apart
 * from "Rally points", hide the ones that don't matter right now, and move a
 * set of pins to another NOMAD box one layer at a time. Everything in here is
 * pure (no Lucid, no HTTP) so the parts that guard the database -- which layer
 * an orphaned pin lands in, and what an imported file is allowed to contain --
 * can be unit-tested without MySQL.
 *
 * "Layer" already means a MapLibre style layer in map_service.ts, so the table
 * and model are `map_marker_layers` / MapMarkerLayer to keep the two apart.
 */

/** The pin fields carried in an export. Ids, timestamps and layer_id are local to one box and never leave it. */
export type ExportedPin = {
  name: string
  latitude: number
  longitude: number
  color: string
  custom_color: string | null
  icon: string | null
  icon_color: string | null
  visible: boolean
  notes: string | null
  marker_type: string
  route_id: string | null
  route_order: number | null
}

export type ExportedLayer = {
  name: string
  visible: boolean
  pins: ExportedPin[]
}

export type MarkerExportFile = {
  format: typeof MARKER_EXPORT_FORMAT
  format_version: number
  exported_at: string
  layers: ExportedLayer[]
}

// ---------------------------------------------------------------------------
// Default layer
// ---------------------------------------------------------------------------

/**
 * The layer a pin falls back to when none is named: the oldest one (lowest id),
 * which on an upgraded box is the "My Pins" layer the migration created. Null
 * means there are no layers at all and the caller has to create the default.
 */
export function pickDefaultLayerId(layers: ReadonlyArray<{ id: number }>): number | null {
  if (layers.length === 0) return null
  return layers.reduce((min, layer) => (layer.id < min ? layer.id : min), layers[0].id)
}

/**
 * Where a new or moved pin goes. An explicit layer must exist -- silently
 * dropping the pin into a different layer than the one the user picked would
 * hide it from them -- so an unknown id is `invalid` and the controller 422s.
 * No layer named means the default layer.
 */
export function resolveMarkerLayerId(
  requested: number | null | undefined,
  layers: ReadonlyArray<{ id: number }>
): { ok: true; layerId: number | null } | { ok: false } {
  if (requested === null || requested === undefined) {
    return { ok: true, layerId: pickDefaultLayerId(layers) }
  }
  return layers.some((layer) => layer.id === requested)
    ? { ok: true, layerId: requested }
    : { ok: false }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Copy only the exported fields off a marker row. Building the object
 * field-by-field (rather than spreading the row) is what keeps ids, layer_id
 * and timestamps out of the file.
 */
export function toExportedPin(marker: ExportedPin): ExportedPin {
  return {
    name: marker.name,
    latitude: Number(marker.latitude),
    longitude: Number(marker.longitude),
    color: marker.color,
    custom_color: marker.custom_color ?? null,
    icon: marker.icon ?? null,
    icon_color: marker.icon_color ?? null,
    visible: Boolean(marker.visible),
    notes: marker.notes ?? null,
    marker_type: marker.marker_type,
    route_id: marker.route_id ?? null,
    route_order: marker.route_order ?? null,
  }
}

export function buildMarkerExport(
  layers: ReadonlyArray<{ name: string; visible: boolean; pins: ReadonlyArray<ExportedPin> }>,
  exportedAt: Date
): MarkerExportFile {
  return {
    format: MARKER_EXPORT_FORMAT,
    format_version: MARKER_EXPORT_FORMAT_VERSION,
    exported_at: exportedAt.toISOString(),
    layers: layers.map((layer) => ({
      name: layer.name,
      visible: Boolean(layer.visible),
      pins: layer.pins.map(toExportedPin),
    })),
  }
}

/** A download filename for a layer export: letters, digits and dashes only, so it is safe in a header. */
export function markerExportFilename(layerName: string | null, date: Date): string {
  const slug = (layerName ?? 'all-layers')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `nomad-pins-${slug || 'layer'}-${date.toISOString().slice(0, 10)}.json`
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * The file is untrusted input: it may have been hand-edited or come from
 * someone else. Every field is typed and bounded the same way the marker CRUD
 * endpoints bound them, numbers and booleans are strict (no "12" or "true"
 * coerced), and vine.object() drops any property it doesn't list, so nothing
 * unexpected reaches MapMarker.create().
 */
const hexColor = /^#[0-9a-fA-F]{6}$/

const importedPinSchema = vine.object({
  name: vine.string().trim().minLength(1).maxLength(255),
  latitude: vine.number({ strict: true }).min(-90).max(90),
  longitude: vine.number({ strict: true }).min(-180).max(180),
  color: vine
    .string()
    .trim()
    .regex(/^[a-z]{1,20}$/)
    .optional(),
  custom_color: vine.string().trim().regex(hexColor).nullable().optional(),
  // Stored names look like `tabler:IconDroplet`; legacy ones are bare words.
  icon: vine
    .string()
    .trim()
    .regex(/^[A-Za-z0-9:_-]{1,50}$/)
    .nullable()
    .optional(),
  icon_color: vine.string().trim().regex(hexColor).nullable().optional(),
  visible: vine.boolean({ strict: true }).optional(),
  notes: vine.string().trim().maxLength(500).nullable().optional(),
  marker_type: vine
    .string()
    .trim()
    .regex(/^[a-z_]{1,20}$/)
    .optional(),
  route_id: vine.string().trim().minLength(1).maxLength(255).nullable().optional(),
  route_order: vine
    .number({ strict: true })
    .withoutDecimals()
    .min(0)
    .max(1_000_000)
    .nullable()
    .optional(),
})

const markerImportHeaderValidator = vine.compile(
  vine.object({
    format: vine.literal(MARKER_EXPORT_FORMAT),
    format_version: vine.number({ strict: true }).withoutDecimals().min(1),
  })
)

const markerImportBodyValidator = vine.compile(
  vine.object({
    layers: vine
      .array(
        vine.object({
          name: vine.string().trim().minLength(1).maxLength(MARKER_LAYER_NAME_MAX_LENGTH),
          visible: vine.boolean({ strict: true }).optional(),
          pins: vine.array(importedPinSchema).maxLength(MAX_MARKER_IMPORT_PINS),
        })
      )
      .minLength(1)
      .maxLength(MAX_MARKER_IMPORT_LAYERS),
  })
)

export class MarkerImportError extends Error {}

export type ParsedMarkerImport = {
  layers: Array<{ name: string; visible: boolean; pins: ExportedPin[] }>
  pinCount: number
}

/**
 * Validate an uploaded export and normalise it (defaults filled in, unknown
 * properties dropped). Throws MarkerImportError with a message fit to show the
 * user; never returns a partially-valid file.
 */
export async function parseMarkerImport(raw: unknown): Promise<ParsedMarkerImport> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MarkerImportError('This is not a NOMAD pin export file.')
  }

  let header: { format: string; format_version: number }
  try {
    header = await markerImportHeaderValidator.validate(raw)
  } catch (error) {
    if (error instanceof errors.E_VALIDATION_ERROR) {
      throw new MarkerImportError('This is not a NOMAD pin export file.')
    }
    throw error
  }

  if (header.format_version > MARKER_EXPORT_FORMAT_VERSION) {
    throw new MarkerImportError(
      `This file was exported by a newer version of NOMAD (format ${header.format_version}). Update this NOMAD to import it.`
    )
  }

  let body: Awaited<ReturnType<typeof markerImportBodyValidator.validate>>
  try {
    body = await markerImportBodyValidator.validate(raw)
  } catch (error) {
    if (error instanceof errors.E_VALIDATION_ERROR) {
      const first = (error.messages as Array<{ field: string; message: string }>)[0]
      throw new MarkerImportError(
        first ? `Invalid pin file at ${first.field}: ${first.message}` : 'Invalid pin file.'
      )
    }
    throw error
  }

  // Per-layer caps alone would still let 100 layers of 5,000 pins through.
  const pinCount = body.layers.reduce((sum, layer) => sum + layer.pins.length, 0)
  if (pinCount > MAX_MARKER_IMPORT_PINS) {
    throw new MarkerImportError(
      `This file has ${pinCount} pins; at most ${MAX_MARKER_IMPORT_PINS} can be imported at once.`
    )
  }

  return {
    pinCount,
    layers: body.layers.map((layer) => ({
      name: layer.name,
      visible: layer.visible ?? true,
      pins: layer.pins.map((pin) => ({
        name: pin.name,
        latitude: pin.latitude,
        longitude: pin.longitude,
        color: pin.color ?? 'orange',
        custom_color: pin.custom_color ?? null,
        icon: pin.icon ?? null,
        icon_color: pin.icon_color ?? null,
        visible: pin.visible ?? true,
        notes: pin.notes ?? null,
        marker_type: pin.marker_type ?? 'pin',
        route_id: pin.route_id ?? null,
        route_order: pin.route_order ?? null,
      })),
    })),
  }
}

/**
 * Give every route in an import a fresh id. Route ids in the file came from
 * another box (or were hand-typed), so reusing them could splice imported
 * points into an unrelated local route. The same old id maps to the same new
 * id across the whole file, so a route keeps all its points and their order.
 */
export function remapRouteIds<T extends { route_id: string | null }>(
  pins: ReadonlyArray<T>,
  newId: () => string
): T[] {
  const mapping = new Map<string, string>()
  return pins.map((pin) => {
    if (pin.route_id === null) return { ...pin }
    let mapped = mapping.get(pin.route_id)
    if (!mapped) {
      mapped = newId()
      mapping.set(pin.route_id, mapped)
    }
    return { ...pin, route_id: mapped }
  })
}

const duplicateKey = (pin: { name: string; latitude: number; longitude: number }) =>
  `${pin.name}\u0000${Number(pin.latitude)}\u0000${Number(pin.longitude)}`

/**
 * Merge skips pins that already exist in the target layer (same name and same
 * coordinates), so importing the same file twice doesn't double every pin.
 * Duplicates within the file itself collapse the same way.
 */
export function filterDuplicatePins<
  T extends { name: string; latitude: number; longitude: number },
>(
  existing: ReadonlyArray<{ name: string; latitude: number; longitude: number }>,
  incoming: ReadonlyArray<T>
): { kept: T[]; skipped: number } {
  const seen = new Set(existing.map(duplicateKey))
  const kept: T[] = []
  for (const pin of incoming) {
    const key = duplicateKey(pin)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(pin)
  }
  return { kept, skipped: incoming.length - kept.length }
}

/**
 * Name for a layer created by an "add as new layer" import. The file's layer
 * name is reused, suffixed if it would clash with an existing one, so the
 * import never lands in (or gets confused with) a layer the user already has.
 */
export function uniqueLayerName(desired: string, existingNames: ReadonlyArray<string>): string {
  const taken = new Set(existingNames.map((name) => name.toLowerCase()))
  const base = desired.trim().slice(0, MARKER_LAYER_NAME_MAX_LENGTH) || DEFAULT_MARKER_LAYER_NAME
  if (!taken.has(base.toLowerCase())) return base

  for (let n = 2; n < 10_000; n++) {
    const suffix = ` (${n})`
    const candidate = `${base.slice(0, MARKER_LAYER_NAME_MAX_LENGTH - suffix.length)}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return base
}

/** The one-line result shown after an import, e.g. "Imported 42 pins and 3 routes into 'Rally points'". */
export function describeMarkerImport(result: {
  pins: number
  routes: number
  skipped: number
  layerNames: string[]
}): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const what =
    result.routes > 0
      ? `${plural(result.pins, 'pin')} and ${plural(result.routes, 'route')}`
      : plural(result.pins, 'pin')
  const where =
    result.layerNames.length === 1
      ? `'${result.layerNames[0]}'`
      : plural(result.layerNames.length, 'layer')
  const skipped = result.skipped > 0 ? ` (${plural(result.skipped, 'duplicate')} skipped)` : ''
  return `Imported ${what} into ${where}${skipped}`
}
