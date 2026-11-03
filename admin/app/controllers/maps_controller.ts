import { MapService } from '#services/map_service'
import MapMarker from '#models/map_marker'
import MapMarkerLayer from '#models/map_marker_layer'
import {
  assertNotPrivateUrl,
  createMarkerLayerValidator,
  downloadCollectionValidator,
  exportMarkerLayersQueryValidator,
  filenameParamValidator,
  importMarkerLayersValidator,
  mapExtractPreflightValidator,
  mapExtractValidator,
  remoteDownloadValidator,
  remoteDownloadValidatorOptional,
  updateMarkerLayerValidator,
} from '#validators/common'
import {
  DEFAULT_MARKER_LAYER_NAME,
  MarkerImportError,
  buildMarkerExport,
  describeMarkerImport,
  filterDuplicatePins,
  markerExportFilename,
  parseMarkerImport,
  remapRouteIds,
  resolveMarkerLayerId,
  uniqueLayerName,
  type ExportedPin,
  type ParsedMarkerImport,
} from '../utils/map_marker_layers.js'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'
import { randomUUID } from 'node:crypto'

@inject()
export default class MapsController {
  constructor(private mapService: MapService) {}

  async index({ inertia }: HttpContext) {
    const baseAssetsCheck = await this.mapService.ensureBaseAssets()
    const [regionFiles, worldBasemapExists] = await Promise.all([
      this.mapService.listRegions(),
      this.mapService.checkWorldBasemapExists(),
    ])
    return inertia.render('maps', {
      maps: {
        baseAssetsExist: baseAssetsCheck,
        worldBasemapExists,
        regionFiles: regionFiles.files,
      },
    })
  }

  async downloadBaseAssets({ request }: HttpContext) {
    const payload = await request.validateUsing(remoteDownloadValidatorOptional)
    if (payload.url) assertNotPrivateUrl(payload.url)
    await this.mapService.downloadBaseAssets(payload.url)
    return { success: true }
  }

  async setupWorldBasemap({ response }: HttpContext) {
    try {
      const ready = await this.mapService.provisionWorldBasemap()
      if (!ready) {
        return response.status(500).send({
          message:
            'Could not download the base map. Please connect this NOMAD to the internet and try again.',
        })
      }
      return { success: true }
    } catch {
      return response.status(500).send({
        message:
          'Could not download the base map. Please connect this NOMAD to the internet and try again.',
      })
    }
  }

  async downloadRemote({ request }: HttpContext) {
    const payload = await request.validateUsing(remoteDownloadValidator)
    assertNotPrivateUrl(payload.url)
    const filename = await this.mapService.downloadRemote(payload.url)
    return {
      message: 'Download started successfully',
      filename,
      url: payload.url,
    }
  }

  async downloadCollection({ request }: HttpContext) {
    const payload = await request.validateUsing(downloadCollectionValidator)
    const resources = await this.mapService.downloadCollection(payload.slug)
    return {
      message: 'Collection download started successfully',
      slug: payload.slug,
      resources,
    }
  }

  // For providing a "preflight" check in the UI before actually starting a background download
  async downloadRemotePreflight({ request }: HttpContext) {
    const payload = await request.validateUsing(remoteDownloadValidator)
    assertNotPrivateUrl(payload.url)
    const info = await this.mapService.downloadRemotePreflight(payload.url)
    return info
  }

  async fetchLatestCollections({}: HttpContext) {
    const success = await this.mapService.fetchLatestCollections()
    return { success }
  }

  async listCuratedCollections({}: HttpContext) {
    return await this.mapService.listCuratedCollections()
  }

  async listRegions({}: HttpContext) {
    return await this.mapService.listRegions()
  }

  async globalMapInfo({}: HttpContext) {
    return await this.mapService.getGlobalMapInfo()
  }

  async downloadGlobalMap({}: HttpContext) {
    const result = await this.mapService.downloadGlobalMap()
    return {
      message: 'Download started successfully',
      ...result,
    }
  }

  async listCountries({}: HttpContext) {
    return { countries: await this.mapService.listCountries() }
  }

  async listCountryGroups({}: HttpContext) {
    return { groups: await this.mapService.listCountryGroups() }
  }

