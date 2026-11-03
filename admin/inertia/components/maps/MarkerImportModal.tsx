import { useEffect, useRef, useState } from 'react'

import StyledModal from '~/components/StyledModal'
import StyledButton from '~/components/StyledButton'
import Select from '~/components/inputs/Select'
import { useNotifications } from '~/context/NotificationContext'
import api from '~/lib/api'
import { previewImportFile, type ImportFilePreview } from '~/lib/map_marker_layers'
import type { MapMarkerLayer } from '~/hooks/useMapMarkers'
import {
  MAX_MARKER_IMPORT_BYTES,
  type MarkerImportMode,
} from '../../../constants/map_marker_layers'

type MarkerImportModalProps = {
  open: boolean
  layers: MapMarkerLayer[]
  pinCounts: Map<number, number>
  /** Pre-selected target for merge/replace: the layer new pins currently go into. */
  defaultTargetLayerId: number | null
  onClose: () => void
  onImported: () => void
}

const MODE_OPTIONS: Array<{ value: MarkerImportMode; label: string; help: string }> = [
  {
    value: 'new',
    label: 'Add as a new layer',
    help: 'Creates a new layer named from the file. Existing pins are not touched.',
  },
  {
    value: 'merge',
    label: 'Merge into an existing layer',
    help: 'Adds the pins to a layer. Pins with the same name and coordinates are skipped.',
  },
  {
    value: 'replace',
    label: 'Replace an existing layer',
    help: "Removes that layer's pins, then imports the file. Other layers are not affected.",
  },
]

/**
 * Import a NOMAD JSON pin export (#1387). The file is read and sanity-checked
 * in the browser so an obviously wrong file fails before upload, then the
 * server validates every field and does the import in one transaction.
 */
export default function MarkerImportModal({
  open,
  layers,
  pinCounts,
  defaultTargetLayerId,
  onClose,
  onImported,
}: MarkerImportModalProps) {
  const { addNotification } = useNotifications()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [fileName, setFileName] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportFilePreview | null>(null)
  const [mode, setMode] = useState<MarkerImportMode>('new')
  const [targetLayerId, setTargetLayerId] = useState<number | null>(defaultTargetLayerId)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Start fresh each time the modal opens.
  useEffect(() => {
    if (!open) return
    setFileName(null)
    setPreview(null)
    setMode('new')
    setTargetLayerId(defaultTargetLayerId)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [open, defaultTargetLayerId])

  const targetLayer = layers.find((layer) => layer.id === targetLayerId) ?? null
  const needsTarget = mode !== 'new'
  const canImport = preview?.ok === true && (!needsTarget || targetLayer !== null) && !importing

  const handleFile = async (file: File | undefined) => {
    setError(null)
    if (!file) {
      setFileName(null)
      setPreview(null)
      return
    }

    setFileName(file.name)
    // Check the size before reading so a huge file is never pulled into memory.
    const text = file.size <= MAX_MARKER_IMPORT_BYTES ? await file.text() : ''
    setPreview(previewImportFile(text, file.size))
  }

  const handleImport = async () => {
    if (!canImport || preview?.ok !== true) return

    setImporting(true)
    setError(null)
    try {
      const result = await api.importMapMarkerLayers({
        mode,
        target_layer_id: needsTarget && targetLayer ? targetLayer.id : undefined,
        file: preview.file,
      })

      if (!result.ok) {
        setError(result.message)
        return
      }

      addNotification({ message: result.data.message, type: 'success' })
      onImported()
      onClose()
    } finally {
      setImporting(false)
    }
  }

  const replacing = mode === 'replace' && targetLayer !== null
  const replacedCount = targetLayer ? (pinCounts.get(targetLayer.id) ?? 0) : 0

  return (
    <StyledModal
      open={open}
      title="Import pins"
      onClose={onClose}
      onCancel={onClose}
      onConfirm={handleImport}
      confirmText={replacing ? 'Replace layer' : 'Import'}
      confirmIcon="IconUpload"
      confirmVariant={replacing ? 'danger' : 'action'}
      confirmLoading={importing}
      confirmDisabled={!canImport}
    >
      <div className="space-y-4 text-left">
        <p className="text-sm text-text-secondary">
          Choose a pin file exported from Project NOMAD (.json).
        </p>

        <div className="flex items-center gap-3">
          <StyledButton
            variant="outline"
            size="sm"
            icon="IconUpload"
            onClick={() => fileInputRef.current?.click()}
          >
            Choose file
          </StyledButton>
          <span className="min-w-0 truncate text-sm text-text-muted">
            {fileName ?? 'No file chosen'}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            aria-label="Pin file to import"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>

        {preview?.ok === true && (
          <p className="text-sm text-text-primary">
            {preview.pinCount} {preview.pinCount === 1 ? 'pin' : 'pins'} in {preview.layerCount}{' '}
            {preview.layerCount === 1 ? 'layer' : 'layers'}.
          </p>
        )}
        {preview?.ok === false && <p className="text-sm text-desert-red">{preview.message}</p>}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text-primary">Import as:</legend>
          {MODE_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-start gap-3">
              <input
                type="radio"
                name="marker-import-mode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => setMode(option.value)}
                className="mt-1 text-desert-green focus:ring-desert-green"
              />
              <span>
                <span className="block text-sm font-medium text-text-primary">{option.label}</span>
                <span className="block text-xs text-text-muted">{option.help}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {needsTarget && (
          <Select<number | null>
            name="marker-import-target"
            label="Layer:"
            value={targetLayerId}
            onChange={setTargetLayerId}
            options={layers.map((layer) => ({ value: layer.id, label: layer.name }))}
            placeholder="Choose a layer"
          />
        )}

        {replacing && (
          <p className="text-sm text-desert-red">
            {replacedCount === 0
              ? `'${targetLayer.name}' is empty; the file's pins will be added to it.`
              : `The ${replacedCount} ${replacedCount === 1 ? 'pin' : 'pins'} in '${targetLayer.name}' will be permanently deleted before importing.`}
          </p>
        )}

        {error && <p className="text-sm text-desert-red">{error}</p>}
      </div>
    </StyledModal>
  )
}
