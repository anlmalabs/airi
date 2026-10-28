import type { ChatHistoryItem } from '../../types/chat'

import assert from 'node:assert/strict'

import { describe, it } from 'vitest'

import { stripLargeInlineImagesForPersistence } from './message-sanitizer'

// ROOT CAUSE:
//
// User image attachments and vision frames are ingested into session history as
// full `data:image/png;base64,...` URLs (see chat.ts image_url ingestion). Those
// multi-megabyte strings are then kept in the reactive `sessionMessages` map,
// JSON-snapshotted on every persist, broadcast over BroadcastChannel per turn,
// and written verbatim into `local:chat/sessions/*` IndexedDB records. Heap
// snapshots showed `(string)` at ~71% of the JS heap with 1.6–1.9 MB base64
// entries retained via the chat session store.
//
// BEFORE: persistSession() snapshotted messages untouched, so every attached
// image lived forever in memory, IPC payloads, and IndexedDB.
//
// FIXED BY: stripping oversized inline `data:` image URLs at the persistence
// boundary (persist/load/broadcast), replacing them with a text placeholder.
describe('stripLargeInlineImagesForPersistence', () => {
  it('replaces oversized data: image_url parts with a text placeholder', () => {
    const bigUrl = `data:image/png;base64,${'A'.repeat(40_000)}`
    const messages: ChatHistoryItem[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: bigUrl } },
        ],
        createdAt: 1,
        id: 'user-1',
      },
    ]

    const sanitized = stripLargeInlineImagesForPersistence(messages)

    assert.equal(sanitized.length, 1)
    const first = sanitized[0]
    assert.ok(first)
    const content = first.content as any[]
    const originalContent = messages[0]?.content as any[]
    assert.equal(content.length, 2)
    assert.equal(content[0], originalContent[0])
    assert.equal(content[1]?.type, 'text')
    assert.match(content[1]?.text, /\[Image omitted/)
    // Input must not be mutated (callers pass reactive store state).
    assert.equal(originalContent[1]?.type, 'image_url')
  })

  it('keeps small inline images and remote/blob references intact', () => {
    const smallUrl = `data:image/png;base64,${'A'.repeat(100)}`
    const messages: ChatHistoryItem[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: smallUrl } }], createdAt: 1, id: 'user-1' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/photo.png' } }], createdAt: 2, id: 'user-2' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'blob:http://localhost/abc' } }], createdAt: 3, id: 'user-3' },
    ]

    const sanitized = stripLargeInlineImagesForPersistence(messages)

    assert.deepEqual(sanitized, messages)
  })

  it('strips oversized images nested in tool_results payloads', () => {
    const bigUrl = `data:image/jpeg;base64,${'B'.repeat(40_000)}`
    const messages: ChatHistoryItem[] = [
      {
        role: 'assistant',
        content: 'done',
        createdAt: 1,
        id: 'assistant-1',
        slices: [],
        tool_results: [{ id: 'call-1', result: [{ type: 'image_url', image_url: { url: bigUrl } }] }],
      },
    ]

    const sanitized = stripLargeInlineImagesForPersistence(messages)
    const results = (sanitized[0] as any).tool_results as any[]

    assert.equal(results.length, 1)
    assert.equal(results[0].id, 'call-1')
    assert.equal(results[0].result[0].type, 'text')
    assert.match(results[0].result[0].text, /\[Image omitted/)
  })
})
