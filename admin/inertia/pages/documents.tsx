import { useEffect, useRef, useState } from 'react'
import { Head } from '@inertiajs/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconSearch } from '@tabler/icons-react'
import AppLayout from '~/layouts/AppLayout'
import Input from '~/components/inputs/Input'
import StyledButton from '~/components/StyledButton'
import StyledModal from '~/components/StyledModal'
import StyledSectionHeader from '~/components/StyledSectionHeader'
import StyledTable from '~/components/StyledTable'
import FileUploader from '~/components/file-uploader'
import { useNotifications } from '~/context/NotificationContext'
import api from '~/lib/api'
import type { KbTextDocument, KbTextSearchHit } from '../../types/kb_text_search'

const DEBOUNCE_MS = 350

/**
 * Documents — keyword search inside knowledge base uploads (#1182).
 *
 * Works without the AI Assistant: the text is extracted and indexed in MySQL
 * independently of Ollama/Qdrant. Uploads go through the same endpoint as the
 * AI Knowledge Base, so a file added here is also embedded if AI is installed.
 */
export default function Documents() {
  const queryClient = useQueryClient()
  const { addNotification } = useNotifications()
  const fileUploaderRef = useRef<React.ComponentRef<typeof FileUploader>>(null)

  const [files, setFiles] = useState<File[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [confirmDeleteSource, setConfirmDeleteSource] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const { data: documents = [], isLoading: isLoadingDocuments } = useQuery({
    queryKey: ['keywordDocuments'],
    queryFn: async () => (await api.listKeywordDocuments()) ?? [],
    // Indexing runs in the background after an upload or rescan; poll so new
    // files show up without a manual refresh.
    refetchInterval: 10000,
  })

  const { data: searchResult, isFetching: isSearching } = useQuery({
    queryKey: ['keywordSearch', debouncedQuery],
    queryFn: () => api.searchKeywordDocuments(debouncedQuery),
    enabled: debouncedQuery.length > 0,
  })

  const rescanMutation = useMutation({
    mutationFn: () => api.rescanKeywordDocuments(),
    onSuccess: (data) => {
      if (data) addNotification({ type: 'success', message: data.message })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (source: string) => api.deleteKeywordDocument(source),
    onSuccess: (data) => {
      if (data) addNotification({ type: 'success', message: data.message })
      queryClient.invalidateQueries({ queryKey: ['keywordDocuments'] })
      queryClient.invalidateQueries({ queryKey: ['keywordSearch'] })
    },
    onSettled: () => setConfirmDeleteSource(null),
  })

  const handleUpload = async () => {
    if (files.length === 0) return
    setIsUploading(true)
    let successCount = 0
    for (const file of files) {
      const result = await api.uploadDocument(file)
      if (result) successCount++
      else addNotification({ type: 'error', message: `Failed to upload: ${file.name}` })
    }
    setIsUploading(false)
    setFiles([])
    fileUploaderRef.current?.clear()
    if (successCount > 0) {
      addNotification({
        type: 'success',
        message: `${successCount} file${successCount > 1 ? 's' : ''} uploaded. ${
          successCount > 1 ? 'They' : 'It'
        } will be searchable once indexed.`,
      })
    }
    queryClient.invalidateQueries({ queryKey: ['keywordDocuments'] })
  }

  const downloadHref = (source: string) =>
    `/api/rag/files/download?source=${encodeURIComponent(source)}`

  const results: KbTextSearchHit[] = searchResult?.results ?? []

  return (
    <AppLayout>
      <Head title="Documents" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-10">
        <section>
          <StyledSectionHeader title="Search Your Documents" />
          <p className="text-sm text-text-secondary mb-4">
            Find text inside the PDFs, Word documents, EPUBs and text files you have uploaded. No AI
            needed. Scanned PDFs without a text layer and images are not searchable here.
          </p>
          <Input
            name="document-search"
            label="Search:"
            placeholder="Words to find in your documents"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            leftIcon={<IconSearch className="h-5 w-5 text-text-muted" />}
            autoComplete="off"
          />
          {debouncedQuery && (
            <div className="mt-4">
              {isSearching && results.length === 0 ? (
                <p className="text-sm text-text-muted">Searching…</p>
              ) : results.length === 0 ? (
                <p className="text-sm text-text-muted">No matches for “{debouncedQuery}”.</p>
              ) : (
                <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface-primary">
                  {results.map((hit, i) => (
                    <li key={`${hit.source}-${i}`} className="p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <a
                          href={downloadHref(hit.source)}
                          className="font-semibold text-text-primary hover:text-desert-green transition-colors break-all"
                        >
                          {hit.fileName}
                        </a>
                        {hit.page !== null && (
                          <span className="text-xs text-text-muted">Page {hit.page}</span>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-text-secondary">
                        {hit.snippet.map((seg, j) =>
                          seg.match ? (
                            <mark
                              key={j}
                              className="rounded-sm bg-desert-orange/25 px-0.5 font-semibold text-text-primary"
                            >
                              {seg.text}
                            </mark>
                          ) : (
                            <span key={j}>{seg.text}</span>
                          )
                        )}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section>
          <StyledSectionHeader title="Upload Documents" />
          <div className="bg-surface-primary rounded-lg border shadow-md overflow-hidden p-6">
            <FileUploader
              ref={fileUploaderRef}
              minFiles={1}
              maxFiles={5}
              onUpload={(uploadedFiles) => setFiles(Array.from(uploadedFiles))}
            />
            <div className="flex justify-center mt-6">
              <StyledButton
                variant="primary"
                size="lg"
                icon="IconUpload"
                onClick={handleUpload}
                disabled={files.length === 0 || isUploading}
                loading={isUploading}
              >
                Upload
              </StyledButton>
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-6 gap-2 flex-wrap">
            <StyledSectionHeader title="Indexed Documents" className="!mb-0" />
            <StyledButton
              variant="secondary"
              icon="IconRefresh"
              onClick={() => rescanMutation.mutate()}
              loading={rescanMutation.isPending}
            >
              Rescan
            </StyledButton>
          </div>
          <StyledTable<KbTextDocument>
            className="font-semibold"
            loading={isLoadingDocuments}
            noDataText="No documents indexed yet. Upload a file above, or use Rescan to pick up files already in storage."
            data={documents}
            columns={[
              {
                accessor: 'fileName',
                title: 'File',
                render: (record) => (
                  <span className="text-text-primary" title={record.fileName}>
                    {record.fileName}
                  </span>
                ),
              },
              {
                accessor: 'chunkCount',
                title: 'Status',
                render: (record) =>
                  record.lastError ? (
                    <span className="text-sm text-desert-red" title={record.lastError}>
                      Could not read text
                    </span>
                  ) : record.chunkCount === 0 ? (
                    <span className="text-sm text-text-muted">No text found</span>
                  ) : (
                    <span className="text-sm text-text-secondary">Searchable</span>
                  ),
              },
              {
                accessor: 'source',
                title: '',
                render: (record) => (
                  <div className="flex justify-end items-center gap-2">
                    <StyledButton
                      variant="ghost"
                      size="sm"
                      icon="IconDownload"
                      onClick={() => {
                        window.location.href = downloadHref(record.source)
                      }}
                    >
                      Download
                    </StyledButton>
                    <StyledButton
                      variant="danger"
                      size="sm"
                      icon="IconTrash"
                      onClick={() => setConfirmDeleteSource(record.source)}
                      disabled={deleteMutation.isPending}
                    >
                      Delete
                    </StyledButton>
                  </div>
                ),
              },
            ]}
          />
        </section>
      </div>

      <StyledModal
        title="Delete Document?"
        open={confirmDeleteSource !== null}
        onConfirm={() => confirmDeleteSource && deleteMutation.mutate(confirmDeleteSource)}
        onCancel={() => setConfirmDeleteSource(null)}
        confirmText="Delete"
        confirmVariant="danger"
        confirmLoading={deleteMutation.isPending}
      >
        <p className="text-text-primary">
          This permanently deletes the file from your NOMAD, including from the AI Knowledge Base if
          it was indexed there. Are you sure?
        </p>
      </StyledModal>
    </AppLayout>
  )
}
