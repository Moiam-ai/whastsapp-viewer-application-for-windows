import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, mkdirSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { lookup } from 'mime-types'
import type { ChatDetails, ChatSummary, ImportPreparation, ImportPreview, ImportResult, ImportSource, LinkRecord, MediaKind, MediaRecord, MessageRecord, SearchResult } from '../shared/models'
import { extractUrls, normalizedIdentity, parseWhatsAppText, type ParseResult, type ParsedMessage } from './parser'

type Progress = (event: { phase: string; completed: number; total: number; label: string }) => void
type StagedImport = { id: string; inputPath: string; sourceType: 'zip' | 'folder' | 'text'; sourceName: string; chatFile: string; tempDir?: string; mediaPaths: Map<string, string>; checksum: string; title: string; parsed: ParseResult; preview: ImportPreview }

const MEDIA_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'bmp', 'mp4', 'mov', 'avi', 'mkv', '3gp', 'opus', 'ogg', 'mp3', 'm4a', 'wav', 'aac', 'gif', 'webm', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'vcf', 'zip'])

function isoNow(): string { return new Date().toISOString() }
function asBoolean(value: number | boolean): boolean { return Boolean(value) }
function safeFilename(name: string): string { return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 96) || 'attachment' }
function textPreview(value: string): string { return value.replace(/\s+/g, ' ').trim().slice(0, 160) || 'System message' }
function mediaKindFromFilename(filename: string): MediaKind {
  const ext = path.extname(filename).slice(1).toLowerCase()
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'bmp'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'avi', 'mkv', '3gp'].includes(ext)) return 'video'
  if (['opus', 'ogg', 'mp3', 'm4a', 'wav', 'aac'].includes(ext)) return 'audio'
  if (ext === 'gif') return 'gif'
  if (ext === 'webm') return 'sticker'
  return 'document'
}

function explainWindowsReadFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/device is not ready/iu.test(detail)) return 'Windows reports that the drive is not ready. Reconnect or unlock the drive, then open the ZIP in File Explorer once before importing it.'
  if (/access is denied|permission/iu.test(detail)) return 'Windows denied access to this file. Close any program that is using it and check the file permissions.'
  if (/cannot find|enoent|not found/iu.test(detail)) return 'The file is no longer at the selected location. Select it again from its current folder.'
  return 'Windows could not read this file. Check that the drive is connected and that the file opens normally in File Explorer.'
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Some Windows volumes expose a file to the .NET file API but return ERROR_INVALID_FUNCTION
 * (reported by Node as UNKNOWN) to libuv. This happens on a few removable/NAS volumes and is
 * especially common with non-Latin filenames. The fallback is intentionally limited to a source
 * selected by the user and streams it into ChatVault's private temporary directory.
 */
