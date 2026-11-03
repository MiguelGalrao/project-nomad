export type BaseStylesFile = {
  version: number
  sources: {
    [key: string]: MapSource
  }
  layers: MapLayer[]
  sprite: string
  glyphs: string
}

export type MapSource = {
  type: 'vector' | 'raster' | 'raster-dem' | 'geojson' | 'image' | 'video'
  attribution?: string
  url: string
}

export type MapLayer = {
  'id': string
  'type': string
  'source'?: string
  'source-layer'?: string
  [key: string]: any
}

/** ISO 3166-1 alpha-2 country code (e.g. "DE", "FR", "US"). */
export type CountryCode = string

export type Country = {
  code: CountryCode
  code3: string
  name: string
  continent: string
  subregion: string
  population: number
}

export type CountryGroup = {
  id: string
  name: string
  description: string
  countries: CountryCode[]
}

export type MapExtractRequest = {
  countries: CountryCode[]
  maxzoom?: number
}

export type MapExtractPreflight = {
  tiles: number
  bytes: number
  source: {
    url: string
    date: string
    key: string
  }
}

export type CreateMapMarkerPayload = {
  name: string
  notes?: string | null
  longitude: number
  latitude: number
  color?: string
  custom_color?: string | null
  icon?: string | null
  icon_color?: string | null
  visible?: boolean
  layer_id?: number | null
}

export type UpdateMapMarkerPayload = Partial<CreateMapMarkerPayload>

export type MapMarkerResponse = {
  id: number
  name: string
  longitude: number
  latitude: number
  color: string
  custom_color?: string | null
  icon?: string | null
  icon_color?: string | null
  visible?: boolean
  notes?: string | null
  layer_id?: number | null
  created_at: string
  updated_at?: string
}

/** A named group of pins (#1387); not a MapLibre style layer. */
export type MapMarkerLayerResponse = {
  id: number
  name: string
  visible: boolean
  created_at: string
  updated_at?: string
}

export type ImportMapMarkerLayersPayload = {
  mode: 'new' | 'merge' | 'replace'
  target_layer_id?: number
  /** The parsed NOMAD JSON export; validated server-side. */
  file: unknown
}

export type ImportMapMarkerLayersResponse = {
  message: string
  imported_pins: number
  imported_routes: number
  skipped_duplicates: number
}
