import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_CONTEXT,
  UNKNOWN_BACKEND_CONTEXT,
  computeKvBytesPerToken,
  computeKvCacheCost,
  estimateKvBytesPerToken,
  needsVerboseModelInfo,
  parseParameterBillions,
  parseUserContextCap,
  readContextLength,
  readModelfileNumCtx,
  resolveContextWindow,
  snapToLadder,
} from '../../app/utils/context_window.js'

const GB = 2 ** 30
const KIB = 1024

/** Real /api/show model_info for llama3:8b, trimmed to the keys we read. */
const LLAMA3_8B_INFO = {
  'general.architecture': 'llama',
  'llama.attention.head_count': 32,
  'llama.attention.head_count_kv': 8,
  'llama.block_count': 32,
  'llama.context_length': 8192,
  'llama.embedding_length': 4096,
}

test('reads context length via the architecture prefix', () => {
  assert.equal(readContextLength(LLAMA3_8B_INFO), 8192)
})

test('falls back to any *.context_length when architecture is missing', () => {
  assert.equal(readContextLength({ 'qwen3.context_length': 32768 }), 32768)
})

test('readContextLength copes with a Map, and with nothing', () => {
  assert.equal(readContextLength(new Map(Object.entries(LLAMA3_8B_INFO))), 8192)
  assert.equal(readContextLength(undefined), undefined)
  assert.equal(readContextLength({}), undefined)
  assert.equal(readContextLength({ 'llama.block_count': 32 }), undefined)
})

test('reads num_ctx out of the modelfile parameters block', () => {
  assert.equal(readModelfileNumCtx('num_keep 24\nnum_ctx                        16384\nstop "<|eot_id|>"'), 16384)
  assert.equal(readModelfileNumCtx('num_keep 24\nstop "<|eot_id|>"'), undefined)
  assert.equal(readModelfileNumCtx(undefined), undefined)
})

test('computes exact KV bytes per token from GGUF metadata', () => {
  // 2 (K+V) * 32 layers * 8 kv-heads * 128 head_dim * 2 bytes = 128 KiB/token,
  // which puts an 8k window at exactly 1 GiB.
  assert.equal(computeKvBytesPerToken(LLAMA3_8B_INFO), 128 * KIB)
  assert.equal(computeKvBytesPerToken(LLAMA3_8B_INFO)! * 8192, 1 * GB)
})

test('uses grouped-query KV head count, not attention head count', () => {
  // head_count 32 vs head_count_kv 8: using the wrong one overstates cost 4x and
  // would hand every GQA model a quarter of the window it can afford.
  const noGqa = { ...LLAMA3_8B_INFO, 'llama.attention.head_count_kv': 32 }
  assert.equal(computeKvBytesPerToken(noGqa), 4 * computeKvBytesPerToken(LLAMA3_8B_INFO)!)
})

test('KV computation returns undefined on incomplete metadata', () => {
  assert.equal(computeKvBytesPerToken({ 'general.architecture': 'llama' }), undefined)
  assert.equal(computeKvBytesPerToken({}), undefined)
  assert.equal(computeKvBytesPerToken(undefined), undefined)
})

const MIB = 2 ** 20

/**
 * Verbose /api/show model_info for gemma4:12b-it-qat (#1446), trimmed to the
 * keys we read. Eight repeats of five sliding-window layers (8 KV heads, 256-dim)
 * followed by one global layer (1 KV head, 512-dim).
 */
const GEMMA4_12B_INFO = {
  'general.architecture': 'gemma4',
  'gemma4.block_count': 48,
  'gemma4.attention.head_count': 16,
  'gemma4.attention.head_count_kv': Array.from({ length: 8 }, () => [8, 8, 8, 8, 8, 1]).flat(),
  'gemma4.attention.sliding_window_pattern': Array.from({ length: 8 }, () => [
    true,
    true,
    true,
    true,
    true,
    false,
  ]).flat(),
  'gemma4.attention.sliding_window': 1024,
  'gemma4.attention.key_length': 512,
  'gemma4.attention.value_length': 512,
  'gemma4.attention.key_length_swa': 256,
  'gemma4.attention.value_length_swa': 256,
  'gemma4.context_length': 262144,
}

/** The same model as a non-verbose /api/show returns it: the arrays come back null. */
const GEMMA4_12B_INFO_NON_VERBOSE = {
  ...GEMMA4_12B_INFO,
  'gemma4.attention.head_count_kv': null,
  'gemma4.attention.sliding_window_pattern': null,
}

