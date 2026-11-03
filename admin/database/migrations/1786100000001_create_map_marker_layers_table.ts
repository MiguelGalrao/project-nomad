import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  DEFAULT_MARKER_LAYER_NAME,
  MARKER_LAYER_NAME_MAX_LENGTH,
  pickDefaultLayerId,
} from '../../app/utils/map_marker_layers.js'

/**
 * Map pin layers (#1387). Named `map_marker_layers` rather than `layers`
 * because "layer" already means a MapLibre style layer in map_service.ts.
 *
 * Every existing pin is moved into a "My Pins" layer so nothing changes for a
 * current user until they create a second layer. `layer_id` stays nullable at
 * the schema level so this alter can never fail on an existing row; the
 * controller always sets it, and the backfill below leaves no pin without one.
 */
export default class extends BaseSchema {
  protected tableName = 'map_marker_layers'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table.string('name', MARKER_LAYER_NAME_MAX_LENGTH).notNullable()
      table.boolean('visible').notNullable().defaultTo(true)
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()
    })

    this.schema.alterTable('map_markers', (table) => {
      // CASCADE backs up the controller, which deletes a layer's pins itself
      // inside the same transaction: "delete layer" means delete its pins.
      table
        .integer('layer_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable(this.tableName)
        .onDelete('CASCADE')
    })

    this.defer(async (db) => {
      const existing = await db.from(this.tableName).select('id')
      let defaultLayerId = pickDefaultLayerId(existing)

      // Created even when there are no pins yet, so a fresh install has a
      // layer to drop the first pin into.
      if (defaultLayerId === null) {
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
        const [id] = await db.table(this.tableName).insert({
          name: DEFAULT_MARKER_LAYER_NAME,
          visible: true,
          created_at: now,
          updated_at: now,
        })
        defaultLayerId = Number(id)
      }

      await db.from('map_markers').whereNull('layer_id').update({ layer_id: defaultLayerId })
    })
  }

  async down() {
    this.schema.alterTable('map_markers', (table) => {
      table.dropForeign(['layer_id'])
      table.dropColumn('layer_id')
    })
    this.schema.dropTable(this.tableName)
  }
}
