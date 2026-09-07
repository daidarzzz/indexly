/* IndexLy Plugin
   id: gamevault
   name: GameVault
   version: 1.3.2
   description: Tu colección de juegos: busca en GameDB (datos de IGDB publicados por LizardByte, sin claves ni configuración), guarda juegos con carátulas y ficha completa, y asígnales fuentes de descarga desde tus propios índices. Incluye auto-match, estadísticas y añadido manual.
   permissions: network, ui, storage
*/
(function () {
  var api = null;
  var pageRoot = null;
  var gamesCache = null;
  var linkSet = {}; // "link" -> true, reconstruido al guardar

  var state = {
    view: "library",      // library | search | detail | picker | settings | amatch
    gameId: null,
    pickIndexId: null,
    pickQuery: "",
    picks: {},            // key -> source (selección temporal del picker)
    libQuery: "",
    statusFilter: "all",
    sortBy: "recent",
    searchQuery: "",
  };

  // Auto-match: estado de la pasada actual (candidatos, progreso, selección)
  // vive en state.am { indexId, items[], running, done, progress, total }
  // items[]: { key, title, clean, link, indexId, indexName, status, result, keep, error }

  var GDB_BASE = "https://app.lizardbyte.dev/GameDB/";
  var STATUSES = [
    { id: "backlog", label: "Backlog", color: "#94a3b8" },
    { id: "playing", label: "Jugando", color: "#0ea5e9" },
    { id: "done", label: "Terminado", color: "#22c55e" },
    { id: "dropped", label: "Abandonado", color: "#f87171" },
  ];

  // ---------- utilidades ----------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function hueFor(s) {
    var h = 0;
    var str = String(s || "x");
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function gradientFor(name) {
    var h = hueFor(name);
    return "linear-gradient(120deg, hsl(" + h + " 60% 30%) 0%, hsl(" + ((h + 45) % 360) + " 65% 20%) 100%)";
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(iso);
    return m[3] + "/" + m[2] + "/" + m[1].slice(2);
  }

  function normStr(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function statusOf(id) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === id) return STATUSES[i];
    return STATUSES[0];
  }

  function rebuildLinkSet() {
    linkSet = {};
    (gamesCache || []).forEach(function (g) {
      (g.sources || []).forEach(function (s) { if (s.itemLink) linkSet[s.itemLink] = true; });
    });
  }

  function ensureGames(cb) {
    if (gamesCache) { cb(); return; }
    api.storage.get("gv_games").then(function (g) {
      gamesCache = Array.isArray(g) ? g : [];
      rebuildLinkSet();
      cb();
    }).catch(function () { gamesCache = []; cb(); });
  }

  function saveGames() {
    rebuildLinkSet();
    return api.storage.set("gv_games", gamesCache || []);
  }

  function findGame(id) {
    return (gamesCache || []).find(function (g) { return g.id === id; }) || null;
  }

  function currentGame() { return state.gameId ? findGame(state.gameId) : null; }

  function rerender() { if (pageRoot) renderPage(pageRoot); }

  // ---------- auto-match ----------
  // Detecta los títulos de un índice, los busca en GameDB (IGDB), tope 60,
  // 3 en paralelo) y muestra cada coincidencia para confirmar antes de añadir.
  // Los juegos añadidos quedan enlazados al item como primera fuente; si el juego
  // ya estaba en la vault, se le puede fusionar la fuente.

  function cleanTitle(raw) {
    var t = String(raw || "").trim();
    var year = null;
    var ym = t.match(/\b(19\d{2}|20\d{2})\b/);
    if (ym) year = ym[1];
    t = t
      .replace(/\((?:19|20)\d{2}\)/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\bv\.?\s?\d+(?:\.\d+)*\b/gi, " ")
      .replace(/\b(?:repack|fitgirl|dodi|elamigos|gog|steam|online|offline|multi\d*|crack(?:ed)?|codex|plaza|goldberg|update\s?\d+|dlc)\b/gi, " ")
      .replace(/[-–—_/|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (t.length > 70) t = t.slice(0, 70).trim();
    return { name: t, year: year };
  }

  function gameInVaultByGdb(id) {
    return (gamesCache || []).find(function (g) { return g.gdbId != null && String(g.gdbId) === String(id); }) || null;
  }

  function amatchBuildItems(index) {
    var inVaultNames = {};
    (gamesCache || []).forEach(function (g) { inVaultNames[normStr(g.name)] = true; });
    var seen = {};
    var items = [];
    (index.games || []).forEach(function (game) {
      var clean = cleanTitle(game.title);
      if (!clean.name || clean.name.length < 2) return;
      var key = normStr(clean.name);
      if (seen[key]) return;
      // Ya en la vault por nombre y sin enlace nuevo que aportar → fuera
      if (inVaultNames[key] && (!game.link || linkSet[game.link])) return;
      seen[key] = true;
      items.push({
        key: key, title: game.title, clean: clean, link: game.link || "",
        indexId: index.id, indexName: index.name,
        status: "pending", result: null, keep: true, error: "",
      });
    });
    return items.slice(0, 60);
  }

  function amatchRun() {
    var am = state.am;
    if (!am || am.running) return;
    am.running = true;
    am.done = false;
    var queue = am.items.filter(function (it) { return it.status === "pending"; });
    am.total = queue.length;
    am.progress = 0;
    var CONC = 3;
    function worker() {
      if (!am.running) return;
      var it = queue.shift();
      if (!it) {
        if (!queue.length && am.progress >= am.total) { am.running = false; am.done = true; rerender(); }
        return;
      }
      it.status = "searching";
      amatchUpdateRow(it);
      // Resultado = {id, name} del bucket. La ficha completa se baja al confirmar.
      gdbSearch(it.clean.name).then(function (hits) {
        var hit = hits.length ? hits[0] : null;
        if (hit) {
          it.result = hit; it.status = "found"; it.keep = true;
        } else {
          it.status = "nomatch"; it.keep = false;
        }
      }).catch(function (err) {
        it.status = "error"; it.keep = false; it.error = err.name === "AbortError" ? "timeout" : err.message;
      }).then(function () {
        am.progress++;
        amatchUpdateRow(it);
        amatchUpdateProgress();
        worker();
      });
    }
    var i;
    for (i = 0; i < Math.min(CONC, queue.length); i++) worker();
  }

  function amatchConfirm() {
    var am = state.am;
    var kept = am.items.filter(function (it) { return it.keep && it.result && it.status === "found"; });
    if (!kept.length) { api.showToast("Nada seleccionado", "info"); return; }
    var btn = document.getElementById("gv-am-confirm");
    var added = 0, merged = 0, done = 0;
    function step() {
      var it = kept[done];
      if (!it) {
        saveGames();
        var msg = (added === 1 ? "1 juego añadido" : added + " juegos añadidos") + (merged ? " · " + merged + " fuentes fusionadas" : "");
        api.showToast(msg, "success", 4000);
        go("library");
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = "Añadiendo " + (done + 1) + " / " + kept.length + "…"; }
      gdbGame(it.result.id).then(function (j) {
        var detail = j || { id: it.result.id, name: it.result.name, url: "" };
        var existing = gameInVaultByGdb(detail.id);
        if (existing) {
          if (it.link && !(existing.sources || []).some(function (s) { return s.itemLink === it.link; })) {
            existing.sources = existing.sources || [];
            existing.sources.push({ indexId: it.indexId, sourceName: it.indexName, itemTitle: it.title, itemLink: it.link });
            merged++;
          }
        } else {
          var src = it.link ? [{ indexId: it.indexId, sourceName: it.indexName, itemTitle: it.title, itemLink: it.link }] : [];
          addGdbGame(detail, src);
          added++;
        }
      }).catch(function () { }).then(function () {
        done++;
        step();
      });
    }
    step();
  }

  // ---------- GameDB (datos IGDB vía LizardByte) — sin configuración ----------

  function gdbJson(path) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 15000);
    return fetch(GDB_BASE + path, { signal: ctrl.signal })
      .then(function (res) {
        clearTimeout(timer);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("GameDB respondió " + res.status);
        return res.json();
      })
      .catch(function (err) { clearTimeout(timer); throw err; });
  }

  // Imágenes IGDB: la ficha trae t_thumb; pedimos tamaños mayores reescribiendo el prefijo
  function igdbImg(url, size) {
    if (!url) return "";
    var u = String(url);
    if (u.indexOf("//") === 0) u = "https:" + u;
    return u.replace("/t_thumb/", "/t_" + (size || "thumb") + "/");
  }

  var gdbBucketCache = {};   // key -> Promise<{id:{name}}>
  var gdbPlatformsPromise = null; // Promise<{id: name}>

  function gdbBucket(key) {
    if (!gdbBucketCache[key]) gdbBucketCache[key] = gdbJson("buckets/" + encodeURIComponent(key) + ".json");
    return gdbBucketCache[key];
  }

  function gdbPlatforms() {
    if (!gdbPlatformsPromise) {
      gdbPlatformsPromise = gdbJson("platforms/all.json").then(function (j) {
        var map = {};
        Object.keys(j || {}).forEach(function (id) { map[id] = (j[id] && j[id].name) || id; });
        return map;
      });
    }
    return gdbPlatformsPromise;
  }

  // Búsqueda: bucket por las 2 primeras letras alfanuméricas del término
  // (con fallback al bucket de 1 letra si el segundo carácter original es un espacio)
  function gdbSearch(q) {
    var nq = normStr(q).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (!nq) return Promise.resolve([]);
    var sq = nq.replace(/[^a-z0-9]/g, "");
    var keys = [];
    if (sq) keys.push(sq.slice(0, 2));
    if (/^[a-z0-9] /.test(nq) && nq.charAt(0) !== sq.slice(0, 1)) keys.push(nq.charAt(0));
    return Promise.all(keys.map(gdbBucket)).then(function (buckets) {
      var pool = {};
      buckets.forEach(function (b) { if (b) Object.keys(b).forEach(function (id) { if (!pool[id]) pool[id] = b[id]; }); });
      var res = [];
      var words = nq.split(" ").filter(Boolean);
      Object.keys(pool).forEach(function (id) {
        var name = (pool[id] && pool[id].name) || "";
        var nn = normStr(name);
        var rank = -1;
        if (nn === nq) rank = 0;
        else if (nn.indexOf(nq) === 0) rank = 1;
        else if (nn.indexOf(nq) >= 0) rank = 2;
        else if (words.length > 1 && words.every(function (w) { return nn.indexOf(w) >= 0; })) rank = 3;
        if (rank >= 0) res.push({ id: id, name: name, rank: rank });
      });
      res.sort(function (a, b) {
        return a.rank - b.rank || (Number(a.id) || 0) - (Number(b.id) || 0) || a.name.localeCompare(b.name);
      });
      return res.slice(0, 20);
    });
  }

  function gdbGame(id) {
    return gdbJson("games/" + encodeURIComponent(id) + ".json");
  }

  // Mapa ficha GameDB → registro de vault
  function mapGameDB(j) {
    var minDate = null;
    (Array.isArray(j.release_dates) ? j.release_dates : []).forEach(function (rd) {
      if (rd && rd.date && (minDate === null || rd.date < minDate)) minDate = rd.date;
    });
    var released = minDate ? new Date(minDate * 1000).toISOString().slice(0, 10) : "";
    var developer = "";
    (Array.isArray(j.involved_companies) ? j.involved_companies : []).some(function (c) {
      if (c && c.developer && c.company && c.company.name) { developer = c.company.name; return true; }
      return false;
    });
    var pegi = null;
    (Array.isArray(j.age_ratings) ? j.age_ratings : []).forEach(function (ar) {
      if (ar && ar.organization && /pegi/i.test(ar.organization.name || "") && ar.rating_category) pegi = String(ar.rating_category.rating || "");
    });
    var cover = j.cover && j.cover.url ? igdbImg(j.cover.url, "cover_big") : "";
    var banner = "";
    if (Array.isArray(j.artworks) && j.artworks[0] && j.artworks[0].url) banner = igdbImg(j.artworks[0].url, "720p");
    else if (Array.isArray(j.screenshots) && j.screenshots[0] && j.screenshots[0].url) banner = igdbImg(j.screenshots[0].url, "720p");
    else if (cover) banner = cover;
    return {
      gdbId: j.id != null ? String(j.id) : null,
      gdbUrl: j.url || (j.slug ? "https://www.igdb.com/games/" + j.slug : ""),
      name: String(j.name || "Sin título").slice(0, 120),
      imageUrl: banner,
      coverUrl: cover,
      rating: typeof j.rating === "number" ? Math.round((j.rating / 20) * 10) / 10 : null,
      metacritic: typeof j.aggregated_rating === "number" ? Math.round(j.aggregated_rating) : null,
      released: released,
      genres: (Array.isArray(j.genres) ? j.genres : []).map(function (g) { return g && g.name; }).filter(Boolean).slice(0, 5),
      platforms: (Array.isArray(j.platforms) ? j.platforms : []).map(String).slice(0, 8), // IDs → resolver al pintar
      developer: developer,
      pegi: pegi,
      website: "",
      description: String(j.summary || j.storyline || "").slice(0, 4000),
      screenshots: (Array.isArray(j.screenshots) ? j.screenshots : []).slice(0, 4).map(function (s) { return s && s.url ? igdbImg(s.url, "screenshot_med") : null; }).filter(Boolean),
    };
  }

  function addGdbGame(j, extraSources) {
    var dup = (gamesCache || []).find(function (g) { return g.gdbId != null && String(g.gdbId) === String(j.id); });
    if (dup) return dup;
    var d = mapGameDB(j);
    var rec = {
      id: "g" + Date.now() + Math.random().toString(36).slice(2, 6),
      name: d.name, imageUrl: d.imageUrl, coverUrl: d.coverUrl, rating: d.rating, metacritic: d.metacritic,
      released: d.released, genres: d.genres, platforms: d.platforms, developer: d.developer, pegi: d.pegi,
      website: d.website, description: d.description, screenshots: d.screenshots, gdbId: d.gdbId, gdbUrl: d.gdbUrl,
      status: "backlog", addedAt: Date.now(), sources: (extraSources || []).slice(),
    };
    gamesCache.push(rec);
    saveGames();
    return rec;
  }

  // Añade desde el card action "＋ Vault" (búsqueda principal de IndexLy)
  function quickAdd(game) {
    var name = String(game && game.title || "").trim();
    if (!name) return;
    var dup = (gamesCache || []).find(function (g) { return g.name.toLowerCase() === name.toLowerCase(); });
    if (dup) { api.showToast("Ya está en tu vault: " + dup.name, "warning"); return; }
    var idx = api.getIndexes().find(function (i) { return i.name === game.source; });
    var rec = {
      id: "m" + Date.now() + Math.random().toString(36).slice(2, 6),
      name: name.slice(0, 120), imageUrl: "", coverUrl: "", rating: null, metacritic: null,
      released: "", genres: [], platforms: [], developer: "", pegi: null, website: "", description: "", screenshots: [],
      gdbId: null, gdbUrl: "", status: "backlog", addedAt: Date.now(),
      sources: game.link ? [{ indexId: idx ? idx.id : null, sourceName: game.source || "", itemTitle: name, itemLink: game.link }] : [],
    };
    gamesCache.push(rec);
    saveGames();
    api.showToast("Añadido a GameVault", "success");
    if (state.view === "library") rerender();
    // Enriquecimiento async con GameDB: banner, ficha completa
    gdbSearch(name).then(function (hits) {
      if (!hits.length) return;
      return gdbGame(hits[0].id).then(function (j) {
        if (!j) return;
        var cur = findGame(rec.id);
        if (!cur) return;
        var mapped = mapGameDB(j);
        cur.gdbId = mapped.gdbId; cur.gdbUrl = mapped.gdbUrl; cur.imageUrl = mapped.imageUrl || cur.imageUrl;
        cur.coverUrl = mapped.coverUrl || cur.coverUrl;
        cur.rating = mapped.rating; cur.metacritic = mapped.metacritic; cur.released = mapped.released;
        cur.genres = mapped.genres; cur.platforms = mapped.platforms; cur.developer = mapped.developer;
        cur.pegi = mapped.pegi;
        cur.description = mapped.description; cur.screenshots = mapped.screenshots;
        saveGames();
        rerender();
      });
    }).catch(function () { /* sin key o fallo de red: queda manual */ });
  }

  // Añadido manual: título obligatorio, imagen y descripción opcionales
  function addManualGame(name, imageUrl, description) {
    var rec = {
      id: "m" + Date.now() + Math.random().toString(36).slice(2, 6),
      name: String(name).slice(0, 120),
      imageUrl: String(imageUrl || "").trim(),
      rating: null, metacritic: null, released: "", genres: [], platforms: [],
      website: "", description: String(description || "").trim().slice(0, 4000),
      screenshots: [], gdbId: null, gdbUrl: "",
      status: "backlog", addedAt: Date.now(), sources: [],
    };
    gamesCache.push(rec);
    saveGames();
    api.showToast("«" + rec.name + "» añadido a la vault", "success");
    if (state.view === "library") rerender();
    return rec;
  }

  function openManualAdd() {
    api.modal({
      title: "Añadir juego a mano",
      html: '<div style="display:flex;flex-direction:column;gap:10px">' +
        '<label class="gv-field">Título *<input id="gv-m-name" class="gv-input box" style="width:100%" placeholder="Ej: Hollow Knight" maxlength="120" /></label>' +
        '<label class="gv-field">URL de imagen (opcional)<input id="gv-m-img" class="gv-input box" style="width:100%" placeholder="https://…/cover.jpg" /></label>' +
        '<label class="gv-field">Descripción (opcional)<textarea id="gv-m-desc" class="gv-input box" style="width:100%;resize:vertical;min-height:70px" placeholder="Notas, género, por qué lo quieres…"></textarea></label>' +
        "</div>",
      actions: [
        { label: "Cancelar" },
        { label: "Añadir", primary: true, onClick: function (bodyEl) {
          var nameEl = bodyEl.querySelector("#gv-m-name");
          var imgEl = bodyEl.querySelector("#gv-m-img");
          var descEl = bodyEl.querySelector("#gv-m-desc");
          var name = nameEl ? nameEl.value.trim() : "";
          if (!name) { api.showToast("El título es obligatorio", "warning"); return false; }
          addManualGame(name, imgEl ? imgEl.value.trim() : "", descEl ? descEl.value : "");
        } },
      ],
    });
  }

  // ---------- estilos ----------

  function ensureStyles() {
    if (document.getElementById("gv-styles")) return;
    var s = document.createElement("style");
    s.id = "gv-styles";
    s.textContent = [
      ".gv-badge-vault{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;color:#4ade80;background:rgba(34,197,94,0.10);border:1px solid rgba(34,197,94,0.25);border-radius:999px;padding:2px 8px;margin-top:6px;width:max-content}",
      ".gv-page{display:flex;flex-direction:column;gap:14px}",
      ".gv-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".gv-head h4{margin:0;font-size:16px;font-weight:700;color:#f1f5f9;letter-spacing:-0.01em}",
      ".gv-head small{font-size:11px;color:#64748b}",
      ".gv-spacer{flex:1}",
      ".gv-btn{background:transparent;border:1px solid #1e293b;border-radius:999px;color:#94a3b8;padding:7px 12px;font-size:11.5px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap}",
      ".gv-btn:hover{background:#152033;color:#e2e8f0;border-color:#24344f}",
      ".gv-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".gv-btn-primary{background:#fff;border-color:#fff;color:#0f172a}",
      ".gv-btn-primary:hover{background:#f1f5f9;color:#0f172a}",
      ".gv-btn-danger{color:#f87171;border-color:rgba(248,113,113,0.3)}",
      ".gv-btn-danger:hover{background:rgba(248,113,113,0.08);color:#fca5a5;border-color:rgba(248,113,113,0.4)}",
      ".gv-chip{background:transparent;border:1px solid #1e293b;border-radius:999px;color:#94a3b8;padding:5px 11px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s}",
      ".gv-chip:hover{color:#e2e8f0;background:rgba(255,255,255,0.04)}",
      ".gv-chip.active{background:#fff;border-color:#fff;color:#0f172a;font-weight:600}",
      ".gv-input{background:#070a12;border:1px solid #1e293b;border-radius:999px;padding:9px 14px;color:#e2e8f0;font-size:12.5px;outline:none;min-width:0}",
      ".gv-input:focus{border-color:#24344f;box-shadow:0 0 0 3px rgba(14,165,233,0.08)}",
      ".gv-input.box{border-radius:10px}",
      ".gv-select{background:#070a12;border:1px solid #1e293b;border-radius:999px;color:#94a3b8;font-size:11.5px;padding:8px 26px 8px 12px;cursor:pointer;appearance:none}",
      ".gv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;overflow:auto}",
      ".gv-card{background:#070a12;border:1px solid #1e293b;border-radius:12px;overflow:hidden;cursor:pointer;transition:border-color .18s,transform .18s,box-shadow .18s;display:flex;flex-direction:column}",
      ".gv-card:hover{border-color:rgba(14,165,233,0.45);transform:translateY(-3px) scale(1.015);box-shadow:0 10px 26px rgba(0,0,0,0.4)}",
      ".gv-poster-wrap{position:relative;overflow:hidden;background:#0d1528}",
      ".gv-poster{width:100%;aspect-ratio:184/258;object-fit:cover;display:block;transition:transform .25s ease}",
      ".gv-card:hover .gv-poster{transform:scale(1.05)}",
      ".gv-poster-ph{width:100%;aspect-ratio:184/258;display:grid;place-items:center;font-size:34px;font-weight:700;color:rgba(255,255,255,0.55);text-shadow:0 2px 8px rgba(0,0,0,0.4)}",
      ".gv-badge-overlay{position:absolute;top:8px;left:8px;z-index:1;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}",
      ".gv-card-body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:3px}",
      ".gv-card-name{font-size:12px;font-weight:600;color:#e2e8f0;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".gv-card-meta{font-size:10.5px;color:#64748b;display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
      ".gv-badge{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;padding:2px 8px;border-radius:999px;border:1px solid;width:max-content}",
      ".gv-banner{width:100%;height:210px;object-fit:cover;border-radius:12px;background:#0d1528;display:block;flex-shrink:0}",
      ".gv-meta-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
      ".gv-tag{font-size:10px;font-weight:500;padding:3px 9px;border:1px solid #1e293b;border-radius:999px;color:#94a3b8;background:#0f141e}",
      ".gv-desc{font-size:12.5px;color:#cbd5e1;line-height:1.65;white-space:pre-wrap;max-height:230px;overflow:auto;background:#070a12;border:1px solid #1e293b;border-radius:10px;padding:12px 14px}",
      ".gv-caption{margin:0;font-size:11.5px;color:#94a3b8}",
      ".gv-cover{width:120px;border-radius:10px;display:block;background:#0d1528;box-shadow:0 6px 18px rgba(0,0,0,0.35);flex-shrink:0}",
      ".gv-shots{display:flex;gap:8px;overflow-x:auto}",
      ".gv-shots img{height:74px;border-radius:8px;cursor:pointer;background:#0d1528;flex-shrink:0}",
      ".gv-section{display:flex;flex-direction:column;gap:10px}",
      ".gv-section-title{display:flex;align-items:center;gap:10px}",
      ".gv-section-title h5{margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8}",
      ".gv-src-row{display:flex;align-items:center;gap:10px;border:1px solid #1e293b;background:#070a12;border-radius:10px;padding:10px 12px}",
      ".gv-src-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}",
      ".gv-src-info strong{font-size:12px;color:#e2e8f0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".gv-src-info small{font-size:10.5px;color:#64748b}",
      ".gv-results{display:flex;flex-direction:column;gap:8px;overflow:auto;max-height:520px}",
      ".gv-res-row{display:flex;gap:10px;align-items:center;border:1px solid #1e293b;border-radius:10px;padding:8px;background:#070a12;transition:border-color .15s}",
      ".gv-res-row:hover{border-color:#24344f}",
      ".gv-res-img{width:92px;height:52px;object-fit:cover;border-radius:6px;background:#0d1528;flex-shrink:0}",
      ".gv-res-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".gv-res-info strong{font-size:12.5px;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".gv-res-info small{font-size:10.5px;color:#64748b}",
      ".gv-empty{margin:auto;text-align:center;color:#64748b;font-size:12.5px;line-height:1.7;padding:26px 10px;max-width:46ch}",
      ".gv-banner-note{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.25);border-radius:12px;padding:12px 14px;font-size:12px;color:#7dd3fc}",
      ".gv-field{display:flex;flex-direction:column;gap:6px;font-size:11px;color:#94a3b8}",
      ".gv-help{font-size:11px;color:#64748b;line-height:1.6;background:#070a12;border:1px solid #1e293b;border-radius:10px;padding:12px 14px}",
      ".gv-help code{font-family:var(--font-mono,monospace);color:#7dd3fc;font-size:10.5px}",
      ".gv-help a{color:#7dd3fc}",
      "@media (max-width:640px){.gv-grid{grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:10px}.gv-banner{height:150px}}",
    ].join("\n");
    document.head.appendChild(s);
  }

  function coverEl(game, cls) {
    if (game.imageUrl) {
      var img = document.createElement("img");
      img.className = cls;
      img.src = game.imageUrl;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", function () {
        var ph = el("div", "gv-card-ph", (game.name || "?").charAt(0).toUpperCase());
        ph.style.background = gradientFor(game.name);
        img.replaceWith(ph);
      });
      return img;
    }
    var ph = el("div", "gv-card-ph", (game.name || "?").charAt(0).toUpperCase());
    ph.style.background = gradientFor(game.name);
    return ph;
  }

  // Carátula vertical (estantería): prefiere coverUrl de IGDB, cae a imageUrl y a placeholder
  function posterPh(game) {
    var ph = el("div", "gv-poster-ph", (game.name || "?").charAt(0).toUpperCase());
    ph.style.background = gradientFor(game.name);
    return ph;
  }
  function posterEl(game) {
    var url = game.coverUrl || game.imageUrl;
    if (url) {
      var img = document.createElement("img");
      img.className = "gv-poster";
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", function () { img.replaceWith(posterPh(game)); });
      return img;
    }
    return posterPh(game);
  }

  function statusBadge(statusId, extraCls) {
    var st = statusOf(statusId);
    var b = el("span", "gv-badge" + (extraCls ? " " + extraCls : ""), st.label);
    b.style.color = st.color;
    b.style.borderColor = st.color + "44";
    b.style.background = st.color + "14";
    return b;
  }

  // ---------- vistas ----------

  // Token de render: las vistas que pueblan el DOM tras Promises asíncronas
  // el DOM cuando la Promise resuelve. Si mientras tanto se re-renderizó (cambio de
  // vista, updateApp del host…), su callback estaría pintando sobre DOM viejo o
  // pisando otra vista → las vistas salían vacías. Cada render invalida al anterior.
  var renderToken = 0;

  function renderPage(root) {
    ensureStyles();
    pageRoot = root;
    root.innerHTML = "";
    var token = ++renderToken;
    var done = false;
    ensureGames(function () {
      if (token !== renderToken || done) return; // render obsoleto
      done = true;
      var page = el("div", "gv-page");
      root.appendChild(page);
      try {
        if (state.view === "search") renderSearch(page);
        else if (state.view === "detail") renderDetail(page);
        else if (state.view === "picker") renderPicker(page);
        else if (state.view === "amatch") renderAMatch(page);
        else if (state.view === "settings") renderSettings(page);
        else renderLibrary(page);
      } catch (err) {
        console.error("[GameVault] render", err);
        page.innerHTML = "";
        var box = el("div", "gv-empty");
        box.textContent = "Error al pintar la vista: " + (err && err.message ? err.message : err);
        page.appendChild(box);
      }
    });
  }

  function go(view) { state.view = view; rerender(); }

  function headerBar(page, title, count, actions) {
    var head = el("div", "gv-head");
    var h = el("h4", "", title);
    head.appendChild(h);
    if (count != null) head.appendChild(el("small", "", count));
    head.appendChild(el("span", "gv-spacer"));
    (actions || []).forEach(function (a) {
      var b = el("button", "gv-btn" + (a.primary ? " gv-btn-primary" : "") + (a.danger ? " gv-btn-danger" : ""), a.label);
      b.type = "button";
      if (a.title) b.title = a.title;
      if (!a.disabled) b.addEventListener("click", a.onClick);
      else b.disabled = true;
      head.appendChild(b);
    });
    page.appendChild(head);
  }

  function renderLibrary(page) {
    var games = gamesCache || [];
    var filtered = games.filter(function (g) {
      if (state.statusFilter !== "all" && g.status !== state.statusFilter) return false;
      if (state.libQuery && normStr(g.name).indexOf(normStr(state.libQuery)) < 0) return false;
      return true;
    });
    filtered.sort(function (a, b) {
      if (state.sortBy === "name") return a.name.localeCompare(b.name);
      if (state.sortBy === "rating") return (b.rating || 0) - (a.rating || 0);
      return (b.addedAt || 0) - (a.addedAt || 0);
    });

    headerBar(page, "GameVault", games.length === 1 ? "1 juego" : games.length + " juegos", [
      { label: "⚙ Ajustes", onClick: function () { go("settings"); } },
      { label: "⚡ Auto-match", onClick: function () {
        var idxs = api.getIndexes();
        if (!idxs.length) { api.showToast("Importa fuentes en IndexLy primero", "warning"); return; }
        state.am = { indexId: null, items: [], running: false, done: false, progress: 0, total: 0 };
        go("amatch");
      } },
      { label: "＋ Añadir manual", onClick: function () { openManualAdd(); } },
      { label: "＋ Buscar juegos", primary: true, onClick: function () { state.searchQuery = ""; go("search"); } },
    ]);

    var tools = el("div", "gv-head");
    var input = el("input", "gv-input");
    input.type = "text";
    input.placeholder = "Buscar en tu vault…";
    input.value = state.libQuery;
    input.style.flex = "1 1 160px";
    input.addEventListener("input", function () {
      state.libQuery = input.value;
      fillList();
    });
    tools.appendChild(input);
    var sel = document.createElement("select");
    sel.className = "gv-select";
    [["recent", "Recientes"], ["name", "A-Z"], ["rating", "Rating"]].forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0]; op.textContent = o[1];
      if (state.sortBy === o[0]) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener("change", function () { state.sortBy = sel.value; fillList(); });
    tools.appendChild(sel);
    page.appendChild(tools);

    var chips = el("div", "gv-head");
    var mk = function (id, label, count) {
      var c = el("button", "gv-chip" + (state.statusFilter === id ? " active" : ""), label + (count != null ? " · " + count : ""));
      c.type = "button";
      c.addEventListener("click", function () { state.statusFilter = id; rerender(); });
      return c;
    };
    chips.appendChild(mk("all", "Todos", games.length));
    STATUSES.forEach(function (st) {
      var n = games.filter(function (g) { return g.status === st.id; }).length;
      chips.appendChild(mk(st.id, st.label, n));
    });
    page.appendChild(chips);

    var listWrap = el("div", "gv-grid");
    page.appendChild(listWrap);

    function fillList() {
      listWrap.innerHTML = "";
      var list = games.filter(function (g) {
        if (state.statusFilter !== "all" && g.status !== state.statusFilter) return false;
        if (state.libQuery && normStr(g.name).indexOf(normStr(state.libQuery)) < 0) return false;
        return true;
      });
      list.sort(function (a, b) {
        if (state.sortBy === "name") return a.name.localeCompare(b.name);
        if (state.sortBy === "rating") return (b.rating || 0) - (a.rating || 0);
        return (b.addedAt || 0) - (a.addedAt || 0);
      });
      if (!list.length) {
        var empty = el("div", "gv-empty");
        empty.style.gridColumn = "1/-1";
        empty.innerHTML = games.length
          ? "Nada coincide con el filtro."
          : "Tu vault está vacía.<br>Busca juegos o añádelos a mano.";
        listWrap.appendChild(empty);
        return;
      }
      list.forEach(function (g) {
        var card = el("div", "gv-card");
        var posterWrap = el("div", "gv-poster-wrap");
        posterWrap.appendChild(posterEl(g));
        var badge = statusBadge(g.status);
        badge.classList.add("gv-badge-overlay");
        badge.style.background = "rgba(7,10,18,0.62)";
        posterWrap.appendChild(badge);
        card.appendChild(posterWrap);
        var body = el("div", "gv-card-body");
        body.appendChild(el("div", "gv-card-name", g.name));
        var meta = el("div", "gv-card-meta");
        var bits = [];
        if (g.released) bits.push(fmtDate(g.released).slice(3));
        if (g.rating != null) bits.push("★ " + g.rating);
        if (g.sources && g.sources.length) bits.push(g.sources.length === 1 ? "1 fuente" : g.sources.length + " fuentes");
        if (bits.length) meta.appendChild(el("span", "", bits.join(" · ")));
        if (meta.children.length) body.appendChild(meta);
        card.appendChild(body);
        card.addEventListener("click", function () {
          state.gameId = g.id;
          go("detail");
        });
        listWrap.appendChild(card);
      });
    }
    fillList();
  }

  function renderSearch(page) {
    headerBar(page, "Buscar juegos", null, [
      { label: "← Volver", onClick: function () { go("library"); } },
    ]);

    var resultsEl = el("div", "gv-results");
    var seq = 0; // invalida búsquedas obsoletas si el usuario repite rápido

    var tools = el("div", "gv-head");
    var input = el("input", "gv-input");
    input.type = "text";
    input.placeholder = "Ej: elden ring, zelda, hollow knight…";
    input.value = state.searchQuery;
    input.style.flex = "1 1 220px";
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
    tools.appendChild(input);
    var goBtn = el("button", "gv-btn gv-btn-primary", "Buscar");
    goBtn.type = "button";
    goBtn.addEventListener("click", doSearch);
    tools.appendChild(goBtn);
    page.appendChild(tools);
    var status = el("div", "gv-head");
    status.appendChild(el("small", "", "Búsqueda sobre GameDB (374.000+ juegos de IGDB). Sin claves ni cuotas."));
    page.appendChild(status);
    page.appendChild(resultsEl);
    if (state.searchQuery) doSearch();

    function rowFor(j) {
      var mapped = mapGameDB(j);
      var inVault = mapped.gdbId != null && (gamesCache || []).some(function (g) { return g.gdbId != null && String(g.gdbId) === String(mapped.gdbId); });
      var row = el("div", "gv-res-row");
      if (mapped.imageUrl) {
        var img = document.createElement("img");
        img.className = "gv-res-img"; img.src = mapped.imageUrl; img.alt = ""; img.loading = "lazy";
        row.appendChild(img);
      } else {
        var ph = el("div", "gv-res-img");
        ph.style.display = "grid"; ph.style.placeItems = "center";
        ph.style.background = gradientFor(mapped.name);
        ph.textContent = mapped.name.charAt(0).toUpperCase();
        row.appendChild(ph);
      }
      var info = el("div", "gv-res-info");
      info.appendChild(el("strong", "", mapped.name));
      var bits = [];
      if (mapped.released) bits.push(fmtDate(mapped.released));
      if (mapped.rating != null) bits.push("★ " + mapped.rating);
      if (mapped.metacritic != null) bits.push("MC " + mapped.metacritic);
      if (mapped.developer) bits.push(mapped.developer);
      if (mapped.genres.length) bits.push(mapped.genres.slice(0, 2).join(", "));
      if (bits.length) info.appendChild(el("small", "", bits.join(" · ")));
      row.appendChild(info);
      if (mapped.gdbUrl) {
        var ext = el("button", "gv-btn", "IGDB ↗");
        ext.type = "button";
        ext.addEventListener("click", function () { api.openLink(mapped.gdbUrl); });
        row.appendChild(ext);
      }
      var add = el("button", inVault ? "gv-btn" : "gv-btn gv-btn-primary", inVault ? "✓ En vault" : "＋ Añadir");
      add.type = "button";
      if (inVault) add.disabled = true;
      else add.addEventListener("click", function () {
        add.disabled = true; add.textContent = "Añadiendo…";
        var finish = function (detail) {
          addGdbGame(detail, []);
          add.textContent = "✓ En vault";
          api.showToast("«" + mapped.name + "» añadido a la vault", "success");
        };
        if (j.summary != null) finish(j);
        else gdbGame(mapped.gdbId).then(finish).catch(function () { finish(j); });
      });
      row.appendChild(add);
      resultsEl.appendChild(row);
    }

    function doSearch() {
      var q = input.value.trim();
      state.searchQuery = q;
      var mySeq = ++seq;
      resultsEl.innerHTML = "";
      if (!q) { status.innerHTML = ""; status.appendChild(el("small", "", "Escribe un término y pulsa Buscar.")); return; }
      status.innerHTML = "";
      status.appendChild(el("small", "", "Buscando «" + q + "» en GameDB…"));
      gdbSearch(q).then(function (hits) {
        if (mySeq !== seq) return; // búsqueda obsoleta
        status.innerHTML = "";
        if (!hits.length) {
          status.appendChild(el("small", "", "Sin resultados en GameDB. Prueba con menos palabras."));
          return;
        }
        // Los buckets solo traen {id, name}: enriquecemos las 12 primeras fichas en
        // paralelo para mostrar banner/año/rating (las demás quedan como lista de nombres).
        status.appendChild(el("small", "", hits.length + " resultados"));
        var top = hits.slice(0, 12).map(function (h) {
          return gdbGame(h.id).then(function (j) { return j || { id: h.id, name: h.name, url: "" }; }).catch(function () { return { id: h.id, name: h.name, url: "" }; });
        });
        return Promise.all(top).then(function (details) {
          if (mySeq !== seq) return; // búsqueda obsoleta
          details.forEach(function (j) { rowFor(j); });
          hits.slice(12).forEach(function (h) { rowFor({ id: h.id, name: h.name, url: "" }); });
        });
      }).catch(function (err) {
        if (mySeq !== seq) return;
        status.innerHTML = "";
        status.appendChild(el("small", "", "Error: " + err.message));
      });
    }
  }

  function renderDetail(page) {
    var g = currentGame();
    if (!g) { go("library"); return; }
    var st = statusOf(g.status);

    headerBar(page, g.name, null, [
      { label: "← Volver", onClick: function () { go("library"); } },
      { label: "Eliminar", danger: true, onClick: function () {
        api.modal({
          title: "Eliminar juego",
          html: "<p>¿Eliminar <strong>" + (api.escapeHtml(g.name)) + "</strong> de tu vault? Sus fuentes guardadas se perderán (tus índices no se tocan).</p>",
          actions: [
            { label: "Cancelar" },
            { label: "Eliminar", danger: true, onClick: function () {
              gamesCache = gamesCache.filter(function (x) { return x.id !== g.id; });
              saveGames();
              api.showToast("Juego eliminado de la vault", "info");
              go("library");
            } },
          ],
        });
      } },
    ]);

    // Banner horizontal + cover vertical (carátula IGDB) lado a lado
    var hero = el("div", "gv-head");
    hero.style.alignItems = "stretch";
    hero.appendChild(coverEl(g, "gv-banner"));
    if (g.coverUrl) {
      var coverWrap = el("div");
      coverWrap.style.cssText = "flex-shrink:0;width:120px";
      var cv = document.createElement("img");
      cv.className = "gv-cover";
      cv.src = g.coverUrl;
      cv.alt = "";
      cv.loading = "lazy";
      cv.style.cssText = "width:120px;border-radius:10px;display:block;background:#0d1528";
      coverWrap.appendChild(cv);
      hero.appendChild(coverWrap);
    }
    page.appendChild(hero);

    var meta = el("div", "gv-meta-row");
    meta.appendChild(statusBadge(g.status));
    if (g.rating != null) { var r = el("span", "gv-tag", "★ " + g.rating); meta.appendChild(r); }
    if (g.metacritic != null) { var mc = el("span", "gv-tag", "Metacritic " + g.metacritic); meta.appendChild(mc); }
    if (g.released) { var rl = el("span", "gv-tag", fmtDate(g.released)); meta.appendChild(rl); }
    if (g.pegi) { var pg = el("span", "gv-tag", "PEGI " + g.pegi); meta.appendChild(pg); }
    (g.genres || []).slice(0, 4).forEach(function (gn) { meta.appendChild(el("span", "gv-tag", gn)); });
    page.appendChild(meta);
    if (g.developer) {
      page.appendChild(el("p", "gv-caption", "Desarrollado por " + g.developer));
    }
    if ((g.platforms || []).length) {
      var platRow = el("div", "gv-meta-row");
      gdbPlatforms().then(function (map) {
        if (!platRow.isConnected) return;
        (g.platforms || []).slice(0, 6).forEach(function (pid) {
          platRow.appendChild(el("span", "gv-tag", map[pid] || ("Plataforma " + pid)));
        });
      }).catch(function () {});
      page.appendChild(platRow);
    }

    // Selector de estado
    var stRow = el("div", "gv-head");
    STATUSES.forEach(function (s) {
      var c = el("button", "gv-chip" + (g.status === s.id ? " active" : ""), s.label);
      c.type = "button";
      c.addEventListener("click", function () {
        g.status = s.id;
        saveGames();
        rerender();
      });
      stRow.appendChild(c);
    });
    page.appendChild(stRow);

    if (g.description) {
      var desc = el("div", "gv-desc", g.description);
      page.appendChild(desc);
    } else if (g.gdbId) {
      // Enriquecimiento perezoso: el juego se añadió sin detalle
      gdbGame(g.gdbId).then(function (d) {
        if (!d) return;
        var mapped = mapGameDB(d);
        var cur = findGame(g.id);
        if (!cur) return;
        cur.description = mapped.description || cur.description;
        cur.genres = mapped.genres.length ? mapped.genres : cur.genres;
        cur.platforms = mapped.platforms.length ? mapped.platforms : cur.platforms;
        cur.developer = mapped.developer || cur.developer;
        cur.pegi = cur.pegi || mapped.pegi;
        cur.screenshots = mapped.screenshots.length ? mapped.screenshots : cur.screenshots;
        cur.imageUrl = mapped.imageUrl || cur.imageUrl;
        cur.coverUrl = mapped.coverUrl || cur.coverUrl;
        cur.rating = cur.rating || mapped.rating;
        cur.metacritic = cur.metacritic || mapped.metacritic;
        cur.released = cur.released || mapped.released;
        saveGames();
        if (state.view === "detail" && state.gameId === g.id) rerender();
      }).catch(function () {});
    }

    if ((g.screenshots || []).length) {
      var shots = el("div", "gv-shots");
      g.screenshots.forEach(function (u) {
        var img = document.createElement("img");
        img.src = u; img.alt = ""; img.loading = "lazy";
        img.addEventListener("click", function () {
          api.modal({
            title: g.name,
            html: '<img src="' + u.replace(/"/g, "%22") + '" alt="" style="width:100%;border-radius:10px;display:block" />',
            actions: [{ label: "Cerrar" }],
          });
        });
        shots.appendChild(img);
      });
      page.appendChild(shots);
    }

    if (g.website || g.gdbUrl) {
      var links = el("div", "gv-head");
      if (g.website) {
        var w = el("button", "gv-btn", "Web oficial ↗");
        w.type = "button";
        w.addEventListener("click", function () { api.openLink(g.website); });
        links.appendChild(w);
      }
      if (g.gdbUrl) {
        var rg = el("button", "gv-btn", "Ver en IGDB ↗");
        rg.type = "button";
        rg.addEventListener("click", function () { api.openLink(g.gdbUrl); });
        links.appendChild(rg);
      }
      page.appendChild(links);
    }

    // Fuentes
    var sec = el("div", "gv-section");
    var st2 = el("div", "gv-section-title");
    st2.appendChild(el("h5", "", "Fuentes de descarga"));
    st2.appendChild(el("small", "", (g.sources || []).length === 1 ? "1 enlace" : (g.sources || []).length + " enlaces"));
    st2.appendChild(el("span", "gv-spacer"));
    var addBtn = el("button", "gv-btn gv-btn-primary", "＋ Añadir fuentes");
    addBtn.type = "button";
    addBtn.addEventListener("click", function () {
      state.picks = {};
      state.pickQuery = "";
      state.pickIndexId = null;
      go("picker");
    });
    st2.appendChild(addBtn);
    sec.appendChild(st2);

    if (!(g.sources || []).length) {
      var none = el("div", "gv-empty");
      none.innerHTML = "Este juego no tiene fuentes todavía.<br>«Añadir fuentes» te deja elegir elementos de tus propios índices de IndexLy.";
      sec.appendChild(none);
    } else {
      g.sources.forEach(function (s) {
        var row = el("div", "gv-src-row");
        var dot = el("span");
        dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:#0ea5e9;flex-shrink:0";
        row.appendChild(dot);
        var info = el("div", "gv-src-info");
        info.appendChild(el("strong", "", s.itemTitle || "Sin título"));
        info.appendChild(el("small", "", s.sourceName || "Fuente"));
        row.appendChild(info);
        if (s.itemLink) {
          var dl = el("button", "gv-btn gv-btn-primary", "Descargar ↗");
          dl.type = "button";
          dl.addEventListener("click", function () { api.openLink(s.itemLink); });
          row.appendChild(dl);
        } else {
          row.appendChild(el("span", "gv-tag", "sin enlace"));
        }
        var rm = el("button", "gv-btn gv-btn-danger", "Quitar");
        rm.type = "button";
        rm.addEventListener("click", function () {
          g.sources = g.sources.filter(function (x) { return x !== s; });
          saveGames();
          rerender();
        });
        row.appendChild(rm);
        sec.appendChild(row);
      });
    }
    page.appendChild(sec);
  }

  // ---------- picker de fuentes ----------

  function pickKey(s) { return s.indexId + "|" + s.itemLink + "|" + s.itemTitle; }

  function renderPicker(page) {
    var g = currentGame();
    if (!g) { go("library"); return; }
    var indexes = api.getIndexes();
    var existingKeys = {};
    (g.sources || []).forEach(function (s) { existingKeys[pickKey(s)] = true; });

    headerBar(page, "Añadir fuentes — " + g.name, null, [
      { label: "Cancelar", onClick: function () { go("detail"); } },
      { label: "Listo", primary: true, onClick: function () {
        var added = 0;
        Object.keys(state.picks).forEach(function (k) {
          var s = state.picks[k];
          if (!existingKeys[pickKey(s)] && !(g.sources || []).some(function (x) { return x.itemLink && x.itemLink === s.itemLink; })) {
            g.sources = g.sources || [];
            g.sources.push(s);
            added++;
          }
        });
        saveGames();
        api.showToast(added === 1 ? "1 fuente añadida" : added + " fuentes añadidas", "success");
        go("detail");
      } },
    ]);

    if (!indexes.length) {
      var e0 = el("div", "gv-empty");
      e0.innerHTML = "No tienes índices cargados.<br>Importa fuentes en IndexLy y vuelve aquí.";
      page.appendChild(e0);
      return;
    }

    var chips = el("div", "gv-head");
    var all = el("button", "gv-chip" + (state.pickIndexId == null ? " active" : ""), "Todas las fuentes");
    all.type = "button";
    all.addEventListener("click", function () { state.pickIndexId = null; rerender(); });
    chips.appendChild(all);
    indexes.forEach(function (ix) {
      var c = el("button", "gv-chip" + (state.pickIndexId === ix.id ? " active" : ""), ix.name);
      c.type = "button";
      c.addEventListener("click", function () { state.pickIndexId = ix.id; rerender(); });
      chips.appendChild(c);
    });
    page.appendChild(chips);

    var tools = el("div", "gv-head");
    var input = el("input", "gv-input");
    input.type = "text";
    input.placeholder = "Buscar elemento en " + (state.pickIndexId == null ? "todas tus fuentes" : "esta fuente") + "…";
    input.value = state.pickQuery;
    input.style.flex = "1 1 220px";
    tools.appendChild(input);
    page.appendChild(tools);

    var selCount = el("div", "gv-head");
    var countLbl = el("small", "", "");
    selCount.appendChild(countLbl);
    page.appendChild(selCount);

    var rows = el("div", "gv-results");
    page.appendChild(rows);

    function updateCount() {
      var n = Object.keys(state.picks).length;
      countLbl.textContent = n === 0 ? "" : (n === 1 ? "1 fuente seleccionada (se guardará con «Listo»)" : n + " fuentes seleccionadas");
    }

    function rowFor(ix, game) {
      if (state.pickIndexId != null && ix.id !== state.pickIndexId) return;
      if (state.pickQuery && normStr(game.title).indexOf(normStr(state.pickQuery)) < 0) return;
      var s = { indexId: ix.id, sourceName: ix.name, itemTitle: game.title || "Sin título", itemLink: game.link || "" };
      var key = pickKey(s);
      var already = existingKeys[key] || !!(g.sources || []).some(function (x) { return x.itemLink && x.itemLink === s.itemLink; });
      var row = el("div", "gv-res-row");
      var info = el("div", "gv-res-info");
      info.appendChild(el("strong", "", s.itemTitle));
      info.appendChild(el("small", "", s.sourceName + (game.subtitle ? " · " + game.subtitle : "")));
      row.appendChild(info);
      var btn = el("button", "gv-btn" + (already || state.picks[key] ? " gv-btn-primary" : ""), already ? "✓ Añadida" : (state.picks[key] ? "✓ Seleccionada" : "＋"));
      btn.type = "button";
      if (already) { btn.disabled = true; }
      else {
        btn.addEventListener("click", function () {
          if (state.picks[key]) { delete state.picks[key]; btn.textContent = "＋"; btn.classList.remove("gv-btn-primary"); }
          else { state.picks[key] = s; btn.textContent = "✓ Seleccionada"; btn.classList.add("gv-btn-primary"); }
          updateCount();
        });
      }
      row.appendChild(btn);
      rows.appendChild(row);
    }

    function fill() {
      rows.innerHTML = "";
      var total = 0;
      indexes.forEach(function (ix) {
        (ix.games || []).forEach(function (game) { rowFor(ix, game); total++; });
      });
      if (!rows.children.length) {
        var e1 = el("div", "gv-empty");
        e1.textContent = state.pickQuery ? "Nada coincide con la búsqueda." : "Estas fuentes no tienen elementos.";
        rows.appendChild(e1);
      }
      updateCount();
    }
    input.addEventListener("input", function () { state.pickQuery = input.value; fill(); });
    fill();
  }

  // ---------- auto-match: vista ----------

  var AM_ROW_STYLE = "display:flex;gap:10px;align-items:center;border:1px solid #1e293b;border-radius:10px;padding:8px;background:#070a12";

  function amatchUpdateProgress() {
    var am = state.am;
    var lbl = document.getElementById("gv-am-progress");
    if (lbl && am) lbl.textContent = am.total ? am.progress + " / " + am.total : "";
  }

  function amatchUpdateRow(it) {
    var row = document.getElementById("gv-am-row-" + it.key.replace(/[^a-z0-9]/gi, ""));
    if (!row) return;
    var badge = row.querySelector(".gv-am-badge");
    var btn = row.querySelector("button.gv-am-toggle");
    var img = row.querySelector("img.gv-res-img");
    var info = row.querySelector(".gv-res-info");
    if (badge) {
      var cls = "gv-am-badge gv-tag";
      var txt = "…";
      var color = "#64748b";
      if (it.status === "found") { txt = "nuevo"; color = "#4ade80"; }
      else if (it.status === "invault") { txt = "en vault"; color = "#7dd3fc"; }
      else if (it.status === "nomatch") { txt = "sin match"; color = "#64748b"; }
      else if (it.status === "error") { txt = "error"; color = "#f87171"; }
      else if (it.status === "searching") { txt = "buscando…"; color = "#fbbf24"; }
      badge.textContent = txt;
      badge.style.color = color;
      badge.style.borderColor = color + "44";
    }
    if (img && it.result && it.result.background_image) { img.src = it.result.background_image; }
    if (info) {
      var sub = info.querySelector("small");
      if (sub && it.result) {
        var bits = [];
        if (it.result.released) bits.push(fmtDate(it.result.released));
        if (typeof it.result.rating === "number") bits.push("★ " + Math.round(it.result.rating * 10) / 10);
        if (Array.isArray(it.result.genres) && it.result.genres[0]) bits.push(it.result.genres[0].name);
        if (it.error) bits.push("error: " + it.error);
        sub.textContent = bits.join(" · ");
      }
    }
    if (btn && (it.status === "found" || it.status === "invault")) {
      btn.style.display = "";
      btn.textContent = it.keep ? "✓" : "＋";
      btn.className = "gv-am-toggle gv-btn" + (it.keep ? " gv-btn-primary" : "");
    }
    if (btn && (it.status === "nomatch" || it.status === "error" || it.status === "pending" || it.status === "searching")) {
      btn.style.display = "none";
    }
  }

  function renderAMatch(page) {
    var am = state.am;
    if (!am) { go("library"); return; }
    var indexes = api.getIndexes();

    headerBar(page, "Auto-match", null, [
      { label: "← Volver", onClick: function () { go("library"); } },
    ]);

    var help = el("div", "gv-help");
    help.innerHTML = "Escanea los títulos de una fuente, los busca en GameDB (IGDB) y te deja <strong>confirmar cada juego</strong> antes de añadirlo con su carátula y ficha. Si el juego ya está en la vault, se fusiona la fuente. Descarga 1 ficha por juego al confirmar.";
    page.appendChild(help);

    // Selección de índice + botón escanear
    var tools = el("div", "gv-head");
    var sel = document.createElement("select");
    sel.className = "gv-select";
    var ph = document.createElement("option");
    ph.value = ""; ph.textContent = "Elige la fuente a escanear…";
    sel.appendChild(ph);
    indexes.forEach(function (ix) {
      var op = document.createElement("option");
      op.value = ix.id; op.textContent = ix.name + " (" + (ix.games || []).length + ")";
      if (am.indexId === ix.id) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener("change", function () { am.indexId = sel.value || null; });
    tools.appendChild(sel);
    var scan = el("button", "gv-btn gv-btn-primary", am.running ? "Escaneando…" : "⚡ Escanear");
    scan.type = "button";
    scan.disabled = am.running;
    scan.addEventListener("click", function () {
      var ix = indexes.find(function (i) { return i.id === am.indexId; });
      if (!ix) { api.showToast("Elige una fuente primero", "warning"); return; }
      am.items = amatchBuildItems(ix);
      if (!am.items.length) { api.showToast("Nada nuevo que escanear en esa fuente", "info"); return; }
      amatchRun();
      rerender();
    });
    tools.appendChild(scan);
    var prog = el("small", "", "");
    prog.id = "gv-am-progress";
    tools.appendChild(prog);
    tools.appendChild(el("span", "gv-spacer"));
    var confirmBtn = el("button", "gv-btn gv-btn-primary", "Añadir seleccionados");
    confirmBtn.type = "button";
    confirmBtn.id = "gv-am-confirm";
    confirmBtn.addEventListener("click", amatchConfirm);
    tools.appendChild(confirmBtn);
    page.appendChild(tools);

    if (!am.items.length) {
      var empty = el("div", "gv-empty");
      empty.textContent = "Elige una fuente y pulsa Escanear para detectar juegos.";
      page.appendChild(empty);
      return;
    }

    var list = el("div", "gv-results");
    page.appendChild(list);

    am.items.forEach(function (it) {
      var row = el("div", "gv-res-row");
      row.id = "gv-am-row-" + it.key.replace(/[^a-z0-9]/gi, "");
      row.setAttribute("style", AM_ROW_STYLE);
      var ph = el("div", "gv-res-img");
      ph.style.display = "grid"; ph.style.placeItems = "center";
      ph.style.background = gradientFor(it.title);
      ph.textContent = (it.clean.name || "?").charAt(0).toUpperCase();
      row.appendChild(ph);
      var info = el("div", "gv-res-info");
      info.appendChild(el("strong", "", it.clean.name || it.title));
      info.appendChild(el("small", "", "original: " + it.title + (it.link ? " · con enlace" : "")));
      row.appendChild(info);
      var badge = el("span", "gv-tag gv-am-badge", it.status === "pending" ? "en cola" : "…");
      badge.style.color = "#64748b";
      row.appendChild(badge);
      var btn = el("button", "gv-btn gv-am-toggle", "＋");
      btn.type = "button";
      btn.style.display = "none";
      btn.addEventListener("click", function () {
        it.keep = !it.keep;
        amatchUpdateRow(it);
      });
      row.appendChild(btn);
      list.appendChild(row);
      if (it.status !== "pending") amatchUpdateRow(it);
    });

    amatchUpdateProgress();
  }

  // ---------- ajustes ----------

  function renderSettings(page) {
    headerBar(page, "Ajustes de GameVault", null, [
      { label: "← Volver", onClick: function () { go("library"); } },
    ]);

    {
      var box = el("div", "gv-section");
      box.style.background = "#0a0f1c";
      box.style.border = "1px solid #1e293b";
      box.style.borderRadius = "12px";
      box.style.padding = "16px";

      var st = el("div", "gv-head");
      st.appendChild(el("h4", "", "Fuente de datos"));
      page.appendChild(st);

      var src = el("div", "gv-help");
      src.innerHTML = "<strong style=\"color:#4ade80\">✓ Sin configuración</strong> — GameVault usa <a href=\"https://github.com/LizardByte/GameDB\" target=\"_blank\" rel=\"noopener\">GameDB</a>," +
        " una copia pública de la base de datos de IGDB publicada por LizardByte como JSON estático (374.000+ juegos, actualizada a diario).<br>" +
        "No hay claves, ni cuotas, ni cuentas: la búsqueda, carátulas y fichas funcionan desde el primer momento. Solo se consultan <code>app.lizardbyte.dev</code> e <code>images.igdb.com</code>.";
      box.appendChild(src);
      page.appendChild(box);

      // Estadísticas de la vault
      function statRow(label, count, max, color) {
        var row = el("div", "gv-head");
        row.style.marginBottom = "6px";
        var l = el("small", "", label);
        l.style.cssText = "width:150px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        row.appendChild(l);
        var track = el("span");
        track.style.cssText = "flex:1;height:7px;border-radius:999px;background:#141b29;overflow:hidden;display:block";
        var bar = el("span");
        bar.style.cssText = "display:block;height:100%;width:" + (max ? Math.round((count / max) * 100) : 0) + "%;border-radius:999px;background:" + color;
        track.appendChild(bar);
        row.appendChild(track);
        row.appendChild(el("small", "", String(count)));
        return row;
      }
      function renderStats() {
        var wrap = document.getElementById("gv-stats");
        if (!wrap) return;
        wrap.innerHTML = "";
        var games = gamesCache || [];
        if (!games.length) {
          wrap.appendChild(el("small", "", "Añade juegos para ver estadísticas."));
          return;
        }
        var withSrc = games.filter(function (g) { return (g.sources || []).length > 0; }).length;
        wrap.appendChild(statRow("Total", games.length, games.length, "#0ea5e9"));
        wrap.appendChild(statRow("Con fuente", withSrc, games.length, "#22c55e"));
        STATUSES.forEach(function (st) {
          var n = games.filter(function (g) { return g.status === st.id; }).length;
          if (n) wrap.appendChild(statRow(st.label, n, games.length, st.color));
        });
        // Géneros top
        var gCount = {};
        games.forEach(function (g) { (g.genres || []).forEach(function (gn) { gCount[gn] = (gCount[gn] || 0) + 1; }); });
        var gTop = Object.keys(gCount).sort(function (a, b) { return gCount[b] - gCount[a]; }).slice(0, 5);
        gTop.forEach(function (gn) { wrap.appendChild(statRow(gn, gCount[gn], gCount[gTop[0]], "#a78bfa")); });
        // Años top
        var yCount = {};
        games.forEach(function (g) { if (g.released) { var y = String(g.released).slice(0, 4); if (/^\d{4}$/.test(y)) yCount[y] = (yCount[y] || 0) + 1; } });
        var yTop = Object.keys(yCount).sort(function (a, b) { return yCount[b] - yCount[a]; }).slice(0, 5);
        yTop.forEach(function (y) { wrap.appendChild(statRow(y, yCount[y], yCount[yTop[0]], "#fbbf24")); });
      }
      var stSec = el("div", "gv-section");
      var stT = el("div", "gv-section-title");
      stT.appendChild(el("h5", "", "Estadísticas"));
      var stRefresh = el("button", "gv-btn", "Refrescar");
      stRefresh.type = "button";
      stRefresh.addEventListener("click", renderStats);
      stT.appendChild(stT.nextSibling == null ? el("span", "gv-spacer") : el("span", "gv-spacer"));
      stT.appendChild(stRefresh);
      stSec.appendChild(stT);
      var stBox = el("div");
      stBox.id = "gv-stats";
      stBox.style.cssText = "display:flex;flex-direction:column;gap:4px;background:#070a12;border:1px solid #1e293b;border-radius:10px;padding:12px 14px";
      stSec.appendChild(stBox);
      page.appendChild(stSec);
      renderStats();

      // Backup
      var bk = el("div", "gv-section");
      var bt = el("div", "gv-section-title");
      bt.appendChild(el("h5", "", "Backup de la vault"));
      bk.appendChild(bt);
      var brow = el("div", "gv-head");
      var exp = el("button", "gv-btn", "Exportar JSON");
      exp.type = "button";
      exp.addEventListener("click", function () {
        var data = JSON.stringify({ app: "indexly-gamevault", version: 1, exportedAt: new Date().toISOString(), games: gamesCache || [] }, null, 2);
        var blob = new Blob([data], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "gamevault-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      });
      brow.appendChild(exp);
      var imp = el("button", "gv-btn", "Importar JSON");
      imp.type = "button";
      imp.addEventListener("click", function () {
        var fi = document.createElement("input");
        fi.type = "file";
        fi.accept = ".json,application/json";
        fi.addEventListener("change", function () {
          var file = fi.files && fi.files[0];
          if (!file) return;
          file.text().then(function (txt) {
            var parsed = JSON.parse(txt);
            var list = Array.isArray(parsed) ? parsed : parsed.games;
            if (!Array.isArray(list)) throw new Error("El archivo no contiene una vault (games[])");
            list = list.filter(function (x) { return x && typeof x.name === "string"; });
            if (!list.length) throw new Error("El archivo no contiene juegos válidos");
            api.modal({
              title: "Importar vault",
              html: "<p>Se reemplazará tu vault actual (" + (gamesCache || []).length + " juegos) por la del archivo (" + list.length + " juegos). ¿Continuar?</p>",
              actions: [
                { label: "Cancelar" },
                { label: "Reemplazar", danger: true, onClick: function () {
                  gamesCache = list.map(function (x) {
                    return {
                      id: String(x.id || ("m" + Date.now() + Math.random().toString(36).slice(2, 6))),
                      name: String(x.name).slice(0, 120), imageUrl: x.imageUrl || "", coverUrl: x.coverUrl || "",
                      rating: x.rating != null ? x.rating : null, metacritic: x.metacritic != null ? x.metacritic : null,
                      released: x.released || "", genres: Array.isArray(x.genres) ? x.genres : [],
                      platforms: Array.isArray(x.platforms) ? x.platforms : [], developer: x.developer || "", pegi: x.pegi || null,
                      website: x.website || "", description: x.description || "", screenshots: Array.isArray(x.screenshots) ? x.screenshots : [],
                      gdbId: x.gdbId != null ? String(x.gdbId) : (x.rawgId != null ? String(x.rawgId) : null), gdbUrl: x.gdbUrl || x.rawgUrl || "",
                      status: STATUSES.some(function (s) { return s.id === x.status; }) ? x.status : "backlog",
                      addedAt: x.addedAt || Date.now(),
                      sources: Array.isArray(x.sources) ? x.sources.filter(function (s2) { return s2 && typeof s2 === "object"; }) : [],
                    };
                  });
                  saveGames();
                  api.showToast("Vault importada: " + gamesCache.length + " juegos", "success");
                  go("library");
                } },
              ],
            });
          }).catch(function (err) {
            api.showToast("Import falló: " + err.message, "error", 5000);
          });
        });
        fi.click();
      });
      brow.appendChild(imp);
      bk.appendChild(brow);
      page.appendChild(bk);
    }
  }

  IndexLy.register({
    setup: function (ctx) {
      api = ctx;
      ensureStyles();
      ensureGames(function () {});
      ctx.addSection({ id: "gamevault", label: "GameVault", render: renderPage });
      // Documentación propia en /ayuda (host de stubs en esa página: los demás slots no aplican)
      if (typeof ctx.addDocSection === "function") {
        ctx.addDocSection({
          id: "gamevault",
          title: "GameVault — tu colección de juegos",
          html:
            "<p><strong>GameVault</strong> añade una pestaña donde guardar tu colección de juegos" +
            " con carátulas, ficha completa y <strong>fuentes de descarga</strong> enlazadas a tus" +
            " propios índices de IndexLy. No necesita ninguna configuración.</p>" +
            "<ul>" +
            "<li><strong>Buscar juegos</strong>: la búsqueda usa <code>GameDB</code> (copia pública" +
            " de IGDB, actualizada a diario). Escribe el nombre y pulsa «＋ Añadir»: se guarda con" +
            " banner, descripción, rating y fecha. También puedes <strong>añadir a mano</strong> un" +
            " juego con imagen por URL.</li>" +
            "<li><strong>Estados</strong>: marca cada juego como Backlog, Jugando, Terminado o" +
            " Abandonado. Los chips de la biblioteca filtran por estado.</li>" +
            "<li><strong>Fuentes de descarga</strong>: dentro de un juego, «＋ Añadir fuentes» abre" +
            " un buscador sobre tus propios índices. Añade todos los elementos que quieras con «＋»" +
            " y pulsa «Listo». Desde entonces, cada fuente tiene su botón" +
            " <strong>«Descargar ↗»</strong> (abre el magnet o enlace).</li>" +
            "<li><strong>＋ Vault</strong>: al buscar en IndexLy, cada tarjeta tiene este botón para" +
            " guardar el elemento como juego en la vault (con su fuente ya enlazada). Si el juego" +
            " ya existe, la fuente se añade a la ficha existente.</li>" +
            "<li><strong>Auto-match</strong>: desde la biblioteca, escanea una fuente entera y" +
            " busca cada título en GameDB (limpia versiones/repacks del nombre). Tú confirmas cada" +
            " juego antes de añadirlo y puede fusionar fuentes de juegos ya guardados.</li>" +
            "<li><strong>Backup</strong>: en Ajustes puedes exportar/importar la vault como JSON," +
            " y consultar estadísticas (estados, géneros, años).</li>" +
            "</ul>" +
            "<p><strong>Privacidad</strong>: la colección vive en tu navegador (IndexedDB) y solo" +
            " se consultan <code>app.lizardbyte.dev</code> (GameDB) e" +
            " <code>images.igdb.com</code> para las imágenes. Nada más.</p>",
        });
      }
      // Botón en los resultados de búsqueda de IndexLy: añade el título a la vault
      // con ese item como primera fuente (GameDB lo enriquece en segundo plano).
      ctx.addCardAction({
        id: "gv-add",
        label: "＋ Vault",
        match: function (g) { return !!(g && g.title); },
        onClick: quickAdd,
      });
      // Badge en las cards cuyo enlace ya está en la vault
      ctx.on("items:hydrate", function (e) {
        if (!e || !e.el || !e.game || !e.game.link || !linkSet[e.game.link]) return;
        if (e.el.querySelector(".gv-badge-vault")) return;
        var info = e.el.querySelector(".game-info-container") || e.el.querySelector(".grid-body");
        if (!info) return;
        var b = document.createElement("span");
        b.className = "gv-badge-vault";
        b.textContent = "✓ en vault";
        info.appendChild(b);
      });
    },
  });
})();
