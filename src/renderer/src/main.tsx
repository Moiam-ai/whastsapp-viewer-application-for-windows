import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ArchiveStats, ChatDetails, ChatSummary, ImportPreparation, MediaRecord, MessageRecord, SearchResult, Theme } from '../../shared/models'
import '../styles.css'

declare global { interface Window { chatvaultFiles: { paths(files: File[]): string[] } } }

const ICONS: Record<string, string> = { archive: '▦', search: '⌕', favorite: '★', recent: '◷', media: '◉', group: '◌', tag: '⌘', import: '↥', info: 'ⓘ', more: '•••', settings: '⚙', close: '×', download: '⇩', pin: '⌖', link: '↗', folder: '▣', moon: '◐', sun: '☀', back: '‹', forward: '›', book: '▱', note: '✎', image: '▧', video: '▷', audio: '♫', document: '▤' }
function Icon({ name }: { name: string }): React.JSX.Element { return <span className="icon" aria-hidden>{ICONS[name] ?? '•'}</span> }
function dateText(value: string | null, style: 'short' | 'long' = 'short'): string { if (!value) return 'Unknown date'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Unknown date' : new Intl.DateTimeFormat(undefined, style === 'short' ? { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined } : { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
function timeText(value: string | null): string { return value ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '' }
function bytes(value: number | null): string { if (value === null) return ''; if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB` }
function dateKey(value: string | null): string { return value ? new Date(value).toDateString() : 'Undated messages' }

function RichText({ text, query }: { text: string; query?: string }): React.JSX.Element {
  const linkSplit = text.split(/(https?:\/\/[^\s<>]+)/giu)
  const queryRegex = query && query.trim() ? new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'giu') : null
  return <>{linkSplit.map((part, index) => {
    if (/^https?:\/\//iu.test(part)) return <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>
    const segments = queryRegex ? part.split(queryRegex) : [part]
    return <React.Fragment key={index}>{segments.map((segment, segmentIndex) => {
      const node = query && segment.localeCompare(query, undefined, { sensitivity: 'accent' }) === 0 ? <mark key={segmentIndex}>{segment}</mark> : <Formatted key={segmentIndex} text={segment} />
      return node
    })}</React.Fragment>
  })}</>
}

function Formatted({ text }: { text: string }): React.JSX.Element {
  const pieces = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`|\n)/gu)
  return <>{pieces.map((piece, index) => {
    if (piece === '\n') return <br key={index} />
    if (/^\*[^*]+\*$/u.test(piece)) return <strong key={index}>{piece.slice(1, -1)}</strong>
    if (/^_[^_]+_$/u.test(piece)) return <em key={index}>{piece.slice(1, -1)}</em>
    if (/^~[^~]+~$/u.test(piece)) return <s key={index}>{piece.slice(1, -1)}</s>
    if (/^`[^`]+`$/u.test(piece)) return <code key={index}>{piece.slice(1, -1)}</code>
    return <React.Fragment key={index}>{piece}</React.Fragment>
  })}</>
}

function Sidebar({ chats, selected, filter, onFilter, onOpen, onImport, query, setQuery, results, onResult, theme, cycleTheme }: { chats: ChatSummary[]; selected: string | null; filter: string; onFilter: (filter: string) => void; onOpen: (id: string) => void; onImport: () => void; query: string; setQuery: (query: string) => void; results: SearchResult[]; onResult: (result: SearchResult) => void; theme: Theme; cycleTheme: () => void }): React.JSX.Element {
  const nav = [['all', 'archive', 'All chats'], ['favorites', 'favorite', 'Favorites'], ['recent', 'recent', 'Recently opened'], ['media', 'media', 'With media'], ['groups', 'group', 'Groups'], ['archived', 'folder', 'Archived']]
  return <aside className="sidebar">
    <div className="brand-row"><div className="mark">C</div><div><h1>ChatVault</h1><span>Private archive</span></div><button className="icon-button" onClick={cycleTheme} title={`Theme: ${theme}`}><Icon name={theme === 'dark' ? 'moon' : 'sun'} /></button></div>
    <button className="import-button" onClick={onImport}><Icon name="import" /> Import export <kbd>Ctrl I</kbd></button>
    <label className="searchbox"><Icon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search your archive" aria-label="Search your archive" /><kbd>Ctrl K</kbd></label>
    {query ? <div className="search-results"><div className="section-label">{results.length} result{results.length === 1 ? '' : 's'}</div>{results.map(result => <button className="result-card" key={result.message.id} onClick={() => onResult(result)}><span>{result.chat.title} · {result.message.senderDisplayName ?? 'System'}</span><p>{result.context}</p><small>{dateText(result.message.timestamp, 'long')}</small></button>)}</div> : <>
      <nav className="nav-list">{nav.map(([key, icon, label]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => onFilter(key)}><Icon name={icon} />{label}{key === 'all' && <span>{chats.length}</span>}</button>)}</nav>
      <div className="sidebar-heading"><span>{filter === 'all' ? 'Archive' : nav.find(item => item[0] === filter)?.[2]}</span><button title="Archive settings"><Icon name="settings" /></button></div>
      <div className="chat-list">{chats.map(chat => <button key={chat.id} className={`chat-card ${selected === chat.id ? 'selected' : ''}`} onClick={() => onOpen(chat.id)}><div className="avatar">{chat.title.slice(0, 1).toUpperCase()}</div><div className="chat-card-text"><div><strong title={chat.title}>{chat.title}</strong><time>{dateText(chat.lastMessageAt)}</time></div><p>{chat.lastPreview}</p><div className="chat-meta">{chat.favorite && <Icon name="favorite" />}{chat.sourceCount > 1 && <span title={`${chat.sourceCount} merged source exports`}>⊕ {chat.sourceCount}</span>}{chat.tags.slice(0, 2).map(tag => <small key={tag}>{tag}</small>)}</div></div></button>)}</div>
    </>}
  </aside>
}

function Messages({ messages, hasOlder, loadOlder, onMedia, onBookmark, onAnnotate, query }: { messages: MessageRecord[]; hasOlder: boolean; loadOlder: () => Promise<void>; onMedia: (media: MediaRecord) => void; onBookmark: (message: MessageRecord) => void; onAnnotate: (message: MessageRecord) => void; query?: string }): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: messages.length, getScrollElement: () => parentRef.current, estimateSize: index => Math.max(68, Math.min(230, 52 + messages[index].renderedText.length * 0.52)), overscan: 8 })
  const lastTop = useRef(0)
  const onScroll = () => { const element = parentRef.current; if (element && element.scrollTop < 25 && hasOlder && !lastTop.current) { lastTop.current = 1; void loadOlder().finally(() => { lastTop.current = 0 }) } }
  return <div className="message-scroller" ref={parentRef} onScroll={onScroll}>
    {hasOlder && <button className="load-history" onClick={loadOlder}>Load earlier messages</button>}
    <div className="virtual-space" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map(item => {
      const message = messages[item.index]; const prior = messages[item.index - 1]; const showDate = !prior || dateKey(prior.timestamp) !== dateKey(message.timestamp)
      return <div className="virtual-row" key={message.id} ref={virtualizer.measureElement} data-index={item.index} style={{ transform: `translateY(${item.start}px)` }}>
        {showDate && <div className="date-divider"><span>{dateKey(message.timestamp)}</span></div>}
        <MessageBubble message={message} onMedia={onMedia} onBookmark={onBookmark} onAnnotate={onAnnotate} query={query} />
      </div>
    })}</div>
  </div>
}

function MessageBubble({ message, onMedia, onBookmark, onAnnotate, query }: { message: MessageRecord; onMedia: (media: MediaRecord) => void; onBookmark: (message: MessageRecord) => void; onAnnotate: (message: MessageRecord) => void; query?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const typeIcon = message.media?.kind === 'image' ? 'image' : message.media?.kind === 'video' ? 'video' : message.media?.kind === 'audio' ? 'audio' : 'document'
  if (message.kind === 'system') return <div className="system-message">{message.renderedText}</div>
  return <article className={`message-row ${message.senderDisplayName ? 'incoming' : 'system'}`}>
    <div className="message-sender">{message.senderDisplayName ?? 'System'}</div>
    <div className="bubble">
      {message.replyPreview && <button className="reply-preview"><strong>Reply</strong><span>{message.replyPreview}</span></button>}
      {message.kind === 'omitted-media' && <div className="omitted"><Icon name="media" /> Media omitted from this export</div>}
      {message.media && <button className={`media-card ${message.media.kind}`} onClick={() => onMedia(message.media!)}><Icon name={typeIcon} /><span>{message.media.originalFilename}</span><small>{bytes(message.media.size)} · {message.media.kind}</small></button>}
      {message.renderedText && message.kind !== 'omitted-media' && <div className="message-text"><RichText text={expanded ? message.renderedText : message.renderedText.slice(0, 1400)} query={query} />{message.renderedText.length > 1400 && <button className="inline-link" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button>}</div>}
      <div className="message-footer"><time>{timeText(message.timestamp)}</time>{message.bookmarked && <Icon name="book" />}<div className="message-actions"><button title="Copy message" onClick={() => void navigator.clipboard.writeText(message.rawText)}><Icon name="download" /></button><button title={message.bookmarked ? 'Remove bookmark' : 'Bookmark'} onClick={() => onBookmark(message)}><Icon name="book" /></button><button title="Add private note" onClick={() => onAnnotate(message)}><Icon name="note" /></button></div></div>
      {message.annotation && <div className="annotation"><Icon name="note" /> {message.annotation}</div>}
    </div>
  </article>
}

function EmptyArchive({ onImport, stats }: { onImport: () => void; stats: ArchiveStats | null }): React.JSX.Element { return <main className="empty-state"><div className="empty-glyph">⌁</div><p className="eyebrow">LOCAL-FIRST ARCHIVE</p><h2>Your conversations stay on your computer.</h2><p>Bring in a WhatsApp ZIP, an extracted export folder, or a <code>_chat.txt</code> file. ChatVault will inspect it before anything is added.</p><button className="primary-button" onClick={onImport}><Icon name="import" /> Import your first export</button><div className="empty-features"><span>◌ Offline by design</span><span>⌕ Searchable archive</span><span>⊕ Safe export merging</span></div>{stats && <small className="storage-label">Archive location: {stats.storagePath}</small>}</main> }

function ChatHeader({ chat, onInfo, onFavorite, onExport }: { chat: ChatDetails; onInfo: () => void; onFavorite: () => void; onExport: () => void }): React.JSX.Element { return <header className="chat-header"><div className="avatar large">{chat.title.slice(0, 1).toUpperCase()}</div><div className="chat-title"><h2>{chat.title}</h2><p>{chat.firstMessageAt ? `${new Date(chat.firstMessageAt).getFullYear()}–${chat.lastMessageAt ? new Date(chat.lastMessageAt).getFullYear() : ''}` : 'Undated'} · {chat.messageCount.toLocaleString()} messages · {chat.mediaCount.toLocaleString()} media · {chat.sourceCount} source{chat.sourceCount === 1 ? '' : 's'}</p></div><div className="header-actions"><button onClick={onFavorite} className={chat.favorite ? 'is-favorite' : ''} title="Favourite chat"><Icon name="favorite" /></button><button onClick={onExport} title="Export transcript"><Icon name="download" /></button><button onClick={onInfo} title="Chat information"><Icon name="info" /></button></div></header> }

function InfoPanel({ chat, close, save }: { chat: ChatDetails; close: () => void; save: (changes: { notes?: string; tags?: string[] }) => void }): React.JSX.Element {
  const [notes, setNotes] = useState(chat.notes); const [tags, setTags] = useState(chat.tags.join(', ')); const [section, setSection] = useState<'about' | 'media' | 'links' | 'sources'>('about')
  const commit = () => save({ notes, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) })
  return <aside className="info-panel"><header><div><p className="eyebrow">CHAT INFORMATION</p><h3>{chat.title}</h3></div><button className="icon-button" onClick={close}><Icon name="close" /></button></header><div className="tabs">{(['about', 'media', 'links', 'sources'] as const).map(item => <button className={section === item ? 'active' : ''} key={item} onClick={() => setSection(item)}>{item}</button>)}</div>{section === 'about' && <div className="info-content"><div className="stat-grid"><div><strong>{chat.messageCount.toLocaleString()}</strong><span>Messages</span></div><div><strong>{chat.mediaCount.toLocaleString()}</strong><span>Media</span></div><div><strong>{chat.sourceCount}</strong><span>Sources</span></div></div><h4>Participants</h4>{chat.participants.map(person => <div className="person" key={person.displayName}><span>{person.displayName}</span><small>{person.messageCount.toLocaleString()}</small></div>)}<h4>Tags</h4><input value={tags} onChange={event => setTags(event.target.value)} onBlur={commit} placeholder="family, important"/><h4>Private chat note</h4><textarea value={notes} onChange={event => setNotes(event.target.value)} onBlur={commit} placeholder="Only stored in ChatVault" /></div>}{section === 'links' && <div className="info-content">{chat.links.length ? chat.links.map(link => <a className="link-item" href={link.url} key={`${link.messageId}-${link.url}`} target="_blank" rel="noreferrer"><span>{link.url}</span><small>{link.sender ?? 'System'} · {dateText(link.timestamp)}</small></a>) : <p className="muted">No links were found in this chat.</p>}</div>}{section === 'sources' && <div className="info-content">{chat.sources.map(source => <div className="source-card" key={source.id}><strong>{source.filename}</strong><span>{source.sourceType} · {source.messageCount.toLocaleString()} messages</span><small>{source.detectedPlatform} · {dateText(source.importedAt, 'long')}</small></div>)}</div>}{section === 'media' && <div className="info-content"><p className="muted">Media is indexed with its message and opened locally. Use the search filter <code>has:image</code> to locate images across the archive.</p></div>}</aside>
}

function ImportDialog({ preparation, progress, close, commit }: { preparation: ImportPreparation; progress: { phase: string; completed: number; total: number; label: string } | null; close: () => void; commit: (choices: Record<string, 'merge' | 'separate'>) => void }): React.JSX.Element {
  const [choices, setChoices] = useState<Record<string, 'merge' | 'separate'>>(() => Object.fromEntries(preparation.previews.map(preview => [preview.id, 'merge'])))
  return <div className="dialog-backdrop" role="dialog" aria-modal="true"><div className="import-dialog"><header><div><p className="eyebrow">IMPORT REVIEW</p><h2>Ready to add {preparation.previews.length} export{preparation.previews.length === 1 ? '' : 's'}</h2></div><button className="icon-button" onClick={close} disabled={Boolean(progress)}><Icon name="close" /></button></header><div className="import-list">{preparation.previews.map(preview => <section className="import-preview" key={preview.id}><div className="preview-title"><div className="file-icon"><Icon name="archive" /></div><div><h3>{preview.chatTitle}</h3><p>{preview.sourceName} · {preview.detectedPlatform} · {preview.encoding}</p></div></div><div className="preview-stats"><span><strong>{preview.messages.toLocaleString()}</strong>messages</span><span><strong>{preview.mediaCandidates}</strong>media candidates</span><span>{dateText(preview.firstMessageAt)} — {dateText(preview.lastMessageAt)}</span></div>{preview.possibleMerge && <div className="merge-choice"><div><strong>Possible existing chat: {preview.possibleMerge.chat.title}</strong><p>{Math.round(preview.possibleMerge.confidence * 100)}% match confidence · approximately {preview.possibleMerge.duplicateEstimate.toLocaleString()} overlapping messages</p></div><div className="segmented"><button className={choices[preview.id] === 'merge' ? 'active' : ''} onClick={() => setChoices(value => ({ ...value, [preview.id]: 'merge' }))}>Merge safely</button><button className={choices[preview.id] === 'separate' ? 'active' : ''} onClick={() => setChoices(value => ({ ...value, [preview.id]: 'separate' }))}>Keep separate</button></div></div>}{preview.warnings.map(warning => <p className="warning" key={warning}>ⓘ {warning}</p>)}</section>)}</div>{progress && <div className="progress"><div><span>{progress.phase}: {progress.label}</span><strong>{progress.total ? Math.round(progress.completed / progress.total * 100) : 0}%</strong></div><i><b style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }} /></i></div>}<footer><span>Your original export is never modified.</span><div><button className="secondary-button" onClick={close} disabled={Boolean(progress)}>Cancel</button><button className="primary-button" onClick={() => commit(choices)} disabled={Boolean(progress)}>{progress ? 'Importing…' : 'Add to archive'}</button></div></footer></div></div>
}

function Lightbox({ media, close }: { media: MediaRecord; close: () => void }): React.JSX.Element {
  const [url, setUrl] = useState(''); useEffect(() => { setUrl(window.archive.getMediaUrl(media.id)) }, [media.id])
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener) }, [close])
  const visual = media.kind === 'image' || media.kind === 'gif' ? <img src={url} alt={media.originalFilename} /> : media.kind === 'video' ? <video src={url} controls autoPlay /> : media.kind === 'audio' ? <audio src={url} controls autoPlay /> : <div className="file-preview"><Icon name="document" /><strong>{media.originalFilename}</strong><span>{bytes(media.size)} · {media.mimeType}</span></div>
  return <div className="lightbox" role="dialog" aria-modal="true" onClick={close}><div className="lightbox-toolbar"><div><strong>{media.originalFilename}</strong><span>{bytes(media.size)} · {media.kind}</span></div><button className="icon-button" onClick={close}><Icon name="close" /></button></div><div className="lightbox-body" onClick={event => event.stopPropagation()}>{visual}</div><button className="open-externally" onClick={() => void window.archive.openMedia(media.id)}><Icon name="forward" /> Open externally</button></div>
}

function App(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>('system'); const [filter, setFilter] = useState('all'); const [chats, setChats] = useState<ChatSummary[]>([]); const [stats, setStats] = useState<ArchiveStats | null>(null); const [selected, setSelected] = useState<ChatDetails | null>(null); const [messages, setMessages] = useState<MessageRecord[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [query, setQuery] = useState(''); const [results, setResults] = useState<SearchResult[]>([]); const [infoOpen, setInfoOpen] = useState(false); const [preparation, setPreparation] = useState<ImportPreparation | null>(null); const [progress, setProgress] = useState<{ phase: string; completed: number; total: number; label: string } | null>(null); const [media, setMedia] = useState<MediaRecord | null>(null); const [error, setError] = useState<string | null>(null)
  const reloadChats = useCallback(async () => { setChats(await window.archive.listChats(filter)); setStats(await window.archive.getStats()) }, [filter])
  useEffect(() => { void reloadChats() }, [reloadChats])
  useEffect(() => { void window.archive.getPreference('theme').then(value => { if (value === 'light' || value === 'dark' || value === 'system') setTheme(value) }) }, [])
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => window.archive.onImportProgress(setProgress), [])
  useEffect(() => { const timer = window.setTimeout(() => { if (query.trim()) void window.archive.search(query).then(setResults).catch(showError); else setResults([]) }, 180); return () => window.clearTimeout(timer) }, [query])
  const showError = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))
  const openChat = async (id: string) => { try { const [chat, page] = await Promise.all([window.archive.getChat(id), window.archive.getMessages(id)]); setSelected(chat); setMessages(page.messages); setCursor(page.nextCursor); setInfoOpen(false); setQuery(''); await reloadChats() } catch (reason) { showError(reason) } }
  const loadOlder = async () => { if (!selected || !cursor) return; const page = await window.archive.getMessages(selected.id, cursor); setMessages(current => [...page.messages, ...current]); setCursor(page.nextCursor) }
  const beginImport = async (paths?: string[]) => { try { const selectedPaths = paths ?? await window.archive.chooseSources(); if (!selectedPaths.length) return; setProgress({ phase: 'Inspecting', completed: 0, total: selectedPaths.length, label: '' }); const value = await window.archive.prepareImport(selectedPaths); setProgress(null); setPreparation(value) } catch (reason) { setProgress(null); showError(reason) } }
  const commitImport = async (choices: Record<string, 'merge' | 'separate'>) => { if (!preparation) return; try { const result = await window.archive.commitImport(preparation.sessionId, choices); setProgress(null); setPreparation(null); await reloadChats(); if (result.imports[0]) await openChat(result.imports[0].chatId) } catch (reason) { setProgress(null); showError(reason) } }
  const toggleFavorite = async () => { if (!selected) return; await window.archive.updateChat(selected.id, { favorite: !selected.favorite }); const updated = await window.archive.getChat(selected.id); setSelected(updated); await reloadChats() }
  const saveInfo = async (changes: { notes?: string; tags?: string[] }) => { if (!selected) return; await window.archive.updateChat(selected.id, changes); const updated = await window.archive.getChat(selected.id); setSelected(updated); await reloadChats() }
  const onBookmark = async (message: MessageRecord) => { const bookmarked = await window.archive.toggleBookmark(message.id); setMessages(current => current.map(item => item.id === message.id ? { ...item, bookmarked } : item)) }
  const onAnnotate = async (message: MessageRecord) => { const annotation = window.prompt('Private note for this message', message.annotation ?? ''); if (annotation === null) return; await window.archive.setAnnotation(message.id, annotation); setMessages(current => current.map(item => item.id === message.id ? { ...item, annotation } : item)) }
  const cycleTheme = () => { const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'; setTheme(next); void window.archive.setPreference('theme', next) }
  const drop = (event: React.DragEvent) => { event.preventDefault(); const paths = window.chatvaultFiles.paths([...event.dataTransfer.files]); if (paths.length) void beginImport(paths) }
  const selectedTitle = useMemo(() => selected?.title ?? '', [selected])
  return <div className="app-shell" onDragOver={event => event.preventDefault()} onDrop={drop}>
    <Sidebar chats={chats} selected={selected?.id ?? null} filter={filter} onFilter={setFilter} onOpen={id => void openChat(id)} onImport={() => void beginImport()} query={query} setQuery={setQuery} results={results} onResult={result => void openChat(result.chat.id)} theme={theme} cycleTheme={cycleTheme} />
    <section className="conversation">{selected ? <><ChatHeader chat={selected} onInfo={() => setInfoOpen(true)} onFavorite={() => void toggleFavorite()} onExport={() => void window.archive.exportText(selected.id)} /><Messages messages={messages} hasOlder={Boolean(cursor)} loadOlder={loadOlder} onMedia={setMedia} onBookmark={message => void onBookmark(message)} onAnnotate={message => void onAnnotate(message)} query={query} /></> : <EmptyArchive onImport={() => void beginImport()} stats={stats} />}</section>
    {infoOpen && selected && <InfoPanel chat={selected} close={() => setInfoOpen(false)} save={changes => void saveInfo(changes)} />}
    {preparation && <ImportDialog preparation={preparation} progress={progress} close={() => setPreparation(null)} commit={choices => void commitImport(choices)} />}
    {media && <Lightbox media={media} close={() => setMedia(null)} />}
    {error && <div className="toast error"><span>{error}</span><button onClick={() => setError(null)}><Icon name="close" /></button></div>}
    {selectedTitle && <span className="sr-only">Viewing {selectedTitle}</span>}
  </div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
