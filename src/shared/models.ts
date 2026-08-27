export type Theme = 'light' | 'dark' | 'system'
export type MessageKind = 'user' | 'system' | 'media' | 'omitted-media' | 'document'
export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'gif' | 'other'
export type ReplyConfidence = 'confirmed' | 'high' | 'medium' | 'low' | 'unresolved'

export interface ChatSummary {
  id: string
  title: string
  type: 'group' | 'individual' | 'unknown'
  firstMessageAt: string | null
  lastMessageAt: string | null
  messageCount: number
  mediaCount: number
  sourceCount: number
  favorite: boolean
  archived: boolean
  tags: string[]
  lastPreview: string
  lastOpenedAt: string | null
}

export interface MessageRecord {
  id: string
  chatId: string
  timestamp: string | null
  senderDisplayName: string | null
  kind: MessageKind
  rawText: string
  renderedText: string
  media?: MediaRecord | null
  replyToMessageId?: string | null
  replyPreview?: string | null
  replyConfidence?: ReplyConfidence | null
  originalOrder: number
  bookmarked: boolean
  annotation?: string | null
}

export interface MediaRecord {
  id: string
  messageId?: string
  originalFilename: string
  mimeType: string
  kind: MediaKind
  size: number | null
  available: boolean
  caption?: string | null
}

export interface ChatDetails extends ChatSummary {
  notes: string
  participants: { displayName: string; messageCount: number }[]
  sources: ImportSource[]
  links: LinkRecord[]
}

export interface ImportSource {
  id: string
  filename: string
  sourceType: 'zip' | 'folder' | 'text'
  importedAt: string
  checksum: string
  hasMedia: boolean
  messageCount: number
  detectedPlatform: string
}

export interface LinkRecord {
  messageId: string
  url: string
  sender: string | null
  timestamp: string | null
  context: string
}

export interface SearchResult {
  message: MessageRecord
  chat: Pick<ChatSummary, 'id' | 'title' | 'tags'>
  context: string
}

export interface ImportPreview {
  id: string
  sourceName: string
  sourceType: 'zip' | 'folder' | 'text'
  detectedPlatform: string
  encoding: string
  chatTitle: string
  messages: number
  mediaCandidates: number
  firstMessageAt: string | null
  lastMessageAt: string | null
  warnings: string[]
  possibleMerge?: { chat: ChatSummary; confidence: number; duplicateEstimate: number } | null
}

export interface ImportPreparation {
  sessionId: string
  previews: ImportPreview[]
}

export interface ImportResult {
  imports: { chatId: string; chatTitle: string; added: number; duplicates: number; media: number; sourceId: string }[]
}

export interface ArchiveStats {
  chats: number
  messages: number
  media: number
  sources: number
  storagePath: string
}

export interface ArchiveApi {
  chooseSources(): Promise<string[]>
  prepareImport(paths: string[]): Promise<ImportPreparation>
  commitImport(sessionId: string, choices: Record<string, 'merge' | 'separate'>): Promise<ImportResult>
  listChats(filter?: string): Promise<ChatSummary[]>
  getChat(id: string): Promise<ChatDetails | null>
  getMessages(chatId: string, before?: string | null): Promise<{ messages: MessageRecord[]; nextCursor: string | null }>
  search(query: string, chatId?: string): Promise<SearchResult[]>
  updateChat(id: string, changes: { favorite?: boolean; archived?: boolean; notes?: string; tags?: string[] }): Promise<void>
  toggleBookmark(messageId: string): Promise<boolean>
  setAnnotation(messageId: string, annotation: string): Promise<void>
  exportText(chatId: string): Promise<{ cancelled: boolean; path?: string }>
  getMediaUrl(mediaId: string): string
  openMedia(mediaId: string): Promise<void>
  getPreference(key: string): Promise<string | null>
  setPreference(key: string, value: string): Promise<void>
  getStats(): Promise<ArchiveStats>
  onImportProgress(listener: (event: { phase: string; completed: number; total: number; label: string }) => void): () => void
}

declare global {
  interface Window { archive: ArchiveApi }
}
