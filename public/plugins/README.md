# Crear plugins para IndexLy

Los plugins de IndexLy son pequeños scripts en JavaScript que amplían la app: secciones nuevas,
filtros, botones por elemento, fuentes de datos, estadísticas… Se instalan desde la propia app
(**Plugins → Añadir plugin**) y se guardan en tu navegador. Referencias vivas: los plugins de
ejemplo en esta carpeta (`streaming.js`, `gamevault.js`, `vistas.js`).

> **Modelo de confianza**: un plugin se ejecuta con los privilegios de la página (no hay sandbox).
> IndexLy pide confirmación al instalar y muestra los permisos declarados, pero instala solo
> plugins de fuentes de confianza. Para distribuir por IndexlyHub, el plugin se valida con
> checksum y manifiesto (`kind: "plugin"`).

## Formato mínimo

Un plugin es un único archivo `.js` que empieza con una cabecera de comentario y se auto-registra:

```js
/* IndexLy Plugin
   id: mi-plugin
   name: Mi plugin
   version: 1.0.0
   description: Qué hace, en una frase.
   permissions: ui, storage
*/
IndexLy.register({
  setup(ctx) {
    // toda la lógica va aquí
  }
});
```

Reglas de la cabecera:

- `id` (obligatorio): minúsculas, números y guiones. Identifica el plugin para siempre.
- `name` (obligatorio): nombre visible.
- `version`: semver (`1.0.0`). Súbela al publicar cambios.
- `permissions`: lista informativa de capacidades. Catálogo: `ui`, `storage`, `network`,
  `sources`, **`data:write`** (v2 — requerido para `ctx.sources.update/remove`).
- `description`: hasta 200 caracteres.

## Ciclo de vida

1. Al arrancar IndexLy se activan los plugins habilitados (antes del primer render).
2. `setup(ctx)` se ejecuta una vez: registra slots y configura listeners.
3. Los slots que registres los consume IndexLy en cada render — no necesitas re-pintarlos tú.
4. Desactivar/eliminar recarga la página (limpieza garantizada).

## Referencia de la API (`ctx`)

`ctx.apiVersion` — versión de la API (v2 = `2`). Detecta capacidades con:

```js
if (ctx.apiVersion >= 2) { /* métodos v2 disponibles */ }
// o el patrón defensivo clásico:
if (typeof ctx.addIndexFlag === "function") { /* host nuevo */ }
```

### Datos (solo lectura)

| Método | Devuelve |
|---|---|
| `ctx.getIndexes()` | Array de fuentes `{id, name, active, rawData, mapping, flags, pkg, games, updatedAt}` |
| `ctx.getAllGames()` | Items de las fuentes activas concatenados |
| `ctx.getFilteredGames()` | Los resultados de la búsqueda actual |
| `ctx.getQuery()` | La búsqueda activa (texto del buscador) |

Cada item (game) tiene `{title, subtitle, link, fileSize, source, meta}`.

### Escritura

| Método | Notas |
|---|---|
| `ctx.addSource({name, rawData, mapping?, flags?, active?})` | Añade una fuente (flujo completo: normaliza + guarda + refresca). Devuelve el id. |
| `ctx.sources.get(id)` **v2** | Copia de la fuente. Requiere `data:write`. |
| `ctx.sources.update(id, patch)` **v2** | `patch = {name?, active?, flags?, mapping?, rawData?}`. Re-normaliza si toca `rawData/mapping`. Requiere `data:write`. |
| `ctx.sources.remove(id)` **v2** | Siempre pide confirmación al usuario. Requiere `data:write`. |
| `ctx.normalize(rawData, name, mapping?)` **v2** | Usa el normalizador de IndexLy (mismas heurísticas que una importación). |

### Eventos — `ctx.on(evento, fn)` (devuelve función para cancelar)

| Evento | Payload | Cuándo |
|---|---|---|
| `results:render` | `{count, total, view}` | Tras cada render de resultados |
| `items:hydrate` | `{el, game}` | Por cada card ya en el DOM (añade badges, estilos…) |
| `state:change` | `{}` | Tras cualquier `updateApp` |
| `query:change` **v2** | `{query}` | Al cambiar el texto del buscador |
| `source:added` / `source:updated` / `source:removed` **v2** | `{source}` / `{id, name}` | Al añadir/editar/eliminar fuentes (cualquier origen) |
| `sources:changed` **v2** | `{}` | Catch-all: tras cada guardado de la biblioteca |

Los errores dentro de un listener no rompen IndexLy (se loguean).

### Slots de UI

