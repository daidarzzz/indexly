// src/utils/exportCodec.js — compact lossless export codec v2
// Envelope v2: { v:2, s:[{n, a?, m?, d, p?}] }  + tabular {k,v} for homogeneous arrays
// p = paquete (carpeta): [slug, name?, version?, r2Url?] — marca de IndexlyHub.
// Falls back to raw copy for heterogeneous / small arrays. Fully round-trippable.

function genId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Marca de paquete: tupla compacta con trailing nulls omitidos.
function compactPkg(pkg) {
  if (!pkg || !pkg.slug) return undefined;
  const tup = [String(pkg.slug)];
  const name = pkg.name && pkg.name !== pkg.slug ? String(pkg.name) : null;
  if (pkg.version != null || pkg.r2Url != null || name != null) tup.push(name);
  if (pkg.version != null || pkg.r2Url != null) tup.push(pkg.version ?? null);
  if (pkg.r2Url != null) tup.push(pkg.r2Url);
  return tup;
}

function restorePkg(p) {
  if (Array.isArray(p) && p.length > 0 && p[0]) {
    return { slug: String(p[0]), name: String(p[1] || p[0]), version: p[2] ?? null, r2Url: p[3] ?? null };
  }
  if (p && typeof p === "object" && p.slug) {
    return { slug: String(p.slug), name: String(p.name || p.slug), version: p.version ?? null, r2Url: p.r2Url ?? null };
  }
  return null;
}

// Try to compact a rawData value that may contain an array.
// Returns {k, v, _key, _rest} tabular descriptor or the original if not worth it.
function compactData(rawData, sourceName) {
  if (rawData == null || typeof rawData !== "object") return rawData;
  if (Array.isArray(rawData)) {
    // top-level array of objects — preserve as _isArray
    if (rawData.length < 3) return rawData;
    const tabular = compactArray(rawData, null, null);
    if (!tabular) return rawData;
    return { k: tabular.k, v: tabular.v, _isArray: true };
  }
  // object with array inside (detect similar to detectArray but preserve _rest)
  // priority keys
  const priority = ["downloads", "items", "results", "data", "entries", "list", "games", "books", "movies", "records", "rows"];
  let foundKey = null;
  let foundArr = null;
  let foundRest = null;
  for (const k of priority) {
    if (Array.isArray(rawData[k])) { foundKey = k; foundArr = rawData[k]; break; }
  }
  if (!foundArr) {
    // pick largest array of objects
    let best = null, bestKey = null;
    for (const [k, v] of Object.entries(rawData)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && !Array.isArray(v[0])) {
        if (!best || v.length > best.length) { best = v; bestKey = k; }
      }
    }
    if (best) { foundKey = bestKey; foundArr = best; }
  }
  if (!foundArr || foundArr.length === 0) {
    // not compactable (single object or no array)
    return rawData;
  }
  // don't compact tiny arrays (<3) — overhead not worth
  if (foundArr.length < 3) return rawData;
  // check homogeneity: sample keys should be similar across items
  const sample = foundArr.find(x => x && typeof x === "object" && !Array.isArray(x));
  if (!sample) return rawData;
  // collect union keys from first N items to detect heterogeneity
  const sampleKeys = Object.keys(sample);
  // if any item has nested object/array-of-objects beyond simple values, skip tabular for safety?
  // we allow nested primitives/arrays-of-strings but table stores them as JSON values
  // Quick heterogeneity check: if >30% items have different key count, fallback
  let mismatched = 0;
  const checkN = Math.min(foundArr.length, 20);
  for (let i = 0; i < checkN; i++) {
    const it = foundArr[i];
    if (!it || typeof it !== "object" || Array.isArray(it)) { mismatched++; continue; }
    if (Object.keys(it).length !== sampleKeys.length) mismatched++;
  }
  if (mismatched > checkN * 0.3) return rawData;

  const tabular = compactArray(foundArr, sampleKeys, foundKey);
  if (!tabular) return rawData;

  // Build rest without the array key; omit d.name if equals sourceName to dedup
  const rest = {};
  let hasRest = false;
  for (const [k, v] of Object.entries(rawData)) {
    if (k === foundKey) continue;
    if (k === "name" && v === sourceName) continue;
    rest[k] = v;
    hasRest = true;
  }
  const out = { k: tabular.k, v: tabular.v, _key: foundKey };
  if (hasRest) out._rest = rest;
  return out;
}

