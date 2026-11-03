import { Job } from 'bullmq'
import { QueueService } from '#services/queue_service'
import { RagService } from '#services/rag_service'
import { DockerService } from '#services/docker_service'
import { OllamaService } from '#services/ollama_service'
import { KbTextSearchService } from '#services/kb_text_search_service'
import logger from '@adonisjs/core/services/logger'

export interface IndexDocumentTextJobParams {
  /** Index this one file. Absent means a sync pass over all of kb_uploads. */
  filePath?: string
}

/**
 * Populates the AI-free keyword index (#1182). Runs on its own queue rather
 * than inside EmbedFileJob because EmbedFileJob bails out as soon as Ollama or
 * Qdrant is missing, which is exactly the install this feature is for.
 *
 * Every run is idempotent (a file's rows are replaced in one transaction), so
 * a retry or a stalled-job re-run is harmless.
 */
export class IndexDocumentTextJob {
  static get queue() {
    return 'kb-text-index'
  }

  static get key() {
    return 'index-document-text'
  }

  /** Fixed id for the user/boot-triggered sync so repeated triggers coalesce. */
  static readonly SYNC_JOB_ID = 'kb-text-sync'

  async handle(job: Job) {
    const { filePath } = job.data as IndexDocumentTextJobParams
    const dockerService = new DockerService()
    const service = new KbTextSearchService(
      new RagService(dockerService, new OllamaService()),
      dockerService
    )

    if (filePath) {
      return await service.indexFile(filePath)
    }

    const result = await service.sync()
    // Bounded passes: chain another one for files beyond this pass's limit
    // instead of extracting an arbitrarily large backlog in one job.
    if (result.deferred > 0) {
      await IndexDocumentTextJob.dispatchSync({ continuation: true })
    }
    return result
  }

  static async dispatchFile(filePath: string) {
    const queue = QueueService.getInstance().getQueue(this.queue)
    const job = await queue.add(this.key, { filePath } satisfies IndexDocumentTextJobParams, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 20 },
    })
    logger.info(`[IndexDocumentTextJob] Queued keyword indexing for ${filePath}`)
    return job
  }

  /**
   * Queue a sync pass. Triggers from boot, the KB Sync action and the
   * Documents page Rescan button coalesce onto one pending job via SYNC_JOB_ID.
   * A continuation (dispatched from inside the running sync, whose own id is
   * still active) gets an auto id instead, or it would be swallowed.
   */
  static async dispatchSync(options?: { continuation?: boolean }) {
    const queue = QueueService.getInstance().getQueue(this.queue)
    const jobOptions: Parameters<typeof queue.add>[2] = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 10 },
    }

    if (!options?.continuation) {
      const existing = await queue.getJob(this.SYNC_JOB_ID)
      if (existing) {
        const state = await existing.getState()
        if (state === 'waiting' || state === 'delayed' || state === 'active') {
          return existing
        }
        // A retained completed/failed record would make queue.add() with the
        // same id a silent no-op, so clear it first.
        await existing.remove()
      }
      jobOptions.jobId = this.SYNC_JOB_ID
    }

    return await queue.add(this.key, {} satisfies IndexDocumentTextJobParams, jobOptions)
  }
}
