/**
 * Map pin layers and the NOMAD JSON pin export/import format (#1387).
 *
 * The import cases are the important ones: an export file is untrusted input
 * (hand-edited, or from someone else's box), and parseMarkerImport is the only
 * thing between it and MapMarker.createMany(). The default-layer cases cover
 * the upgrade path, where every existing pin must land in one layer.
 *
 * Pure functions only, no MySQL, Redis, Qdrant or Ollama needed:
 *   npm run test:unit
 */
import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_MARKER_LAYER_NAME,
  MARKER_EXPORT_FORMAT,
  MARKER_EXPORT_FORMAT_VERSION,
  MAX_MARKER_IMPORT_PINS,
  MarkerImportError,
  buildMarkerExport,
  describeMarkerImport,
  filterDuplicatePins,
  markerExportFilename,
  parseMarkerImport,
  pickDefaultLayerId,
  remapRouteIds,
  resolveMarkerLayerId,
  uniqueLayerName,
  type ExportedPin,
} from '../../app/utils/map_marker_layers.js'
import {
  countPinsByLayer,
  effectiveLayerId,
  isMarkerShown,
  previewImportFile,
} from '../../inertia/lib/map_marker_layers.js'

const pin = (overrides: Partial<ExportedPin> = {}): ExportedPin => ({
  name: 'Well',
  latitude: 38.57,
  longitude: -109.55,
  color: 'blue',
  custom_color: null,
  icon: 'tabler:IconDroplet',
  icon_color: null,
  visible: true,
  notes: 'Pump handle sticks',
  marker_type: 'pin',
  route_id: null,
  route_order: null,
  ...overrides,
})

const file = (layers: unknown, extra: Record<string, unknown> = {}) => ({
  format: MARKER_EXPORT_FORMAT,
  format_version: MARKER_EXPORT_FORMAT_VERSION,
  exported_at: '2026-11-03T00:00:00.000Z',
  layers,
  ...extra,
})

const rejects = (raw: unknown, pattern: RegExp) =>
  assert.rejects(parseMarkerImport(raw), (error: unknown) => {
    assert.ok(error instanceof MarkerImportError, `expected MarkerImportError, got ${error}`)
    assert.match((error as Error).message, pattern)
    return true
  })

// --- Default layer (upgrade migration + fallback) ---

test('with no layers the default has to be created', () => {
  assert.equal(pickDefaultLayerId([]), null)
})

test('the default layer is the oldest one, whatever order rows come back in', () => {
  assert.equal(pickDefaultLayerId([{ id: 7 }, { id: 3 }, { id: 12 }]), 3)
})

test('the default layer name is the one the issue proposes', () => {
  assert.equal(DEFAULT_MARKER_LAYER_NAME, 'My Pins')
})

test('a pin with no layer named goes to the default layer', () => {
  assert.deepEqual(resolveMarkerLayerId(undefined, [{ id: 4 }, { id: 2 }]), {
    ok: true,
    layerId: 2,
  })
  assert.deepEqual(resolveMarkerLayerId(null, [{ id: 4 }]), { ok: true, layerId: 4 })
})

test('a pin for a named layer goes there, and an unknown layer is refused rather than redirected', () => {
  assert.deepEqual(resolveMarkerLayerId(4, [{ id: 2 }, { id: 4 }]), { ok: true, layerId: 4 })
  assert.deepEqual(resolveMarkerLayerId(9, [{ id: 2 }, { id: 4 }]), { ok: false })
})

// --- Export shape ---

test('an export is versioned and carries the layer name, styling, notes and route fields', () => {
  const exported = buildMarkerExport(
    [{ name: 'Water sources', visible: false, pins: [pin({ route_id: 'r1', route_order: 2 })] }],
    new Date('2026-11-03T12:00:00Z')
  )

  assert.deepEqual(exported, {
    format: 'nomad-map-pins',
    format_version: 1,
    exported_at: '2026-11-03T12:00:00.000Z',
    layers: [
      {
        name: 'Water sources',
        visible: false,
        pins: [pin({ route_id: 'r1', route_order: 2 })],
      },
    ],
  })
})

test('export never leaks local ids, layer ids or timestamps from the marker row', () => {
  const row = {
    ...pin(),
    id: 42,
    layer_id: 3,
    created_at: '2026-01-01',
    updated_at: '2026-01-02',
  } as unknown as ExportedPin
  const [exportedPin] = buildMarkerExport([{ name: 'L', visible: true, pins: [row] }], new Date())
    .layers[0].pins

  assert.deepEqual(Object.keys(exportedPin).sort(), Object.keys(pin()).sort())
})

test('mysql tinyint visibility is exported as a real boolean', () => {
  const row = { ...pin(), visible: 0 } as unknown as ExportedPin
  const exported = buildMarkerExport(
    [{ name: 'L', visible: 1 as unknown as boolean, pins: [row] }],
    new Date()
  )
  assert.equal(exported.layers[0].visible, true)
  assert.equal(exported.layers[0].pins[0].visible, false)
})

