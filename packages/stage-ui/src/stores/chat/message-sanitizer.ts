import type { ChatHistoryItem } from '../../types/chat'

// NOTICE: Inline `data:` image URLs (screenshots, attachments, vision frames)
// are multi-megabyte strings. They must never reach IndexedDB, BroadcastChannel
// payloads, or the remote sync queue — each copy permanently inflates the JS
// heap, IPC serialization cost, and storage quota. Small thumbnails and
// remote/blob references stay untouched.
export const DEFAULT_MAX_INLINE_IMAGE_URL_CHARS = 32_768

const OMITTED_IMAGE_TEXT = '[Image omitted — large inline attachment stripped before persistence]'

function isOversizedInlineImage(url: unknown, maxChars: number) {
  return typeof url === 'string' && url.startsWith('data:') && url.length > maxChars
}

function sanitizeContentPart(part: any, maxChars: number) {
  if (part && typeof part === 'object' && part.type === 'image_url' && isOversizedInlineImage(part.image_url?.url, maxChars))
    return { type: 'text', text: OMITTED_IMAGE_TEXT }
  return part
}

function sanitizeContentParts(content: unknown, maxChars: number) {
  if (!Array.isArray(content))
    return content
  let changed = false
  const next = (content as any[]).map((part) => {
    const sanitized = sanitizeContentPart(part, maxChars)
    if (sanitized !== part)
      changed = true
    return sanitized
  })
  return changed ? next : content
}

function sanitizeToolResults(toolResults: unknown, maxChars: number) {
  if (!Array.isArray(toolResults))
    return toolResults
  let changed = false
  const next = (toolResults as any[]).map((entry) => {
    if (!entry || typeof entry !== 'object' || !('result' in entry))
      return entry
    const sanitized = sanitizeContentParts((entry as any).result, maxChars)
    if (sanitized === (entry as any).result)
      return entry
    changed = true
    return { ...entry, result: sanitized }
  })
  return changed ? next : toolResults
}

function sanitizeSlices(slices: unknown, maxChars: number) {
  if (!Array.isArray(slices))
    return slices
  let changed = false
  const next = (slices as any[]).map((slice) => {
    if (!slice || typeof slice !== 'object' || !('result' in slice))
      return slice
    const sanitized = sanitizeContentParts((slice as any).result, maxChars)
    if (sanitized === (slice as any).result)
      return slice
    changed = true
    return { ...slice, result: sanitized }
  })
  return changed ? next : slices
}

export function stripLargeInlineImagesForPersistence<TMessage extends ChatHistoryItem>(messages: TMessage[], maxChars = DEFAULT_MAX_INLINE_IMAGE_URL_CHARS): TMessage[] {
  return messages.map((message) => {
    const record = message as unknown as Record<string, unknown>
    const content = sanitizeContentParts(record.content, maxChars)
    const toolResults = sanitizeToolResults(record.tool_results, maxChars)
    const slices = sanitizeSlices(record.slices, maxChars)
    if (content === record.content && toolResults === record.tool_results && slices === record.slices)
      return message
    const next: Record<string, unknown> = { ...record }
    if (content !== record.content)
      next.content = content
    if (toolResults !== record.tool_results && 'tool_results' in record)
      next.tool_results = toolResults
    if (slices !== record.slices && 'slices' in record)
      next.slices = slices
    return next as TMessage
  })
}
