import KVStore from '#models/kv_store'
import { remoteAuthHeaders } from '../utils/remote_ai_backend.js'

/**
 * The one place that decides which auth headers go to the AI backend (#1434).
 * Every request NOMAD makes to Ollama / the remote AI host takes its headers
 * from here, so a new call site cannot quietly go out without the token.
 *
 * The key is only sent while a remote URL is configured: it belongs to that
 * remote host, and the local nomad_ollama container has no business seeing it.
 */
export async function getAiBackendAuthHeaders(): Promise<Record<string, string>> {
  const remoteUrl = await KVStore.getValue('ai.remoteOllamaUrl')
  if (!remoteUrl || !remoteUrl.trim()) return {}
  return remoteAuthHeaders(await KVStore.getValue('ai.remoteOllamaApiKey'))
}
