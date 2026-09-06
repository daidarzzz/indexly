# AGENTS.md — IndexLy

Guía para agentes de IA. Objetivo: entender el proyecto y editar correctamente con el mínimo de lecturas/ tokens.

## Resumen

**IndexLy**: gestor local de índices (juegos, libros, películas, cualquier lista). Importa archivos de datos y busca en todos como una sola base de datos.

- **Arquitectura**: SPA estática de 1 página con Astro 7. **Cero frameworks frontend** (no React/Vue/Svelte): toda la lógica es JavaScript vanilla en un solo `<script>` client-side.
- **Privacidad por diseño (restricción dura)**: todo ocurre en el navegador, sin backend ni telemetría. Las únicas llamadas de red son la API opcional de IndexlyHub (ver sección IndexlyHub).
- **Idioma**: TODOS los strings de UI, mensajes de error, aria-labels, comentarios y commits van en **español**. Sin framework i18n (hardcodeados). Fechas `es-ES`.
- Sin tests, sin lint, sin typecheck. La verificación es `npm run build` sin errores.

## Comandos

```bash
# Servidor de desarrollo — usar SIEMPRE modo background:
astro dev --background
astro dev status      # comprobar estado
astro dev logs        # ver logs
astro dev stop        # parar

npm run build         # build de producción a ./dist (es la "verificación": debe terminar sin errores)
npm run preview       # servir ./dist
```

Requisito: Node >= 22.12.0. No existe `npm run lint/test/typecheck`.

## Mapa de archivos

| Archivo | Rol |
|---|---|
| `src/pages/index.astro` | Única ruta (`/`). Compone `Layout` + `Title` + `Search`. |
| `src/layouts/Layout.astro` | Shell HTML (`lang="es"`, fuentes Inter/JetBrains Mono, PWA manifest, meta OG). Contiene el **design system global** en `<style is:global>`: ~70 custom properties (paleta oscura, escala tipográfica, grid de 4px, radii, shadows) bajo el encabezado "Premium Design System". |
| `src/components/Search.astro` | **LA APLICACIÓN ENTERA (~2040 líneas, monolito intencional).** Markup líneas 1–241 (fuentes, hub, buscador, chips, grid de resultados, 5 modales, toasts), `<script>` líneas 242–1546 (toda la lógica client), estilos scoped líneas 1548–2040. Las features nuevas se añaden aquí, no se extraen componentes. |
| `src/components/Title.astro` | Header sticky (logo, botón "Conectar Hub" `#hub-connect-btn`, `#hub-dot`) + hero. Sus IDs de elementos son consumidos por el script de `Search.astro`. |
| `src/components/Welcome.astro` | **Código muerto** del starter de Astro. No se usa, no tocar ni importar. |
| `src/utils/loaders.js` | `parseFileContent(text, fileName)`: dispatch por extensión → CSV/TSV (parser propio, quote-aware), YAML (`yaml` npm), XML (`DOMParser`), TXT (1 título/línea), JSON por defecto. Devuelve `{name, items}` u objeto crudo. |
| `src/utils/normalizer.js` | **Motor central.** `normalizeJson(rawJson, fileName, mapping)` convierte JSON arbitrario en array plano de items `{id, source, title, subtitle, fileSize, link, meta, raw}`. También: `detectArray()` (claves prioritarias `downloads/items/results/data/…`, fallback al mayor array), `getAvailableKeys()`, `getAutoMapping()`. Heurísticas de claves con variantes españolas (`titulo`, `nombre`, `enlace`, `tamaño`, `magnet`). |
| `src/utils/exportCodec.js` | Backup: `compactIndexes()` → envelope `{v:2, s:[…]}` (columnas tabulares, mapping como tupla), `inflateIndexes()` (round-trip), `migrateV1()`, `isV2Envelope()`. Errores en español. |
| `src/utils/compress.js` | gzip nativo (`CompressionStream`): `compressJsonToBlob()`, `decompressBlobToText()` (sniffea magic bytes `1f 8b`), `decodeBackupFile()`. |
| `src/utils/gameParser.js` | **Shim legacy**: re-exporta `normalizeJson` como `parseGameJson`. Usar `normalizer.js` directamente en código nuevo. |
| `src/utils/parsers/gameParser.js` | Parser legacy del formato "juegos" (`{name, downloads:[{title, fileSize, uris[]}]}`). |
| `src/utils/parsers/registry.js` | Registro `parsers = {auto, juegos}`. **NO lo usa la UI** (Search.astro llama a `normalizeJson` directo). No lo seguir con código nuevo. |
| `src/assets/*` | SVGs del starter. Sin uso. |
| `public/` | `CNAME` (indexly.daida.net), favicons, `manifest.json` (PWA standalone, theme `#070a12`), `robots.txt`. |

## Flujo de datos

