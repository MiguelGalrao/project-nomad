/**
 * Pure helpers for deciding how large a model's context window should be.
 *
 * Kept out of OllamaService so they can run under bare `node --test` with no
 * Ollama, Docker, or MySQL — the same convention as `rag_prompt.ts`. The service
 * supplies the facts (what /api/show said, how much memory is free); everything
 * here is a function of its arguments.
 */

/**
 * Ladder of context sizes we're willing to request.
 *
 * Snapping to a ladder is not cosmetic. Ollama unloads and reloads a model
 * whenever a request asks for a different `num_ctx` than the loaded instance, so
 * a continuously-varying window would stall a turn and throw away the KV cache
 * every time the conversation grew. Snapping (plus per-model memoization in the
 * resolver) keeps the value constant for a session.
 */
export const CONTEXT_LADDER = [4096, 8192, 16384, 32768, 65536, 131072] as const

/** Never go below this: it is roughly a system prompt plus a few real turns. */
export const MIN_CONTEXT = 4096

/**
 * Fallback window when the backend can't tell us anything — a non-Ollama
 * OpenAI-compatible server, or /api/show unavailable. Deliberately modest:
 * budgeting too small wastes capacity, budgeting too large silently truncates.
 */
export const UNKNOWN_BACKEND_CONTEXT = 8192

/**
 * Read the trained context length out of an /api/show `model_info` blob.
 *
 * Keys are architecture-prefixed (`llama.context_length`, `qwen3.context_length`,
 * `gemma3.context_length`, ...), so prefer the prefix named by
 * `general.architecture` and fall back to any `*.context_length` key. Ollama's
 * client types this as a Map but the wire format is a plain object; handle both.
 */
export function readContextLength(modelInfo: unknown): number | undefined {
  if (!modelInfo) return undefined
  const entries: [string, any][] =
    modelInfo instanceof Map
      ? [...modelInfo.entries()]
      : typeof modelInfo === 'object'
        ? Object.entries(modelInfo as Record<string, any>)
        : []
  if (entries.length === 0) return undefined

  const lookup = new Map(entries)
  const arch = lookup.get('general.architecture')
  if (typeof arch === 'string') {
    const exact = lookup.get(`${arch}.context_length`)
    if (typeof exact === 'number' && exact > 0) return exact
  }

  for (const [key, value] of entries) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
      return value
    }
  }
  return undefined
}

/**
 * Pull `num_ctx` out of the `parameters` string /api/show returns (the modelfile
 * PARAMETER lines, e.g. `num_ctx                        8192`). When a model
 * author baked in a window, that is a deliberate signal worth respecting as a
 * ceiling hint.
 */