async function copyWithWindowsFileApi(source: string, destination: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('The selected file cannot be read by this system.')
  const script = `$ErrorActionPreference='Stop'; $source=$env:CHATVAULT_BRIDGE_SOURCE; $destination=$env:CHATVAULT_BRIDGE_DESTINATION; $input=[System.IO.File]::Open($source,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); try { $output=[System.IO.File]::Open($destination,[System.IO.FileMode]::Create,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None); try { $input.CopyTo($output) } finally { $output.Dispose() } } finally { $input.Dispose() }`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CHATVAULT_BRIDGE_SOURCE: source, CHATVAULT_BRIDGE_DESTINATION: destination } })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Windows could not read the selected file (exit ${code ?? 'unknown'}).`)))
  })
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...await walk(full))
    else if (entry.isFile()) result.push(full)
  }
  return result
}

function isSafeZipPath(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, '/')
  return !normalized.startsWith('/') && !/^[a-z]:/iu.test(normalized) && !normalized.split('/').includes('..') && !normalized.startsWith('//')
}

export class ArchiveRepository {
  readonly baseDir: string
  readonly mediaDir: string
  readonly tempDir: string
  readonly db: Database.Database
  private sessions = new Map<string, StagedImport[]>()

  constructor(baseDir: string, private readonly progress: Progress) {
    this.baseDir = baseDir
    this.mediaDir = path.join(baseDir, 'media')
    this.tempDir = path.join(baseDir, 'import-tmp')
    mkdirSync(baseDir, { recursive: true })
    this.db = new Database(path.join(baseDir, 'archive.sqlite'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
  }

  async initialize(): Promise<void> { await Promise.all([mkdir(this.baseDir, { recursive: true }), mkdir(this.mediaDir, { recursive: true }), mkdir(this.tempDir, { recursive: true })]) }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, normalized_title TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown',
        created_at TEXT NOT NULL, first_message_at TEXT, last_message_at TEXT, message_count INTEGER NOT NULL DEFAULT 0,
        media_count INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '', last_opened_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chats_normalized_title_idx ON chats(normalized_title);
      CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, display_name TEXT NOT NULL, normalized_name TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, UNIQUE(chat_id, normalized_name));
      CREATE TABLE IF NOT EXISTS import_sources (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, filename TEXT NOT NULL, origin_path TEXT NOT NULL,
        source_type TEXT NOT NULL, imported_at TEXT NOT NULL, checksum TEXT NOT NULL UNIQUE, has_media INTEGER NOT NULL,
        message_count INTEGER NOT NULL, detected_platform TEXT NOT NULL, encoding TEXT NOT NULL, parser_version TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, original_filename TEXT NOT NULL, normalized_filename TEXT NOT NULL,
        storage_path TEXT, mime_type TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, timestamp TEXT,
        sender_display_name TEXT, sender_normalized TEXT, kind TEXT NOT NULL, raw_text TEXT NOT NULL, rendered_text TEXT NOT NULL,
        fingerprint TEXT NOT NULL, media_id TEXT REFERENCES media(id), reply_to_message_id TEXT, reply_preview TEXT,
        reply_confidence TEXT, original_order INTEGER NOT NULL, source_line INTEGER, created_at TEXT NOT NULL,
        UNIQUE(chat_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS messages_chat_cursor_idx ON messages(chat_id, timestamp, id);
      CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages(chat_id, sender_normalized);
      CREATE TABLE IF NOT EXISTS message_sources (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, source_id TEXT NOT NULL REFERENCES import_sources(id) ON DELETE CASCADE, source_line INTEGER, PRIMARY KEY(message_id, source_id, source_line));
      CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
      CREATE TABLE IF NOT EXISTS chat_tags (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(chat_id, tag_id));
      CREATE TABLE IF NOT EXISTS bookmarks (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS annotations (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, body TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS import_journal (id TEXT PRIMARY KEY, state TEXT NOT NULL, source_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(message_id UNINDEXED, chat_id UNINDEXED, sender, body, tokenize='unicode61 remove_diacritics 2');
    `)
  }

  async prepareImport(inputPaths: string[]): Promise<ImportPreparation> {
    const staged: StagedImport[] = []
    for (let index = 0; index < inputPaths.length; index++) {
      this.progress({ phase: 'Inspecting', completed: index, total: inputPaths.length, label: path.basename(inputPaths[index]) })
      staged.push(await this.stage(inputPaths[index]))
    }
    const sessionId = randomUUID()
    this.sessions.set(sessionId, staged)
    return { sessionId, previews: staged.map(item => item.preview) }
  }

  private async stage(inputPath: string): Promise<StagedImport> {
    let accessInputPath = inputPath
    let compatibilityFile: string | undefined
    let info
    try {
      info = await stat(accessInputPath)
    } catch (originalError) {
      const extension = path.extname(inputPath).toLowerCase()
      if (process.platform !== 'win32' || !['.zip', '.txt'].includes(extension)) {
        throw new Error(`ChatVault could not access this source. ${explainWindowsReadFailure(originalError)}`)
      }
      await mkdir(this.tempDir, { recursive: true })
      compatibilityFile = path.join(this.tempDir, `${randomUUID()}${extension}`)
      try {
        await copyWithWindowsFileApi(inputPath, compatibilityFile)
        accessInputPath = compatibilityFile
        info = await stat(accessInputPath)
      } catch (fallbackError) {
        throw new Error(`ChatVault could not read this Windows file. ${explainWindowsReadFailure(fallbackError)}`)
      }
    }
    let sourceType: StagedImport['sourceType'] = info.isDirectory() ? 'folder' : path.extname(inputPath).toLowerCase() === '.zip' ? 'zip' : 'text'
    let root = sourceType === 'folder' ? accessInputPath : path.dirname(accessInputPath)
    let tempDir: string | undefined
    if (sourceType === 'zip') {
      tempDir = path.join(this.tempDir, randomUUID())
      await mkdir(tempDir, { recursive: true })
      const zip = new AdmZip(accessInputPath)
      const entries = zip.getEntries()
      if (entries.length > 20_000) throw new Error('This ZIP has more than 20,000 entries and was not extracted for safety.')
      for (const entry of entries) {
        if (entry.isDirectory) continue
        if (!isSafeZipPath(entry.entryName)) throw new Error(`Unsafe path in ZIP: ${entry.entryName}`)
        const destination = path.join(tempDir, entry.entryName)
        if (!destination.startsWith(tempDir + path.sep)) throw new Error('ZIP path escaped the temporary import folder.')
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, entry.getData())
      }
      root = tempDir
    }
    const files = sourceType === 'text' ? [accessInputPath] : await walk(root)
    const chatFile = sourceType === 'text' ? accessInputPath : files.find(file => path.basename(file).toLowerCase() === '_chat.txt') ?? files.find(file => path.extname(file).toLowerCase() === '.txt')
    if (!chatFile) throw new Error('No _chat.txt file was found in this import.')
    const buffer = await readFile(chatFile)
    const parsed = parseWhatsAppText(buffer)
    const mediaPaths = new Map<string, string>()
    for (const file of files) {
      if (file === chatFile || !MEDIA_EXTENSIONS.has(path.extname(file).slice(1).toLowerCase())) continue
      mediaPaths.set(normalizedIdentity(path.basename(file)), file)
    }
    const checksum = createHash('sha256').update(buffer).update([...mediaPaths.keys()].sort().join('\n')).digest('hex')
    const title = this.deriveTitle(inputPath, chatFile, parsed)
    const existing = this.db.prepare(`SELECT * FROM chats WHERE normalized_title = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1`).get(normalizedIdentity(title)) as Record<string, unknown> | undefined
    let possibleMerge: ImportPreview['possibleMerge'] = null
    if (existing) {
      const duplicateEstimate = parsed.messages.reduce((count, message) => count + Number(Boolean(this.db.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND fingerprint = ?').get(existing.id, message.fingerprint))), 0)
      possibleMerge = { chat: this.mapChat(existing), confidence: duplicateEstimate ? 0.98 : 0.78, duplicateEstimate }
    }
    const id = randomUUID()
    const preview: ImportPreview = {
      id, sourceName: path.basename(inputPath), sourceType, detectedPlatform: parsed.platform, encoding: parsed.encoding, chatTitle: title,
      messages: parsed.messages.length, mediaCandidates: parsed.messages.filter(message => message.attachmentName).length,
      firstMessageAt: parsed.messages.find(message => message.timestamp)?.timestamp ?? null,
      lastMessageAt: [...parsed.messages].reverse().find(message => message.timestamp)?.timestamp ?? null,
      warnings: compatibilityFile ? [...parsed.warnings, 'Read through the Windows compatibility bridge; the original source was not changed.'] : parsed.warnings, possibleMerge
    }
    if (compatibilityFile) await unlink(compatibilityFile).catch(() => undefined)
    return { id, inputPath, sourceType, sourceName: path.basename(inputPath), chatFile, tempDir, mediaPaths, checksum, title, parsed, preview }
  }

  private deriveTitle(inputPath: string, chatFile: string, parsed: ParseResult): string {
    const base = path.basename(inputPath, path.extname(inputPath)).replace(/^WhatsApp Chat with /iu, '').trim()
    if (base && !['chat', '_chat', 'whatsapp chat'].includes(normalizedIdentity(base))) return base
    const parent = path.basename(path.dirname(chatFile)).replace(/^WhatsApp Chat with /iu, '').trim()
    if (parent && !['chat', '_chat'].includes(normalizedIdentity(parent))) return parent
    const senders = [...new Set(parsed.messages.map(message => message.sender).filter((value): value is string => Boolean(value)))].slice(0, 3)
    return senders.length ? senders.join(', ') : `Imported chat ${new Date().toLocaleDateString()}`
  }

  async commitImport(sessionId: string, choices: Record<string, 'merge' | 'separate'>): Promise<ImportResult> {
    const staged = this.sessions.get(sessionId)
    if (!staged) throw new Error('Import session expired. Inspect the export again.')
    const imports: ImportResult['imports'] = []
    try {
      for (let index = 0; index < staged.length; index++) {
        const item = staged[index]
        this.progress({ phase: 'Importing', completed: index, total: staged.length, label: item.sourceName })
        imports.push(await this.persistStaged(item, choices[item.id] ?? 'merge'))
      }
      return { imports }
    } finally {
      this.sessions.delete(sessionId)
      await Promise.all(staged.map(async item => { if (item.tempDir) await this.removeTree(item.tempDir) }))
    }
  }

  private async persistStaged(item: StagedImport, choice: 'merge' | 'separate'): Promise<ImportResult['imports'][number]> {
    const existingSource = this.db.prepare('SELECT id, chat_id FROM import_sources WHERE checksum = ?').get(item.checksum) as { id: string; chat_id: string } | undefined
    if (existingSource) return { chatId: existingSource.chat_id, chatTitle: item.title, added: 0, duplicates: item.parsed.messages.length, media: 0, sourceId: existingSource.id }
    const mergeTarget = choice === 'merge' && item.preview.possibleMerge ? item.preview.possibleMerge.chat.id : null
    const chatId = mergeTarget ?? randomUUID()
    const sourceId = randomUUID()
    const journalId = randomUUID()
    const now = isoNow()
    this.db.prepare('INSERT INTO import_journal (id, state, source_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(journalId, 'PARSING', item.sourceName, now, now)
    let added = 0; let duplicates = 0; let media = 0
    try {
      // Hash/copy media before the DB mutation. If this stage is interrupted it can leave an
      // unreferenced object, but never a partially merged conversation; repair can safely inspect it.
      const mediaIds = await Promise.all(item.parsed.messages.map(async (message, index) => {
        if (!message.attachmentName) return null
        const sourcePath = item.mediaPaths.get(normalizedIdentity(path.basename(message.attachmentName)))
        if (!sourcePath) return null
        this.progress({ phase: 'Processing media', completed: index, total: item.parsed.messages.length, label: item.sourceName })
        return this.storeMedia(sourcePath, message.attachmentName)
      }))
      media = mediaIds.filter(Boolean).length
      const commit = this.db.transaction(() => {
        if (!mergeTarget) this.db.prepare('INSERT INTO chats (id, title, normalized_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(chatId, item.title, normalizedIdentity(item.title), now, now)
        this.db.prepare('INSERT INTO import_sources (id, chat_id, filename, origin_path, source_type, imported_at, checksum, has_media, message_count, detected_platform, encoding, parser_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(sourceId, chatId, item.sourceName, item.inputPath, item.sourceType, now, item.checksum, Number(item.mediaPaths.size > 0), item.parsed.messages.length, item.parsed.platform, item.parsed.encoding, '1.0')
      for (let index = 0; index < item.parsed.messages.length; index++) {
        if (index % 100 === 0) this.progress({ phase: 'Indexing', completed: index, total: item.parsed.messages.length, label: item.sourceName })
        const message = item.parsed.messages[index]
        const mediaId = mediaIds[index]
        const messageId = randomUUID()
        const insert = this.db.prepare(`INSERT OR IGNORE INTO messages (id, chat_id, timestamp, sender_display_name, sender_normalized, kind, raw_text, rendered_text, fingerprint, media_id, original_order, source_line, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(messageId, chatId, message.timestamp, message.sender, message.sender ? normalizedIdentity(message.sender) : null, message.kind, message.rawText, message.renderedText, message.fingerprint, mediaId, message.originalOrder, message.sourceLine, now)
        let canonicalId: string = messageId
        if (insert.changes) {
          added++
          this.db.prepare('INSERT INTO message_fts (message_id, chat_id, sender, body) VALUES (?, ?, ?, ?)').run(messageId, chatId, message.sender ?? '', message.renderedText)
          if (message.sender) this.db.prepare('INSERT INTO participants (id, chat_id, display_name, normalized_name, message_count) VALUES (?, ?, ?, ?, 1) ON CONFLICT(chat_id, normalized_name) DO UPDATE SET message_count = message_count + 1').run(randomUUID(), chatId, message.sender, normalizedIdentity(message.sender))
        } else {
          duplicates++
          const existing = this.db.prepare('SELECT id, media_id FROM messages WHERE chat_id = ? AND fingerprint = ?').get(chatId, message.fingerprint) as { id: string; media_id: string | null }
          canonicalId = existing.id
          if (!existing.media_id && mediaId) this.db.prepare('UPDATE messages SET media_id = ? WHERE id = ?').run(mediaId, existing.id)
        }
        this.db.prepare('INSERT OR IGNORE INTO message_sources (message_id, source_id, source_line) VALUES (?, ?, ?)').run(canonicalId, sourceId, message.sourceLine)
      }
      this.refreshChat(chatId)
      this.db.prepare('UPDATE import_journal SET state = ?, updated_at = ? WHERE id = ?').run('COMMITTED', isoNow(), journalId)
      })
      commit()
      return { chatId, chatTitle: item.title, added, duplicates, media, sourceId }
    } catch (error) {
      this.db.prepare('UPDATE import_journal SET state = ?, updated_at = ?, error = ? WHERE id = ?').run('FAILED', isoNow(), error instanceof Error ? error.message : 'Unknown import failure', journalId)
      throw error
    }
  }

  private async storeMedia(sourcePath: string, originalFilename: string): Promise<string> {
    const contentHash = await hashFile(sourcePath)
    const existing = this.db.prepare('SELECT id FROM media WHERE content_hash = ?').get(contentHash) as { id: string } | undefined
    if (existing) return existing.id
    const info = await stat(sourcePath)
    const ext = path.extname(originalFilename).toLowerCase()
    const destination = path.join(this.mediaDir, contentHash.slice(0, 2), `${contentHash}${ext}`)
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(sourcePath, destination, { force: false, errorOnExist: false })
    const id = randomUUID()
    const mime = lookup(originalFilename) || 'application/octet-stream'
    this.db.prepare('INSERT INTO media (id, content_hash, original_filename, normalized_filename, storage_path, mime_type, kind, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, contentHash, originalFilename, normalizedIdentity(originalFilename), destination, mime, mediaKindFromFilename(originalFilename), info.size, isoNow())
    return id
  }

  private refreshChat(chatId: string): void {
    this.db.prepare(`UPDATE chats SET first_message_at = (SELECT MIN(timestamp) FROM messages WHERE chat_id = ?), last_message_at = (SELECT MAX(timestamp) FROM messages WHERE chat_id = ?), message_count = (SELECT COUNT(*) FROM messages WHERE chat_id = ?), media_count = (SELECT COUNT(*) FROM messages WHERE chat_id = ? AND media_id IS NOT NULL), updated_at = ? WHERE id = ?`).run(chatId, chatId, chatId, chatId, isoNow(), chatId)
  }

  listChats(filter = 'all'): ChatSummary[] {
    const clauses: string[] = []; const params: unknown[] = []
    if (filter === 'favorites') clauses.push('c.favorite = 1')
    else if (filter === 'recent') clauses.push('c.last_opened_at IS NOT NULL')
    else if (filter === 'media') clauses.push('c.media_count > 0')
    else if (filter === 'groups') clauses.push("c.type = 'group'")
    else if (filter === 'individual') clauses.push("c.type = 'individual'")
    else if (filter === 'archived') clauses.push('c.archived = 1')
    else clauses.push('c.archived = 0')
    const rows = this.db.prepare(`SELECT c.*, COALESCE((SELECT rendered_text FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC, id DESC LIMIT 1), '') AS last_preview, COALESCE((SELECT group_concat(t.name, '|') FROM tags t JOIN chat_tags ct ON ct.tag_id = t.id WHERE ct.chat_id = c.id), '') AS tag_names, (SELECT COUNT(*) FROM import_sources WHERE chat_id = c.id) AS source_count FROM chats c WHERE ${clauses.join(' AND ')} ORDER BY c.favorite DESC, COALESCE(c.last_opened_at, c.last_message_at, c.updated_at) DESC`).all(...params) as Record<string, unknown>[]
    return rows.map(row => this.mapChat(row))
  }

  getChat(id: string): ChatDetails | null {
    const row = this.db.prepare(`SELECT c.*, COALESCE((SELECT rendered_text FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC, id DESC LIMIT 1), '') AS last_preview, COALESCE((SELECT group_concat(t.name, '|') FROM tags t JOIN chat_tags ct ON ct.tag_id = t.id WHERE ct.chat_id = c.id), '') AS tag_names, (SELECT COUNT(*) FROM import_sources WHERE chat_id = c.id) AS source_count FROM chats c WHERE c.id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    this.db.prepare('UPDATE chats SET last_opened_at = ? WHERE id = ?').run(isoNow(), id)
    const chat = this.mapChat(row)
    const participants = this.db.prepare('SELECT display_name, message_count FROM participants WHERE chat_id = ? ORDER BY message_count DESC, display_name LIMIT 40').all(id) as { display_name: string; message_count: number }[]
    const sources = this.db.prepare('SELECT id, filename, source_type, imported_at, checksum, has_media, message_count, detected_platform FROM import_sources WHERE chat_id = ? ORDER BY imported_at DESC').all(id) as Record<string, unknown>[]
    return { ...chat, notes: String(row.notes), participants: participants.map(participant => ({ displayName: participant.display_name, messageCount: participant.message_count })), sources: sources.map(source => ({ id: String(source.id), filename: String(source.filename), sourceType: source.source_type as ImportSource['sourceType'], importedAt: String(source.imported_at), checksum: String(source.checksum), hasMedia: asBoolean(source.has_media as number), messageCount: Number(source.message_count), detectedPlatform: String(source.detected_platform) })), links: this.getLinks(id) }
  }

  getMessages(chatId: string, before?: string | null): { messages: MessageRecord[]; nextCursor: string | null } {
    let rows: Record<string, unknown>[]
    if (before) {
      const cursor = JSON.parse(before) as { timestamp: string; id: string }
      rows = this.db.prepare(`SELECT m.*, md.id AS media_id_out, md.original_filename, md.mime_type, md.kind AS media_kind, md.size, md.storage_path, b.message_id AS bookmark_id, a.body AS annotation FROM messages m LEFT JOIN media md ON md.id = m.media_id LEFT JOIN bookmarks b ON b.message_id = m.id LEFT JOIN annotations a ON a.message_id = m.id WHERE m.chat_id = ? AND (COALESCE(m.timestamp, '') < ? OR (COALESCE(m.timestamp, '') = ? AND m.id < ?)) ORDER BY COALESCE(m.timestamp, '') DESC, m.id DESC LIMIT 250`).all(chatId, cursor.timestamp, cursor.timestamp, cursor.id) as Record<string, unknown>[]
      rows.reverse()
    } else {
      rows = this.db.prepare(`SELECT m.*, md.id AS media_id_out, md.original_filename, md.mime_type, md.kind AS media_kind, md.size, md.storage_path, b.message_id AS bookmark_id, a.body AS annotation FROM messages m LEFT JOIN media md ON md.id = m.media_id LEFT JOIN bookmarks b ON b.message_id = m.id LEFT JOIN annotations a ON a.message_id = m.id WHERE m.chat_id = ? ORDER BY COALESCE(m.timestamp, '') DESC, m.id DESC LIMIT 250`).all(chatId) as Record<string, unknown>[]
      rows.reverse()
    }
    const oldest = rows[0]
    return { messages: rows.map(row => this.mapMessage(row)), nextCursor: oldest ? JSON.stringify({ timestamp: String(oldest.timestamp ?? ''), id: String(oldest.id) }) : null }
  }

  search(rawQuery: string, chatId?: string): SearchResult[] {
    const filters: Record<string, string> = {}
    const terms: string[] = []
    for (const token of rawQuery.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
      const operator = token.match(/^(from|chat|after|before|has|tag):(.+)$/iu)
      if (operator) filters[operator[1].toLowerCase()] = operator[2].replace(/^"|"$/g, '')
      else terms.push(token.replace(/^"|"$/g, ''))
    }
    const where: string[] = []; const params: unknown[] = []
    if (terms.length) { where.push('f.body MATCH ?'); params.push(terms.map(term => `"${term.replace(/"/g, '')}"`).join(' AND ')) }
    if (chatId) { where.push('m.chat_id = ?'); params.push(chatId) }
    if (filters.from) { where.push('m.sender_normalized LIKE ?'); params.push(`%${normalizedIdentity(filters.from)}%`) }
    if (filters.chat) { where.push('c.normalized_title LIKE ?'); params.push(`%${normalizedIdentity(filters.chat)}%`) }
    if (filters.after) { where.push('m.timestamp >= ?'); params.push(new Date(filters.after).toISOString()) }
    if (filters.before) { where.push('m.timestamp < ?'); params.push(new Date(`${filters.before}T23:59:59`).toISOString()) }
    if (filters.has) { where.push('md.kind = ?'); params.push(filters.has === 'image' ? 'image' : filters.has === 'video' ? 'video' : filters.has === 'audio' ? 'audio' : filters.has === 'document' ? 'document' : filters.has === 'link' ? 'link' : filters.has) }
    if (filters.has === 'link') { where.pop(); params.pop(); where.push("m.rendered_text LIKE '%http%'") }
    if (filters.tag) { where.push('EXISTS (SELECT 1 FROM chat_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.chat_id = c.id AND t.name = ?)'); params.push(filters.tag) }
    const table = terms.length ? 'message_fts f JOIN messages m ON m.id = f.message_id' : 'messages m LEFT JOIN message_fts f ON f.message_id = m.id'
    const condition = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT m.*, c.title AS chat_title, c.id AS chat_id_out, COALESCE((SELECT group_concat(t.name, '|') FROM tags t JOIN chat_tags ct ON ct.tag_id=t.id WHERE ct.chat_id=c.id),'') AS tag_names, md.id AS media_id_out, md.original_filename, md.mime_type, md.kind AS media_kind, md.size, b.message_id AS bookmark_id, a.body AS annotation FROM ${table} JOIN chats c ON c.id = m.chat_id LEFT JOIN media md ON md.id = m.media_id LEFT JOIN bookmarks b ON b.message_id = m.id LEFT JOIN annotations a ON a.message_id=m.id ${condition} ORDER BY m.timestamp DESC, m.id DESC LIMIT 200`).all(...params) as Record<string, unknown>[]
    return rows.map(row => ({ message: this.mapMessage(row), chat: { id: String(row.chat_id_out), title: String(row.chat_title), tags: String(row.tag_names ?? '').split('|').filter(Boolean) }, context: textPreview(String(row.rendered_text)) }))
  }

  updateChat(id: string, changes: { favorite?: boolean; archived?: boolean; notes?: string; tags?: string[] }): void {
    const fields: string[] = []; const params: unknown[] = []
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'tags' || value === undefined) continue
      fields.push(`${key} = ?`); params.push(typeof value === 'boolean' ? Number(value) : value)
    }
    if (fields.length) this.db.prepare(`UPDATE chats SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...params, isoNow(), id)
    if (changes.tags) {
      const transaction = this.db.transaction((tagNames: string[]) => {
        this.db.prepare('DELETE FROM chat_tags WHERE chat_id = ?').run(id)
        for (const rawName of tagNames.map(name => name.trim()).filter(Boolean)) {
          this.db.prepare('INSERT INTO tags (id, name) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(randomUUID(), rawName)
          const tag = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(rawName) as { id: string }
          this.db.prepare('INSERT OR IGNORE INTO chat_tags (chat_id, tag_id) VALUES (?, ?)').run(id, tag.id)
        }
      })
      transaction(changes.tags)
    }
  }

  toggleBookmark(messageId: string): boolean {
    const current = this.db.prepare('SELECT 1 FROM bookmarks WHERE message_id = ?').get(messageId)
    if (current) { this.db.prepare('DELETE FROM bookmarks WHERE message_id = ?').run(messageId); return false }
    this.db.prepare('INSERT INTO bookmarks (message_id, created_at) VALUES (?, ?)').run(messageId, isoNow()); return true
  }
  setAnnotation(messageId: string, annotation: string): void {
    if (!annotation.trim()) this.db.prepare('DELETE FROM annotations WHERE message_id = ?').run(messageId)
    else this.db.prepare('INSERT INTO annotations (message_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at').run(messageId, annotation.trim(), isoNow())
  }
  getPreference(key: string): string | null { return (this.db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null }
  setPreference(key: string, value: string): void { this.db.prepare('INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value) }
  getMediaPath(mediaId: string): string | null { const row = this.db.prepare('SELECT storage_path FROM media WHERE id = ?').get(mediaId) as { storage_path: string | null } | undefined; return row?.storage_path && path.resolve(row.storage_path).startsWith(path.resolve(this.mediaDir) + path.sep) ? row.storage_path : null }
  getStats() { const row = this.db.prepare(`SELECT (SELECT COUNT(*) FROM chats) AS chats, (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM media) AS media, (SELECT COUNT(*) FROM import_sources) AS sources`).get() as { chats: number; messages: number; media: number; sources: number }; return { ...row, storagePath: this.baseDir } }

  getLinks(chatId: string): LinkRecord[] { const rows = this.db.prepare('SELECT id, sender_display_name, timestamp, rendered_text FROM messages WHERE chat_id = ? AND rendered_text LIKE ? ORDER BY timestamp DESC LIMIT 500').all(chatId, '%http%') as { id: string; sender_display_name: string | null; timestamp: string | null; rendered_text: string }[]; return rows.flatMap(row => extractUrls(row.rendered_text).map(url => ({ messageId: row.id, url, sender: row.sender_display_name, timestamp: row.timestamp, context: textPreview(row.rendered_text) }))) }
  transcript(chatId: string): string { const chat = this.getChat(chatId); if (!chat) throw new Error('Chat not found.'); const messages = this.db.prepare('SELECT timestamp, sender_display_name, raw_text FROM messages WHERE chat_id = ? ORDER BY COALESCE(timestamp, \'\'), id').all(chatId) as { timestamp: string | null; sender_display_name: string | null; raw_text: string }[]; return [`ChatVault transcript: ${chat.title}`, `Exported ${new Date().toLocaleString()}`, '', ...messages.map(message => `${message.timestamp ? new Date(message.timestamp).toLocaleString() : 'Unknown date'}${message.sender_display_name ? ` — ${message.sender_display_name}` : ''}: ${message.raw_text}`)].join('\n') }

  private mapChat(row: Record<string, unknown>): ChatSummary { return { id: String(row.id), title: String(row.title), type: row.type as ChatSummary['type'], firstMessageAt: row.first_message_at as string | null, lastMessageAt: row.last_message_at as string | null, messageCount: Number(row.message_count), mediaCount: Number(row.media_count), sourceCount: Number(row.source_count), favorite: asBoolean(row.favorite as number), archived: asBoolean(row.archived as number), tags: String(row.tag_names ?? '').split('|').filter(Boolean), lastPreview: textPreview(String(row.last_preview ?? '')), lastOpenedAt: row.last_opened_at as string | null } }
  private mapMessage(row: Record<string, unknown>): MessageRecord {
    const media = row.media_id_out ? { id: String(row.media_id_out), messageId: String(row.id), originalFilename: String(row.original_filename), mimeType: String(row.mime_type), kind: row.media_kind as MediaKind, size: row.size === null ? null : Number(row.size), available: Boolean(row.storage_path) } satisfies MediaRecord : null
    return { id: String(row.id), chatId: String(row.chat_id), timestamp: row.timestamp as string | null, senderDisplayName: row.sender_display_name as string | null, kind: row.kind as MessageRecord['kind'], rawText: String(row.raw_text), renderedText: String(row.rendered_text), media, replyToMessageId: row.reply_to_message_id as string | null, replyPreview: row.reply_preview as string | null, replyConfidence: row.reply_confidence as MessageRecord['replyConfidence'], originalOrder: Number(row.original_order), bookmarked: Boolean(row.bookmark_id), annotation: row.annotation as string | null }
  }
  private async removeTree(dir: string): Promise<void> { try { const files = await walk(dir); await Promise.all(files.map(file => unlink(file))); await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true }) } catch { /* startup cleanup will reclaim a locked temporary directory later */ } }
}
