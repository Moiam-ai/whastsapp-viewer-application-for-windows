import { createHash } from 'node:crypto'
import path from 'node:path'
import type { MediaKind, MessageKind } from '../shared/models'

export interface ParsedMessage {
  timestamp: string | null
  sender: string | null
  rawText: string
  renderedText: string
  kind: MessageKind
  originalOrder: number
  fingerprint: string
  attachmentName: string | null
  attachmentKind: MediaKind | null
  sourceLine: number
}

export interface ParseResult {
  messages: ParsedMessage[]
  encoding: string
  platform: string
  warnings: string[]
}

const EXTENSIONS: Record<string, MediaKind> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', heic: 'image', bmp: 'image',
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', '3gp': 'video',
  opus: 'audio', ogg: 'audio', mp3: 'audio', m4a: 'audio', wav: 'audio', aac: 'audio',
  gif: 'gif', webm: 'sticker', pdf: 'document', doc: 'document', docx: 'document',
  xls: 'document', xlsx: 'document', ppt: 'document', pptx: 'document', txt: 'document',
  vcf: 'document', zip: 'document'
}

const MEDIA_OMITTED = /(?:media omitted|image omitted|video omitted|audio omitted|sticker omitted|document omitted|attached)$/iu
const URL_PATTERN = /\bhttps?:\/\/[^\s<>]+/giu

export function decodeChat(buffer: Buffer): { text: string; encoding: string } {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return { text: buffer.subarray(3).toString('utf8'), encoding: 'UTF-8 BOM' }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return { text: buffer.subarray(2).toString('utf16le'), encoding: 'UTF-16 LE' }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2)
    for (let i = 2; i < buffer.length - 1; i += 2) { swapped[i - 2] = buffer[i + 1]; swapped[i - 1] = buffer[i] }
    return { text: swapped.toString('utf16le'), encoding: 'UTF-16 BE' }
  }
  const utf8 = buffer.toString('utf8')
  const replacementRate = (utf8.match(/�/g)?.length ?? 0) / Math.max(1, utf8.length)
  return replacementRate < 0.003 ? { text: utf8, encoding: 'UTF-8' } : { text: buffer.toString('latin1'), encoding: 'Windows-1252 fallback' }
}

function normalizeForMatch(input: string): string {
  return input.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function parseDate(value: string, time: string): string | null {
  const parts = value.split(/[/.\-]/).map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null
  let [a, b, c] = parts
  let year = c < 100 ? (c >= 70 ? 1900 + c : 2000 + c) : c
  let day = a; let month = b
  if (a > 31) { year = a; month = b; day = c }
  else if (a <= 12 && b > 12) { month = a; day = b }
  // Ambiguous numeric dates use day-first. The UI stores the source raw text and can report this choice.
  const clock = time.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i)
  if (!clock) return null
  let hour = Number(clock[1]); const minute = Number(clock[2]); const second = Number(clock[3] ?? 0)
  const suffix = clock[4]?.toUpperCase()
  if (suffix === 'PM' && hour < 12) hour += 12
  if (suffix === 'AM' && hour === 12) hour = 0
  const parsed = new Date(year, month - 1, day, hour, minute, second)
  if (Number.isNaN(parsed.valueOf()) || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null
  return parsed.toISOString()
}

function tryMessageStart(line: string): { timestamp: string | null; sender: string | null; body: string; platform: string } | null {
  const android = line.match(/^\[?(\d{1,4}[/.\-]\d{1,2}[/.\-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\]?\s+(?:-\s*)?(.*)$/u)
  if (!android) return null
  const timestamp = parseDate(android[1], android[2])
  if (!timestamp) return null
  const remainder = android[3]
  const colon = remainder.match(/^(.+?):\s([\s\S]*)$/u)
  return { timestamp, sender: colon ? colon[1].trim() : null, body: colon ? colon[2] : remainder, platform: line.includes(' - ') ? 'iOS-style text export' : 'Android-style text export' }
}

function findAttachment(body: string): { name: string | null; kind: MediaKind | null; omitted: boolean } {
  const cleaned = body.replace(/[<>]/g, '').trim()
  if (MEDIA_OMITTED.test(cleaned)) return { name: null, kind: null, omitted: true }
  const candidates = [cleaned.match(/^(.+?)\s*\(file attached\)$/iu)?.[1], cleaned.match(/^(.+?)\s*attached$/iu)?.[1], cleaned]
  for (const candidate of candidates) {
    if (!candidate) continue
    const extension = path.extname(candidate).slice(1).toLowerCase()
    if (EXTENSIONS[extension]) return { name: candidate.trim(), kind: EXTENSIONS[extension], omitted: false }
  }
  return { name: null, kind: null, omitted: false }
}

export function parseWhatsAppText(buffer: Buffer): ParseResult {
  const { text, encoding } = decodeChat(buffer)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const drafts: { timestamp: string | null; sender: string | null; body: string; platform: string; sourceLine: number }[] = []
  let platform = 'WhatsApp text export'
  const warnings: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const start = tryMessageStart(lines[index])
    if (start) {
      platform = start.platform
      drafts.push({ ...start, sourceLine: index + 1 })
    } else if (drafts.length) {
      drafts[drafts.length - 1].body += `\n${lines[index]}`
    } else if (lines[index].trim()) {
      warnings.push(`Unrecognized content before the first message at line ${index + 1}.`)
    }
  }
  if (!drafts.length) warnings.push('No validated WhatsApp message headers were found. Check the export format and date locale.')
  const messages = drafts.map((draft, originalOrder) => {
    const attachment = findAttachment(draft.body)
    const kind: MessageKind = attachment.omitted ? 'omitted-media' : attachment.kind ? (attachment.kind === 'document' ? 'document' : 'media') : draft.sender ? 'user' : 'system'
    // Media presentation tokens vary by locale. Do not let an omitted token prevent a media-containing duplicate from merging.
    const fingerprintBody = normalizeForMatch(draft.body.replace(MEDIA_OMITTED, '').replace(/\s*\(file attached\)$/iu, ''))
    const fingerprint = createHash('sha256').update([draft.timestamp ?? '', normalizeForMatch(draft.sender ?? ''), kind === 'media' || kind === 'omitted-media' ? 'attachment' : kind, fingerprintBody].join('\u001f')).digest('hex')
    return { timestamp: draft.timestamp, sender: draft.sender, rawText: draft.body, renderedText: draft.body, kind, originalOrder, fingerprint, attachmentName: attachment.name, attachmentKind: attachment.kind, sourceLine: draft.sourceLine }
  })
  return { messages, encoding, platform, warnings: [...new Set(warnings)].slice(0, 10) }
}

export function extractUrls(text: string): string[] { return [...text.matchAll(URL_PATTERN)].map(match => match[0].replace(/[.,;!?)]$/u, '')) }

export function normalizedIdentity(value: string): string { return normalizeForMatch(value) }
