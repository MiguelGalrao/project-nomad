import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import { KbTextSearchService } from '#services/kb_text_search_service'
import { IndexDocumentTextJob } from '#jobs/index_document_text_job'
import { kbTextSearchSchema } from '#validators/kb_text_search'
import { deleteFileSchema } from '#validators/rag'

/**
 * Documents page: keyword search over knowledge base uploads that works
 * without the AI Assistant (#1182). Unlike /chat (and the Knowledge Base modal
 * inside it), nothing here is gated on Ollama/Qdrant being installed.
 */
@inject()
export default class DocumentsController {
  constructor(private kbTextSearchService: KbTextSearchService) {}

  async index({ inertia }: HttpContext) {
    return inertia.render('documents')
  }

  async list({ response }: HttpContext) {
    const documents = await this.kbTextSearchService.listDocuments()
    return response.status(200).json({ documents })
  }

  async search({ request, response }: HttpContext) {
    const { q } = await request.validateUsing(kbTextSearchSchema)
    try {
      const result = await this.kbTextSearchService.search(q)
      return response.status(200).json(result)
    } catch (error) {
      logger.error({ err: error }, '[DocumentsController] search failed')
      return response.status(500).json({ error: 'Error searching documents' })
    }
  }

  async rescan({ response }: HttpContext) {
    try {
      await IndexDocumentTextJob.dispatchSync()
      return response.status(202).json({ message: 'Document scan queued.' })
    } catch (error) {
      logger.error({ err: error }, '[DocumentsController] failed to queue scan')
      return response.status(500).json({ error: 'Error queueing document scan' })
    }
  }

  async destroy({ request, response }: HttpContext) {
    const { source } = await request.validateUsing(deleteFileSchema)
    const result = await this.kbTextSearchService.deleteDocument(source)
    if (!result.success) {
      return response.status(400).json({ error: result.message })
    }
    return response.status(200).json({ message: result.message })
  }
}