export function readModelfileNumCtx(parameters: unknown): number | undefined {
  if (typeof parameters !== 'string') return undefined
  const match = parameters.match(/^\s*num_ctx\s+(\d+)\s*$/m)
  if (!match) return undefined
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Parse Ollama's `details.parameter_size` ("8.0B", "1.5B", "70B") into billions.
 * Falls back to the tag-name regex — which is what the codebase used to rely on
 * exclusively, and which guesses wrong on names like "phi3" that carry no size.
 */
export function parseParameterBillions(
  parameterSize: string | undefined,
  modelName?: string
): number | undefined {
  const fromDetails = parameterSize?.match(/([\d.]+)\s*B/i)
  if (fromDetails) {
    const value = Number.parseFloat(fromDetails[1])
    if (Number.isFinite(value)) return value
  }
  const fromName = modelName?.match(/(\d+\.?\d*)\s*[bB](?![a-zA-Z])/)
  if (fromName) {
    const value = Number.parseFloat(fromName[1])
    if (Number.isFinite(value)) return value
  }
  return undefined
}

/** Round a token count down to the largest ladder rung that fits. */
export function snapToLadder(tokens: number): number {
  let chosen = MIN_CONTEXT
  for (const rung of CONTEXT_LADDER) {
    if (rung <= tokens) chosen = rung
  }
  return chosen
}

// ---------------------------------------------------------------------------
// How much memory a context window actually costs
// ---------------------------------------------------------------------------

/**
 * Bytes per element in the KV cache.
 *
 * Budgeted at f16 (2 bytes) even though the Ollama container is started with
 * `OLLAMA_KV_CACHE_TYPE=q8_0`. Ollama silently falls back to f16 on
 * architectures that don't support cache quantization, so treating q8_0 as
 * guaranteed would double the real cost of every window we hand out. Quantized
 * cache is headroom, not a budgeting assumption.
 */
const KV_BYTES_PER_ELEMENT = 2

/** Turn an /api/show `model_info` blob (plain object or Map) into a Map. */
function modelInfoMap(modelInfo: unknown): Map<string, any> | undefined {
  if (!modelInfo) return undefined
  const entries: [string, any][] =
    modelInfo instanceof Map
      ? [...modelInfo.entries()]
      : typeof modelInfo === 'object'
        ? Object.entries(modelInfo as Record<string, any>)
        : []
  if (entries.length === 0) return undefined
  return new Map(entries)
}

/**
 * The KV-cache cost of a model, split into what grows with the window and what
 * does not.
 *
 * `perTokenBytes` is charged for every token of `num_ctx`. `fixedBytes` is the
 * cache held by sliding-window attention layers, which never grows past the
 * window they attend over no matter how large `num_ctx` gets (#1446).
 */
export type KvCacheCost = {
  perTokenBytes: number
  fixedBytes: number
}

/**
 * Exact KV-cache cost, from the model's own GGUF metadata.
 *
 *     2 (K and V) x layers x kv_heads x head_dim x bytes_per_element
 *
 * For llama3:8b that is 2 x 32 x 8 x 128 x 2 = 128 KiB per token, so an 8k
 * window costs 1 GiB — which is why "just set num_ctx high" is not free advice
 * on the hardware NOMAD targets.
 *
 * Two refinements for interleaved-attention models such as Gemma 4 (#1446):
 *
 *   - `attention.head_count_kv` may be a per-layer array rather than one number.
 *     Each layer is charged its own head count; treating the array as missing and
 *     falling back to `head_count` overstated gemma4:12b nearly 100-fold.
 *   - When `attention.sliding_window_pattern` marks layers as sliding-window, only
 *     the remaining global layers are charged per token. A sliding layer caches at
 *     most `attention.sliding_window` tokens, sized by `key_length_swa` /
 *     `value_length_swa`, so it is a fixed cost. It is budgeted at the full
 *     sliding window: every window we hand out is at least MIN_CONTEXT, which is
 *     at or above the sliding window of the models that use one.
 *
 * Ollama returns both arrays as `null` from a non-verbose /api/show; the service
 * re-fetches verbosely when that happens (see `needsVerboseModelInfo`). Should
 * they still be missing, this degrades to the old every-layer-is-global estimate,
 * which overstates cost and so errs toward a smaller window, never an OOM.
 *
 * Returns undefined when the metadata is missing (non-Ollama backend, or an
 * architecture that names its keys differently), leaving the caller to fall back
 * to `estimateKvBytesPerToken`.
 */
export function computeKvCacheCost(modelInfo: unknown): KvCacheCost | undefined {
  const info = modelInfoMap(modelInfo)
  if (!info) return undefined

  const arch = info.get('general.architecture')
  if (typeof arch !== 'string') return undefined
  const num = (suffix: string): number | undefined => {
    const value = info.get(`${arch}.${suffix}`)
    return typeof value === 'number' && value > 0 ? value : undefined
  }

  const layers = num('block_count')
  if (!layers) return undefined

  // Grouped-query attention means KV heads are usually far fewer than attention
  // heads; using head_count here would overestimate cost several-fold. A
  // per-layer array is only trusted when it covers every layer with a sane count.
  const kvHeadsArray = info.get(`${arch}.attention.head_count_kv`)
  const perLayerKvHeads =
    Array.isArray(kvHeadsArray) &&
    kvHeadsArray.length === layers &&
    kvHeadsArray.every((h) => typeof h === 'number' && h >= 0)
      ? (kvHeadsArray as number[])
      : undefined
  const kvHeads = num('attention.head_count_kv') ?? num('attention.head_count')
  if (!perLayerKvHeads && !kvHeads) return undefined
  const kvHeadsAt = (layer: number): number => perLayerKvHeads?.[layer] ?? kvHeads!

  // Prefer explicit key/value lengths; otherwise derive head_dim from the
  // embedding width and the attention head count.
  let headDim = num('attention.key_length')
  if (!headDim) {
    const embedding = num('embedding_length')
    const heads = num('attention.head_count')
    if (embedding && heads) headDim = embedding / heads
  }
  if (!headDim) return undefined

  // Sliding-window layers, if the model declares a per-layer pattern and the
  // window it slides over. Without both, every layer is treated as global.
  const pattern = info.get(`${arch}.attention.sliding_window_pattern`)
  const slidingWindow = num('attention.sliding_window')
  const hasSlidingPattern =
    Array.isArray(pattern) &&
    pattern.length === layers &&
    pattern.every((p) => typeof p === 'boolean') &&
    slidingWindow !== undefined
  const swaKeyLength = num('attention.key_length_swa') ?? headDim
  const swaValueLength = num('attention.value_length_swa') ?? swaKeyLength

  let globalHeads = 0
  let slidingHeads = 0
  for (let layer = 0; layer < layers; layer++) {
    if (hasSlidingPattern && pattern[layer] === true) slidingHeads += kvHeadsAt(layer)
    else globalHeads += kvHeadsAt(layer)
  }

  return {
    perTokenBytes: 2 * globalHeads * headDim * KV_BYTES_PER_ELEMENT,
    fixedBytes: hasSlidingPattern
      ? slidingHeads * (swaKeyLength + swaValueLength) * KV_BYTES_PER_ELEMENT * slidingWindow
      : 0,
  }
}

/**
 * Per-token KV-cache cost — the part of `computeKvCacheCost` that grows with the
 * window. Undefined under the same conditions.
 */
export function computeKvBytesPerToken(modelInfo: unknown): number | undefined {
  return computeKvCacheCost(modelInfo)?.perTokenBytes
}

/**
 * Whether a non-verbose /api/show withheld metadata the KV calculation needs.
 *
 * Ollama elides long arrays from `model_info` unless asked with `verbose: true`,
 * leaving the key present with a `null` value. `head_count_kv` and
 * `sliding_window_pattern` are per-layer arrays on interleaved-attention models
 * like Gemma 4, so they arrive as `null` and the KV cost is overstated enough to
 * pin the window to the floor (#1446). The verbose response also carries the
 * whole tokenizer vocabulary, so it is only worth fetching when this says so.
 */
export function needsVerboseModelInfo(modelInfo: unknown): boolean {
  const info = modelInfoMap(modelInfo)
  if (!info) return false
  const arch = info.get('general.architecture')
  if (typeof arch !== 'string') return false
  return ['attention.head_count_kv', 'attention.sliding_window_pattern'].some(
    (suffix) => info.has(`${arch}.${suffix}`) && info.get(`${arch}.${suffix}`) === null
  )
}

/**
 * Fallback KV cost per token when GGUF metadata is unavailable, interpolated
 * from the common architectures at each size. Deliberately pessimistic — an
 * overestimate costs a smaller window, an underestimate costs an OOM at load.
 */
export function estimateKvBytesPerToken(paramBillions: number | undefined): number {
  const b = paramBillions ?? 8
  if (b <= 1.5) return 32 * 1024
  if (b <= 4) return 64 * 1024
  if (b <= 9) return 128 * 1024
  if (b <= 15) return 192 * 1024
  if (b <= 35) return 256 * 1024
  return 512 * 1024
}

/**
 * Fraction of memory left free for weights-adjacent overhead: compute buffers,
 * activations, the graph, and whatever else shares the device. Without this the
 * arithmetic says a window fits right up to the byte and the model fails to load.
 */
const MEMORY_SAFETY_FRACTION = 0.8

export type ContextWindowInputs = {
  /** Trained context length from /api/show. The hard ceiling. */
  modelMaxCtx?: number
  /** num_ctx baked into the modelfile, treated as an author's ceiling hint. */
  modelfileNumCtx?: number
  /** Cost of one token of KV cache, exact or estimated. */
  kvBytesPerToken: number
  /**
   * KV cache that does not grow with the window (sliding-window attention
   * layers, #1446). Comes out of the pool before the per-token division.
   */
  kvFixedBytes?: number
  /** Memory available for the model, in bytes (VRAM, or a share of system RAM). */
  availableBytes?: number
  /** On-disk size of the weights, in bytes — they occupy the same pool. */
  modelBytes?: number
  /** User cap from `ai.contextWindow`. Only ever lowers the result. */
  userCap?: number
}

export type ContextWindowDecision = {
  contextWindow: number
  /** Which constraint actually bound the result — surfaced in logs and the UI. */
  limitedBy: 'user' | 'model' | 'memory' | 'floor' | 'default'
  affordableTokens?: number
}

/**
 * Decide the context window for a model.
 *
 * The result must be *stable for the life of the process*: Ollama unloads and
 * reloads a model whenever a request asks for a different num_ctx than the
 * loaded instance, which stalls the turn and discards the KV cache. Callers
 * memoize per model; this function is pure so that memoization is safe.
 */
export function resolveContextWindow(inputs: ContextWindowInputs): ContextWindowDecision {
  const ceilings: Array<{ value: number; source: ContextWindowDecision['limitedBy'] }> = []

  if (inputs.modelMaxCtx && inputs.modelMaxCtx > 0) {
    ceilings.push({ value: inputs.modelMaxCtx, source: 'model' })
  }
  if (inputs.modelfileNumCtx && inputs.modelfileNumCtx > 0) {
    ceilings.push({ value: inputs.modelfileNumCtx, source: 'model' })
  }
  if (inputs.userCap && inputs.userCap > 0) {
    ceilings.push({ value: inputs.userCap, source: 'user' })
  }

  let affordableTokens: number | undefined
  if (inputs.availableBytes && inputs.availableBytes > 0 && inputs.kvBytesPerToken > 0) {
    const forKv =
      inputs.availableBytes * MEMORY_SAFETY_FRACTION -
      (inputs.modelBytes ?? 0) -
      (inputs.kvFixedBytes ?? 0)
    affordableTokens = Math.max(0, Math.floor(forKv / inputs.kvBytesPerToken))
    ceilings.push({ value: affordableTokens, source: 'memory' })
  }

  if (ceilings.length === 0) {
    return { contextWindow: UNKNOWN_BACKEND_CONTEXT, limitedBy: 'default' }
  }

  const binding = ceilings.reduce((lowest, c) => (c.value < lowest.value ? c : lowest))
  const snapped = snapToLadder(binding.value)

  // The floor wins over a *memory* shortfall: a window under 4k is not worth
  // having, and Ollama will offload to host RAM rather than refuse. It must
  // never win over the model itself, though — asking for more than the trained
  // context pushes RoPE past what the weights ever saw and degrades output.
  // tinyllama (trained 2048) is the case that catches this.
  const hardCeiling = Math.min(
    ...[inputs.modelMaxCtx, inputs.modelfileNumCtx, inputs.userCap].filter(
      (v): v is number => typeof v === 'number' && v > 0
    ),
    Number.POSITIVE_INFINITY
  )

  if (snapped <= MIN_CONTEXT) {
    const floored = Math.min(MIN_CONTEXT, hardCeiling)
    return {
      contextWindow: floored,
      limitedBy: floored < MIN_CONTEXT ? 'model' : 'floor',
      affordableTokens,
    }
  }

  return { contextWindow: snapped, limitedBy: binding.source, affordableTokens }
}

/** Parse the `ai.contextWindow` setting. "auto"/unset/garbage all mean "no cap". */
export function parseUserContextCap(raw: string | null | undefined): number | undefined {
  if (!raw || raw === 'auto') return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= MIN_CONTEXT ? value : undefined
}