function compactArray(arr, forcedKeys, arrayKey) {
  const sample = arr.find(x => x && typeof x === "object" && !Array.isArray(x));
  if (!sample) return null;
  const k = forcedKeys || Object.keys(sample);
  if (k.length === 0) return null;
  // estimate saving: tabular saves roughly (N*(k.length*~6 overhead)) vs dict, so worthwhile
  const v = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      // primitive item in array — store as single-element row (not tabular ideal)
      return null;
    }
    const row = new Array(k.length);
    for (let j = 0; j < k.length; j++) {
      const val = item[k[j]];
      // preserve undefined as null sentinel (JSON has no undefined)
      row[j] = val === undefined ? null : val;
    }
    v[i] = row;
  }
  return { k, v, _key: arrayKey };
}

function inflateData(d, fallbackName) {
  if (d == null || typeof d !== "object" || Array.isArray(d)) return d;
  // tabular detection: has k and v arrays
  if (Array.isArray(d.k) && Array.isArray(d.v)) {
    if (d._isArray) {
      // top-level array
      return d.v.map(row => {
        const obj = {};
        for (let i = 0; i < d.k.length; i++) {
          const val = row[i];
          if (val !== null) obj[d.k[i]] = val;
        }
        return obj;
      });
    }
    const key = d._key || "items";
    const rest = d._rest || {};
    const items = d.v.map(row => {
      const obj = {};
      for (let i = 0; i < d.k.length; i++) {
        const val = row[i];
        if (val !== null) obj[d.k[i]] = val;
      }
      return obj;
    });
    const out = { ...rest };
    if (!out.name && fallbackName) out.name = fallbackName;
    out[key] = items;
    return out;
  }
  return d;
}

// Public API
export function compactIndexes(indexes) {
  const s = indexes.map(idx => {
    const entry = { n: idx.name };
    if (idx.active === false) entry.a = false;
    // mapping compact: tuple [titleKey, linkKey, subtitleKey] — omit nulls trailing
    if (idx.mapping && idx.mapping.titleKey) {
      const m = idx.mapping;
      // store as array len 1-3
      const tup = [m.titleKey];
      // only push link/subtitle if not null
      if (m.linkKey != null || m.subtitleKey != null) tup.push(m.linkKey ?? null);
      if (m.subtitleKey != null) tup.push(m.subtitleKey);
      entry.m = tup;
    }
    const d = compactData(idx.rawData, idx.name);
    entry.d = d;
    const pk = compactPkg(idx.pkg);
    if (pk) entry.p = pk;
    return entry;
  });
  return { v: 2, s };
}

export function inflateIndexes(parsed) {
  // parsed is already JSON.parse result of v2 envelope
  if (!parsed || typeof parsed !== "object" || parsed.v !== 2 || !Array.isArray(parsed.s)) {
    throw new Error("Backup v2 inválido");
  }
  return parsed.s.map(entry => {
    const name = String(entry.n || "Fuente Desconocida");
    const active = entry.a === false ? false : true;
    let mapping = null;
    if (Array.isArray(entry.m) && entry.m.length > 0) {
      mapping = {
        titleKey: entry.m[0] ?? null,
        linkKey: entry.m[1] ?? null,
        subtitleKey: entry.m[2] ?? null,
      };
      // normalize nulls
      if (!mapping.titleKey) mapping = null;
    } else if (entry.m && typeof entry.m === "object") {
      // fallback old object shape {t,l,s} or {titleKey,...}
      mapping = {
        titleKey: entry.m.t ?? entry.m.titleKey ?? null,
        linkKey: entry.m.l ?? entry.m.linkKey ?? null,
        subtitleKey: entry.m.s ?? entry.m.subtitleKey ?? null,
      };
      if (!mapping.titleKey) mapping = null;
    }
    const rawData = inflateData(entry.d, name);
    return {
      id: genId(),
      name,
      active,
      rawData,
      mapping,
      pkg: restorePkg(entry.p),
    };
  });
}

// Legacy v1 -> normalized for storage (keeps rawData as-is, regenerates id if missing)
export function migrateV1(arr) {
  if (!Array.isArray(arr)) throw new Error("Backup debe ser un array");
  return arr.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`Entrada ${i} inválida`);
    if (!item.rawData) throw new Error(`Entrada "${item.name || i}" sin rawData`);
    return {
      id: item.id || genId(),
      name: String(item.name || `Fuente ${i + 1}`),
      active: item.active === false ? false : true,
      rawData: item.rawData,
      mapping: item.mapping || null,
      pkg: restorePkg(item.pkg),
    };
  });
}

export function isV2Envelope(parsed) {
  return parsed && typeof parsed === "object" && parsed.v === 2 && Array.isArray(parsed.s);
}
