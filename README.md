# IndexLy

> Local index manager for any file. Games, books, movies — whatever you use. Load, combine and search instantly. Nothing leaves your browser.

**Demo:** https://indexly.daida.net · **Repo:** https://github.com/daidarzzz/indexly

[![Deploy](https://github.com/daidarzzz/indexly/actions/workflows/deploy.yml/badge.svg)](https://github.com/daidarzzz/indexly/actions/workflows/deploy.yml) ![Astro](https://img.shields.io/badge/Astro-7.2-0e0e0e) ![Local only](https://img.shields.io/badge/storage-IndexedDB-0ea5e9) ![License](https://img.shields.io/badge/license-MIT-6b7280)

### What it is

IndexLy lets you throw in any file and search across them as one. Three game dumps, two book lists and a movie export? Drop them in, toggle sources on/off, and search. It's useful when you don't want to upload anything anywhere. Everything is parsed locally.

Built because I had too many JSON exports and no good way to search them together without spinning up a database — now it also handles CSV, YAML, XML and more.

### Features

- **Any file, one search.** `JSON`, `CSV`/`TSV`, `YAML`/`YML`, `XML`, `TXT` via `src/utils/loaders.js`. Add several files at once (`multiple`), drag & drop, or paste with `Ctrl+V`. Toggle each source or delete it. Search runs over the union of active sources.
- **Generic normalizer.** No strict schema required. Auto-detects where the array is (`downloads`, `items`, `results`, `data`, `entries`, `list`, nested `data.items`), picks a title field (`title`/`name`/`nombre`...), a link (`url`/`uris`/`magnet`/`link`...) and treats the rest as metadata. Single-object and primitive arrays (`["one","two"]`) also work. Fallback name is filename without extension.
- **Manual mapping when auto fails.** Click ⚙ on any source to rename it and pick which field is Title / Subtitle / Link. Live preview (`N elementos · ej: "..."`). Mapping is saved in IndexedDB per source.
- **Totally instant search.** `0ms` direct `input → renderSearch()`, no debounce. Diacritics-insensitive (`NFD` + `normalizeStr`), covers `title + subtitle + source + metadata + fileSize`. `_searchText` cached per item (non-enumerable) so filtering is just `includes`. `?q=` synced via `history.replaceState` for shareable links, `/` and `Ctrl/Cmd+K` to focus.
- **Filter & sort.** Chips `Todos / Con enlace / Sin enlace` and select `Relevancia / Título A-Z/Z-A / Tamaño ↓/↑ / Fecha reciente/antigua` (size via `parseSizeToBytes`, date via `getItemDate` on `uploadDate/fecha` metadata). 50 items paginated with “Cargar más”, `content-visibility: auto` on cards.
- **Bulk actions.** `Activar todo / Desactivar todo / Borrar todo` (with confirm). Per-source `Activar/Desactivar`, `⚙` map, `✕` delete with undo `Deshacer` (6s toast with action + 6.5s timer).
- **Drag & drop + paste + file picker.** `drop-zone` handles `.json/.csv/.tsv/.yaml/.yml/.xml/.txt`, toast on wrong type, paste JSON/CSV/YAML from clipboard creates `Pegado HH:MM:SS` source.
- **Export / Import with selection.** Premium modals (`#0f141e`, `blur(6px)` overlay, no animation). Export: checkbox list with pill `Seleccionar todo` (`:global`), counter `3/3`, `dot` status, `badge` compact (`1,4k` via `fmtCompact`, `title` full), `Cancelar / Exportar (N)` → `indexly-backup-YYYY-MM-DD.json`. Import: same list parsed from backup, duplicates `disabled` (`ya existe` / `sin datos`), `Seleccionar todo` only on enabled, `Importar (N)`. Close on overlay / `Escape`.
- **Toasts & confirms.** Minimal dark pills `#0f141e` / border `#1e293b`, `toast-success/warning/error` with colored dot, separator `1px #1e293b`, action pill `#1a2335`. Confirm modal reuses `mapping-dialog` style.
- **Quotas & polish.** `navigator.storage.estimate()` → `Almacenamiento: X MB (Y%)` when `>75%`. `Fuentes` collapsible with chevron `26px` pill (`localStorage indexly_fuentes_collapsed`). Minimal dark premium design, segmented pill controls `#0a0f1c`, no entrance animations.
- **100% local.** `idb-keyval` → `indexly_saved_indexes` in IndexedDB. No backend, no account, no telemetry. Footer says it: *Todo se guarda localmente. Nada se envía a servidores.*
- **Static & SEO.** Astro 7 static, 3 deps (`astro`, `idb-keyval`, `yaml`, `@astrojs/sitemap`). `site: https://indexly.daida.net`, `robots.txt`, `sitemap.xml`, `manifest.json`, `theme-color`, OG/twitter/canonical.

### Quick start

1. Open https://indexly.daida.net
2. Click **Añadir archivo** and drop your files (or drag & drop / `Ctrl+V`)
3. Type to search — use `/` to focus, chips to filter, select to sort

**Legacy games format (still supported):**
```json
{
  "name": "My Games",
  "downloads": [
    { "title": "SuperTuxKart", "fileSize": "1.2 GB", "uploadDate": "2026-04-04T17:39:30+00:00", "uris": ["https://example.com/supertuxkart.zip"] }
  ]
}
```

**Generic format (books, movies, anything):**
```json
{
  "name": "My Books",
  "items": [
    { "title": "Dune", "author": "Frank Herbert", "url": "https://..." },
    { "title": "Foundation", "author": "Asimov", "year": 1951 }
  ]
}
```

Other supported shapes:
- Root array: `[{"title": "A"}, {"title": "B"}]`
- Nested: `{"data": {"items": [...]}}`
- Single object: `{"title": "Solo", "author": "Me"}`
- Primitive list: `["one", "two", "three"]`
- CSV/TSV/YAML/XML/TXT → auto-converted to raw object then normalized

If auto-detection picks the wrong field, open ⚙ → pick Title/Subtitles/Link manually. You can also rename the source there.

### Display details

- `fileSize` / `Tamaño` and `uploadDate` show as plain values (`26.6 GB`, `04/04/26` via `formatDateDDMMYY`) without the label, to keep cards clean. Other metadata shows as `Label: value` (max 3 badges).
- Search covers all visible metadata. Diacritics stripped (`é→e`, `ñ→n`).

### Local development

```sh
npm ci
npm run dev      # http://localhost:4321
npm run build    # ./dist
npm run preview
```

Requires `node >= 22.12.0`. No env vars.

When starting the dev server, use background mode per `AGENTS.md`:
```sh
astro dev --background
# manage with astro dev stop / status / logs
```

### Stack & Privacy

- **Stack:** Astro 7 (static), vanilla JS, CSS variables, `idb-keyval` for persistence, `yaml` for YAML, `@astrojs/sitemap` for SEO.
- **Privacy:** No `fetch` to external APIs, no analytics. Only Google Fonts (`Inter` + `JetBrains Mono`) are fetched. IndexedDB quota is browser-dependent — very large files will just hit the `set` alert.
- **Deploy:** `push` to `master` → GitHub Actions (`actions/checkout`, `setup-node`, `npm ci`, `npm run build`, `peaceiris/actions-gh-pages` with `cname: indexly.daida.net`).

### Project structure

```
/
├── public/             # favicon, CNAME, manifest.json, robots.txt
├── src/
│   ├── components/     # Search.astro (core), Title.astro
│   ├── layouts/        # Layout.astro (design system)
│   ├── pages/          # index.astro
│   ├── utils/          # normalizer.js, loaders.js, parsers/
│   └── assets/
├── astro.config.mjs
└── package.json
```

Key files: `src/components/Search.astro` (~1100 lines), `src/utils/normalizer.js`, `src/utils/loaders.js` (CSV/TSV/YAML/XML/TXT), `src/layouts/Layout.astro`, `astro.config.mjs`.

### Roadmap

- [x] CSV / TSV / YAML / XML / TXT loaders (same normalizer)
- [x] Export/Import selection modals with premium UI
- [x] Instant search with cache + URL sync (no highlight overhead)
- [ ] Optional API sources (e.g. TMDB) with per-user key + IndexedDB cache
- [ ] Worker for very large files
- [ ] Tags / categories per item

Ideas and samples that fail auto-detection are welcome — open an issue with an anonymized sample.

### Contributing

1. Fork → branch → PR to `master`.
2. Keep it local-first. No backend unless discussed.
3. If your file isn’t detected, attach a minimal sample and the expected Title/Link mapping.

### License

MIT — see `LICENSE`. If you use it, a star is appreciated but not required.