test('an export round-trips through import unchanged', async () => {
  const exported = buildMarkerExport(
    [
      {
        name: 'Trip: Moab 2026',
        visible: true,
        pins: [
          pin(),
          pin({ name: 'Camp', route_id: 'r', route_order: 0, custom_color: '#aabbcc' }),
        ],
      },
    ],
    new Date()
  )
  const parsed = await parseMarkerImport(JSON.parse(JSON.stringify(exported)))
  assert.equal(parsed.pinCount, 2)
  assert.deepEqual(parsed.layers, exported.layers)
})

test('export filenames are slugged so they are safe in a header', () => {
  const date = new Date('2026-11-03T12:00:00Z')
  assert.equal(
    markerExportFilename('Trip: Moab "2026"', date),
    'nomad-pins-trip-moab-2026-2026-11-03.json'
  )
  assert.equal(markerExportFilename(null, date), 'nomad-pins-all-layers-2026-11-03.json')
  assert.equal(markerExportFilename('水', date), 'nomad-pins-layer-2026-11-03.json')
})

// --- Import validation ---

test('import fills defaults for optional fields', async () => {
  const parsed = await parseMarkerImport(
    file([{ name: 'L', pins: [{ name: 'A', latitude: 1, longitude: 2 }] }])
  )
  assert.deepEqual(parsed.layers[0], {
    name: 'L',
    visible: true,
    pins: [
      pin({
        name: 'A',
        latitude: 1,
        longitude: 2,
        color: 'orange',
        icon: null,
        notes: null,
      }),
    ],
  })
})

test('import drops properties it does not know, so they never reach the database', async () => {
  const parsed = await parseMarkerImport(
    file([
      { name: 'L', id: 5, pins: [{ ...pin(), id: 99, layer_id: 1, created_at: 'x', evil: true }] },
    ])
  )
  assert.deepEqual(Object.keys(parsed.layers[0]).sort(), ['name', 'pins', 'visible'])
  assert.deepEqual(Object.keys(parsed.layers[0].pins[0]).sort(), Object.keys(pin()).sort())
})

test('non-objects and foreign JSON are refused as not a NOMAD file', async () => {
  for (const raw of [null, 'text', 42, [], {}, { type: 'FeatureCollection', features: [] }]) {
    await rejects(raw, /not a NOMAD pin export/)
  }
  await rejects(file([], { format: 'something-else' }), /not a NOMAD pin export/)
  await rejects(file([], { format_version: '1' }), /not a NOMAD pin export/)
})

test('a file from a newer NOMAD is refused rather than half-read', async () => {
  await rejects(
    file([{ name: 'L', pins: [] }], { format_version: MARKER_EXPORT_FORMAT_VERSION + 1 }),
    /newer version/
  )
})

test('coordinates out of range are refused', async () => {
  await rejects(
    file([{ name: 'L', pins: [pin({ latitude: 91 })] }]),
    /layers\.0\.pins\.0\.latitude/
  )
  await rejects(file([{ name: 'L', pins: [pin({ longitude: -180.5 })] }]), /longitude/)
})

test('numbers and booleans are strict: strings are not coerced', async () => {
  await rejects(file([{ name: 'L', pins: [{ ...pin(), latitude: '12' }] }]), /latitude/)
  await rejects(file([{ name: 'L', pins: [{ ...pin(), visible: 'true' }] }]), /visible/)
  await rejects(file([{ name: 'L', pins: [{ ...pin(), route_order: 1.5 }] }]), /route_order/)
})

test('styling fields must look like what the UI writes', async () => {
  await rejects(
    file([{ name: 'L', pins: [pin({ custom_color: 'red;background:url(x)' })] }]),
    /custom_color/
  )
  await rejects(
    file([{ name: 'L', pins: [pin({ icon: '<img src=x onerror=alert(1)>' })] }]),
    /icon/
  )
  await rejects(file([{ name: 'L', pins: [pin({ color: 'ORANGE!' })] }]), /color/)
})

test('text fields are length-capped like the marker CRUD endpoints', async () => {
  await rejects(file([{ name: 'L', pins: [pin({ name: 'x'.repeat(256) })] }]), /name/)
  await rejects(file([{ name: 'L', pins: [pin({ notes: 'x'.repeat(501) })] }]), /notes/)
  await rejects(file([{ name: 'x'.repeat(101), pins: [] }]), /layers\.0\.name/)
  await rejects(file([{ name: 'L', pins: [pin({ name: '   ' })] }]), /name/)
})

test('a file with no layers, or layers that are not arrays, is refused', async () => {
  await rejects(file([]), /layers/)
  await rejects(file({ name: 'L' }), /layers/)
  await rejects(file([{ name: 'L', pins: 'nope' }]), /pins/)
})

