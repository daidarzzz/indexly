// src/utils/normalizer.js — auto-normalizer for arbitrary JSON + manual mapping
import { parseGameJson } from "./parsers/gameParser.js";

// Heuristic lists
const TITLE_KEYS = ["title", "titulo", "título", "name", "nombre", "label", "subject", "headline"];
const LINK_KEYS = ["uris", "uri", "url", "link", "enlace", "magnet", "href", "downloadUrl", "download_url"];
const SIZE_KEYS = ["fileSize", "filesize", "size", "tamaño", "tamano"];

function isLinkValue(v) {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s.startsWith("http://") || s.startsWith("https://") || s.startsWith("magnet:") || s.startsWith("ftp:");
}

function findSourceName(raw, fallback) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (typeof raw.name === "string" && raw.name.trim()) return raw.name.trim();
    if (typeof raw.title === "string" && raw.title.trim()) return raw.title.trim();
    if (typeof raw.source === "string" && raw.source.trim()) return raw.source.trim();
  }
  return fallback || "Fuente Desconocida";
}

export function detectArray(raw) {
  if (Array.isArray(raw)) return { array: raw, key: null };
  if (raw && typeof raw === "object") {
    const priority = ["downloads", "items", "results", "data", "entries", "list", "games", "books", "movies", "records", "rows"];
    for (const k of priority) {
      if (Array.isArray(raw[k])) return { array: raw[k], key: k };
    }
    let best = null;
    let bestKey = null;
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
        if (!best || v.length > best.length) { best = v; bestKey = k; }
      }
    }
    if (best) return { array: best, key: bestKey };
    for (const v of Object.values(raw)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          if (Array.isArray(v2) && v2.length > 0 && typeof v2[0] === "object") {
            return { array: v2, key: k2 };
          }
        }
      }
    }
  }
  return { array: null, key: null };
}

export function getAvailableKeys(raw) {
  const { array } = detectArray(raw);
  if (array && array.length > 0) {
    const sample = array.find(x => x && typeof x === "object" && !Array.isArray(x)) || array[0];
    if (sample && typeof sample === "object" && !Array.isArray(sample)) return Object.keys(sample);
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const directKeys = Object.keys(raw);
    if (directKeys.some(k => TITLE_KEYS.includes(k.toLowerCase()))) return directKeys;
  }
  return [];
}

export function getAutoMapping(raw) {
  const { array } = detectArray(raw);
  if (!array || array.length === 0) return { titleKey: null, linkKey: null, subtitleKey: null };
  const sample = array.find(x => x && typeof x === "object" && !Array.isArray(x)) || array[0];
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return { titleKey: null, linkKey: null, subtitleKey: null };
  const { titleKey, linkKey } = detectFields(sample);
  // subtitle not auto-detected, leave null
  return { titleKey, linkKey, subtitleKey: null };
}

function detectFields(sample) {
  if (!sample || typeof sample !== "object") return { titleKey: null, linkKey: null, sizeKey: null };
  const keys = Object.keys(sample);
  const lowerMap = new Map(keys.map(k => [k.toLowerCase(), k]));
  let titleKey = null;
  for (const cand of TITLE_KEYS) {
    if (lowerMap.has(cand)) { titleKey = lowerMap.get(cand); break; }
  }
  if (!titleKey) {
    for (const k of keys) {
      const v = sample[k];
      if (typeof v === "string" && v.trim().length >= 2 && v.trim().length <= 200) {
        if (!LINK_KEYS.includes(k.toLowerCase()) && !SIZE_KEYS.includes(k.toLowerCase())) { titleKey = k; break; }
      }
    }
  }
  let linkKey = null;
  for (const cand of LINK_KEYS) {
    if (lowerMap.has(cand)) {
      const v = sample[lowerMap.get(cand)];
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string" && isLinkValue(v[0])) { linkKey = lowerMap.get(cand); break; }
      if (typeof v === "string" && isLinkValue(v)) { linkKey = lowerMap.get(cand); break; }
    }
  }
  if (!linkKey) {
    for (const k of keys) {
      const v = sample[k];
      if (typeof v === "string" && isLinkValue(v)) { linkKey = k; break; }
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string" && isLinkValue(v[0])) { linkKey = k; break; }
    }
  }
  let sizeKey = null;
  for (const cand of SIZE_KEYS) {
    if (lowerMap.has(cand)) { sizeKey = lowerMap.get(cand); break; }
  }
  return { titleKey, linkKey, sizeKey };
}

function extractMeta(item, titleKey, linkKey, sizeKey, subtitleKey) {
  const meta = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === titleKey || k === linkKey || k === sizeKey || k === subtitleKey) continue;
    if (v == null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (typeof v === "object" && !Array.isArray(v)) continue;
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") continue;
    const label = k.charAt(0).toUpperCase() + k.slice(1);
    let display = v;
    if (Array.isArray(v)) display = v.slice(0, 3).join(", ");
    else if (typeof v === "number" || typeof v === "boolean") display = String(v);
    else if (typeof v === "string") display = v.trim();
    else display = String(v);
    if (String(display).length > 80) display = String(display).slice(0, 77) + "...";
    meta[label] = display;
  }
  if (sizeKey && item[sizeKey] != null) {
    const v = String(item[sizeKey]).trim();
    if (v) meta["Tamaño"] = v;
  }
  return meta;
}