test('charges only global layers per token on a sliding-window model (#1446)', () => {
  // 8 global layers x 1 KV head x 2 (K+V) x 512 x 2 bytes = 16 KiB/token, not
  // the 1536 KiB the every-layer, head_count fallback produced.
  assert.equal(computeKvBytesPerToken(GEMMA4_12B_INFO), 16 * KIB)
  // 40 sliding layers x 8 KV heads x (256 + 256) x 2 bytes x 1024 tokens.
  assert.deepEqual(computeKvCacheCost(GEMMA4_12B_INFO), {
    perTokenBytes: 16 * KIB,
    fixedBytes: 320 * MIB,
  })
})

test('a per-layer head_count_kv array is summed per layer without a sliding pattern', () => {
  const noPattern: Record<string, unknown> = { ...GEMMA4_12B_INFO }
  delete noPattern['gemma4.attention.sliding_window_pattern']
  // 2 x (40 x 8 + 8 x 1) heads x 512 x 2 bytes = 656 KiB, all of it per token.
  assert.deepEqual(computeKvCacheCost(noPattern), { perTokenBytes: 656 * KIB, fixedBytes: 0 })
})

test('null per-layer arrays degrade to the pessimistic estimate and ask for verbose info', () => {
  // Falls back to head_count on every layer: overstated, but never understated.
  assert.equal(computeKvBytesPerToken(GEMMA4_12B_INFO_NON_VERBOSE), 1536 * KIB)
  assert.equal(computeKvCacheCost(GEMMA4_12B_INFO_NON_VERBOSE)!.fixedBytes, 0)
  assert.equal(needsVerboseModelInfo(GEMMA4_12B_INFO_NON_VERBOSE), true)
  assert.equal(needsVerboseModelInfo(GEMMA4_12B_INFO), false)
  // Models without these keys never pay for the (large) verbose response.
  assert.equal(needsVerboseModelInfo(LLAMA3_8B_INFO), false)
  assert.equal(needsVerboseModelInfo(undefined), false)
})

test('models without sliding-window metadata have no fixed KV cost', () => {
  assert.deepEqual(computeKvCacheCost(LLAMA3_8B_INFO), { perTokenBytes: 128 * KIB, fixedBytes: 0 })
})

test('gemma4:12b on a 12 GB GPU gets a real window, not the floor (#1446)', () => {
  // The pool NOMAD derived in the issue: ~2007 tokens x 1536 KiB ≈ 2.9 GiB for KV.
  const forKv = 2007 * 1536 * KIB
  const common = {
    modelMaxCtx: 262144,
    availableBytes: 12 * GB,
    modelBytes: 12 * GB * 0.8 - forKv,
  }
  const before = resolveContextWindow({ ...common, kvBytesPerToken: 1536 * KIB })
  assert.equal(before.contextWindow, MIN_CONTEXT)
  assert.equal(before.limitedBy, 'floor')

  const cost = computeKvCacheCost(GEMMA4_12B_INFO)!
  const after = resolveContextWindow({
    ...common,
    kvBytesPerToken: cost.perTokenBytes,
    kvFixedBytes: cost.fixedBytes,
  })
  assert.ok(after.contextWindow >= 32768)
  assert.equal(after.contextWindow, 131072)
  assert.equal(after.limitedBy, 'memory')
  // (2.9 GiB - 320 MiB) / 16 KiB ≈ 172K, as the issue works out.
  assert.equal(after.affordableTokens, Math.floor((forKv - 320 * MIB) / (16 * KIB)))
})

test('the fixed KV cost comes out of the pool before dividing', () => {
  const inputs = { modelMaxCtx: 131072, kvBytesPerToken: 128 * KIB, availableBytes: 8 * GB }
  const without = resolveContextWindow(inputs)
  const withFixed = resolveContextWindow({ ...inputs, kvFixedBytes: 1 * GB })
  assert.equal(without.affordableTokens! - withFixed.affordableTokens!, GB / (128 * KIB))
})

test('KV estimate falls back by parameter size, monotonically', () => {
  assert.ok(estimateKvBytesPerToken(1) < estimateKvBytesPerToken(8))
  assert.ok(estimateKvBytesPerToken(8) < estimateKvBytesPerToken(70))
  // Unknown size is treated as mid-range rather than free.
  assert.equal(estimateKvBytesPerToken(undefined), estimateKvBytesPerToken(8))
})