  async extractPreflight({ request }: HttpContext) {
    const payload = await request.validateUsing(mapExtractPreflightValidator)
    return await this.mapService.extractPreflight(payload)
  }

  async extractRegion({ request }: HttpContext) {
    const payload = await request.validateUsing(mapExtractValidator)
    const result = await this.mapService.extractRegion(payload)
    return {
      message: 'Extract started successfully',
      ...result,
    }
  }

  async styles({ request, response }: HttpContext) {
    // Automatically ensure base assets are present before generating styles
    const baseAssetsExist = await this.mapService.ensureBaseAssets()
    if (!baseAssetsExist) {
      return response.status(500).send({
        message:
          'Base map assets are missing and could not be downloaded. Please check your connection and try again.',
      })
    }

    const forwardedProto = request.headers()['x-forwarded-proto'];

    const protocol: string = forwardedProto
      ? (typeof forwardedProto === 'string' ? forwardedProto : request.protocol())
      : request.protocol();

    const styles = await this.mapService.generateStylesJSON(request.host(), protocol)
    return response.json(styles)
  }

  async delete({ request, response }: HttpContext) {
    const payload = await request.validateUsing(filenameParamValidator)

    try {
      await this.mapService.delete(payload.params.filename)
    } catch (error) {
      if (error.message === 'not_found') {
        return response.status(404).send({
          message: `Map file with key ${payload.params.filename} not found`,
        })
      }
      throw error // Re-throw any other errors and let the global error handler catch
    }

    return {
      message: 'Map file deleted successfully',
    }
  }

  // --- Map Markers ---

  async listMarkers({}: HttpContext) {
    return await MapMarker.query().orderBy('created_at', 'asc')
  }

  async createMarker({ request, response }: HttpContext) {
    const payload = await request.validateUsing(
      vine.compile(
        vine.object({
          name: vine.string().trim().minLength(1).maxLength(255),
          longitude: vine.number().min(-180).max(180),
          latitude: vine.number().min(-90).max(90),
          color: vine.string().trim().maxLength(20).optional(),
          custom_color: vine.string().trim().maxLength(7).nullable().optional(),
          icon: vine.string().trim().maxLength(50).nullable().optional(),
          icon_color: vine.string().trim().maxLength(7).nullable().optional(),
          visible: vine.boolean().optional(),
          notes: vine.string().trim().maxLength(500).nullable().optional(),
          marker_type: vine.string().trim().maxLength(20).optional(),
          layer_id: vine.number().withoutDecimals().positive().nullable().optional(),
        })
      )
    )

    // A new pin goes into the layer the user picked, or the default layer
    // when the client doesn't name one (e.g. an older cached UI) (#1387).
    const target = resolveMarkerLayerId(payload.layer_id, await this.ensureMarkerLayers())
    if (!target.ok) {
      return response.status(422).send({ message: 'That layer no longer exists' })
    }

    const marker = await MapMarker.create({
      layer_id: target.layerId,
      name: payload.name,
      longitude: payload.longitude,
      latitude: payload.latitude,
      color: payload.color ?? 'orange',
      custom_color: payload.custom_color ?? null,
      icon: payload.icon ?? null,
      icon_color: payload.icon_color ?? null,
      visible: payload.visible ?? true,
      notes: payload.notes ?? null,
      marker_type: payload.marker_type ?? 'pin',
    })

    return marker
  }

