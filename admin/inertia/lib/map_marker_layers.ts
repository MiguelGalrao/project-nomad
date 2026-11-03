import { MARKER_EXPORT_FORMAT, MAX_MARKER_IMPORT_BYTES } from '../../constants/map_marker_layers.js'

/**
 * Client-side rules for map pin layers (#1387), kept pure so they can be
 * unit-tested without a browser.
 */

type LayerLike = { id: number; visible: boolean }
type MarkerLike = { visible: boolean; layerId: number | null }

/**
 * The layer a pin belongs to. The upgrade migration gives every pin a layer,
 * but a pin row written by an older cached UI mid-upgrade could still have
 * none; the server treats that as the default (oldest) layer, so do the same.
 */
export function effectiveLayerId(
  marker: { layerId: number | null },
  layers: ReadonlyArray<{ id: number }>
): number | null {
  if (marker.layerId !== null && layers.some((layer) => layer.id === marker.layerId)) {
    return marker.layerId
  }
  return layers.reduce<number | null>(
    (min, layer) => (min === null || layer.id < min ? layer.id : min),
    null
  )
}

/** Whether the pin's layer is switched on, regardless of the pin's own flag. */
export function isMarkerInVisibleLayer(
  marker: { layerId: number | null },
  layers: ReadonlyArray<LayerLike>
): boolean {
  const layerId = effectiveLayerId(marker, layers)
  const layer = layers.find((candidate) => candidate.id === layerId)
  // Before layers have loaded there is nothing to hide by; keep today's behaviour.
  return layer ? layer.visible : true
}

/** A pin shows only if both it and its layer are visible (the per-pin flag stays). */
export function isMarkerShown(marker: MarkerLike, layers: ReadonlyArray<LayerLike>): boolean {
  return marker.visible && isMarkerInVisibleLayer(marker, layers)
}

export function countPinsByLayer(
  markers: ReadonlyArray<{ layerId: number | null }>,
  layers: ReadonlyArray<{ id: number }>
): Map<number, number> {
  const counts = new Map<number, number>(layers.map((layer) => [layer.id, 0]))
  for (const marker of markers) {
    const layerId = effectiveLayerId(marker, layers)
    if (layerId !== null) counts.set(layerId, (counts.get(layerId) ?? 0) + 1)
  }
  return counts
}

export type ImportFilePreview =
  | { ok: true; file: unknown; layerCount: number; pinCount: number }
  | { ok: false; message: string }

/**
 * A quick look at a chosen file before it is uploaded: refuse what is
 * obviously wrong (too big, not JSON, not a NOMAD export) with a clear message,
 * and count what is in it for the confirmation. The server re-validates every
 * field; this is only to fail fast and to show "3 layers, 42 pins".
 */
export function previewImportFile(text: string, sizeBytes: number): ImportFilePreview {
  if (sizeBytes > MAX_MARKER_IMPORT_BYTES) {
    return { ok: false, message: 'This file is too large to import (the limit is 1 MB).' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: 'This file is not valid JSON.' }
  }

  const candidate = parsed as { format?: unknown; layers?: unknown }
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    candidate.format !== MARKER_EXPORT_FORMAT ||
    !Array.isArray(candidate.layers)
  ) {
    return { ok: false, message: 'This is not a NOMAD pin export file.' }
  }

  const pinCount = candidate.layers.reduce<number>((sum, layer) => {
    const pins = (layer as { pins?: unknown } | null)?.pins
    return sum + (Array.isArray(pins) ? pins.length : 0)
  }, 0)

  return { ok: true, file: parsed, layerCount: candidate.layers.length, pinCount }
}