test('parses parameter size from details, falling back to the tag name', () => {
  assert.equal(parseParameterBillions('8.0B'), 8)
  assert.equal(parseParameterBillions('1.5B'), 1.5)
  assert.equal(parseParameterBillions(undefined, 'qwen2.5:0.5b'), 0.5)
  assert.equal(parseParameterBillions(undefined, 'llama3.2:3b'), 3)
  // The case the old name-regex got wrong: no size in the name at all. Better to
  // say "unknown" than to silently assume 8B.
  assert.equal(parseParameterBillions(undefined, 'phi3'), undefined)
})

test('snaps down to a ladder rung', () => {
  assert.equal(snapToLadder(9000), 8192)
  assert.equal(snapToLadder(8192), 8192)
  assert.equal(snapToLadder(100), MIN_CONTEXT)
})

test('the model trained context is a hard ceiling', () => {
  const d = resolveContextWindow({
    modelMaxCtx: 8192,
    kvBytesPerToken: 128 * KIB,
    availableBytes: 80 * GB,
  })
  assert.equal(d.contextWindow, 8192)
  assert.equal(d.limitedBy, 'model')
})

test('never exceeds trained context even to reach the floor', () => {
  // tinyllama trains to 2048. Requesting 4096 pushes RoPE past anything the
  // weights saw; a smaller-than-floor window is the correct answer here.
  const d = resolveContextWindow({
    modelMaxCtx: 2048,
    kvBytesPerToken: 22 * KIB,
    availableBytes: 8 * GB,
  })
  assert.equal(d.contextWindow, 2048)
  assert.equal(d.limitedBy, 'model')
})

test('memory limits the window when the model would allow more', () => {
  // gemma-class KV cost against a small card.
  const d = resolveContextWindow({
    modelMaxCtx: 262144,
    kvBytesPerToken: 1536 * KIB,
    availableBytes: 24 * GB,
    modelBytes: 7.6 * GB,
  })
  assert.ok(d.contextWindow < 262144)
  assert.ok(d.contextWindow >= MIN_CONTEXT)
})

test('a user cap only ever lowers the result', () => {
  const capped = resolveContextWindow({
    modelMaxCtx: 131072,
    kvBytesPerToken: 112 * KIB,
    availableBytes: 24 * GB,
    userCap: 8192,
  })
  assert.equal(capped.contextWindow, 8192)
  assert.equal(capped.limitedBy, 'user')

  // A cap above what the model or memory allows must not raise anything.
  const notRaised = resolveContextWindow({
    modelMaxCtx: 8192,
    kvBytesPerToken: 128 * KIB,
    availableBytes: 24 * GB,
    userCap: 131072,
  })
  assert.equal(notRaised.contextWindow, 8192)
})

test('weights are subtracted from the memory pool', () => {
  const inputs = { modelMaxCtx: 131072, kvBytesPerToken: 128 * KIB, availableBytes: 8 * GB }
  const withoutWeights = resolveContextWindow(inputs)
  const withWeights = resolveContextWindow({ ...inputs, modelBytes: 5 * GB })
  assert.ok(withWeights.contextWindow < withoutWeights.contextWindow)
})

test('falls back to a conservative default when nothing is known', () => {
  const d = resolveContextWindow({ kvBytesPerToken: 128 * KIB })
  assert.equal(d.contextWindow, UNKNOWN_BACKEND_CONTEXT)
  assert.equal(d.limitedBy, 'default')
})

test('the resolver is deterministic — the same inputs give the same window', () => {
  // Stability is the whole point: a window that varies between requests makes
  // Ollama unload and reload the model, stalling the turn and dropping the KV cache.
  const inputs = {
    modelMaxCtx: 131072,
    kvBytesPerToken: 128 * KIB,
    availableBytes: 8 * GB,
    modelBytes: 4.7 * GB,
  }
  const first = resolveContextWindow(inputs)
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(resolveContextWindow(inputs), first)
  }
})

test('parses the user context cap setting', () => {
  assert.equal(parseUserContextCap('16384'), 16384)
  assert.equal(parseUserContextCap('auto'), undefined)
  assert.equal(parseUserContextCap(null), undefined)
  assert.equal(parseUserContextCap(''), undefined)
  assert.equal(parseUserContextCap('nonsense'), undefined)
  // Below the floor is meaningless; treat it as unset rather than crippling chat.
  assert.equal(parseUserContextCap('512'), undefined)
})
