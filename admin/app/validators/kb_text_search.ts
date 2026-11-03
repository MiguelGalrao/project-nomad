import vine from '@vinejs/vine'

export const kbTextSearchSchema = vine.compile(
  vine.object({
    // Longer input is truncated by sanitizeSearchQuery rather than rejected,
    // but cap the raw string so a huge query string never reaches it.
    q: vine.string().trim().minLength(1).maxLength(1000),
  })
)