| Slot | Qué añade |
|---|---|
| `ctx.addSection({id, label, render(container)})` | Una pestaña-página junto al Buscador |
| `ctx.addChip({id, label, test(game)})` | Un filtro junto a "Con enlace/Sin enlace" |
| `ctx.addCardAction({id, label, match(game)?, onClick(game)})` | Botón en cada card de resultado |
| `ctx.addSourceAction({id, label, short?, match(source)?, onClick(source)})` **v2** | Botón en cada pill de fuente (tarjeta Fuentes) |
| `ctx.addSearchFilter(fn)` **v2** | `fn(games[]) → games[]` aplicado antes del matching |
| `ctx.addFooter(html)` | Bloque bajo los resultados |
| `ctx.addIndexFlag({id, label, hint?})` | Checkbox "por fuente" en el modal de mapeo (se persiste en `index.flags`) |
| `ctx.addDocSection({id, title, html? \| render?(container)})` **v2** | Tu propia sección en la página de ayuda (`/ayuda`), dentro de «Documentación de plugins» |

### UI y utilidades

| Método | Notas |
|---|---|
| `ctx.showToast(msg, type?, duration?)` | `info`, `success`, `warning`, `error` |
| `ctx.modal({title, html, actions})` | Modal genérico; `actions: [{label, primary?, danger?, onClick(bodyEl)}]` — devuelve `false` en onClick para mantenerlo abierto |
| `ctx.openLink(url)` | Solo `http(s)` y `magnet:` |
| `ctx.storage.get/set/remove(key)` | Persistencia namespaced por plugin (IndexedDB) |
| `ctx.refreshApp()` | Re-render completo |
| `ctx.escapeHtml(str)`, `ctx.debounce(fn, ms)` | Utilidades del host |

## Reglas de oro

1. **HTML del plugin = responsabilidad del plugin.** Lo que inyectas con `innerHTML` no pasa por
   `escapeHtml`. Escapa tú todo dato interpolado (`ctx.escapeHtml`).
2. **No toques el DOM de IndexLy fuera de tus slots** si quieres que tu plugin sobreviva a cambios
   de la app. La inyección directa (CSS, elementos en `.controls`…) funciona — lo demuestra
   `vistas.js` — pero es la vía frágil.
3. **Guardas defensivos** para APIs nuevas: `if (ctx.apiVersion >= 2) { ... }` o
   `if (typeof ctx.addIndexFlag === "function")`. Así el mismo archivo funciona en hosts viejos.
4. **`data:write` es poder destructivo**: `sources.remove` siempre pide confirmación al usuario;
   ni aun así lo uses para limpiezas silenciosas.
5. **No bloques**: sin `while` síncrono largo ni render ajeno; usa `ctx.debounce` para inputs.

## Distribución

- **Fichero**: Plugins → Añadir → Fichero `.js`.
- **URL**: Plugins → Añadir → URL (o deep-link `indexly.daida.net/?plugin=<url-del-plugin>`).
- **IndexlyHub**: sube en `/upload` con «Es un plugin» activado (etiqueta `plugin` automática,
  comprimido gzip). Los usuarios lo instalan desde la pestaña **Plugins** del Hub o desde el
  botón "Instalar en IndexLy" de la página del paquete.

Límites: código ≤ 512 KB · validación de cabecera y sintaxis al instalar · activación aislada
(un plugin que falla no rompe la app ni a los demás).

## Plantilla starter

```js
/* IndexLy Plugin
   id: mi-plugin
   name: Mi plugin
   version: 1.0.0
   description: Describe aquí tu plugin.
   permissions: ui, storage
*/
IndexLy.register({
  setup(ctx) {
    // Un chip de filtro + un botón por card: lo mínimo viable
    ctx.addChip({ id: "sin-titulo", label: "Sin título", test: g => !g.title });
    ctx.addCardAction({
      id: "saludar",
      label: "Hola",
      onClick: (game) => ctx.showToast("Hola, " + game.title, "info"),
    });
  }
});
```

Recetas completas: mira `streaming.js` (secciones + player), `gamevault.js` (vault con
persistencia y red), `vistas.js` (UI declarativa con CSS sobre el render nativo).

### Receta: documenta tu plugin

Tu plugin puede tener su propia sección en la página de ayuda (`/ayuda`), dentro de
«Documentación de plugins». Llámalo desde `setup`, siempre sin condiciones (en la página
principal es un no-op):

```js
IndexLy.register({
  setup(ctx) {
    ctx.addDocSection?.({
      id: "mi-plugin-doc",
      title: "Mi plugin — para qué sirve",
      html: "<p>Explica aquí <strong>cómo se usa</strong>: qué añade, dónde aparece, " +
            "si necesita configuración y qué servicios externos consulta.</p>",
      // alternativa para contenido vivo:
      // render: (container) => { container.append(...) }
    });
  }
});
```

El HTML es responsabilidad del plugin (escapa tú cualquier dato dinámico con
`ctx.escapeHtml`). Mantén la guía centrada en el usuario final: qué puede hacer y dónde,
no cómo está implementado. `gamevault.js` tiene un ejemplo completo.