```
Importación (file input / drag&drop / Ctrl+V / deep-link Hub ?import=)
  → handleFiles()            Search.astro:450
  → parseFileContent()       loaders.js        texto → objeto crudo
  → normalizeJson()          normalizer.js     objeto crudo → items planos
  → estado `indexes`         [{id, name, active, rawData, mapping, pkg, games}]
  → saveIndexesToStorage()   Search.astro:443  → idb-keyval set("indexly_saved_indexes")
  → updateApp()              Search.astro:877  re-render imperativo completo
```

- **Búsqueda**: `renderSearch()` (Search.astro:853) concatena `games` de los índices *activos*, aplica chips de filtro (con/sin link), búsqueda substring sobre `getSearchableText()` (blob minúsculas sin diacríticos, memoizado). URL sync con `?q=` (`history.replaceState`). Paginación de 50 + botón "Cargar más". Vista lista o cuadrícula (cards con gradiente HSL determinista del hash del título).
- **Mapping manual**: modal por fuente elige qué claves crudas → título/subtítulo/link; se guarda en `index.mapping` y se re-aplica al cargar.
- **Backup**: export → `compactIndexes()` → gzip opcional → `indexly-backup-YYYY-MM-DD.json.gz`; import → sniff gzip → v2 envelope o `migrateV1` → modal de selección → merge.
- **Init** (fin del script de Search.astro): aplica vista → `loadStoredIndexes()` → `updateHubUI()` → `handleHubImport()` si hay `?import=`.

## Estado y persistencia

- **Sin store/lib de estado**: variables de módulo en el script de `Search.astro` (`indexes`, `currentFilteredGames`, `activeFilter`, `sortBy`, `resultsView`, `visibleCount`, `hubToken`, `hubTab`, `hubCache`…). Re-render imperativo tras cada mutación.
- **IndexedDB** (vía `idb-keyval`, única lib de persistencia): clave `"indexly_saved_indexes"` — solo en `loadStoredIndexes()` (:428) y `saveIndexesToStorage()` (:443). Al guardar se descartan los `games` derivados; se re-normalizan al cargar con el `mapping` guardado.
- **localStorage** (solo preferencias UI): `indexly_results_view`, `indexly_fuentes_collapsed`, `indexly_hub_collapsed`, `indexly_hub_token` (Bearer `ih_…`), `indexly_pkg_collapsed` (JSON map).
- **Handlers globales**: el HTML generado usa `onclick="…"` inline → las funciones (`toggleIndex`, `removeIndex`, `openMappingModal`, `saveMapping`, `hubImport`…) deben estar expuestas en `window`.
- **Seguridad**: TODO dato de usuario interpolado en HTML generado pasa por `escapeHtml()` (Search.astro:406). Mantener esto en HTML nuevo.
- **Toasts**: `showToast(msg, type, duration, action)` (:317) con soporte de acción "Deshacer" (borrado con undo de 6.5s); confirmaciones destructivas vía modal `showConfirm()`.

## Convenciones

- Componentes `.astro` con frontmatter mínimo (a menudo vacío); cero lógica server-side; un `<script>` client por componente, procesado por Vite (imports relativos **sin extensión** `.js`, p. ej. `../utils/normalizer`).
- JS plano sin tipos (tsconfig `strict` solo afecta a config de Astro). No introducir TypeScript ni Tailwind ni frameworks sin pedirlo.
- Estilos: tokens del design system de `Layout.astro` vía `var(--color-*)`, `var(--space-*)`, `var(--radius-*)`, `var(--text-*)`. Tema oscuro fijo (no hay light mode). Estilos por componente en `<style>` scoped.
- Monolito intencional: editar/añadir en `Search.astro` siguiendo el patrón existente (función → muta estado → `updateApp()`).
- Red: cualquier fetch lleva `AbortController` con timeout (~20s).

## IndexlyHub (integración opcional)

- `HUB_API = "https://indexlyhub.daida.net/api/v1"` (Search.astro:1171).
- Token Bearer `ih_…` en localStorage, verificado contra `/favorites`; 401 → desconexión automática; 429 manejado; caché de respuestas 3 min (`hubCache`).
- Tabs: Populares (`/packages?sort=downloads`), Recientes, Favoritos (`/favorites`).
- Paquetes importados se agrupan bajo `pkg` ("carpeta") con toggle/remove masivo.

## Deploy

Push a `master` → GitHub Actions (`.github/workflows/deploy.yml`) → `npm ci` + `npm run build` → GH Pages con CNAME `indexly.daida.net`. `astro.config.mjs` ya fija `site` y `base: '/'` — no añadir ni cambiar `base`.

## Docs de Astro

- https://docs.astro.build
- Consultar antes de tareas relacionadas:
  - [Routing](https://docs.astro.build/en/guides/routing/) · [Componentes](https://docs.astro.build/en/basics/astro-components/) · [Framework components](https://docs.astro.build/en/guides/framework-components/) · [Content collections](https://docs.astro.build/en/guides/content-collections/) · [Estilos](https://docs.astro.build/en/guides/styling/) · [i18n](https://docs.astro.build/en/guides/internationalization/)