  async updateMarker({ request, response }: HttpContext) {
    const { id } = request.params()
    const marker = await MapMarker.find(id)

    if (!marker) {
      return response.status(404).send({ message: 'Marker not found' })
    }

    const payload = await request.validateUsing(
      vine.compile(
        vine.object({
          name: vine.string().trim().minLength(1).maxLength(255).optional(),
          color: vine.string().trim().maxLength(20).optional(),
          custom_color: vine.string().trim().maxLength(7).nullable().optional(),
          icon: vine.string().trim().maxLength(50).nullable().optional(),
          icon_color: vine.string().trim().maxLength(7).nullable().optional(),
          visible: vine.boolean().optional(),
          longitude: vine.number().min(-180).max(180).optional(),
          latitude: vine.number().min(-90).max(90).optional(),
          notes: vine.string().trim().maxLength(500).nullable().optional(),
          marker_type: vine.string().trim().maxLength(20).optional(),
          layer_id: vine.number().withoutDecimals().positive().optional(),
        })
      )
    )

    if (payload.layer_id !== undefined && payload.layer_id !== marker.layer_id) {
      // A route and all its points stay in one layer together (#1387), so a
      // single route point can't be moved out on its own.
      if (marker.route_id) {
        return response
          .status(422)
          .send({ message: 'Pins that are part of a route cannot be moved to another layer' })
      }
      const target = resolveMarkerLayerId(payload.layer_id, await MapMarkerLayer.all())
      if (!target.ok) {
        return response.status(422).send({ message: 'That layer no longer exists' })
      }
      marker.layer_id = target.layerId
    }

    if (payload.name !== undefined) marker.name = payload.name
    if (payload.color !== undefined) marker.color = payload.color
    if (payload.custom_color !== undefined) marker.custom_color = payload.custom_color
    if (payload.icon !== undefined) marker.icon = payload.icon
    if (payload.icon_color !== undefined) marker.icon_color = payload.icon_color
    if (payload.visible !== undefined) marker.visible = payload.visible
    if (payload.longitude !== undefined) marker.longitude = payload.longitude
    if (payload.latitude !== undefined) marker.latitude = payload.latitude
    if (payload.notes !== undefined) marker.notes = payload.notes
    if (payload.marker_type !== undefined) marker.marker_type = payload.marker_type

    await marker.save()
    return marker
  }

  async deleteMarker({ request, response }: HttpContext) {
    const { id } = request.params()
    const marker = await MapMarker.find(id)
    if (!marker) {
      return response.status(404).send({ message: 'Marker not found' })
    }
    await marker.delete()
    return { message: 'Marker deleted' }
  }

  // --- Map Marker Layers (#1387) ---

  /**
   * All layers, oldest first, recreating the default one if none exist. The
   * migration creates it and deleteMarkerLayer refuses to remove the last one,
   * so this only fires if the table was emptied by hand -- but without it the
   * map would have nowhere to put a new pin.
   */
  private async ensureMarkerLayers(): Promise<MapMarkerLayer[]> {
    const layers = await MapMarkerLayer.query().orderBy('id', 'asc')
    if (layers.length > 0) return layers
    return [await MapMarkerLayer.create({ name: DEFAULT_MARKER_LAYER_NAME, visible: true })]
  }

  async listMarkerLayers({}: HttpContext) {
    return await this.ensureMarkerLayers()
  }

  async createMarkerLayer({ request }: HttpContext) {
    const payload = await request.validateUsing(createMarkerLayerValidator)
    return await MapMarkerLayer.create({ name: payload.name, visible: true })
  }

  async updateMarkerLayer({ request, response }: HttpContext) {
    const layer = await MapMarkerLayer.find(request.param('id'))
    if (!layer) {
      return response.status(404).send({ message: 'Layer not found' })
    }

    const payload = await request.validateUsing(updateMarkerLayerValidator)
    if (payload.name !== undefined) layer.name = payload.name
    if (payload.visible !== undefined) layer.visible = payload.visible

    await layer.save()
    return layer
  }

  async deleteMarkerLayer({ request, response }: HttpContext) {
    const layer = await MapMarkerLayer.find(request.param('id'))
    if (!layer) {
      return response.status(404).send({ message: 'Layer not found' })
    }

    // Keep at least one layer so a click on the map always has somewhere to
    // drop a pin; the user can rename the last one instead.
    const layerCount = await MapMarkerLayer.query().count('* as total')
    if (Number(layerCount[0].$extras.total) <= 1) {
      return response.status(409).send({ message: 'The last layer cannot be deleted' })
    }

    // Deleting a layer deletes its pins (the UI confirms first). Done
    // explicitly rather than relying only on the FK cascade.
    const deletedPins = await db.transaction(async (trx) => {
      const deleted = await MapMarker.query({ client: trx }).where('layer_id', layer.id).delete()
      layer.useTransaction(trx)
      await layer.delete()
      return Number(Array.isArray(deleted) ? deleted[0] : deleted) || 0
    })

    return { message: 'Layer deleted', deleted_pins: deletedPins }
  }

