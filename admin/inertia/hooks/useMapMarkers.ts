// eslint-disable-next-line @unicorn/filename-case
import { useCallback, useEffect, useState } from 'react'

import api from '~/lib/api'
import type { MapMarkerLayerResponse, MapMarkerResponse } from '../../types/maps'

export const PIN_COLORS = [
  { id: 'orange', label: 'Orange', hex: '#a84a12' },
  { id: 'red', label: 'Red', hex: '#994444' },
  { id: 'green', label: 'Green', hex: '#424420' },
  { id: 'blue', label: 'Blue', hex: '#2563eb' },
  { id: 'purple', label: 'Purple', hex: '#7c3aed' },
  { id: 'yellow', label: 'Yellow', hex: '#ca8a04' },
] as const

export type PinColorId = (typeof PIN_COLORS)[number]['id']

export type MarkerIcon = 'pin' | 'circle' | 'star'

export interface MapMarker {
  id: number
  name: string
  longitude: number
  latitude: number
  color: PinColorId
  customColor?: string | null
  icon?: MarkerIcon | string | null
  iconColor?: string | null
  visible: boolean
  notes?: string | null
  layerId: number | null
  createdAt: string
  updatedAt?: string
}

/** A named group of pins (#1387). */
export interface MapMarkerLayer {
  id: number
  name: string
  visible: boolean
}

type CreateMapMarkerValues = {
  name: string
  longitude: number
  latitude: number
  color?: PinColorId
  customColor?: string | null
  icon?: MarkerIcon | string | null
  iconColor?: string | null
  visible?: boolean
  notes?: string | null
  layerId?: number | null
}

type UpdateMapMarkerValues = {
  name?: string
  color?: PinColorId
  customColor?: string | null
  icon?: MarkerIcon | string | null
  iconColor?: string | null
  visible?: boolean
  notes?: string | null
  layerId?: number
}

const mapMarkerResponse = (marker: MapMarkerResponse): MapMarker => ({
  id: marker.id,
  name: marker.name,
  longitude: marker.longitude,
  latitude: marker.latitude,
  color: marker.color as PinColorId,
  customColor: marker.custom_color ?? null,
  icon: marker.icon ?? null,
  iconColor: marker.icon_color ?? null,
  visible: marker.visible ?? true,
  notes: marker.notes ?? null,
  layerId: marker.layer_id ?? null,
  createdAt: marker.created_at,
  updatedAt: marker.updated_at,
})

const mapLayerResponse = (layer: MapMarkerLayerResponse): MapMarkerLayer => ({
  id: layer.id,
  name: layer.name,
  visible: Boolean(layer.visible),
})

export function useMapMarkers() {
  const [markers, setMarkers] = useState<MapMarker[]>([])
  const [layers, setLayers] = useState<MapMarkerLayer[]>([])
  const [loaded, setLoaded] = useState(false)

  // Pins and layers load together; an import adds both, so it reloads both.
  const reload = useCallback(async () => {
    const [markerData, layerData] = await Promise.all([
      api.listMapMarkers(),
      api.listMapMarkerLayers(),
    ])

    if (markerData) setMarkers(markerData.map(mapMarkerResponse))
    if (layerData) setLayers(layerData.map(mapLayerResponse))
    setLoaded(true)
  }, [])

  // Load markers from API on mount
  useEffect(() => {
    reload()
  }, [reload])

  const addMarker = useCallback(async (values: CreateMapMarkerValues) => {
    const result = await api.createMapMarker({
      name: values.name,
      longitude: values.longitude,
      latitude: values.latitude,
      color: values.color ?? 'orange',
      custom_color: values.customColor ?? null,
      icon: values.icon ?? null,
      icon_color: values.iconColor ?? null,
      visible: values.visible ?? true,
      notes: values.notes ?? null,
      layer_id: values.layerId ?? null,
    })

    if (result) {
      const marker = mapMarkerResponse(result)
      setMarkers((prev) => [...prev, marker])
      return marker
    }

    return null
  }, [])

  const updateMarker = useCallback(async (id: number, updates: UpdateMapMarkerValues) => {
    const result = await api.updateMapMarker(id, {
      name: updates.name,
      color: updates.color,
      custom_color: updates.customColor,
      icon: updates.icon,
      icon_color: updates.iconColor,
      visible: updates.visible,
      notes: updates.notes,
      layer_id: updates.layerId,
    })

    if (result) {
      const marker = mapMarkerResponse(result)

      setMarkers((prev) =>
        prev.map((existingMarker) => (existingMarker.id === id ? marker : existingMarker))
      )

      return marker
    }

    return null
  }, [])

  const deleteMarker = useCallback(async (id: number) => {
    await api.deleteMapMarker(id)
    setMarkers((prev) => prev.filter((marker) => marker.id !== id))
  }, [])

  const addLayer = useCallback(async (name: string) => {
    const result = await api.createMapMarkerLayer(name)
    if (!result) return null

    const layer = mapLayerResponse(result)
    setLayers((prev) => [...prev, layer])
    return layer
  }, [])

  const updateLayer = useCallback(
    async (id: number, updates: { name?: string; visible?: boolean }) => {
      const result = await api.updateMapMarkerLayer(id, updates)
      if (!result) return null

      const layer = mapLayerResponse(result)
      setLayers((prev) => prev.map((existing) => (existing.id === id ? layer : existing)))
      return layer
    },
    []
  )

  // Deleting a layer deletes its pins server-side, so drop them here too.
  const deleteLayer = useCallback(async (id: number) => {
    const result = await api.deleteMapMarkerLayer(id)
    if (!result) return false

    setLayers((prev) => prev.filter((layer) => layer.id !== id))
    setMarkers((prev) => prev.filter((marker) => marker.layerId !== id))
    return true
  }, [])

  return {
    markers,
    layers,
    loaded,
    reload,
    addMarker,
    updateMarker,
    deleteMarker,
    addLayer,
    updateLayer,
    deleteLayer,
  }
}
