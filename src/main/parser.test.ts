import { describe, expect, it } from 'vitest'
import { parseWhatsAppText } from './parser'

describe('WhatsApp text parser', () => {
  it('keeps multiline messages with punctuation-rich sender names', () => {
    const source = Buffer.from('[12/08/2024, 18:31] Dr. عادل (Work): First line\nsecond line\n[12/08/2024, 18:32] Sara: IMG-20240812-WA001.jpg (file attached)')
    const result = parseWhatsAppText(source)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0].sender).toBe('Dr. عادل (Work)')
    expect(result.messages[0].rawText).toContain('second line')
    expect(result.messages[1].attachmentKind).toBe('image')
  })

  it('recognizes an iOS-style hyphen delimiter and system messages', () => {
    const source = Buffer.from('12/31/23, 10:20 PM - Alice: hello\n12/31/23, 10:21 PM - Messages and calls are end-to-end encrypted.')
    const result = parseWhatsAppText(source)
    expect(result.messages.map(message => message.kind)).toEqual(['user', 'system'])
  })
})
