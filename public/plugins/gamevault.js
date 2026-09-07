/* IndexLy Plugin
   id: gamevault
   name: GameVault
   version: 1.2.0
   description: Tu colección de juegos: busca en RAWG (con tu API key, gratis), guarda juegos con banners y asígnales fuentes de descarga desde tus propios índices. Incluye auto-match, estadísticas y añadido manual. Sin key, la vault funciona igual.
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

  var RAWG_BASE = "https://api.rawg.io/api/";
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

  function getSettings(cb) {
    return api.storage.get("gv_settings").then(function (s) { cb((s && typeof s === "object") ? s : { rawgKey: "" }); });
  }

  function findGame(id) {
    return (gamesCache || []).find(function (g) { return g.id === id; }) || null;
  }

  function currentGame() { return state.gameId ? findGame(state.gameId) : null; }

  function rerender() { if (pageRoot) renderPage(pageRoot); }

  // ---------- auto-match ----------
  // Detecta los títulos de un índice, los busca en RAWG (1 req/título, tope 60,
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

  function gameInVaultByRawg(id) {
    return (gamesCache || []).find(function (g) { return g.rawgId != null && String(g.rawgId) === String(id); }) || null;
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
      var params = { search: it.clean.name, page_size: "3" };
      if (it.clean.year) params.dates = it.clean.year + "-01-01," + it.clean.year + "-12-31";
      rawgFetch("games", params).then(function (json) {
        var hit = json && Array.isArray(json.results) && json.results[0] ? json.results[0] : null;
        if (hit && gameInVaultByRawg(hit.id)) {
          it.result = hit; it.status = "invault"; it.keep = true;
        } else if (hit) {
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
    var added = 0, merged = 0;
    am.items.forEach(function (it) {
      if (!it.keep || !it.result) return;
      if (it.status === "found") {
        var dup = (gamesCache || []).some(function (g) { return g.rawgId != null && String(g.rawgId) === String(it.result.id); });
        if (dup) return;
        var src = it.link ? [{ indexId: it.indexId, sourceName: it.indexName, itemTitle: it.title, itemLink: it.link }] : [];
        var d = mapRawg(it.result);
        gamesCache.push({
          id: "g" + Date.now() + Math.random().toString(36).slice(2, 6),
          name: d.name, imageUrl: d.imageUrl, rating: d.rating, metacritic: d.metacritic,
          released: d.released, genres: d.genres, platforms: d.platforms, website: d.website,
          description: d.description, screenshots: d.screenshots, rawgId: d.rawgId, rawgUrl: d.rawgUrl,
          status: "backlog", addedAt: Date.now(), sources: src,
        });
        added++;
      } else if (it.status === "invault") {
        var cur = gameInVaultByRawg(it.result.id);
        if (cur && it.link && !(cur.sources || []).some(function (s) { return s.itemLink === it.link; })) {
          cur.sources = cur.sources || [];
          cur.sources.push({ indexId: it.indexId, sourceName: it.indexName, itemTitle: it.title, itemLink: it.link });
          merged++;
        }
      }
    });
    saveGames();
    var msg = added === 0 && merged === 0 ? "Nada que añadir" : (added === 1 ? "1 juego añadido" : added + " juegos añadidos") + (merged ? " · " + merged + " fuentes fusionadas" : "");
    api.showToast(msg, "success", 4000);
    go("library");
  }

  // ---------- RAWG ----------

  function rawgFetch(path, params) {
    return getSettings(function () {}).then(function (settings) {
      if (!settings.rawgKey) throw new Error("Configura tu API key de RAWG en Ajustes");
      var qs = new URLSearchParams(params || {});
      qs.set("key", settings.rawgKey);
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 15000);
      return fetch(RAWG_BASE + path + "?" + qs.toString(), { signal: ctrl.signal })
        .then(function (res) {
          if (res.status === 401) throw new Error("API key de RAWG no válida");
          if (res.status === 429) throw new Error("Límite de RAWG alcanzado (20.000/mes en el plan gratis)");
          if (!res.ok) throw new Error("RAWG respondió " + res.status);
          return res.json();
        })
        .finally(function () { clearTimeout(timer); });
    });
  }

  function rawgDetail(id) {
    return getSettings(function () {}).then(function (settings) {
      if (!settings.rawgKey) throw new Error("Sin API key de RAWG");
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 15000);
      return fetch(RAWG_BASE + "games/" + encodeURIComponent(id) + "?key=" + encodeURIComponent(settings.rawgKey), { signal: ctrl.signal })
        .then(function (res) {
          if (!res.ok) throw new Error("RAWG respondió " + res.status);
          return res.json();
        })
        .finally(function () { clearTimeout(timer); });
    });
  }

  // Mapa RAWG (resultado de búsqueda o detalle) → registro de vault parcial
  function mapRawg(r) {
    return {
      rawgId: r.id != null ? String(r.id) : null,
      name: String(r.name || "Sin título").slice(0, 120),
      imageUrl: r.background_image || "",
      rating: typeof r.rating === "number" ? Math.round(r.rating * 10) / 10 : null,
      metacritic: typeof r.metacritic === "number" ? r.metacritic : null,
      released: r.released || "",
      genres: Array.isArray(r.genres) ? r.genres.map(function (g) { return g.name; }).filter(Boolean).slice(0, 5) : [],
      platforms: Array.isArray(r.platforms) ? r.platforms.map(function (p) { return p && p.platform && p.platform.name; }).filter(Boolean).slice(0, 6) : [],
      website: r.website || "",
      description: r.description_raw ? String(r.description_raw).slice(0, 4000) : "",
      screenshots: Array.isArray(r.screenshots) ? r.screenshots.map(function (s) { return s.image; }).filter(Boolean).slice(0, 4) : [],
      rawgUrl: r.slug ? "https://rawg.io/games/" + r.slug : "",
    };
  }

  function addRawgGame(r, extraSources) {
    var dup = (gamesCache || []).find(function (g) { return g.rawgId != null && String(g.rawgId) === String(r.id); });
    if (dup) return dup;
    var d = mapRawg(r);
    var rec = {
      id: "g" + Date.now() + Math.random().toString(36).slice(2, 6),
      name: d.name, imageUrl: d.imageUrl, rating: d.rating, metacritic: d.metacritic,
      released: d.released, genres: d.genres, platforms: d.platforms, website: d.website,
      description: d.description, screenshots: d.screenshots, rawgId: d.rawgId, rawgUrl: d.rawgUrl,
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
      name: name.slice(0, 120), imageUrl: "", rating: null, metacritic: null,
      released: "", genres: [], platforms: [], website: "", description: "", screenshots: [],
      rawgId: null, rawgUrl: "", status: "backlog", addedAt: Date.now(),
      sources: game.link ? [{ indexId: idx ? idx.id : null, sourceName: game.source || "", itemTitle: name, itemLink: game.link }] : [],
    };
    gamesCache.push(rec);
    saveGames();
    api.showToast("Añadido a GameVault", "success");
    if (state.view === "library") rerender();
    // Enriquecimiento async con RAWG si hay key: banner + descripción
    getSettings(function () {}).then(function (settings) {
      if (!settings.rawgKey) return;
      return rawgFetch("games", { search: name, page_size: "1" }).then(function (json) {
        var hit = json && Array.isArray(json.results) ? json.results[0] : null;
        if (!hit) return;
        return rawgDetail(hit.id).then(function (d) {
          var cur = findGame(rec.id);
          if (!cur) return;
          var mapped = mapRawg(d);
          cur.rawgId = mapped.rawgId; cur.imageUrl = mapped.imageUrl || cur.imageUrl;
          cur.rating = mapped.rating; cur.metacritic = mapped.metacritic; cur.released = mapped.released;
          cur.genres = mapped.genres; cur.platforms = mapped.platforms; cur.website = mapped.website;
          cur.description = mapped.description; cur.screenshots = mapped.screenshots; cur.rawgUrl = mapped.rawgUrl;
          saveGames();
          rerender();
        });
      });
    }).catch(function () { /* sin key o fallo de red: queda manual */ });
  }

  // Añadido manual (sin RAWG): título obligatorio, imagen y descripción opcionales
  function addManualGame(name, imageUrl, description) {
    var rec = {
      id: "m" + Date.now() + Math.random().toString(36).slice(2, 6),
      name: String(name).slice(0, 120),
      imageUrl: String(imageUrl || "").trim(),
      rating: null, metacritic: null, released: "", genres: [], platforms: [],
      website: "", description: String(description || "").trim().slice(0, 4000),
      screenshots: [], rawgId: null, rawgUrl: "",
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
      ".gv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:12px;overflow:auto}",
      ".gv-card{background:#070a12;border:1px solid #1e293b;border-radius:12px;overflow:hidden;cursor:pointer;transition:border-color .15s,transform .15s;display:flex;flex-direction:column}",
      ".gv-card:hover{border-color:#24344f;transform:translateY(-2px)}",
      ".gv-card-img{height:108px;width:100%;object-fit:cover;display:block;background:#0d1528;flex-shrink:0}",
      ".gv-card-ph{height:108px;width:100%;display:grid;place-items:center;font-size:26px;font-weight:700;color:rgba(255,255,255,0.55);text-shadow:0 2px 8px rgba(0,0,0,0.4)}",
      ".gv-card-body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:4px}",
      ".gv-card-name{font-size:12.5px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".gv-card-meta{font-size:10.5px;color:#64748b;display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
      ".gv-badge{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;padding:2px 8px;border-radius:999px;border:1px solid;width:max-content}",
      ".gv-banner{width:100%;height:210px;object-fit:cover;border-radius:12px;background:#0d1528;display:block;flex-shrink:0}",
      ".gv-meta-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
      ".gv-tag{font-size:10px;font-weight:500;padding:3px 9px;border:1px solid #1e293b;border-radius:999px;color:#94a3b8;background:#0f141e}",
      ".gv-desc{font-size:12.5px;color:#cbd5e1;line-height:1.65;white-space:pre-wrap;max-height:230px;overflow:auto;background:#070a12;border:1px solid #1e293b;border-radius:10px;padding:12px 14px}",
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
      "@media (max-width:640px){.gv-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}.gv-banner{height:150px}}",
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

  function statusBadge(statusId, extraCls) {
    var st = statusOf(statusId);
    var b = el("span", "gv-badge" + (extraCls ? " " + extraCls : ""), st.label);
    b.style.color = st.color;
    b.style.borderColor = st.color + "44";
    b.style.background = st.color + "14";
    return b;
  }

  // ---------- vistas ----------

  function renderPage(root) {
    ensureStyles();
    pageRoot = root;
    root.innerHTML = "";
    ensureGames(function () {
      var page = el("div", "gv-page");
      root.appendChild(page);
      if (state.view === "search") renderSearch(page);
      else if (state.view === "detail") renderDetail(page);
      else if (state.view === "picker") renderPicker(page);
      else if (state.view === "amatch") renderAMatch(page);
      else if (state.view === "settings") renderSettings(page);
      else renderLibrary(page);
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

    getSettings(function () {}).then(function (settings) {
      if (!settings.rawgKey) {
        var note = el("div", "gv-banner-note");
        note.appendChild(el("span", "", "Sin API key de RAWG: puedes añadir juegos a mano y gestionar fuentes. Con key gratis obtienes búsqueda, banners, ratings y descripciones."));
        var b = el("button", "gv-btn", "Configurar RAWG");
        b.type = "button";
        b.addEventListener("click", function () { go("settings"); });
        note.appendChild(b);
        page.appendChild(note);
      }
    }).catch(function () {});

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
          : "Tu vault está vacía.<br>Busca juegos en RAWG o añádelos a mano.";
        listWrap.appendChild(empty);
        return;
      }
      list.forEach(function (g) {
        var card = el("div", "gv-card");
        card.appendChild(coverEl(g, "gv-card-img"));
        var body = el("div", "gv-card-body");
        body.appendChild(el("div", "gv-card-name", g.name));
        var meta = el("div", "gv-card-meta");
        meta.appendChild(statusBadge(g.status));
        var bits = [];
        if (g.released) bits.push(fmtDate(g.released).slice(3));
        if (g.rating != null) bits.push("★ " + g.rating);
        if (g.sources && g.sources.length) bits.push(g.sources.length === 1 ? "1 fuente" : g.sources.length + " fuentes");
        if (bits.length) meta.appendChild(el("span", "", bits.join(" · ")));
        body.appendChild(meta);
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

    getSettings(function () {}).then(function (settings) {
      if (!settings.rawgKey) {
        var note = el("div", "gv-banner-note");
        note.appendChild(el("span", "", "Necesitas una API key gratuita de RAWG para buscar."));
        var b = el("button", "gv-btn gv-btn-primary", "Configurar");
        b.type = "button";
        b.addEventListener("click", function () { go("settings"); });
        note.appendChild(b);
        page.appendChild(note);
        return;
      }
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
      status.appendChild(el("small", "", state.searchQuery ? "Pulsa Buscar para repetir la consulta." : "La búsqueda consume cuota de tu key (20.000/mes)."));
      page.appendChild(status);
      page.appendChild(resultsEl);
      if (state.searchQuery) doSearch();

      function doSearch() {
        var q = input.value.trim();
        state.searchQuery = q;
        resultsEl.innerHTML = "";
        if (!q) return;
        status.innerHTML = "";
        status.appendChild(el("small", "", "Buscando «" + q + "» en RAWG…"));
        rawgFetch("games", { search: q, page_size: "20" }).then(function (json) {
          status.innerHTML = "";
          var results = (json && json.results) || [];
          if (!results.length) {
            status.appendChild(el("small", "", "Sin resultados en RAWG."));
            return;
          }
          status.appendChild(el("small", "", results.length + " resultados"));
          results.forEach(function (r) {
            var mapped = mapRawg(r);
            var inVault = (gamesCache || []).some(function (g) { return g.rawgId != null && String(g.rawgId) === String(mapped.rawgId); });
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
            if (mapped.genres.length) bits.push(mapped.genres.slice(0, 2).join(", "));
            if (bits.length) info.appendChild(el("small", "", bits.join(" · ")));
            row.appendChild(info);
            if (mapped.rawgUrl) {
              var ext = el("button", "gv-btn", "RAWG ↗");
              ext.type = "button";
              ext.addEventListener("click", function () { api.openLink(mapped.rawgUrl); });
              row.appendChild(ext);
            }
            var add = el("button", inVault ? "gv-btn" : "gv-btn gv-btn-primary", inVault ? "✓ En vault" : "＋ Añadir");
            add.type = "button";
            if (inVault) add.disabled = true;
            else add.addEventListener("click", function () {
              add.disabled = true; add.textContent = "Añadiendo…";
              rawgDetail(mapped.rawgId).then(function (d) {
                addRawgGame(d, []);
                add.textContent = "✓ En vault";
                api.showToast("«" + mapped.name + "» añadido a la vault", "success");
              }).catch(function (err) {
                // sin detalle igualmente se añade con lo que ya hay del search
                addRawgGame(r, []);
                add.textContent = "✓ En vault";
                api.showToast("Añadido (sin detalle: " + err.message + ")", "warning", 5000);
              });
            });
            row.appendChild(add);
            resultsEl.appendChild(row);
          });
        }).catch(function (err) {
          status.innerHTML = "";
          status.appendChild(el("small", "", "Error: " + err.message));
        });
      }
    }).catch(function () {});

    var resultsEl = el("div", "gv-results");
    // (resultsEl se engancha dentro de getSettings si hay key)
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

    page.appendChild(coverEl(g, "gv-banner"));

    var meta = el("div", "gv-meta-row");
    meta.appendChild(statusBadge(g.status));
    if (g.rating != null) { var r = el("span", "gv-tag", "★ " + g.rating); meta.appendChild(r); }
    if (g.metacritic != null) { var mc = el("span", "gv-tag", "Metacritic " + g.metacritic); meta.appendChild(mc); }
    if (g.released) { var rl = el("span", "gv-tag", fmtDate(g.released)); meta.appendChild(rl); }
    (g.genres || []).slice(0, 4).forEach(function (gn) { meta.appendChild(el("span", "gv-tag", gn)); });
    page.appendChild(meta);

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
    } else if (g.rawgId) {
      // Enriquecimiento perezoso: el juego se añadió sin detalle
      rawgDetail(g.rawgId).then(function (d) {
        var mapped = mapRawg(d);
        var cur = findGame(g.id);
        if (!cur) return;
        cur.description = mapped.description || cur.description;
        cur.genres = mapped.genres.length ? mapped.genres : cur.genres;
        cur.platforms = mapped.platforms.length ? mapped.platforms : cur.platforms;
        cur.website = mapped.website || cur.website;
        cur.screenshots = mapped.screenshots.length ? mapped.screenshots : cur.screenshots;
        cur.imageUrl = mapped.imageUrl || cur.imageUrl;
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

    if (g.website || g.rawgUrl) {
      var links = el("div", "gv-head");
      if (g.website) {
        var w = el("button", "gv-btn", "Web oficial ↗");
        w.type = "button";
        w.addEventListener("click", function () { api.openLink(g.website); });
        links.appendChild(w);
      }
      if (g.rawgUrl) {
        var rg = el("button", "gv-btn", "Ver en RAWG ↗");
        rg.type = "button";
        rg.addEventListener("click", function () { api.openLink(g.rawgUrl); });
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
    help.innerHTML = "Escanea los títulos de una fuente, los busca en RAWG y te deja <strong>confirmar cada juego</strong> antes de añadirlo con su banner y ficha. Si el juego ya está en la vault, puedes fusionar la fuente. Consume 1 petición de tu cuota por título (tope 60, de 3 en 3).";
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
      getSettings(function () {}).then(function (settings) {
        if (!settings.rawgKey) { api.showToast("Configura tu API key de RAWG primero", "warning"); go("settings"); return; }
        am.items = amatchBuildItems(ix);
        if (!am.items.length) { api.showToast("Nada nuevo que escanear en esa fuente", "info"); return; }
        amatchRun();
        rerender();
      }).catch(function () {});
    });
    tools.appendChild(scan);
    var prog = el("small", "", "");
    prog.id = "gv-am-progress";
    tools.appendChild(prog);
    tools.appendChild(el("span", "gv-spacer"));
    var confirmBtn = el("button", "gv-btn gv-btn-primary", "Añadir seleccionados");
    confirmBtn.type = "button";
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

    getSettings(function () {}).then(function (settings) {
      var box = el("div", "gv-section");
      box.style.background = "#0a0f1c";
      box.style.border = "1px solid #1e293b";
      box.style.borderRadius = "12px";
      box.style.padding = "16px";

      var f1 = el("label", "gv-field");
      f1.appendChild(el("span", "", "API key de RAWG (gratis)"));
      var keyInput = el("input", "gv-input box");
      keyInput.type = "text";
      keyInput.placeholder = "Pega aquí tu key de rawg.io";
      keyInput.value = settings.rawgKey || "";
      f1.appendChild(keyInput);
      box.appendChild(f1);

      var actions = el("div", "gv-head");
      var save = el("button", "gv-btn gv-btn-primary", "Guardar");
      save.type = "button";
      save.addEventListener("click", function () {
        settings.rawgKey = keyInput.value.trim();
        api.storage.set("gv_settings", settings).then(function () {
          api.showToast("Ajustes guardados", "success");
        }).catch(function () {
          api.showToast("Error al guardar", "error");
        });
      });
      actions.appendChild(save);

      var test = el("button", "gv-btn", "Probar conexión");
      test.type = "button";
      var testOut = el("small", "", "");
      test.addEventListener("click", function () {
        var key = keyInput.value.trim();
        if (!key) { testOut.textContent = "Introduce una key primero."; testOut.style.color = "#fbbf24"; return; }
        test.disabled = true; testOut.textContent = "Probando…"; testOut.style.color = "";
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 15000);
        fetch(RAWG_BASE + "games?key=" + encodeURIComponent(key) + "&page_size=1", { signal: ctrl.signal })
          .then(function (res) {
            clearTimeout(timer);
            if (res.status === 401) throw new Error("key no válida");
            if (res.status === 429) throw new Error("límite alcanzado");
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (json) {
            testOut.textContent = "Conexión OK — RAWG respondió " + ((json.results || []).length ? "con resultados" : "correctamente") + ".";
            testOut.style.color = "#4ade80";
          })
          .catch(function (err) {
            clearTimeout(timer);
            testOut.textContent = "Fallo: " + (err.name === "AbortError" ? "timeout" : err.message) + ".";
            testOut.style.color = "#f87171";
          })
          .finally(function () { test.disabled = false; });
      });
      actions.appendChild(test);
      actions.appendChild(testOut);
      box.appendChild(actions);

      var help = el("div", "gv-help");
      help.innerHTML = "1. Crea una cuenta gratis en <a href=\"https://rawg.io/apidocs\" target=\"_blank\" rel=\"noopener\">rawg.io/apidocs</a> y consigue tu key.<br>" +
        "2. Pégala arriba y guarda. La key se queda en tu navegador y solo se envía a <code>api.rawg.io</code>.<br>" +
        "3. Sin key, GameVault sigue funcionando: añade juegos a mano (con imagen por URL) y gestiona sus fuentes.<br>" +
        "Límite del plan gratis: 20.000 peticiones/mes — GameVault solo llama a RAWG al buscar y al añadir.";
      box.appendChild(help);
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
                      name: String(x.name).slice(0, 120), imageUrl: x.imageUrl || "",
                      rating: x.rating != null ? x.rating : null, metacritic: x.metacritic != null ? x.metacritic : null,
                      released: x.released || "", genres: Array.isArray(x.genres) ? x.genres : [],
                      platforms: Array.isArray(x.platforms) ? x.platforms : [], website: x.website || "",
                      description: x.description || "", screenshots: Array.isArray(x.screenshots) ? x.screenshots : [],
                      rawgId: x.rawgId != null ? String(x.rawgId) : null, rawgUrl: x.rawgUrl || "",
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
    }).catch(function () {});
  }

  IndexLy.register({
    setup: function (ctx) {
      api = ctx;
      ensureStyles();
      ensureGames(function () {});
      ctx.addSection({ id: "gamevault", label: "GameVault", render: renderPage });
      // Botón en los resultados de búsqueda de IndexLy: añade el título a la vault
      // con ese item como primera fuente (si RAWG tiene key, lo enriquece luego).
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