  /**
   * Download one layer (?layer_id=) or every layer as a versioned NOMAD JSON
   * file. Served as an attachment so the UI can link straight to it.
   */
  async exportMarkerLayers({ request, response }: HttpContext) {
    const { layer_id: layerId } = await request.validateUsing(exportMarkerLayersQueryValidator, {
      data: request.qs(),
    })

    const layers = layerId
      ? await MapMarkerLayer.query().where('id', layerId)
      : await this.ensureMarkerLayers()
    if (layerId && layers.length === 0) {
      return response.status(404).send({ message: 'Layer not found' })
    }

    // Creation order. Route grouping and order travel in each pin's route_id /
    // route_order, so a route survives the round trip unchanged.
    const markers = await MapMarker.query()
      .whereIn(
        'layer_id',
        layers.map((layer) => layer.id)
      )
      .orderBy('id', 'asc')

    const exportFile = buildMarkerExport(
      layers.map((layer) => ({
        name: layer.name,
        visible: layer.visible,
        pins: markers
          .filter((marker) => marker.layer_id === layer.id)
          .map((marker) => marker as unknown as ExportedPin),
      })),
      new Date()
    )

    const filename = markerExportFilename(layerId ? layers[0].name : null, new Date())
    response.header('Content-Disposition', `attachment; filename="${filename}"`)
    return response.json(exportFile)
  }

  /**
   * Import a NOMAD JSON pin export. `new` (default in the UI) creates a layer
   * per layer in the file and never touches existing pins; `merge` adds to a
   * chosen layer, skipping exact duplicates; `replace` empties a chosen layer
   * first. Everything runs in one transaction so a failure leaves no partial
   * import behind.
   */
  async importMarkerLayers({ request, response }: HttpContext) {
    const payload = await request.validateUsing(importMarkerLayersValidator)

    let parsed: ParsedMarkerImport
    try {
      parsed = await parseMarkerImport(payload.file)
    } catch (error) {
      if (error instanceof MarkerImportError) {
        return response.status(422).send({ message: error.message })
      }
      throw error
    }

    const existingLayers = await this.ensureMarkerLayers()
    const target =
      payload.mode === 'new'
        ? null
        : existingLayers.find((layer) => layer.id === payload.target_layer_id)
    if (payload.mode !== 'new' && !target) {
      return response.status(422).send({ message: 'Choose an existing layer to import into' })
    }

    const toRows = (pins: ExportedPin[], layerId: number) =>
      // Fresh route ids per file layer, so imported routes can't collide with
      // (or splice into) routes already on this box.
      remapRouteIds(pins, randomUUID).map((pin) => ({ ...pin, layer_id: layerId }))

    const result = await db.transaction(async (trx) => {
      let rows: Array<ExportedPin & { layer_id: number }> = []
      let skipped = 0
      const layerNames: string[] = []

      if (!target) {
        const names = existingLayers.map((layer) => layer.name)
        for (const fileLayer of parsed.layers) {
          const name = uniqueLayerName(fileLayer.name, names)
          names.push(name)
          const layer = await MapMarkerLayer.create(
            { name, visible: fileLayer.visible },
            { client: trx }
          )
          layerNames.push(layer.name)
          rows.push(...toRows(fileLayer.pins, layer.id))
        }
      } else {
        layerNames.push(target.name)
        const incoming = parsed.layers.flatMap((fileLayer) => toRows(fileLayer.pins, target.id))

        if (payload.mode === 'replace') {
          await MapMarker.query({ client: trx }).where('layer_id', target.id).delete()
          rows = incoming
        } else {
          const existing = await MapMarker.query({ client: trx })
            .where('layer_id', target.id)
            .select('name', 'latitude', 'longitude')
          const filtered = filterDuplicatePins(existing, incoming)
          rows = filtered.kept
          skipped = filtered.skipped
        }
      }

      if (rows.length > 0) {
        await MapMarker.createMany(rows, { client: trx })
      }

      const routes = new Set(rows.map((row) => row.route_id).filter((id) => id !== null)).size
      return { pins: rows.length, routes, skipped, layerNames }
    })

    return {
      message: describeMarkerImport(result),
      imported_pins: result.pins,
      imported_routes: result.routes,
      skipped_duplicates: result.skipped,
    }
  }
}