test('the total pin count is capped across layers, not just per layer', async () => {
  const half = Array.from({ length: MAX_MARKER_IMPORT_PINS / 2 + 1 }, () => pin())
  await rejects(
    file([
      { name: 'A', pins: half },
      { name: 'B', pins: half },
    ]),
    /at most 5000/
  )
})

// --- Import planning ---

test('route ids are replaced, consistently within the file', () => {
  let n = 0
  const remapped = remapRouteIds(
    [
      pin({ route_id: 'a', route_order: 0 }),
      pin({ route_id: 'b', route_order: 0 }),
      pin({ route_id: 'a', route_order: 1 }),
      pin(),
    ],
    () => `new-${++n}`
  )
  assert.deepEqual(
    remapped.map((p) => [p.route_id, p.route_order]),
    [
      ['new-1', 0],
      ['new-2', 0],
      ['new-1', 1],
      [null, null],
    ]
  )
})

test('merge skips pins with the same name and coordinates, including repeats within the file', () => {
  const existing = [{ name: 'Well', latitude: 1, longitude: 2 }]
  const { kept, skipped } = filterDuplicatePins(existing, [
    pin({ name: 'Well', latitude: 1, longitude: 2 }),
    pin({ name: 'Well', latitude: 1, longitude: 2.0001 }),
    pin({ name: 'Cache', latitude: 1, longitude: 2 }),
    pin({ name: 'Cache', latitude: 1, longitude: 2 }),
  ])
  assert.equal(skipped, 2)
  assert.deepEqual(
    kept.map((p) => [p.name, p.longitude]),
    [
      ['Well', 2.0001],
      ['Cache', 2],
    ]
  )
})

test('a new layer from an import never clashes with an existing name', () => {
  assert.equal(uniqueLayerName('Rally points', ['My Pins']), 'Rally points')
  assert.equal(uniqueLayerName('My Pins', ['my pins']), 'My Pins (2)')
  assert.equal(uniqueLayerName('My Pins', ['My Pins', 'My Pins (2)']), 'My Pins (3)')
  assert.equal(uniqueLayerName('x'.repeat(100), ['x'.repeat(100)]).length, 100)
})

test('the import summary reads like the issue example', () => {
  assert.equal(
    describeMarkerImport({ pins: 42, routes: 3, skipped: 0, layerNames: ['Rally points'] }),
    "Imported 42 pins and 3 routes into 'Rally points'"
  )
  assert.equal(
    describeMarkerImport({ pins: 1, routes: 0, skipped: 2, layerNames: ['A', 'B'] }),
    'Imported 1 pin into 2 layers (2 duplicates skipped)'
  )
})

// --- Map UI (inertia/lib/map_marker_layers.ts) ---

const layers = [
  { id: 2, visible: true },
  { id: 5, visible: false },
]

test('a pin shows only if both it and its layer are visible', () => {
  assert.equal(isMarkerShown({ visible: true, layerId: 2 }, layers), true)
  assert.equal(isMarkerShown({ visible: true, layerId: 5 }, layers), false)
  assert.equal(isMarkerShown({ visible: false, layerId: 2 }, layers), false)
})

test('a pin with no (or an unknown) layer is treated as in the default layer, as the server does', () => {
  assert.equal(effectiveLayerId({ layerId: null }, layers), 2)
  assert.equal(effectiveLayerId({ layerId: 99 }, layers), 2)
  assert.equal(isMarkerShown({ visible: true, layerId: null }, [{ id: 5, visible: false }]), false)
})

test('before layers load, pins show as they did before layers existed', () => {
  assert.equal(isMarkerShown({ visible: true, layerId: 3 }, []), true)
})

test('pin counts include every layer, empty ones too', () => {
  const counts = countPinsByLayer(
    [{ layerId: 2 }, { layerId: 2 }, { layerId: null }, { layerId: 5 }],
    [...layers, { id: 9, visible: true }]
  )
  assert.deepEqual(
    [...counts.entries()],
    [
      [2, 3],
      [5, 1],
      [9, 0],
    ]
  )
})

test('the import preview refuses oversized, non-JSON and foreign files before upload', () => {
  assert.deepEqual(previewImportFile('{}', 2 * 1024 * 1024), {
    ok: false,
    message: 'This file is too large to import (the limit is 1 MB).',
  })
  assert.equal(previewImportFile('{not json', 9).ok, false)
  assert.equal(previewImportFile('{"type":"FeatureCollection","features":[]}', 40).ok, false)
  assert.equal(previewImportFile('null', 4).ok, false)
})

test('the import preview counts layers and pins in a NOMAD export', () => {
  const text = JSON.stringify(
    buildMarkerExport(
      [
        { name: 'A', visible: true, pins: [pin(), pin()] },
        { name: 'B', visible: true, pins: [pin()] },
      ],
      new Date()
    )
  )
  const preview = previewImportFile(text, text.length)
  assert.equal(preview.ok, true)
  if (preview.ok) {
    assert.equal(preview.layerCount, 2)
    assert.equal(preview.pinCount, 3)
  }
})
