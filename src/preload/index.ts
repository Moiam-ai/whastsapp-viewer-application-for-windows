import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ArchiveApi } from '../shared/models'

const api: ArchiveApi = {
  chooseSources: () => ipcRenderer.invoke('archive:chooseSources'),
  prepareImport: paths => ipcRenderer.invoke('archive:prepareImport', paths),
  commitImport: (sessionId, choices) => ipcRenderer.invoke('archive:commitImport', sessionId, choices),
  listChats: filter => ipcRenderer.invoke('archive:listChats', filter),
  getChat: id => ipcRenderer.invoke('archive:getChat', id),
  getMessages: (id, before) => ipcRenderer.invoke('archive:getMessages', id, before),
  search: (query, chatId) => ipcRenderer.invoke('archive:search', query, chatId),
  updateChat: (id, changes) => ipcRenderer.invoke('archive:updateChat', id, changes),
  toggleBookmark: id => ipcRenderer.invoke('archive:toggleBookmark', id),
  setAnnotation: (id, annotation) => ipcRenderer.invoke('archive:setAnnotation', id, annotation),
  exportText: id => ipcRenderer.invoke('archive:exportText', id),
  getMediaUrl: id => `chatvault-media://${id}`,
  openMedia: id => ipcRenderer.invoke('archive:openMedia', id),
  getPreference: key => ipcRenderer.invoke('archive:getPreference', key),
  setPreference: (key, value) => ipcRenderer.invoke('archive:setPreference', key, value),
  getStats: () => ipcRenderer.invoke('archive:getStats'),
  onImportProgress: listener => { const handler = (_event: Electron.IpcRendererEvent, value: { phase: string; completed: number; total: number; label: string }) => listener(value); ipcRenderer.on('archive:importProgress', handler); return () => ipcRenderer.removeListener('archive:importProgress', handler) }
}

contextBridge.exposeInMainWorld('archive', api)
contextBridge.exposeInMainWorld('chatvaultFiles', { paths: (files: File[]) => files.map(file => webUtils.getPathForFile(file)).filter(Boolean) })
