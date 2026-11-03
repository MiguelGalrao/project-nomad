import { useState } from 'react'
import {
  IconCheck,
  IconDownload,
  IconPencil,
  IconPlus,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons-react'

import StyledModal from '~/components/StyledModal'
import api from '~/lib/api'
import type { MapMarkerLayer } from '~/hooks/useMapMarkers'
import { MARKER_LAYER_NAME_MAX_LENGTH } from '../../../constants/map_marker_layers'

import MarkerImportModal from './MarkerImportModal'

type MarkerLayersSectionProps = {
  layers: MapMarkerLayer[]
  pinCounts: Map<number, number>
  /** The layer a newly dropped pin goes into. */
  activeLayerId: number | null
  onSelectActive: (id: number) => void
  onToggleVisibility: (id: number, visible: boolean) => void
  onCreate: (name: string) => Promise<unknown>
  onRename: (id: number, name: string) => Promise<unknown>
  onDelete: (id: number) => Promise<unknown>
  onImported: () => void
}

// Same field styling as the "Search pins..." box below it.
const textInputClass =
  'block w-full min-w-0 rounded border border-border-default bg-surface-primary px-2 py-1 text-sm text-text-primary placeholder:text-text-muted focus:border-desert-green focus:outline-none'

const iconButtonClass =
  'shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-surface-secondary hover:text-text-primary'

/**
 * The layers list at the top of the pins panel (#1387): a visibility checkbox
 * per layer, click a name to make it the layer new pins go into, and
 * create / rename / delete / export / import.
 */
export default function MarkerLayersSection({
  layers,
  pinCounts,
  activeLayerId,
  onSelectActive,
  onToggleVisibility,
  onCreate,
  onRename,
  onDelete,
  onImported,
}: MarkerLayersSectionProps) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [pendingDelete, setPendingDelete] = useState<MapMarkerLayer | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const submitCreate = async () => {
    const name = newName.trim()
    if (!name) return
    await onCreate(name)
    setNewName('')
    setCreating(false)
  }

  const submitRename = async () => {
    const name = renameValue.trim()
    if (renamingId === null || !name) return
    await onRename(renamingId, name)
    setRenamingId(null)
  }

  const pendingDeleteCount = pendingDelete ? (pinCounts.get(pendingDelete.id) ?? 0) : 0

  return (
    <div className="border-b border-border-subtle px-3 py-2">
      <div className="mb-1 flex items-center gap-1">
        <span className="flex-1 text-xs font-semibold text-text-secondary">Layers</span>

        <button
          type="button"
          onClick={() => {
            setCreating(true)
            setRenamingId(null)
          }}
          className={iconButtonClass}
          title="New layer"
          aria-label="New layer"
        >
          <IconPlus size={14} />
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className={iconButtonClass}
          title="Import pins"
          aria-label="Import pins"
        >
          <IconUpload size={14} />
        </button>
        <a
          href={api.mapMarkerLayerExportUrl()}
          download
          className={iconButtonClass}
          title="Export all layers"
          aria-label="Export all layers"
        >
          <IconDownload size={14} />
        </a>
      </div>

      <ul className="max-h-40 overflow-y-auto">
        {layers.map((layer) => {
          const active = layer.id === activeLayerId
          const count = pinCounts.get(layer.id) ?? 0

          if (renamingId === layer.id) {
            return (
              <li key={layer.id} className="flex items-center gap-1 py-1">
                <input
                  autoFocus
                  type="text"
                  value={renameValue}
                  maxLength={MARKER_LAYER_NAME_MAX_LENGTH}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  className={textInputClass}
                  aria-label="Layer name"
                />
                <button
                  type="button"
                  onClick={submitRename}
                  disabled={!renameValue.trim()}
                  className={iconButtonClass}
                  title="Save name"
                  aria-label="Save name"
                >
                  <IconCheck size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setRenamingId(null)}
                  className={iconButtonClass}
                  title="Cancel"
                  aria-label="Cancel"
                >
                  <IconX size={14} />
                </button>
              </li>
            )
          }

          return (
            <li
              key={layer.id}
              className={`group flex items-center gap-2 rounded px-1 py-1 transition-colors ${
                active ? 'bg-desert-green/10' : 'hover:bg-surface-secondary'
              }`}
            >
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={(e) => onToggleVisibility(layer.id, e.target.checked)}
                className="h-4 w-4 shrink-0 cursor-pointer rounded accent-desert-green"
                aria-label={`Show layer ${layer.name}`}
                title={layer.visible ? 'Hide layer' : 'Show layer'}
              />

              <button
                type="button"
                onClick={() => onSelectActive(layer.id)}
                className="min-w-0 flex-1 text-left"
                title={active ? 'New pins go into this layer' : 'Put new pins in this layer'}
              >
                <p
                  className={`truncate text-sm text-text-primary ${active ? 'font-semibold' : 'font-medium'} ${
                    layer.visible ? '' : 'opacity-60'
                  }`}
                >
                  {layer.name}
                </p>
              </button>

              <span className="shrink-0 text-[11px] text-text-muted">{count}</span>

              <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => {
                    setRenamingId(layer.id)
                    setRenameValue(layer.name)
                    setCreating(false)
                  }}
                  className={iconButtonClass}
                  title="Rename layer"
                  aria-label={`Rename layer ${layer.name}`}
                >
                  <IconPencil size={14} />
                </button>
                <a
                  href={api.mapMarkerLayerExportUrl(layer.id)}
                  download
                  className={iconButtonClass}
                  title="Export layer"
                  aria-label={`Export layer ${layer.name}`}
                >
                  <IconDownload size={14} />
                </a>
                {/* The last layer can't be deleted: a click on the map always
                    needs a layer to drop the pin into. */}
                {layers.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setPendingDelete(layer)}
                    className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-surface-secondary hover:text-desert-red"
                    title="Delete layer"
                    aria-label={`Delete layer ${layer.name}`}
                  >
                    <IconTrash size={14} />
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {creating && (
        <div className="mt-1 flex items-center gap-1">
          <input
            autoFocus
            type="text"
            placeholder="Layer name"
            value={newName}
            maxLength={MARKER_LAYER_NAME_MAX_LENGTH}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCreate()
              if (e.key === 'Escape') setCreating(false)
            }}
            className={textInputClass}
            aria-label="New layer name"
          />
          <button
            type="button"
            onClick={submitCreate}
            disabled={!newName.trim()}
            className={iconButtonClass}
            title="Create layer"
            aria-label="Create layer"
          >
            <IconCheck size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false)
              setNewName('')
            }}
            className={iconButtonClass}
            title="Cancel"
            aria-label="Cancel"
          >
            <IconX size={14} />
          </button>
        </div>
      )}

      <StyledModal
        open={pendingDelete !== null}
        title={`Delete layer '${pendingDelete?.name ?? ''}'?`}
        onClose={() => setPendingDelete(null)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return
          setDeleting(true)
          try {
            await onDelete(pendingDelete.id)
            setPendingDelete(null)
          } finally {
            setDeleting(false)
          }
        }}
        confirmText="Delete layer"
        confirmIcon="IconTrash"
        confirmVariant="danger"
        confirmLoading={deleting}
      >
        <p className="text-sm text-text-secondary">
          {pendingDeleteCount === 0
            ? 'This layer has no pins.'
            : `This also permanently deletes the ${pendingDeleteCount} ${
                pendingDeleteCount === 1 ? 'pin' : 'pins'
              } in it. Export the layer first if you may want them back.`}
        </p>
      </StyledModal>

      <MarkerImportModal
        open={importOpen}
        layers={layers}
        pinCounts={pinCounts}
        defaultTargetLayerId={activeLayerId}
        onClose={() => setImportOpen(false)}
        onImported={onImported}
      />
    </div>
  )
}
