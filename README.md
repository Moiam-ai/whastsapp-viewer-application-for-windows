# ChatVault

ChatVault is a local-first Windows desktop viewer for WhatsApp text and ZIP exports. It indexes content in a local SQLite archive, stores media by SHA-256, and never sends chat content to a service.

## Development

```powershell
npm install
npm run dev
```

## Package for Windows

```powershell
npm run build
```

The NSIS installer is written to `release/`. The archive itself lives under the application data directory (`ChatVault/archive`) and is separate from the application installation.

## Supported first release workflow

- Import one or more `_chat.txt` files, export folders, or ZIP exports.
- Preview a possible same-chat merge before committing it.
- Persist canonical messages, sources, provenance, tags, bookmarks, notes, and media locally.
- Browse, search, filter, favourite, and export text transcripts without network access.

WhatsApp plain-text exports do not contain all of the data present in a live chat (for example reliable reply IDs and reactions). ChatVault preserves raw source lines and represents uncertainty rather than manufacturing missing history.
