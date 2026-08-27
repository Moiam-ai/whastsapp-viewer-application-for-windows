import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { join, normalize, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ArchiveRepository } from './archive'

protocol.registerSchemesAsPrivileged([
  { scheme: 'chatvault', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'chatvault-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

let mainWindow: BrowserWindow | null = null
let archive: ArchiveRepository

function rendererPath(url: string): string | null {
  const requested = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '') || 'index.html'
  const root = join(__dirname, '../renderer')
  const resolved = normalize(join(root, requested))
  return relative(root, resolved).startsWith('..') ? null : resolved
}

async function registerProtocols(): Promise<void> {
  protocol.handle('chatvault', async request => {
    const filePath = rendererPath(request.url)
    if (!filePath) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(filePath).toString())
  })
  protocol.handle('chatvault-media', async request => {
    const mediaId = new URL(request.url).hostname || new URL(request.url).pathname.replace(/^\//, '')
    const filePath = archive.getMediaPath(mediaId)
    if (!filePath) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: 'ChatVault',
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/iu.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadURL('chatvault://app/index.html')
}

function requireArchive(): ArchiveRepository {
  if (!archive) throw new Error('Archive is still initializing.')
  return archive
}

function registerIpc(): void {
  ipcMain.handle('archive:chooseSources', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import WhatsApp export',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'WhatsApp exports', extensions: ['zip', 'txt'] }, { name: 'All files', extensions: ['*'] }]
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('archive:prepareImport', (_event, paths: unknown) => requireArchive().prepareImport(validatePaths(paths)))
  ipcMain.handle('archive:commitImport', (_event, sessionId: unknown, choices: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid import session.')
    const safeChoices: Record<string, 'merge' | 'separate'> = {}
    if (choices && typeof choices === 'object') for (const [id, choice] of Object.entries(choices as Record<string, unknown>)) if (choice === 'merge' || choice === 'separate') safeChoices[id] = choice
    return requireArchive().commitImport(sessionId, safeChoices)
  })
  ipcMain.handle('archive:listChats', (_event, filter: unknown) => requireArchive().listChats(typeof filter === 'string' ? filter : 'all'))
  ipcMain.handle('archive:getChat', (_event, id: unknown) => requireArchive().getChat(validateId(id)))
  ipcMain.handle('archive:getMessages', (_event, id: unknown, cursor: unknown) => requireArchive().getMessages(validateId(id), typeof cursor === 'string' ? cursor : null))
  ipcMain.handle('archive:search', (_event, query: unknown, chatId: unknown) => requireArchive().search(String(query ?? '').slice(0, 500), typeof chatId === 'string' ? chatId : undefined))
  ipcMain.handle('archive:updateChat', (_event, id: unknown, changes: unknown) => { requireArchive().updateChat(validateId(id), validateChatChanges(changes)); })
  ipcMain.handle('archive:toggleBookmark', (_event, id: unknown) => requireArchive().toggleBookmark(validateId(id)))
  ipcMain.handle('archive:setAnnotation', (_event, id: unknown, annotation: unknown) => requireArchive().setAnnotation(validateId(id), String(annotation ?? '').slice(0, 10_000)))
  ipcMain.handle('archive:getPreference', (_event, key: unknown) => requireArchive().getPreference(validateKey(key)))
  ipcMain.handle('archive:setPreference', (_event, key: unknown, value: unknown) => requireArchive().setPreference(validateKey(key), String(value ?? '').slice(0, 10_000)))
  ipcMain.handle('archive:getStats', () => requireArchive().getStats())
  ipcMain.handle('archive:getMediaUrl', (_event, id: unknown) => `chatvault-media://${validateId(id)}`)
  ipcMain.handle('archive:openMedia', async (_event, id: unknown) => {
    const mediaPath = requireArchive().getMediaPath(validateId(id))
    if (!mediaPath) throw new Error('Media file is no longer available.')
    const error = await shell.openPath(mediaPath)
    if (error) throw new Error(error)
  })
  ipcMain.handle('archive:exportText', async (_event, id: unknown) => {
    const chat = requireArchive().getChat(validateId(id))
    if (!chat) throw new Error('Chat not found.')
    const result = await dialog.showSaveDialog(mainWindow!, { title: 'Export text transcript', defaultPath: `${chat.title.replace(/[<>:"/\\|?*]/g, '_')}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] })
    if (result.canceled || !result.filePath) return { cancelled: true }
    await (await import('node:fs/promises')).writeFile(result.filePath, requireArchive().transcript(chat.id), 'utf8')
    return { cancelled: false, path: result.filePath }
  })
}

function validateId(value: unknown): string { if (typeof value !== 'string' || !/^[a-z0-9-]{8,80}$/iu.test(value)) throw new Error('Invalid identifier.'); return value }
function validateKey(value: unknown): string { if (typeof value !== 'string' || !/^[a-z0-9._-]{1,80}$/iu.test(value)) throw new Error('Invalid preference key.'); return value }
function validatePaths(value: unknown): string[] { if (!Array.isArray(value) || value.length > 25 || value.some(item => typeof item !== 'string' || item.length > 32_000)) throw new Error('Invalid import paths.'); return value as string[] }
function validateChatChanges(value: unknown): { favorite?: boolean; archived?: boolean; notes?: string; tags?: string[] } {
  if (!value || typeof value !== 'object') throw new Error('Invalid chat update.')
  const input = value as Record<string, unknown>; const result: { favorite?: boolean; archived?: boolean; notes?: string; tags?: string[] } = {}
  if (typeof input.favorite === 'boolean') result.favorite = input.favorite
  if (typeof input.archived === 'boolean') result.archived = input.archived
  if (typeof input.notes === 'string') result.notes = input.notes.slice(0, 20_000)
  if (Array.isArray(input.tags)) result.tags = input.tags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.slice(0, 80)).slice(0, 30)
  return result
}

app.whenReady().then(async () => {
  archive = new ArchiveRepository(join(app.getPath('userData'), 'archive'), event => mainWindow?.webContents.send('archive:importProgress', event))
  await archive.initialize()
  await registerProtocols()
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(error => { dialog.showErrorBox('ChatVault could not start', error instanceof Error ? error.message : String(error)); app.quit() })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
