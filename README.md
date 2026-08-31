# IndexLy

> Local index manager for any JSON. Games, books, movies — whatever you use. Load, combine and search instantly. Nothing leaves your browser.

**Demo:** https://indexly.daida.net · **Repo:** https://github.com/daidarzzz/indexly

[![Deploy](https://github.com/daidarzzz/indexly/actions/workflows/deploy.yml/badge.svg)](https://github.com/daidarzzz/indexly/actions/workflows/deploy.yml) ![Astro](https://img.shields.io/badge/Astro-7.2-0e0e0e) ![Local only](https://img.shields.io/badge/storage-IndexedDB-0ea5e9) ![License](https://img.shields.io/badge/license-MIT-6b7280)

### What it is

IndexLy lets you throw in any `.json` and search across them as one. You have three game dumps, two book lists and a movie export? Drop them in, toggle sources on/off, and search. It's useful when you don't want to upload anything anywhere.

Built because I had too many JSON exports and no good way to search them together without spinning up a database.

### Features

- **Multiple sources, one search.** Add several JSON files at once (`multiple` input). Toggle each source or delete it. The search runs over the union of active sources.
- **Generic normalizer.** No strict schema required. It auto-detects where the array is (`downloads`, `items`, `results`, `data`, `entries`, `list`, etc.), picks a title field (`title`/`name`/`nombre`...), a link (`url`/`uris`/`magnet`...) and treats the rest as metadata. Single-object JSON and primitive arrays also work.
- **Manual mapping when auto fails.** Click ⚙ on any source to rename it and pick which field is Title / Subtitle / Link. Preview is live. Mapping is saved in IndexedDB.
- **Fast search.** Filters on `title + subtitle + source + metadata`. Instant `input` filtering, `50` items paginated with “Load more”, `/` and `Ctrl/Cmd+K` to focus.
- **100% local.** Uses `idb-keyval` → `indexly_saved_indexes` in IndexedDB. No backend, no account, no telemetry. Footer says it: *Everything stays locally. Nothing is sent to servers.*
- **Small and static.** Astro static build, 2 dependencies (`astro`, `idb-keyval`), deploys to GitHub Pages.

### Quick start

1. Open https://indexly.daida.net
2. Click **Add JSON** and drop your files
3. Type to search — use `/` to focus

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

If auto-detection picks the wrong field, open ⚙ → pick Title/Subtitles/Link manually. You can also rename the source there.

### Display details

- `fileSize` / `Tamaño` and `uploadDate` show as plain values (`26.6 GB`, `04/04/26`) without the label, to keep cards clean. Other metadata shows as `Label: value` (max 3 badges).
- Search covers all visible metadata.

### Local development

```sh
npm ci
npm run dev      # http://localhost:4321
npm run build    # ./dist
npm run preview
```

Requires `node >= 22.12.0`. No env vars.

### Stack & Privacy

- **Stack:** Astro 7 (static), vanilla JS, CSS variables, `idb-keyval` for persistence.
- **Privacy:** No `fetch` to external APIs, no analytics. Only Google Fonts (`Inter` + `JetBrains Mono`) are fetched. IndexedDB quota is browser-dependent — very large JSONs will just hit the `set` alert.
- **Deploy:** `push` to `master` → GitHub Actions (`actions/checkout`, `setup-node`, `npm ci`, `npm run build`, `peaceiris/actions-gh-pages` with `cname: indexly.daida.net`).

### Project structure

```
/
├── public/             # favicon, CNAME
├── src/
│   ├── components/     # Search.astro (core), Title.astro
│   ├── layouts/        # Layout.astro (design system)
│   ├── pages/          # index.astro
│   ├── utils/          # normalizer.js, parsers/gameParser.js
│   └── assets/
├── astro.config.mjs
└── package.json
```

Key files: `src/components/Search.astro`, `src/utils/normalizer.js`, `src/utils/parsers/gameParser.js`, `astro.config.mjs`.

### Roadmap

- [ ] CSV / TSV / YAML loaders (same normalizer)
- [ ] Optional API sources (e.g. TMDB) with per-user key + IndexedDB cache
- [ ] Worker for large files

Ideas and JSON samples that fail auto-detection are welcome — open an issue with an anonymized sample.

### Contributing

1. Fork → branch → PR to `master`.
2. Keep it local-first. No backend unless discussed.
3. If your JSON isn’t detected, attach a minimal sample and the expected Title/Link mapping.

### License

MIT — see `LICENSE`. If you use it, a star is appreciated but not required.
