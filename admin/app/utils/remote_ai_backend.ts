/**
 * Pure helpers for talking to a remote AI backend configured in
 * `ai.remoteOllamaUrl` — a remote Ollama, an OpenAI-compatible server, or an
 * authenticating proxy in front of Ollama such as Open WebUI (#1434).
 *
 * Open WebUI exposes a native-Ollama passthrough at `<host>/ollama` that
 * answers with Ollama's own response shapes (`/ollama/api/tags`,
 * `/ollama/api/chat`, `/ollama/api/embed`, ...), so pointing the remote URL at
 * it is enough for NOMAD to treat it as Ollama — provided every request carries
 * `Authorization: Bearer <api key>`. Everything here is free of I/O so it can
 * be unit tested; the KV-backed wrapper lives in services/ai_backend_auth.ts.
 */

/**
 * Normalize an API key as typed into the settings form. Returns null for "no
 * key". A leading "Bearer " is stripped because people paste the whole header
 * value as often as the bare key.
 *
 * Throws on embedded whitespace or control characters: the key is sent
 * verbatim as an HTTP header value, and a pasted line break would either be
 * rejected by the HTTP client deep inside a chat request or, worse, split the
 * header. Failing at save time puts the error next to the field instead.
 */
export function normalizeRemoteApiKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw
    .trim()
    .replace(/^bearer(?:\s+|$)/i, '')
    .trim()
  if (key === '') return null
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(key)) {
    throw new Error('The API key must not contain spaces or line breaks.')
  }
  return key
}

/**
 * Headers to send with every request to the AI backend. Empty when no key is
 * set, so callers can always spread the result into their request options.
 */
export function remoteAuthHeaders(apiKey: string | null | undefined): Record<string, string> {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  return key ? { Authorization: `Bearer ${key}` } : {}
}

/**
 * Append an API path to a backend base URL, keeping any path prefix the base
 * already has. `new URL('/api/tags', base)` resolves against the origin and
 * silently drops a prefix like Open WebUI's `/ollama`, which would send the
 * request to Open WebUI's own `/api/tags` instead of the Ollama passthrough.
 */
export function joinBackendUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/**
 * Whether an HTTP status means the backend refused our credentials. Such a
 * response proves a live server but says nothing about whether it speaks the
 * native Ollama API: Open WebUI's `/ollama` passthrough answers 401 to a
 * request without a valid key, and classifying that as "not Ollama" would be
 * memoized and keep model pulls and num_ctx disabled after the key is fixed.
 */
export function isAuthRejectionStatus(status: number | null | undefined): boolean {
  return status === 401 || status === 403
}

/**
 * OpenSSL verification codes Node reports when the server's certificate chain
 * is not trusted by this process. All of them mean "the TLS handshake worked
 * but we refuse the certificate", which is a trust-store problem, not a
 * reachability problem.
 */
export const TLS_TRUST_ERROR_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_CRL',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/**
 * Find a TLS trust error code anywhere on an error's `cause` chain. Node's
 * built-in fetch wraps the socket error as `TypeError('fetch failed')` with the
 * real code on `cause`; axios copies it onto the AxiosError itself; the OpenAI
 * SDK wraps it once more in an APIConnectionError. Walking the chain handles
 * all three without caring which client produced the error.
 */
export function findTlsTrustErrorCode(err: unknown): string | null {
  let current: unknown = err
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && TLS_TRUST_ERROR_CODES.has(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return null
}

/**
 * User-facing explanation for a TLS trust failure. NOMAD's admin container
 * ships its own CA bundle, so a certificate from a private CA that every
 * browser on the LAN trusts is still unknown inside the container. Node reads
 * extra CAs from NODE_EXTRA_CA_CERTS at startup, which is the supported way to
 * add one; certificate verification is deliberately never switched off.
 */
export function describeTlsTrustError(url: string, code: string): string {
  return (
    `Could not connect to ${url}: its TLS certificate is not trusted by the NOMAD container (${code}). ` +
    `If it is signed by a private CA, mount the CA certificate (PEM) into the nomad_admin container and set ` +
    `NODE_EXTRA_CA_CERTS to its path in the admin service's environment in management_compose.yaml, then restart NOMAD.`
  )
}

/**
 * User-facing message for a connectivity test that got an HTTP error back.
 * 401/403 get their own wording because the usual cause is specific: Open
 * WebUI rejects requests without an API key, and API keys are disabled there
 * by default. A session (JWT) token also works until it expires (4 weeks by
 * default), so the message steers people to the non-expiring API key.
 */
export function describeRemoteHttpFailure(url: string, status: number, hasApiKey: boolean): string {
  if (isAuthRejectionStatus(status)) {
    const lead = hasApiKey
      ? `${url} rejected the API key (HTTP ${status}).`
      : `${url} requires an API key (HTTP ${status}).`
    return (
      `${lead} For Open WebUI, use the URL ending in /ollama and an API key from Settings > Account > API Keys ` +
      `(enable API keys first under Admin Panel > Settings > Authentication). Session tokens expire and should not be used.`
    )
  }
  return `Could not connect to ${url} (HTTP ${status}). Make sure the server is running and accessible. For Ollama, start it with OLLAMA_HOST=0.0.0.0.`
}

/**
 * User-facing message for a connectivity test that never got an HTTP
 * response: a certificate problem gets its own explanation, anything else the
 * generic reachability hint.
 */
export function describeRemoteConnectionFailure(url: string, err: unknown): string {
  const tlsCode = findTlsTrustErrorCode(err)
  if (tlsCode) return describeTlsTrustError(url, tlsCode)
  return `Could not connect to ${url}. Make sure the server is running and reachable. For Ollama, start it with OLLAMA_HOST=0.0.0.0.`
}