function buildNormalizedItem(item, index, sourceName, titleKey, linkKey, subtitleKey, meta) {
  let title = "Sin título";
  if (titleKey && item[titleKey] != null && String(item[titleKey]).trim()) title = String(item[titleKey]).trim();
  else {
    for (const v of Object.values(item)) {
      if (typeof v === "string" && v.trim().length >= 2) { title = v.trim(); break; }
    }
  }
  let link = "";
  if (linkKey && item[linkKey] != null) {
    const v = item[linkKey];
    if (Array.isArray(v) && v.length > 0) link = String(v[0]);
    else if (typeof v === "string") link = v;
    else link = String(v);
  }
  let fileSize = "Tamaño desconocido";
  if (meta["Tamaño"]) fileSize = meta["Tamaño"];
  else if (meta["Size"]) fileSize = meta["Size"];
  let subtitle = "";
  if (subtitleKey && item[subtitleKey] != null && String(item[subtitleKey]).trim()) {
    subtitle = String(item[subtitleKey]).trim();
  } else {
    const subtitleCandidates = ["author", "autor", "artist", "director", "creator", "subtitle", "description", "descripcion"];
    for (const cand of subtitleCandidates) {
      for (const [mk, mv] of Object.entries(meta)) {
        if (mk.toLowerCase() === cand) { subtitle = mv; break; }
      }
      if (subtitle) break;
    }
  }
  return { id: `${sourceName}-${index}`, source: sourceName, title, subtitle, fileSize, link, meta, raw: item };
}

export function normalizeJson(rawJson, fileName, mapping) {
  const fallbackName = fileName ? fileName.replace(/\.json$/i, "") : "Fuente Desconocida";
  // If manual mapping provided, use it (bypass legacy check unless downloads explicitly mapped)
  if (mapping && mapping.titleKey) {
    const sourceName = findSourceName(rawJson, fallbackName);
    const { array } = detectArray(rawJson);
    if (!array) {
      if (rawJson && typeof rawJson === "object" && !Array.isArray(rawJson)) {
        const meta = extractMeta(rawJson, mapping.titleKey, mapping.linkKey || null, null, mapping.subtitleKey || null);
        return [buildNormalizedItem(rawJson, 0, sourceName, mapping.titleKey, mapping.linkKey || null, mapping.subtitleKey || null, meta)];
      }
      return [];
    }
    if (array.length === 0) return [];
    return array.map((item, i) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { id: `${sourceName}-${i}`, source: sourceName, title: String(item), subtitle: "", fileSize: "Tamaño desconocido", link: "", meta: {}, raw: item };
      }
      const meta = extractMeta(item, mapping.titleKey, mapping.linkKey || null, null, mapping.subtitleKey || null);
      return buildNormalizedItem(item, i, sourceName, mapping.titleKey, mapping.linkKey || null, mapping.subtitleKey || null, meta);
    });
  }

  if (rawJson && typeof rawJson === "object" && !Array.isArray(rawJson) && Array.isArray(rawJson.downloads)) {
    return parseGameJson(rawJson);
  }
  const sourceName = findSourceName(rawJson, fallbackName);
  const { array } = detectArray(rawJson);
  if (!array) {
    if (rawJson && typeof rawJson === "object" && !Array.isArray(rawJson)) {
      const keys = Object.keys(rawJson);
      const hasTitleLike = keys.some(k => TITLE_KEYS.includes(k.toLowerCase()));
      if (hasTitleLike) {
        const { titleKey, linkKey, sizeKey } = detectFields(rawJson);
        const meta = extractMeta(rawJson, titleKey, linkKey, sizeKey, null);
        return [buildNormalizedItem(rawJson, 0, sourceName, titleKey, linkKey, null, meta)];
      }
    }
    return [];
  }
  if (array.length === 0) return [];
  const sample = array.find(x => x && typeof x === "object" && !Array.isArray(x)) || array[0];
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    return array.map((v, i) => ({ id: `${sourceName}-${i}`, source: sourceName, title: String(v), subtitle: "", fileSize: "Tamaño desconocido", link: "", meta: {}, raw: v }));
  }
  const { titleKey, linkKey, sizeKey } = detectFields(sample);
  return array.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { id: `${sourceName}-${i}`, source: sourceName, title: String(item), subtitle: "", fileSize: "Tamaño desconocido", link: "", meta: {}, raw: item };
    }
    const meta = extractMeta(item, titleKey, linkKey, sizeKey, null);
    return buildNormalizedItem(item, i, sourceName, titleKey, linkKey, null, meta);
  });
}

export function parseGameJsonWrapper(rawJson) {
  return normalizeJson(rawJson, null);
}
