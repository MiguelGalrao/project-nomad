import { DateTime } from 'luxon'
import { BaseModel, column, SnakeCaseNamingStrategy } from '@adonisjs/lucid/orm'

/**
 * A named group of map pins (#1387). Not to be confused with MapLibre style
 * layers in map_service.ts, hence `map_marker_layers`.
 */
export default class MapMarkerLayer extends BaseModel {
  static table = 'map_marker_layers'
  static namingStrategy = new SnakeCaseNamingStrategy()

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column({
    // tinyint(1) comes back from mysql2 as 1/0; see MapMarker.visible.
    consume: (value: number | boolean) => Boolean(value),
  })
  declare visible: boolean

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime
}
