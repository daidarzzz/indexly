// src/utils/plugins.js — motor de plugins de IndexLy (userscript-style, fase 1).
// Un plugin es un .js con cabecera de comentario que se auto-registra:
//   /* IndexLy Plugin
//      id: mi-plugin
//      name: Mi plugin
//      version: 1.0.0
//      permissions: network, ui, storage
//   */
//   IndexLy.register({ setup(ctx) { /* usa ctx.* */ } });
// Modelo de confianza: consentimiento explícito al instalar; el código NO está
// sandboxeado (accede a la página completa). Sin cabecera válida no se instala.

import { get as idbGet, set as idbSet } from "idb-keyval";

export const PLUGINS_KEY = "indexly_plugins";
export const PLUGIN_STORAGE_KEY = "indexly_plugin_storage";
export const MAX_PLUGIN_BYTES = 512 * 1024;

export async function getStoredPlugins() {
  try {
    const v = await idbGet(PLUGINS_KEY);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export async function saveStoredPlugins(list) {
  const clean = (list || []).map((p) => ({
    id: String(p.id),
    name: String(p.name || p.id),
    version: String(p.version || "1.0.0"),
    permissions: Array.isArray(p.permissions) ? p.permissions.slice(0, 10) : [],
    description: String(p.description || ""),
    code: String(p.code || ""),
    enabled: !!p.enabled,
    installedAt: p.installedAt || Date.now(),
  }));
  await idbSet(PLUGINS_KEY, clean);
}

// Cabecera: primer bloque de comentario /* IndexLy Plugin ... */ con claves key: value.
export function parsePluginHeader(code) {
  const m = String(code || "").match(/\/\*\s*IndexLy Plugin([\s\S]*?)\*\//i);
  if (!m) return { error: "Falta la cabecera /* IndexLy Plugin … */ con id y name" };
  const kv = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = line.match(/^\s*([a-zA-Z_]+)\s*:\s*(.+?)\s*$/);
    if (km) kv[km[1].toLowerCase()] = km[2];
  }
  const id = String(kv.id || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!id) return { error: "La cabecera no declara un id válido (letras, números y guiones)" };
  if (!kv.name) return { error: "La cabecera no declara name" };
  return {
    id,
    name: String(kv.name).slice(0, 60),
    version: String(kv.version || "1.0.0").slice(0, 20),
    permissions: String(kv.permissions || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 10),
    description: String(kv.description || "").slice(0, 200),
  };
}

export function pluginCodeBytes(code) {
  try { return new TextEncoder().encode(String(code || "")).length; } catch { return String(code || "").length; }
}

// Compila sin ejecutar: lanza SyntaxError si el código no es JS válido.
export function compilePlugin(code) {
  new Function("IndexLy", String(code || ""));
}

async function readStorage() {
  try { const v = await idbGet(PLUGIN_STORAGE_KEY); return (v && typeof v === "object") ? v : {}; }
  catch { return {}; }
}
async function writeStorage(all) {
  try { await idbSet(PLUGIN_STORAGE_KEY, all); } catch {}
}

/**
 * Crea el runtime de plugins. `host` aporta las funciones de la app:
 *   showToast(msg, type, duration), modal(opts, pluginId), getIndexes(), getAllGames(),
 *   getFilteredGames(), getQuery(), addSource(input, pluginId), refreshApp(),
 *   escapeHtml(str), debounce(fn, delay)
 * Devuelve { activateAll, emit, chips, cardActions, sections, footers, registeredIds }.
 * Los slots (chips/acciones/secciones/footers) quedan registrados aquí y el host los consume en cada render.
 */
export function createPluginRuntime(host) {
  const chips = [];
  const cardActions = [];
  const sections = [];
  const footers = [];
  const indexFlags = [];
  const listeners = [];
  const registeredIds = new Set();

  function apiFor(plugin) {
    const api = {
      info: { id: plugin.id, name: plugin.name, version: plugin.version || "1.0.0", permissions: (plugin.permissions || []).slice() },
      register(def) {
        if (def && typeof def.setup === "function") def.setup(api);
      },
      // ---- datos (solo lectura) ----
      getIndexes: host.getIndexes,
      getAllGames: host.getAllGames,
      getFilteredGames: host.getFilteredGames,
      getQuery: host.getQuery,
      // ---- escritura limitada: añadir fuentes ----
      addSource(input) { return host.addSource(input, plugin.id); },
      refreshApp() { host.refreshApp(); },
      // ---- eventos ----
      on(event, fn) {
        if (typeof fn !== "function") return () => {};
        const entry = { pluginId: plugin.id, event: String(event), fn };
        listeners.push(entry);
        return () => {
          const i = listeners.indexOf(entry);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      // ---- UI ----
      showToast(msg, type, duration) { host.showToast(String(msg ?? ""), type, duration); },
      modal(opts) { return host.modal(opts, plugin.id); },
      openLink(url) {
        try {
          const u = new URL(String(url), window.location.href);
          // http(s): páginas normales · magnet: descarga P2P vía handler del SO (anchor click)
          if (u.protocol === "http:" || u.protocol === "https:") window.open(u.toString(), "_blank", "noopener");
          else if (u.protocol === "magnet:" && u.toString().length > 8) {
            const a = document.createElement("a");
            a.href = u.toString();
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
        } catch {}
      },
      // ---- slots ----
      addChip(cfg) {
        if (!cfg || !cfg.id) return;
        chips.push({ pluginId: plugin.id, id: String(cfg.id), label: String(cfg.label || cfg.id), test: typeof cfg.test === "function" ? cfg.test : null });
      },
      addCardAction(cfg) {
        if (!cfg || !cfg.id) return;
        cardActions.push({
          pluginId: plugin.id,
          id: String(cfg.id),
          label: String(cfg.label || cfg.id),
          match: typeof cfg.match === "function" ? cfg.match : null,
          onClick: typeof cfg.onClick === "function" ? cfg.onClick : null,
        });
      },
      addSection(cfg) {
        if (!cfg || !cfg.id || typeof cfg.render !== "function") return;
        sections.push({ pluginId: plugin.id, id: String(cfg.id), label: String(cfg.label || cfg.id), render: cfg.render });
      },
      addFooter(html) {
        footers.push({ pluginId: plugin.id, html: String(html ?? "") });
      },
      // Marca configurable por fuente (checkbox en el modal de mapeo).
      // Cada flag se persiste en index.flags y el plugin la consulta con getIndexFlag().
      addIndexFlag(cfg) {
        if (!cfg || !cfg.id || typeof cfg.label !== "string") return;
        indexFlags.push({
          pluginId: plugin.id,
          id: String(cfg.id),
          label: String(cfg.label),
          hint: cfg.hint ? String(cfg.hint).slice(0, 120) : "",
        });
      },
      // ---- persistencia namespaced por plugin ----
      storage: {
        async get(key) {
          const all = await readStorage();
          return all[plugin.id] ? all[plugin.id][key] : undefined;
        },
        async set(key, value) {
          const all = await readStorage();
          if (!all[plugin.id]) all[plugin.id] = {};
          all[plugin.id][key] = value;
          await writeStorage(all);
        },
        async remove(key) {
          const all = await readStorage();
          if (all[plugin.id] && key in all[plugin.id]) {
            delete all[plugin.id][key];
            await writeStorage(all);
          }
        },
      },
      // ---- utilidades ----
      escapeHtml: host.escapeHtml,
      debounce: host.debounce,
    };
    return api;
  }

  // Activa los plugins habilitados. Si un plugin ya está activo, se salta (permite
  // activar solo el recién instalado sin duplicar slots).
  async function activateAll() {
    const stored = await getStoredPlugins();
    for (const p of stored) {
      if (!p.enabled) continue;
      if (registeredIds.has(p.id)) continue;
      try {
        const api = apiFor(p);
        new Function("IndexLy", String(p.code || ""))(api);
        registeredIds.add(p.id);
        p._error = null;
      } catch (err) {
        p._error = (err && err.message) || "Error al activar";
        console.error(`[IndexLy] Plugin "${p.id}" falló:`, err);
      }
    }
    return stored;
  }

  function emit(event, payload) {
    for (const l of listeners) {
      if (l.event !== event) continue;
      try { l.fn(payload); } catch (err) { console.error(`[IndexLy] Evento ${event} de "${l.pluginId}":`, err); }
    }
  }

  return { activateAll, emit, chips, cardActions, sections, footers, indexFlags, registeredIds };
}
