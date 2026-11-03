import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeRemoteConnectionFailure,
  describeRemoteHttpFailure,
  findTlsTrustErrorCode,
  isAuthRejectionStatus,
  joinBackendUrl,
  normalizeRemoteApiKey,
  remoteAuthHeaders,
} from '../../app/utils/remote_ai_backend.js'

test('normalizeRemoteApiKey: empty and non-string input mean "no key"', () => {
  assert.equal(normalizeRemoteApiKey(''), null)
  assert.equal(normalizeRemoteApiKey('   '), null)
  assert.equal(normalizeRemoteApiKey(null), null)
  assert.equal(normalizeRemoteApiKey(undefined), null)
  assert.equal(normalizeRemoteApiKey(42), null)
})

test('normalizeRemoteApiKey: trims and strips a pasted "Bearer " prefix', () => {
  assert.equal(normalizeRemoteApiKey('  sk-abc123  '), 'sk-abc123')
  assert.equal(normalizeRemoteApiKey('Bearer sk-abc123'), 'sk-abc123')
  assert.equal(normalizeRemoteApiKey('bearer   sk-abc123'), 'sk-abc123')
  assert.equal(normalizeRemoteApiKey('Bearer '), null)
})

test('normalizeRemoteApiKey: rejects keys that would break the header', () => {
  assert.throws(() => normalizeRemoteApiKey('sk-abc\n123'), /spaces or line breaks/)
  assert.throws(() => normalizeRemoteApiKey('sk abc'), /spaces or line breaks/)
  assert.throws(() => normalizeRemoteApiKey('sk-abc\u0000'), /spaces or line breaks/)
})

test('remoteAuthHeaders: bearer header only when a key is set', () => {
  assert.deepEqual(remoteAuthHeaders('sk-abc123'), { Authorization: 'Bearer sk-abc123' })
  assert.deepEqual(remoteAuthHeaders(null), {})
  assert.deepEqual(remoteAuthHeaders(undefined), {})
  assert.deepEqual(remoteAuthHeaders('  '), {})
})

test('joinBackendUrl: keeps a path prefix such as Open WebUI /ollama', () => {
  assert.equal(
    joinBackendUrl('https://llm.home.arpa/ollama', '/api/tags'),
    'https://llm.home.arpa/ollama/api/tags'
  )
  assert.equal(
    joinBackendUrl('https://llm.home.arpa/ollama/', '/api/tags'),
    'https://llm.home.arpa/ollama/api/tags'
  )
  assert.equal(
    joinBackendUrl(' http://10.0.0.5:11434// ', 'api/ps'),
    'http://10.0.0.5:11434/api/ps'
  )
  // The bug this replaces: URL resolution against the origin drops the prefix.
  assert.equal(
    new URL('/api/tags', 'https://llm.home.arpa/ollama').toString(),
    'https://llm.home.arpa/api/tags'
  )
})

test('isAuthRejectionStatus: only 401 and 403', () => {
  assert.equal(isAuthRejectionStatus(401), true)
  assert.equal(isAuthRejectionStatus(403), true)
  assert.equal(isAuthRejectionStatus(404), false)
  assert.equal(isAuthRejectionStatus(500), false)
  assert.equal(isAuthRejectionStatus(undefined), false)
})

test('findTlsTrustErrorCode: finds the code however the HTTP client wrapped it', () => {
  // Node's built-in fetch: TypeError('fetch failed') with the socket error on `cause`.
  const fetchErr = new TypeError('fetch failed', {
    cause: Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    }),
  })
  assert.equal(findTlsTrustErrorCode(fetchErr), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')

  // axios copies the code onto the error itself.
  assert.equal(
    findTlsTrustErrorCode({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
    'SELF_SIGNED_CERT_IN_CHAIN'
  )

  // OpenAI SDK: one more wrapper layer.
  const sdkErr = new Error('Connection error.', { cause: fetchErr })
  assert.equal(findTlsTrustErrorCode(sdkErr), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')

  assert.equal(
    findTlsTrustErrorCode({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    'DEPTH_ZERO_SELF_SIGNED_CERT'
  )
})

test('findTlsTrustErrorCode: ignores non-TLS failures', () => {
  assert.equal(
    findTlsTrustErrorCode(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })),
    null
  )
  assert.equal(findTlsTrustErrorCode({ code: 'ETIMEDOUT' }), null)
  assert.equal(findTlsTrustErrorCode(null), null)
  assert.equal(findTlsTrustErrorCode('boom'), null)
})

test('findTlsTrustErrorCode: a cause cycle does not loop forever', () => {
  const a: any = { code: 'ECONNRESET' }
  a.cause = a
  assert.equal(findTlsTrustErrorCode(a), null)
})

test('describeRemoteConnectionFailure: certificate errors say the CA is not trusted', () => {
  const err = new TypeError('fetch failed', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } })
  const msg = describeRemoteConnectionFailure('https://llm.home.arpa/ollama', err)
  assert.match(msg, /not trusted by the NOMAD container/)
  assert.match(msg, /SELF_SIGNED_CERT_IN_CHAIN/)
  assert.match(msg, /NODE_EXTRA_CA_CERTS/)
})

test('describeRemoteConnectionFailure: other errors keep the reachability hint', () => {
  const err = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
  const msg = describeRemoteConnectionFailure('http://10.0.0.5:11434', err)
  assert.match(msg, /Make sure the server is running and reachable/)
  assert.doesNotMatch(msg, /certificate/)
})

test('describeRemoteHttpFailure: 401/403 explain the Open WebUI API key', () => {
  const missing = describeRemoteHttpFailure('https://llm.home.arpa/ollama', 401, false)
  assert.match(missing, /requires an API key \(HTTP 401\)/)
  assert.match(missing, /Admin Panel > Settings > Authentication/)
  assert.match(missing, /\/ollama/)

  const rejected = describeRemoteHttpFailure('https://llm.home.arpa/ollama', 403, true)
  assert.match(rejected, /rejected the API key \(HTTP 403\)/)
})

test('describeRemoteHttpFailure: other statuses keep the generic message', () => {
  const msg = describeRemoteHttpFailure('http://10.0.0.5:11434', 500, false)
  assert.match(msg, /HTTP 500/)
  assert.match(msg, /OLLAMA_HOST=0\.0\.0\.0/)
  assert.doesNotMatch(msg, /API key/)
})
