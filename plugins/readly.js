/* IndexLy Plugin
   id: readly
   name: ReadLy
    version: 1.6.0
   description: Tu biblioteca de libros dentro de IndexLy: añade tus EPUB, PDF y TXT, léalos en un lector a pantalla completa con temas, índice de capítulos y progreso guardado por página. La carátula se extrae del propio EPUB; ficha automática de Google Books como complemento. Todo local.
   permissions: network, ui, storage
*/
(function () {
  var api = null;
  var booksCache = null;
  var pageRoot = null;
  var renderSeq = 0;

  var state = {
    view: "library",      // library | detail
    bookId: null,
    libQuery: "",
    statusFilter: "all",
  };

  var STATUSES = [
    { id: "reading", label: "Leyendo", color: "#0ea5e9" },
    { id: "todo", label: "Pendiente", color: "#94a3b8" },
    { id: "done", label: "Terminado", color: "#22c55e" },
    { id: "dropped", label: "Abandonado", color: "#f87171" },
  ];
  var THEMES = ["sepia", "light", "dark"];

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
    return "linear-gradient(160deg, hsl(" + h + " 45% 30%) 0%, hsl(" + ((h + 40) % 360) + " 55% 18%) 100%)";
  }

  function normStr(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var m = String(iso).match(/^(\d{4})/);
    return m ? m[1] : String(iso);
  }

  function statusOf(id) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === id) return STATUSES[i];
    return STATUSES[1];
  }

  function kindOf(fileName) {
    var lower = String(fileName || "").toLowerCase();
    if (/\.epub$/.test(lower)) return "epub";
    if (/\.pdf$/.test(lower)) return "pdf";
    if (/\.txt$/.test(lower)) return "txt";
    return null;
  }

  // "Autor - Título (2020).epub" / "Título.epub" → { title, author? , year? }
  function parseFileName(name) {
    var base = String(name || "").replace(/\.(epub|pdf|txt)$/i, "").replace(/[_]+/g, " ").trim();
    var year = null;
    var ym = base.match(/\((19|20)\d{2}\)/);
    if (ym) year = ym[0].replace(/[()]/g, "");
    base = base.replace(/\((19|20)\d{2}\)/, " ").replace(/\[[^\]]*\]/g, " ").replace(/\s{2,}/g, " ").trim();
    var author = null, title = base;
    var sep = base.indexOf(" - ");
    if (sep > 0) { author = base.slice(0, sep).trim(); title = base.slice(sep + 3).trim(); }
    return { title: title || base, author: author, year: year };
  }

  function esc(s) { return String(s == null ? "" : s); }

  // ---------- almacenamiento ----------
  // MUTEX de escritura: ctx.storage.set hace read-modify-write del almacén completo.
  // Al añadir varios ficheros a la vez, dos escrituras en paralelo se pisaban
  // (la última ganaba y el blob del otro libro desaparecía). Cola de promesas.
  var writeQueue = Promise.resolve();
  function serialized(fnWrite) {
    var next = writeQueue.then(fnWrite, fnWrite);
    writeQueue = next.catch(function () {});
    return next;
  }
  function storageSet(key, value) { return serialized(function () { return api.storage.set(key, value); }); }
  function storageRemove(key) { return serialized(function () { return api.storage.remove(key); }); }

  function ensureBooks(cb) {
    if (booksCache) { cb(); return; }
    api.storage.get("lib_books").then(function (b) {
      booksCache = Array.isArray(b) ? b : [];
      cb();
    }).catch(function () { booksCache = []; cb(); });
  }

  // Reconstruye los objectURL de portadas embebidas tras recargar la página
  // (el Blob vive en IndexedDB; el objectURL muere con la sesión)
  function loadCovers(done) {
    var pending = 0;
    var started = false;
    (booksCache || []).forEach(function (b) {
      if (b.kind !== "epub" || coverUrls[b.id]) return;
      started = true;
      pending++;
      api.storage.get("book_cover_" + b.id).then(function (blob) {
        if (blob && !coverUrls[b.id]) coverUrls[b.id] = URL.createObjectURL(blob);
        pending--;
        if (pending === 0 && done) done();
      }).catch(function () { pending--; if (pending === 0 && done) done(); });
    });
    if (!started && done) done();
  }

  function saveBooks() { return storageSet("lib_books", booksCache || []); }

  function findBook(id) { return (booksCache || []).find(function (b) { return b.id === id; }) || null; }
  function currentBook() { return state.bookId ? findBook(state.bookId) : null; }
  function rerender() { if (pageRoot) renderPage(pageRoot); }

  // Los ficheros se guardan como Blob aparte: listar la biblioteca no los toca.
  function storeFile(id, blob) { return storageSet("book_file_" + id, blob); }
  function loadFile(id) { return api.storage.get("book_file_" + id); }

  // ---------- metadata: Google Books (sin clave) + OpenLibrary fallback ----------

  // Limpia la query antes de buscar: quita ruido típico de nombres de fichero que
  // rompe la relevancia de Google ("1984 George Orwell Calibre 2.90 [Orwell]-azw3" etc.)
  function cleanQuery(title) {
    var t = String(title || "");
    t = t
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\((?:[^)]*(?:calibre|convert|pdf|epub|mobi|azw|retail|fixed|v\d)[^)]*)\)/gi, " ")
      .replace(/\b(?:calibre|converted?|retail|fixed|edition|[a-z]{1,2}[- ]?book|ebook)\b/gi, " ")
      .replace(/\bv\.?\s?\d+(?:\.\d+)*\b/gi, " ") // versiones v2, v2.3
      .replace(/\b\d{1,2}[.,]\d{1,2}\b/g, " ") // versiones tipo 2.90
      .replace(/[-–—_|]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    // Años sueltos ("(1980)", "1984 George Orwell") — PERO nunca si el título ES el año
    // ("1984" de Orwell se queda) ni si al quitarlos no queda nada útil
    var stripped = t
      .replace(/\(\s*(?:19|20)\d{2}\s*\)/g, " ")
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (stripped.length >= 3) t = stripped;
    return t;
  }

  function normalizeTitle(s) {
    return normStr(s).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }

  function metaFromGoogle(query, author, tryNoAuthorFallback) {
    var clean = cleanQuery(query);
    var qs = new URLSearchParams({ q: clean, maxResults: "8", printType: "books" });
    if (author) qs.set("inauthor", author);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 12000);
    return fetch("https://www.googleapis.com/books/v1/volumes?" + qs.toString(), { signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error("Google Books " + r.status); return r.json(); })
      .then(function (j) {
        var items = (j && j.items || []).map(function (x) { return x && x.volumeInfo; }).filter(Boolean);
        if (!items.length) {
          // Reintento sin "inauthor:" (autor mal parseado excluye resultados)
          if (author && tryNoAuthorFallback !== false) return metaFromGoogle(clean, null, false);
          return null;
          }
        // Elige el mejor match, no el primero: exacto > empieza > contiene (y con cover)
        var nt = normalizeTitle(clean);
        var ranked = items.map(function (it) {
          var nTitle = normalizeTitle(it.title || "");
          var rank = -1;
          if (nTitle === nt) rank = 0;
          else if (nTitle.indexOf(nt) === 0 || nt.indexOf(nTitle) === 0) rank = 1;
          else if (nTitle.indexOf(nt) >= 0 || nt.indexOf(nTitle.split(" ")[0] || "~~~") >= 0) rank = 2;
          else rank = 3;
          return { it: it, rank: rank };
        });
        ranked.sort(function (a, b) {
          return a.rank - b.rank
            || (b.it.ratingsCount || 0) - (a.it.ratingsCount || 0) // popularidad como desempate
            || (b.it.imageLinks ? 1 : 0) - (a.it.imageLinks ? 1 : 0);
        });
        // Sin nada que se parezca al título: mejor sin ficha que una ficha errónea
        if (ranked[0].rank >= 3) {
          if (author && tryNoAuthorFallback !== false) return metaFromGoogle(clean, null, false);
          return null;
        }
        var it = ranked[0].it;
        if (!it) return null;
        return {
          title: it.title || "", author: (it.authors && it.authors[0]) || "",
          year: (it.publishedDate || "").slice(0, 4), pages: it.pageCount || null,
          publisher: it.publisher || "", description: it.description || "",
          cover: (it.imageLinks && (it.imageLinks.thumbnail || it.imageLinks.smallThumbnail || "").replace(/^http:/, "https:")) || "",
        };
      })
      .catch(function () { clearTimeout(timer); return null; });
  }

  function metaFromOpenLibrary(title, author) {
    var qs = new URLSearchParams({ title: title, limit: "5" });
    if (author) qs.set("author", author);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 12000);
    return fetch("https://openlibrary.org/search.json?" + qs.toString(), { signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error("OpenLibrary " + r.status); return r.json(); })
      .then(function (j) {
        var d = j && Array.isArray(j.docs) && j.docs[0];
        if (!d) return null;
        return {
          title: d.title || "", author: (d.author_name && d.author_name[0]) || "",
          year: d.first_publish_year ? String(d.first_publish_year) : "",
          pages: d.number_of_pages_median || null,
          publisher: (d.publisher && d.publisher[0]) || "",
          description: "",
          cover: d.cover_i ? ("https://covers.openlibrary.org/b/id/" + d.cover_i + "-M.jpg") : "",
        };
      })
      .catch(function () { clearTimeout(timer); return null; });
  }

  var metaSeq = 0; // invalida búsquedas de ficha obsoletas

  // Candidatas ordenadas: Google primero (puntuado), OpenLibrary detrás, dedup
  function metaCandidates(title, author) {
    var clean = cleanQuery(title);
    return Promise.all([
      metaFromGoogle(clean, author || null),
      metaFromOpenLibrary(clean, author || null),
    ]).then(function (res) {
      var all = [];
      if (res[0]) all.push(res[0]);
      if (res[1]) all.push(res[1]);
      var seen = {};
      var out = [];
      all.forEach(function (m) {
        var k = normalizeTitle(m.title) + "|" + normalizeTitle(m.author);
        if (!seen[k]) { seen[k] = 1; out.push(m); }
      });
      return out;
    });
  }

  function metaSearch(title, author) {
    return metaCandidates(title, author).then(function (cands) { return cands[0] || null; });
  }

  // ---------- portada embebida del EPUB (fuente primaria de carátula) ----------
  // Un EPUB es un ZIP: container.xml → OPF → item de cover → imagen como Blob.
  // Casi todos los EPUB la traen: así la carátula es siempre la correcta y offline.

  var coverUrls = {}; // bookId -> objectURL de la portada embebida (cache de render)

  function coverFor(book) {
    if (coverUrls[book.id]) return coverUrls[book.id];
    return book.cover || "";
  }

  function setCoverBlob(id, blob) {
    try { if (coverUrls[id]) URL.revokeObjectURL(coverUrls[id]); } catch {}
    coverUrls[id] = URL.createObjectURL(blob);
    return storageSet("book_cover_" + id, blob);
  }

  function extractCoverFromEpub(buf) {
    return ensureJsZip().then(function () {
      return window.JSZip.loadAsync(buf);
    }).then(function (zip) {
      var containerFile = zip.file("META-INF/container.xml");
      if (!containerFile) return null;
      return containerFile.async("text").then(function (xml) {
        var doc = new DOMParser().parseFromString(xml, "application/xml");
        var root = doc.querySelector("rootfile");
        var opfPath = root && root.getAttribute("full-path");
        if (!opfPath) return null;
        var opfFile = zip.file(opfPath);
        if (!opfFile) return null;
        return opfFile.async("text").then(function (opf) {
          var opfDoc = new DOMParser().parseFromString(opf, "application/xml");
          var manifest = opfDoc.querySelector("manifest");
          if (!manifest) return null;
          var opfDir = opfPath.indexOf("/") >= 0 ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
          // 1) meta name="cover" (EPUB2) · 2) properties="cover-image" (EPUB3) · 3) heurística
          var href = null;
          var meta = opfDoc.querySelector('meta[name="cover"]');
          if (meta) {
            var coverId = meta.getAttribute("content");
            var byId = manifest.querySelector('item[id="' + coverId + '"]');
            if (byId) href = byId.getAttribute("href");
          }
          if (!href) {
            var prop = manifest.querySelector('item[properties~="cover-image"]');
            if (prop) href = prop.getAttribute("href");
          }
          if (!href) {
            var imgs = Array.prototype.slice.call(manifest.querySelectorAll('item[media-type^="image/"]'));
            var cand = imgs.find(function (i) { return /cover/i.test((i.getAttribute("id") || "") + " " + (i.getAttribute("href") || "")); });
            if (cand) href = cand.getAttribute("href");
          }
          if (!href) return null;
          // resolver href relativo a la carpeta del OPF (../ y subdirectorios)
          var parts = (opfDir + href).split("/");
          var stack = [];
          parts.forEach(function (p) {
            if (p === "." || p === "") return;
            if (p === "..") stack.pop();
            else stack.push(p);
          });
          var f = zip.file(stack.join("/")) || zip.file(href);
          if (!f) return null;
          return f.async("blob");
        });
      });
    }).catch(function () { return null; });
  }

  // ---------- vista: biblioteca ----------

  function ensureStyles() {
    if (document.getElementById("lib-styles")) return;
    var s = document.createElement("style");
    s.id = "lib-styles";
    s.textContent = [
      ".lib-badge-vault{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;color:#c4b5fd;background:rgba(167,139,250,0.10);border:1px solid rgba(167,139,250,0.25);border-radius:999px;padding:2px 8px;margin-top:6px;width:max-content}",
      ".lib-page{display:flex;flex-direction:column;gap:14px}",
      ".lib-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".lib-head h4{margin:0;font-size:16px;font-weight:700;color:#f1f5f9;letter-spacing:-0.01em}",
      ".lib-head small{font-size:11px;color:#64748b}",
      ".lib-spacer{flex:1}",
      ".lib-btn{background:transparent;border:1px solid #1e293b;border-radius:999px;color:#94a3b8;padding:7px 12px;font-size:11.5px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap}",
      ".lib-btn:hover{background:#152033;color:#e2e8f0;border-color:#24344f}",
      ".lib-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".lib-btn-primary{background:#fff;border-color:#fff;color:#0f172a}",
      ".lib-btn-primary:hover{background:#f1f5f9;color:#0f172a}",
      ".lib-btn-danger{color:#f87171;border-color:rgba(248,113,113,0.3)}",
      ".lib-btn-danger:hover{background:rgba(248,113,113,0.08);color:#fca5a5;border-color:rgba(248,113,113,0.4)}",
      ".lib-btn-subtle{opacity:.55}",
      ".lib-btn-subtle:hover{opacity:1}",
      ".lib-imp-list{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto;margin:8px 0}",
      ".lib-imp-row{display:flex;gap:8px;align-items:center;font-size:12px;color:#cbd5e1;border:1px solid #1e293b;border-radius:8px;padding:6px 10px;background:#070a12}",
      ".lib-imp-row small{color:#64748b}",
      ".lib-imp-new{color:#22c55e;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.05em;flex-shrink:0}",
      ".lib-imp-dup{color:#f59e0b;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.05em;flex-shrink:0}",
      ".lib-chip{background:transparent;border:1px solid #1e293b;border-radius:999px;color:#94a3b8;padding:5px 11px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s}",
      ".lib-chip:hover{color:#e2e8f0;background:rgba(255,255,255,0.04)}",
      ".lib-chip.active{background:#fff;border-color:#fff;color:#0f172a;font-weight:600}",
      ".lib-input{background:#070a12;border:1px solid #1e293b;border-radius:999px;padding:9px 14px;color:#e2e8f0;font-size:12.5px;outline:none;min-width:0}",
      ".lib-input:focus{border-color:#24344f;box-shadow:0 0 0 3px rgba(14,165,233,0.08)}",
      ".lib-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:12px;overflow:auto}",
      ".lib-card{background:#070a12;border:1px solid #1e293b;border-radius:12px;overflow:hidden;cursor:pointer;transition:border-color .18s,transform .18s,box-shadow .18s;display:flex;flex-direction:column}",
      ".lib-card:hover{border-color:rgba(167,139,250,0.45);transform:translateY(-3px) scale(1.015);box-shadow:0 10px 26px rgba(0,0,0,0.4)}",
      ".lib-poster-wrap{position:relative;overflow:hidden;background:#0d1528}",
      ".lib-poster{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;transition:transform .25s ease}",
      ".lib-card:hover .lib-poster{transform:scale(1.05)}",
      ".lib-poster-ph{width:100%;aspect-ratio:2/3;display:grid;place-items:center;font-size:30px;font-weight:700;color:rgba(255,255,255,0.55);text-shadow:0 2px 8px rgba(0,0,0,0.4)}",
      ".lib-badge-overlay{position:absolute;top:8px;left:8px;z-index:1;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}",
      ".lib-progress-bar{position:absolute;left:0;bottom:0;height:3px;background:#a78bfa;z-index:1;transition:width .3s}",
      ".lib-kind{position:absolute;right:8px;top:8px;z-index:1;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:rgba(255,255,255,0.85);background:rgba(7,10,18,0.55);border:1px solid rgba(255,255,255,0.15);border-radius:999px;padding:2px 7px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}",
      // Overlay «Leer / Ficha / ✕» al hover sobre el poster
      ".lib-hover-read{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:linear-gradient(180deg,rgba(7,10,18,0.15),rgba(7,10,18,0.72));opacity:0;transition:opacity .18s ease}",
      ".lib-card:hover .lib-hover-read,.lib-hover-read:focus-within{opacity:1}",
      ".lib-hover-actions{display:flex;flex-direction:column;gap:7px;align-items:center}",
      ".lib-hover-read button{background:#fff;border:none;color:#0f172a;border-radius:999px;padding:8px 18px;font-size:12px;font-weight:700;cursor:pointer;transform:translateY(6px);transition:transform .18s ease,box-shadow .18s ease;box-shadow:0 6px 18px rgba(0,0,0,0.35);font-family:inherit}",
      ".lib-hover-read button.lib-sec{background:rgba(7,10,18,0.72);color:#e2e8f0;border:1px solid rgba(255,255,255,0.2)}",
      ".lib-card:hover .lib-hover-read button{transform:translateY(0)}",
      ".lib-hover-read button:hover{box-shadow:0 8px 24px rgba(0,0,0,0.5)}",
      ".lib-hover-del{position:absolute;top:8px;right:8px;z-index:3;width:26px;height:26px;display:grid;place-items:center;background:rgba(7,10,18,0.72);border:1px solid rgba(248,113,113,0.45);color:#fca5a5;border-radius:999px;font-size:11px;cursor:pointer;opacity:0;transition:opacity .18s,background .15s;font-family:inherit}",
      ".lib-card:hover .lib-hover-del{opacity:1}",
      ".lib-hover-del:hover{background:rgba(239,68,68,0.25);color:#fff}",
      // Al hacer hover, los badges (estado/formato) se apartan para que el ✕ y los botones respiren
      ".lib-badge-overlay,.lib-kind{transition:opacity .15s ease}",
      ".lib-card:hover .lib-badge-overlay,.lib-card:hover .lib-kind{opacity:0}",
      "@media (hover:none){.lib-hover-read{display:none}.lib-hover-del{display:none}}",
      ".lib-card-body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:3px}",
      ".lib-card-name{font-size:12px;font-weight:600;color:#e2e8f0;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".lib-card-meta{font-size:10.5px;color:#64748b;display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
      ".lib-badge{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;padding:2px 8px;border-radius:999px;border:1px solid;width:max-content}",
      ".lib-tag{font-size:10px;font-weight:500;padding:3px 9px;border:1px solid #1e293b;border-radius:999px;color:#94a3b8;background:#0f141e}",
      ".lib-desc{font-size:12.5px;color:#cbd5e1;line-height:1.65;white-space:pre-wrap;max-height:200px;overflow:auto;background:#070a12;border:1px solid #1e293b;border-radius:10px;padding:12px 14px}",
      ".lib-src-row{display:flex;align-items:center;gap:10px;border:1px solid #1e293b;background:#070a12;border-radius:10px;padding:8px 12px}",
      ".lib-src-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}",
      ".lib-src-info strong{font-size:12px;color:#e2e8f0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".lib-src-info small{font-size:10.5px;color:#64748b}",
      ".lib-res-row{display:flex;gap:10px;align-items:center;border:1px solid #1e293b;border-radius:10px;padding:8px;background:#070a12}",
      ".lib-res-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".lib-res-info strong{font-size:12.5px;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".lib-res-info small{font-size:10.5px;color:#64748b}",
      ".lib-empty{margin:auto;text-align:center;color:#64748b;font-size:12.5px;line-height:1.7;padding:26px 10px;max-width:46ch}",
      ".lib-note{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:rgba(167,139,250,0.07);border:1px solid rgba(167,139,250,0.25);border-radius:12px;padding:12px 14px;font-size:12px;color:#c4b5fd}",
      // Lector overlay
      ".lib-reader{position:fixed;inset:0;z-index:90;background:#070a12;display:flex;flex-direction:column}",
      ".lib-reader-top{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #1e293b;background:#0a0f1c;flex-shrink:0}",
      ".lib-reader-top h4{margin:0;font-size:13px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}",
      ".lib-reader-top small{font-size:11px;color:#64748b;white-space:nowrap}",
      ".lib-reader-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
      ".lib-tools-toggle{opacity:.6;padding:7px 10px;font-weight:400;letter-spacing:.1em}",
      ".lib-tools-toggle:hover{opacity:1}",
      ".lib-reader.lib-tools-hidden .lib-reader-tools{display:none}",
      ".lib-reader-body{flex:1;min-height:0;position:relative;overflow:hidden}",
      ".lib-reader-view{position:absolute;inset:0;touch-action:pan-y;will-change:transform}",
      ".lib-swipe-anim{transition:transform .24s cubic-bezier(.2,.7,.3,1)}",
      ".lib-swipe-drag{cursor:grabbing}",
      "@media (prefers-reduced-motion:reduce){.lib-swipe-anim{transition:none}}",
      ".lib-reader-bottom{display:flex;align-items:center;gap:12px;padding:8px 16px;border-top:1px solid #1e293b;background:#0a0f1c;flex-shrink:0}",
      ".lib-track{flex:1;height:4px;border-radius:999px;background:#141b29;overflow:hidden}",
      ".lib-track span{display:block;height:100%;background:#a78bfa;border-radius:999px;transition:width .2s}",
      ".lib-toc{position:absolute;right:0;top:0;bottom:0;width:260px;background:#0a0f1c;border-left:1px solid #1e293b;overflow:auto;z-index:5;padding:12px;display:none;flex-direction:column;gap:4px}",
      ".lib-toc.open{display:flex}",
      ".lib-toc button{background:transparent;border:none;color:#94a3b8;text-align:left;font-size:12px;padding:6px 8px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}",
      ".lib-toc button:hover{background:#152033;color:#e2e8f0}",
      ".lib-toc-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;padding:2px 8px 6px}",
      // Móvil: flechas flotantes + tocar en los bordes para pasar página
      ".lib-tapzone{position:absolute;top:12%;bottom:8%;width:22%;z-index:3;display:none}",
      ".lib-tapzone-left{left:0}",
      ".lib-tapzone-right{right:0}",
      ".lib-nav-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:4;width:34px;height:52px;display:none;align-items:center;justify-content:center;background:rgba(7,10,18,0.4);border:1px solid rgba(255,255,255,0.12);color:#cbd5e1;border-radius:10px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);font-size:18px;line-height:1;cursor:pointer;opacity:0.75;transition:opacity .15s,background .15s;font-family:inherit;padding:0}",
      ".lib-nav-arrow:active{background:rgba(14,165,233,0.35);opacity:1}",
      ".lib-nav-left{left:6px}",
      ".lib-nav-right{right:6px}",
      ".lib-nav-off .lib-nav-arrow,.lib-nav-off .lib-tapzone,.lib-nav-off .lib-hide-nav{display:none!important}",
      ".lib-hide-nav{display:none!important}",
      ".lib-reader.is-touch .lib-hide-nav{display:inline-flex!important}",
      "@media (max-width:640px){.lib-hide-nav{display:inline-flex!important}}",
      "@media (max-width:640px){.lib-tapzone{display:block}.lib-nav-arrow{display:flex}}",
      "@media (hover:none) and (pointer:coarse){.lib-tapzone{display:block}.lib-nav-arrow{display:flex}.lib-hide-nav{display:inline-flex!important}}",
      ".lib-reader.is-touch .lib-tapzone{display:block}",
      ".lib-reader.is-touch .lib-nav-arrow{display:flex}",
      ".lib-reader.lib-nav-hidden .lib-tapzone{top:0;bottom:0;width:30%}",
      ".lib-pdfframe{width:100%;height:100%;border:0;background:#14161c}",
      "@keyframes libFadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}",
      ".lib-detail{display:flex;flex-direction:column;gap:16px;animation:libFadeUp .35s ease both}",
      ".lib-detail-nav{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".lib-hero{display:flex;gap:18px;align-items:flex-start;background:linear-gradient(180deg,rgba(167,139,250,0.07),rgba(167,139,250,0.02));border:1px solid #1e293b;border-radius:18px;padding:18px;position:relative;overflow:hidden}",
      ".lib-hero::before{content:'';position:absolute;inset:0;background:radial-gradient(420px 160px at 12% 0%,rgba(167,139,250,0.12),transparent 70%);pointer-events:none}",
      ".lib-cover{width:128px;flex-shrink:0;border-radius:12px;overflow:hidden;background:#0d1528;box-shadow:0 12px 30px rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.08);position:relative;z-index:1}",
      ".lib-hero-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;position:relative;z-index:1}",
      ".lib-title-xl{font-size:20px;font-weight:800;color:#f8fafc;letter-spacing:-0.02em;line-height:1.25;margin:0}",
      ".lib-author{font-size:13px;color:#94a3b8;font-weight:500}",
      ".lib-meta-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
      ".lib-progress{height:6px;border-radius:999px;background:#141b29;overflow:hidden;width:100%;max-width:300px}",
      ".lib-progress i{display:block;height:100%;background:linear-gradient(90deg,#a78bfa,#7c6cf0);border-radius:999px;transition:width .4s ease}",
      ".lib-progress-lbl{font-size:11.5px;color:#a78bfa;font-weight:600}",
      ".lib-status-row{display:flex;gap:8px;flex-wrap:wrap}",
      ".lib-card-sec{background:#0a0f1c;border:1px solid #1e293b;border-radius:14px;padding:14px 16px;transition:border-color .2s}",
      ".lib-card-sec:hover{border-color:#24344f}",
      ".lib-sec-h{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:#64748b;margin:0 0 10px}",
      ".lib-sec-h small{color:#475569;text-transform:none;letter-spacing:0;font-weight:500}",
      ".lib-desc-smooth{font-size:13px;color:#cbd5e1;line-height:1.75;white-space:pre-wrap;max-height:240px;overflow:auto;margin:0;scrollbar-width:thin}",
      ".lib-detail-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;opacity:0.92}",
      ".lib-read-cta{font-size:13px!important;padding:10px 20px!important}",
      "@media (max-width:640px){.lib-hero{flex-direction:row;padding:14px;gap:14px}.lib-cover{width:96px}.lib-title-xl{font-size:17px}}",
      // Móvil: barras compactas, grid más denso, tap targets grandes, TOC ancho
      "@media (max-width:640px){" +
        ".lib-grid{grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px}" +
        ".lib-toc{width:84%}" +
        ".lib-reader-top{padding:8px 10px;gap:8px}" +
        ".lib-reader-top h4{font-size:12px}" +
        ".lib-reader-top small{display:none}" +
        ".lib-reader-bottom{padding:8px 10px;gap:8px}" +
        ".lib-reader .lib-btn{padding:9px 12px;font-size:12px}" +
        ".lib-reader .lib-btn:active{background:#1e2a44;color:#fff}" +
        ".lib-toc button{padding:11px 10px;font-size:13px}" +
      "}",
    ].join("\n");
    document.head.appendChild(s);
  }

  function posterFor(book) {
    // Prioridad: portada embebida del fichero (objectURL cacheado) → cover de API → placeholder
    var embedded = coverFor(book);
    if (embedded) {
      var img0 = document.createElement("img");
      img0.className = "lib-poster";
      img0.src = embedded;
      img0.alt = "";
      img0.addEventListener("error", function () { img0.replaceWith(posterPh(book)); });
      return img0;
    }
    if (book.cover) {
      var img = document.createElement("img");
      img.className = "lib-poster";
      img.src = book.cover;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", function () { img.replaceWith(posterPh(book)); });
      return img;
    }
    return posterPh(book);
  }
  function posterPh(book) {
    var ph = el("div", "lib-poster-ph", (book.title || "?").charAt(0).toUpperCase());
    ph.style.background = gradientFor(book.title);
    return ph;
  }
  function statusBadge(statusId) {
    var st = statusOf(statusId);
    var b = el("span", "lib-badge", st.label);
    b.style.color = st.color;
    b.style.borderColor = st.color + "44";
    b.style.background = st.color + "14";
    return b;
  }

  function pct(book) {
    return Math.max(0, Math.min(100, Math.round((book.progress && book.progress.percentage || 0) * 100)));
  }

  function renderPage(root) {
    ensureStyles();
    pageRoot = root;
    root.innerHTML = "";
    var seq = ++renderSeq;
    ensureBooks(function () {
      if (seq !== renderSeq) return;
      // Reconstruye los objectURL de portadas (tras recargar la página estaban muertos)
      loadCovers(function () {
        if (seq !== renderSeq) return;
        var page = el("div", "lib-page");
        root.appendChild(page);
        if (state.view === "detail") renderDetail(page);
        else renderLibrary(page);
      });
    });
  }

  function go(view) { state.view = view; rerender(); }

  function renderLibrary(page) {
    var books = booksCache || [];
    headerBar(page, "ReadLy", books.length === 1 ? "1 libro" : books.length + " libros", [
      { label: "⤓ Exportar", subtle: true, disabled: !books.length, onClick: exportLibrary },
      { label: "⤒ Importar", subtle: true, onClick: importLibrary },
      { label: "＋ Añadir libros", primary: true, onClick: openAddDialog },
    ]);

    var tools = el("div", "lib-head");
    var input = el("input", "lib-input");
    input.type = "text";
    input.placeholder = "Buscar en tu biblioteca…";
    input.value = state.libQuery;
    input.style.flex = "1 1 160px";
    input.addEventListener("input", function () { state.libQuery = input.value; fillList(); });
    tools.appendChild(input);
    page.appendChild(tools);

    var chips = el("div", "lib-head");
    var mk = function (id, label, count) {
      var c = el("button", "lib-chip" + (state.statusFilter === id ? " active" : ""), label + (count != null ? " · " + count : ""));
      c.type = "button";
      c.addEventListener("click", function () { state.statusFilter = id; rerender(); });
      return c;
    };
    chips.appendChild(mk("all", "Todos", books.length));
    STATUSES.forEach(function (st) {
      var n = books.filter(function (b) { return (b.status || "todo") === st.id; }).length;
      chips.appendChild(mk(st.id, st.label, n));
    });
    page.appendChild(chips);

    var listWrap = el("div", "lib-grid");
    page.appendChild(listWrap);

    function fillList() {
      listWrap.innerHTML = "";
      var q = normStr(state.libQuery);
      var list = books.filter(function (b) {
        if (state.statusFilter !== "all" && (b.status || "todo") !== state.statusFilter) return false;
        if (q && normStr(b.title + " " + (b.author || "")).indexOf(q) < 0) return false;
        return true;
      });
      list.sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
      if (!list.length) {
        var empty = el("div", "lib-empty");
        empty.style.gridColumn = "1/-1";
        empty.innerHTML = books.length ? "Nada coincide con el filtro." : "Tu biblioteca está vacía.<br>Añade tus EPUB, PDF o TXT y se guardan aquí (en tu navegador).";
        listWrap.appendChild(empty);
        return;
      }
      list.forEach(function (b) {
        var card = el("div", "lib-card");
        var wrap = el("div", "lib-poster-wrap");
        wrap.appendChild(posterFor(b));
        var badge = statusBadge(b.status || "todo");
        badge.classList.add("lib-badge-overlay");
        badge.style.background = "rgba(7,10,18,0.62)";
        wrap.appendChild(badge);
        wrap.appendChild(el("span", "lib-kind", b.kind || ""));
        if (b.kind === "epub" && pct(b) > 0) {
          var bar = el("span");
          bar.style.cssText = "position:absolute;left:0;bottom:0;height:3px;background:#a78bfa;z-index:1;width:" + pct(b) + "%";
          wrap.appendChild(bar);
        }
        // Overlay «Leer» + «Ficha» al hover; ✕ borrar arriba a la derecha
        var hover = el("div", "lib-hover-read");
        var hoverActions = el("div", "lib-hover-actions");
        var readBtn = el("button", "", b.kind === "epub" && pct(b) > 0 ? "Continuar" : "Leer");
        readBtn.type = "button";
        readBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          openReader(b);
        });
        hoverActions.appendChild(readBtn);
        var infoBtn = el("button", "lib-sec", "Ficha");
        infoBtn.type = "button";
        infoBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          state.bookId = b.id;
          go("detail");
        });
        hoverActions.appendChild(infoBtn);
        hover.appendChild(hoverActions);
        var delBtn = el("button", "lib-hover-del", "✕");
        delBtn.type = "button";
        delBtn.title = "Eliminar " + (b.title || "libro");
        delBtn.setAttribute("aria-label", "Eliminar " + (b.title || "libro"));
        delBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          confirmDeleteBook(b);
        });
        wrap.appendChild(hover);
        wrap.appendChild(delBtn);
        card.appendChild(wrap);
        var body = el("div", "lib-card-body");
        body.appendChild(el("div", "lib-card-name", b.title || "Sin título"));
        var meta = el("div", "lib-card-meta");
        var bits = [];
        if (b.author) bits.push(b.author);
        if (b.kind === "epub" && pct(b) > 0) bits.push(pct(b) + "%");
        if (bits.length) meta.appendChild(el("span", "", bits.join(" · ")));
        if (meta.children.length) body.appendChild(meta);
        card.appendChild(body);
        card.addEventListener("click", function () {
          state.bookId = b.id;
          go("detail");
        });
        listWrap.appendChild(card);
      });
    }
    fillList();
  }

  function headerBar(page, title, count, actions) {
    var head = el("div", "lib-head");
    head.appendChild(el("h4", "", title));
    if (count != null) head.appendChild(el("small", "", count));
    head.appendChild(el("span", "lib-spacer"));
    (actions || []).forEach(function (a) {
      var b = el("button", "lib-btn" + (a.primary ? " lib-btn-primary" : "") + (a.danger ? " lib-btn-danger" : "") + (a.subtle ? " lib-btn-subtle" : ""), a.label);
      b.type = "button";
      if (a.disabled) b.disabled = true;
      else b.addEventListener("click", a.onClick);
      head.appendChild(b);
    });
    page.appendChild(head);
  }

  // ---------- añadir libros ----------

  function openAddDialog() {
    var fi = document.createElement("input");
    fi.type = "file";
    fi.accept = ".epub,.pdf,.txt,application/epub+zip,application/pdf,text/plain";
    fi.multiple = true;
    // En iOS el input debe estar en el DOM para que el picker se abra de forma fiable
    fi.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
    fi.setAttribute("aria-hidden", "true");
    document.body.appendChild(fi);
    fi.addEventListener("change", function () {
      var files = Array.prototype.slice.call(fi.files || []);
      try { fi.remove(); } catch (e) { if (fi.parentNode) fi.parentNode.removeChild(fi); }
      if (!files.length) return;
      files.forEach(function (f) { addBookFile(f); });
    });
    // Si el usuario cancela, limpia el input huérfano
    fi.addEventListener("cancel", function () {
      setTimeout(function () { try { fi.remove(); } catch (e) {} }, 500);
    });
    try { fi.click(); } catch (e) {
      try { fi.remove(); } catch (_e) {}
      api.showToast("Tu navegador bloqueó el selector de ficheros. Toca de nuevo «Añadir libros».", "warning", 5000);
    }
  }

  function addBookFile(file) {
    var kind = kindOf(file.name);
    if (!kind) { api.showToast("Formato no soportado: " + file.name + " (usa EPUB, PDF o TXT)", "warning", 5000); return; }
    var parsed = parseFileName(file.name);
    var id = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    var rec = {
      id: id,
      kind: kind,
      fileName: file.name,
      title: parsed.title,
      author: parsed.author || "",
      year: parsed.year || "",
      pages: null, publisher: "", description: "", cover: "",
      status: "todo",
      addedAt: Date.now(),
      progress: null, // { cfi, percentage, chapter, updatedAt } — solo EPUB
      sources: [],
    };
    blobToArrayBuffer(file).then(function (buf) {
      return storeFile(id, new Blob([buf])).then(function () { return buf; });
    }).then(function (buf) {
      booksCache.push(rec);
      saveBooks();
      api.showToast("«" + rec.title + "» añadido", "success");
      // Portada embebida del EPUB (fuente primaria: siempre correcta y offline)
      if (kind === "epub") {
        return extractCoverFromEpub(buf).then(function (coverBlob) {
          if (!coverBlob) return;
          return setCoverBlob(id, coverBlob).then(function () {
            if (state.view === "library" && pageRoot) rerender();
          });
        }).catch(function () {});
      }
    }).then(function () {
      // Ficha automática (autor, año, descripción…) en segundo plano;
      // la carátula de la API solo cubre si el EPUB no traía la suya (posterFor prioriza la embebida)
      enrichBook(rec, parsed);
      if (state.view === "library") rerender();
    }).catch(function (err) {
      api.showToast("No se pudo guardar " + file.name + ": " + err.message, "error", 5000);
    });
  }

  function enrichBook(rec, parsed) {
    metaSearch(rec.title, parsed.author || rec.author).then(function (m) {
      var cur = findBook(rec.id);
      if (!cur || !m) return;
      var changed = false;
      if (m.cover && !cur.cover) { cur.cover = m.cover; changed = true; }
      if (m.author && !cur.author) { cur.author = m.author; changed = true; }
      if (m.year && !cur.year) { cur.year = m.year; changed = true; }
      if (m.pages && !cur.pages) { cur.pages = m.pages; changed = true; }
      if (m.publisher && !cur.publisher) { cur.publisher = m.publisher; changed = true; }
      if (m.description && !cur.description) { cur.description = m.description; changed = true; }
      if (changed) {
        saveBooks();
        if (state.view === "library" && pageRoot) rerender();
      }
    }).catch(function () {});
  }

  function confirmDeleteBook(b) {
    api.modal({
      title: "Eliminar libro",
      html: "<p>¿Eliminar <strong>" + esc(b.title) + "</strong> de ReadLy? También se borra el fichero guardado y tu progreso de lectura.</p>",
      actions: [
        { label: "Cancelar" },
        { label: "Eliminar", danger: true, onClick: function () {
          booksCache = booksCache.filter(function (x) { return x.id !== b.id; });
          saveBooks();
          storageRemove("book_file_" + b.id).catch(function () {});
          storageRemove("book_cover_" + b.id).catch(function () {});
          try { if (coverUrls[b.id]) { URL.revokeObjectURL(coverUrls[b.id]); delete coverUrls[b.id]; } } catch {}
          api.showToast("Libro eliminado", "info");
          go("library");
        } },
      ],
    });
  }

  // ---------- vista: ficha ----------

  function renderDetail(page) {
    var b = currentBook();
    if (!b) { go("library"); return; }
    var wrap = el("div", "lib-detail");
    page.appendChild(wrap);

    // Barra superior mínima: volver discreto + acción principal
    var nav = el("div", "lib-detail-nav");
    var back = el("button", "lib-btn", "← Biblioteca");
    back.type = "button";
    back.addEventListener("click", function () { go("library"); });
    nav.appendChild(back);
    nav.appendChild(el("span", "lib-spacer"));
    var readCta = el("button", "lib-btn lib-btn-primary lib-read-cta", b.kind === "epub" && pct(b) > 0 ? "Continuar · " + pct(b) + "%" : "Leer ahora");
    readCta.type = "button";
    readCta.addEventListener("click", function () { openReader(b); });
    nav.appendChild(readCta);
    wrap.appendChild(nav);

    // Hero: portada + título + meta + progreso + estados
    var hero = el("div", "lib-hero");
    var coverWrap = el("div", "lib-cover");
    coverWrap.appendChild(posterFor(b));
    hero.appendChild(coverWrap);
    var info = el("div", "lib-hero-info");
    var titleEl = el("h2", "lib-title-xl", b.title || "Sin título");
    info.appendChild(titleEl);
    if (b.author) info.appendChild(el("div", "lib-author", b.author));
    var meta = el("div", "lib-meta-row");
    if (b.year) meta.appendChild(el("span", "lib-tag", b.year));
    if (b.pages) meta.appendChild(el("span", "lib-tag", b.pages + " págs."));
    if (b.publisher) meta.appendChild(el("span", "lib-tag", b.publisher));
    meta.appendChild(el("span", "lib-tag", (b.kind || "").toUpperCase()));
    if (meta.children.length) info.appendChild(meta);
    if (b.kind === "epub" && b.progress && pct(b) > 0) {
      var track = el("div", "lib-progress");
      var fillEl = el("i");
      fillEl.style.width = pct(b) + "%";
      track.appendChild(fillEl);
      info.appendChild(track);
      var pl = el("div", "lib-progress-lbl", pct(b) + "%" + (b.progress.page ? " · " + b.progress.page : "") + (b.progress.chapter ? " · " + b.progress.chapter : ""));
      info.appendChild(pl);
    }
    var stRow = el("div", "lib-status-row");
    STATUSES.forEach(function (st) {
      var c = el("button", "lib-chip" + ((b.status || "todo") === st.id ? " active" : ""), st.label);
      c.type = "button";
      c.addEventListener("click", function () { b.status = st.id; saveBooks(); rerender(); });
      stRow.appendChild(c);
    });
    info.appendChild(stRow);
    hero.appendChild(info);
    wrap.appendChild(hero);

    // Sinopsis
    if (b.description) {
      var descCard = el("div", "lib-card-sec");
      descCard.appendChild(el("h5", "lib-sec-h", "Sinopsis"));
      descCard.appendChild(el("p", "lib-desc-smooth", b.description));
      wrap.appendChild(descCard);
    }

    // Fuentes enlazadas
    var srcCard = el("div", "lib-card-sec");
    var srcHead = el("div", "lib-detail-nav");
    srcHead.style.marginBottom = "10px";
    var srcTitle = el("h5", "lib-sec-h", "Fuentes enlazadas");
    srcTitle.style.margin = "0";
    srcHead.appendChild(srcTitle);
    var srcCount = el("small", "", (b.sources || []).length === 1 ? "1 enlace" : (b.sources || []).length + " enlaces");
    srcCount.style.cssText = "color:#475569;font-size:11px";
    srcHead.appendChild(srcCount);
    srcHead.appendChild(el("span", "lib-spacer"));
    var addSrc = el("button", "lib-btn", "＋ Enlazar");
    addSrc.type = "button";
    addSrc.addEventListener("click", function () { openSourcePicker(b); });
    srcHead.appendChild(addSrc);
    srcCard.appendChild(srcHead);
    if ((b.sources || []).length) {
      b.sources.forEach(function (s) {
        var row = el("div", "lib-src-row");
        row.style.marginBottom = "8px";
        var sInfo = el("div", "lib-src-info");
        sInfo.appendChild(el("strong", "", s.itemTitle || "Sin título"));
        sInfo.appendChild(el("small", "", s.sourceName || "Fuente"));
        row.appendChild(sInfo);
        if (s.itemLink) {
          var dl = el("button", "lib-btn", "Abrir ↗");
          dl.type = "button";
          dl.addEventListener("click", function () { api.openLink(s.itemLink); });
          row.appendChild(dl);
        }
        var rm = el("button", "lib-btn lib-btn-danger", "Quitar");
        rm.type = "button";
        rm.addEventListener("click", function () {
          b.sources = (b.sources || []).filter(function (x) { return x !== s; });
          saveBooks();
          rerender();
        });
        row.appendChild(rm);
        srcCard.appendChild(row);
      });
    } else {
      var none = el("div", "", "Sin fuentes enlazadas. Conecta la descarga original del Hub para tenerla a mano.");
      none.style.cssText = "font-size:12px;color:#64748b;line-height:1.6";
      srcCard.appendChild(none);
    }
    wrap.appendChild(srcCard);

    // Gestión secundaria, discreta
    var mgmt = el("div", "lib-detail-actions");
    var metaBtn = el("button", "lib-btn", "Buscar ficha");
    metaBtn.type = "button";
    metaBtn.addEventListener("click", function () { openMetaSearch(b); });
    mgmt.appendChild(metaBtn);
    var exp = el("button", "lib-btn", "Exportar");
    exp.type = "button";
    exp.addEventListener("click", exportLibrary);
    mgmt.appendChild(exp);
    var imp = el("button", "lib-btn", "Importar");
    imp.type = "button";
    imp.addEventListener("click", importLibrary);
    mgmt.appendChild(imp);
    mgmt.appendChild(el("span", "lib-spacer"));
    var del = el("button", "lib-btn lib-btn-danger", "Eliminar");
    del.type = "button";
    del.addEventListener("click", function () { confirmDeleteBook(b); });
    mgmt.appendChild(del);
    wrap.appendChild(mgmt);
  }

  // Búsqueda de ficha (Google Books + OpenLibrary) con candidatas elegibles
  function openMetaSearch(b) {
    api.modal({
      title: "Buscar ficha para «" + b.title + "»",
      html: '<div style="display:flex;flex-direction:column;gap:10px">' +
        '<label style="display:flex;flex-direction:column;gap:6px;font-size:11px;color:#94a3b8">Título<input id="lib-s-title" class="lib-input" style="width:100%;border-radius:10px" value="' + esc(b.title).replace(/"/g, "&quot;") + '" /></label>' +
        '<label style="display:flex;flex-direction:column;gap:6px;font-size:11px;color:#94a3b8">Autor (opcional)<input id="lib-s-author" class="lib-input" style="width:100%;border-radius:10px" value="' + esc(b.author).replace(/"/g, "&quot;") + '" /></label>' +
        '<div id="lib-s-list" style="display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto"><p style="margin:0;font-size:11.5px;color:#64748b">Buscando…</p></div></div>',
      actions: [{ label: "Cerrar" }],
    });
    function run() {
      var t = ((document.getElementById("lib-s-title") || {}).value || "").trim();
      var a = ((document.getElementById("lib-s-author") || {}).value || "").trim();
      var list = document.getElementById("lib-s-list");
      if (!list) return; // modal cerrado
      var mySeq = ++metaSeq;
      if (!t) { list.innerHTML = '<p style="margin:0;font-size:11.5px;color:#64748b">Escribe un título.</p>'; return; }
      list.innerHTML = '<p style="margin:0;font-size:11.5px;color:#64748b">Buscando…</p>';
      metaCandidates(t, a).then(function (cands) {
        if (mySeq !== metaSeq) return; // búsqueda obsoleta
        list.innerHTML = "";
        if (!cands.length) {
          list.innerHTML = '<p style="margin:0;font-size:11.5px;color:#64748b">Sin coincidencias en Google Books ni OpenLibrary. Prueba a ajustar título/autor.</p>';
          return;
        }
        cands.slice(0, 6).forEach(function (m) {
          var row = el("div", "lib-res-row");
          if (m.cover) {
            var img = document.createElement("img");
            img.src = m.cover; img.alt = ""; img.loading = "lazy";
            img.style.cssText = "width:42px;height:60px;object-fit:cover;border-radius:6px;background:#0d1528;flex-shrink:0";
            row.appendChild(img);
          } else {
            var ph = el("div");
            ph.style.cssText = "width:42px;height:60px;border-radius:6px;display:grid;place-items:center;font-weight:700;color:rgba(255,255,255,0.5);flex-shrink:0";
            ph.style.background = gradientFor(m.title);
            ph.textContent = (m.title || "?").charAt(0).toUpperCase();
            row.appendChild(ph);
          }
          var info = el("div", "lib-res-info");
          info.appendChild(el("strong", "", m.title || "?"));
          var bits = [];
          if (m.author) bits.push(m.author);
          if (m.year) bits.push(m.year);
          if (m.publisher) bits.push(m.publisher);
          info.appendChild(el("small", "", bits.join(" · ") || "—"));
          row.appendChild(info);
          var apply = el("button", "lib-btn lib-btn-primary", "Aplicar");
          apply.type = "button";
          apply.addEventListener("click", function () {
            var cur = findBook(b.id);
            if (!cur) return;
            if (m.cover) cur.cover = m.cover;
            if (m.author) cur.author = m.author;
            if (m.year) cur.year = m.year;
            if (m.pages) cur.pages = m.pages;
            if (m.publisher) cur.publisher = m.publisher;
            if (m.description) cur.description = m.description;
            saveBooks();
            if (typeof window.closePluginModal === "function") window.closePluginModal();
            rerender();
          });
          row.appendChild(apply);
          list.appendChild(row);
        });
      }).catch(function () {
        if (mySeq === metaSeq) list.innerHTML = '<p style="margin:0;font-size:11.5px;color:#f87171">Error de red al buscar.</p>';
      });
    }
    run();
    var st = document.getElementById("lib-s-title");
    var sa = document.getElementById("lib-s-author");
    if (st) st.addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
    if (sa) sa.addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
    if (st) st.addEventListener("input", api.debounce(run, 500));
    if (sa) sa.addEventListener("input", api.debounce(run, 500));
  }

  // ---------- fuentes enlazadas (picker sobre los índices del usuario) ----------

  function openSourcePicker(book) {
    var indexes = api.getIndexes();
    if (!indexes.length) { api.showToast("Importa fuentes en IndexLy primero", "warning"); return; }
    var query = "";
    var idxId = null;
    api.modal({
      title: "Enlazar fuentes — " + book.title,
      html: '<div style="display:flex;flex-direction:column;gap:10px">' +
        '<input id="lib-p-q" class="lib-input" style="width:100%;border-radius:10px" placeholder="Buscar en mis fuentes…" />' +
        '<select id="lib-p-idx" class="lib-input" style="width:100%;border-radius:10px">' +
        '<option value="">Todas las fuentes</option>' +
        indexes.map(function (ix) { return '<option value="' + esc(ix.id) + '">' + esc(ix.name) + "</option>"; }).join("") +
        '</select><div id="lib-p-list" style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto"></div>' +
        '<p id="lib-p-out" style="margin:0;font-size:11.5px;color:#64748b"></p></div>',
      actions: [
        { label: "Cancelar" },
        { label: "Listo", primary: true, onClick: function (bodyEl) {
          var added = window.__libPicked ? Object.keys(window.__libPicked).length : 0;
          var book2 = findBook(book.id);
          if (book2 && window.__libPicked) {
            Object.keys(window.__libPicked).forEach(function (k) {
              var s = window.__libPicked[k];
              var dup = (book2.sources || []).some(function (x) { return x.itemLink && x.itemLink === s.itemLink; });
              if (!dup) { book2.sources = book2.sources || []; book2.sources.push(s); }
            });
            saveBooks();
          }
          window.__libPicked = null;
          api.showToast(added === 1 ? "1 fuente enlazada" : added + " fuentes enlazadas", "success");
          rerender();
        } },
      ],
    });
    window.__libPicked = {};
    var qEl = document.getElementById("lib-p-q");
    var idxEl = document.getElementById("lib-p-idx");
    var listEl = document.getElementById("lib-p-list");
    var outEl = document.getElementById("lib-p-out");
    function updateOut() {
      var n = Object.keys(window.__libPicked).length;
      outEl.textContent = n === 0 ? "" : (n === 1 ? "1 seleccionada — se guardará con «Listo»" : n + " seleccionadas");
    }
    function fill() {
      listEl.innerHTML = "";
      var nq = normStr(query);
      var total = 0;
      indexes.forEach(function (ix) {
        if (idxId && ix.id !== idxId) return;
        (ix.games || []).forEach(function (g) {
          if (nq && normStr(g.title).indexOf(nq) < 0) return;
          total++;
          var s = { indexId: ix.id, sourceName: ix.name, itemTitle: g.title || "", itemLink: g.link || "" };
          var key = s.indexId + "|" + s.itemLink + "|" + s.itemTitle;
          var row = el("div", "lib-res-row");
          var info = el("div", "lib-res-info");
          info.appendChild(el("strong", "", s.itemTitle));
          info.appendChild(el("small", "", s.sourceName));
          row.appendChild(info);
          var btn = el("button", "lib-btn" + (window.__libPicked[key] ? " lib-btn-primary" : ""), window.__libPicked[key] ? "✓" : "＋");
          btn.type = "button";
          btn.addEventListener("click", function () {
            if (window.__libPicked[key]) { delete window.__libPicked[key]; btn.textContent = "＋"; btn.classList.remove("lib-btn-primary"); }
            else { window.__libPicked[key] = s; btn.textContent = "✓"; btn.classList.add("lib-btn-primary"); }
            updateOut();
          });
          row.appendChild(btn);
          listEl.appendChild(row);
        });
      });
      if (!total) listEl.innerHTML = '<p class="lib-empty" style="padding:10px">Nada coincide.</p>';
      updateOut();
    }
    qEl.addEventListener("input", function () { query = qEl.value; fill(); });
    idxEl.addEventListener("change", function () { idxId = idxEl.value || null; fill(); });
    fill();
  }

  // ---------- export / import total (metadatos + progreso; los ficheros se re-suben) ----------

  function exportLibrary() {
    var books = booksCache || [];
    if (!books.length) { api.showToast("Nada que exportar: la biblioteca está vacía", "warning"); return; }
    var data = JSON.stringify({ app: "indexly-readly", version: 2, exportedAt: new Date().toISOString(), count: books.length, books: books }, null, 2);
    var blob = new Blob([data], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "readly-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    api.showToast(books.length === 1 ? "1 libro exportado" : books.length + " libros exportados", "success");
  }

  function bookKey(b) { return normStr(b.title) + "|" + normStr(b.author || ""); }

  // Sanea un registro importado y conserva ajustes + progreso; devuelve null si no es válido
  function sanitizeImportedBook(x) {
    if (!x || typeof x.title !== "string" || !x.title.trim()) return null;
    return {
      kind: (x.kind === "pdf" || x.kind === "txt") ? x.kind : "epub",
      fileName: typeof x.fileName === "string" && x.fileName ? x.fileName : String(x.title).slice(0, 200) + ".epub",
      title: String(x.title).slice(0, 200),
      author: typeof x.author === "string" ? x.author.slice(0, 200) : "",
      year: typeof x.year === "string" ? x.year.slice(0, 4) : "",
      pages: typeof x.pages === "number" ? x.pages : null,
      publisher: typeof x.publisher === "string" ? x.publisher.slice(0, 200) : "",
      description: typeof x.description === "string" ? x.description.slice(0, 8000) : "",
      cover: typeof x.cover === "string" ? x.cover.slice(0, 2000) : "",
      status: STATUSES.some(function (s) { return s.id === x.status; }) ? x.status : "todo",
      addedAt: typeof x.addedAt === "number" ? x.addedAt : Date.now(),
      progress: (x.progress && typeof x.progress === "object") ? x.progress : null,
      sources: Array.isArray(x.sources) ? x.sources.filter(function (s) { return s && typeof s.itemTitle === "string"; }).slice(0, 50) : [],
      theme: THEMES.indexOf(x.theme) >= 0 ? x.theme : undefined,
      fontSize: (typeof x.fontSize === "number" && x.fontSize >= 80 && x.fontSize <= 220) ? x.fontSize : undefined,
      spread: (x.spread === "auto" || x.spread === "none") ? x.spread : undefined,
      hideNav: typeof x.hideNav === "boolean" ? x.hideNav : undefined,
    };
  }

  function applyImportedFields(target, clean) {
    ["kind", "fileName", "title", "author", "year", "pages", "publisher", "description",
     "cover", "status", "addedAt", "progress", "sources"].forEach(function (k) { target[k] = clean[k]; });
    if (clean.theme !== undefined) target.theme = clean.theme;
    if (clean.fontSize !== undefined) target.fontSize = clean.fontSize;
    if (clean.spread !== undefined) target.spread = clean.spread;
    if (clean.hideNav !== undefined) target.hideNav = clean.hideNav;
  }

  function importLibrary() {
    var fi = document.createElement("input");
    fi.type = "file";
    fi.accept = ".json,application/json";
    fi.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(fi);
    fi.addEventListener("change", function () {
      var f = fi.files && fi.files[0];
      try { fi.remove(); } catch (e) { if (fi.parentNode) fi.parentNode.removeChild(fi); }
      if (!f) return;
      blobToText(f).then(function (txt) {
        var parsed;
        try { parsed = JSON.parse(txt); } catch (e) { throw new Error("El archivo no es un JSON válido"); }
        var list = Array.isArray(parsed) ? parsed : parsed.books;
        if (!Array.isArray(list)) throw new Error("El archivo no contiene una biblioteca (books[])");
        var clean = list.map(sanitizeImportedBook).filter(Boolean);
        if (!clean.length) throw new Error("El archivo no contiene libros válidos");
        var fresh = [];
        var dups = [];
        clean.forEach(function (x) {
          var hit = (booksCache || []).filter(function (b) { return bookKey(b) === bookKey(x); });
          if (hit.length) dups.push({ incoming: x, existing: hit[0] });
          else fresh.push(x);
        });
        function doMerge() {
          fresh.forEach(function (x) {
            var rec = { id: "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) };
            applyImportedFields(rec, x);
            booksCache.push(rec);
          });
          saveBooks();
          api.showToast(fresh.length === 1 ? "1 libro importado (se conservó el resto)" : fresh.length + " libros importados (se conservó el resto)", "success");
          go("library");
        }
        function doOverwrite() {
          dups.forEach(function (d) { applyImportedFields(d.existing, d.incoming); });
          fresh.forEach(function (x) {
            var rec = { id: "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) };
            applyImportedFields(rec, x);
            booksCache.push(rec);
          });
          saveBooks();
          api.showToast("Biblioteca importada: " + fresh.length + " nuevos, " + dups.length + " actualizados", "success");
          go("library");
        }
        // Resumen visual: nuevos frente a duplicados
        var rows = clean.slice(0, 30).map(function (x) {
          var isDup = dups.some(function (d) { return d.incoming === x; });
          return '<div class="lib-imp-row"><span class="' + (isDup ? "lib-imp-dup" : "lib-imp-new") + '">' +
            (isDup ? "Existe" : "Nuevo") + '</span><span>' + esc(x.title).slice(0, 80) +
            (x.author ? ' <small>· ' + esc(x.author).slice(0, 60) + "</small>" : "") + "</span></div>";
        }).join("");
        if (clean.length > 30) rows += '<p style="margin:4px 0 0;font-size:11px;color:#64748b">…y ' + (clean.length - 30) + " más.</p>";
        var note = "<p style=\"margin:8px 0 0;font-size:11.5px;color:#64748b\">El backup guarda libros, ajustes y progreso de lectura. Los ficheros (EPUB/PDF/TXT) hay que volver a añadirlos.</p>";
        if (!dups.length) {
          api.modal({
            title: "Importar biblioteca",
            html: "<p>" + fresh.length + (fresh.length === 1 ? " libro nuevo" : " libros nuevos") + ", ninguno duplicado. ¿Continuar?</p><div class=\"lib-imp-list\">" + rows + "</div>" + note,
            actions: [
              { label: "Cancelar" },
              { label: "Importar", primary: true, onClick: doMerge },
            ],
          });
        } else {
          // Hay solape: preguntar antes de sobreescribir nada
          api.modal({
            title: "Importar con duplicados",
            html: "<p><strong>" + dups.length + "</strong> " + (dups.length === 1 ? "ya existe en tu biblioteca" : "ya existen en tu biblioteca") +
              " y <strong>" + fresh.length + "</strong> " + (fresh.length === 1 ? "es nuevo" : "son nuevos") +
              ". ¿Qué hago con " + (dups.length === 1 ? "el duplicado" : "los duplicados") + "?</p><div class=\"lib-imp-list\">" + rows + "</div>" + note,
            actions: [
              { label: "Cancelar" },
              { label: fresh.length ? ("Añadir solo nuevos (" + fresh.length + ")") : "Conservar los míos", primary: true, onClick: function () {
                if (!fresh.length) { api.showToast("Sin cambios: se conservaron tus libros", "info"); return; }
                doMerge();
              } },
              { label: "Sobreescribir duplicados", danger: true, onClick: function () {
                // Segunda confirmación: la sobreescritura no se puede deshacer
                api.modal({
                  title: "¿Sobreescribir?",
                  html: "<p>Se reemplazarán los datos de <strong>" + dups.length + "</strong> " +
                    (dups.length === 1 ? "libro (ficha, ajustes y progreso)" : "libros (ficha, ajustes y progreso)") +
                    " con los del archivo. Tus ficheros guardados se conservan. Esta acción no se puede deshacer.</p>",
                  actions: [
                    { label: "Volver" },
                    { label: "Sí, sobreescribir", danger: true, onClick: doOverwrite },
                  ],
                });
              } },
            ],
          });
        }
      }).catch(function (err) { api.showToast("No se pudo importar: " + (err && err.message || err), "error", 5000); });
    });
    try { fi.click(); } catch (e) {
      try { fi.remove(); } catch (_e) {}
    }
  }

  // ---------- lector ----------

  var epubJsPromise = null; // carga perezosa de epub.js desde CDN
  function loadScript(src, fallbackMsg) {
    return new Promise(function (resolve, reject) {
      var sc = document.createElement("script");
      sc.src = src;
      sc.onload = function () { resolve(); };
      sc.onerror = function () { epubJsPromise = null; reject(new Error(fallbackMsg || ("Sin conexión: no se pudo cargar " + src.split("/").pop()))); };
      document.head.appendChild(sc);
    });
  }
  var jsZipPromise = null;
  function ensureJsZip() {
    if (window.JSZip) return Promise.resolve();
    if (jsZipPromise) return jsZipPromise;
    jsZipPromise = loadScript("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js", "Sin conexión: no se pudo descargar JSZip (solo la primera vez)")
      .then(function () { if (!window.JSZip) throw new Error("JSZip no se inicializó"); })
      .catch(function (err) { jsZipPromise = null; throw err; });
    return jsZipPromise;
  }
  function loadEpubJs() {
    // epub.js necesita JSZip como global ANTES de cargarse (su bundle no lo incluye)
    if (window.ePub && window.JSZip) return Promise.resolve();
    if (epubJsPromise) return epubJsPromise;
    epubJsPromise = ensureJsZip()
      .then(function () {
        return loadScript("https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js", "Sin conexión: no se pudo descargar el lector EPUB (solo la primera vez)");
      })
      .then(function () {
        if (!window.ePub || !window.JSZip) throw new Error("El lector EPUB no se inicializó correctamente");
      })
      .catch(function (err) { epubJsPromise = null; throw err; });
    return epubJsPromise;
  }

  var reader = null; // estado del lector abierto { overlay, rendition, bookId, kind, save }

  function closeReader() {
    if (!reader) return;
    var wasBookId = reader.bookId;
    if (reader.swipeDetach) { try { reader.swipeDetach(); } catch (e) { /* noop */ } }
    // Guarda el progreso final antes de destruir nada (el debounce puede perderlo)
    if (reader.lastProgress) {
      var cur = findBook(wasBookId);
      if (cur) { cur.progress = reader.lastProgress; cur.status = cur.status === "todo" ? "reading" : cur.status; saveBooks(); }
    }
    if (reader.keyHandler) document.removeEventListener("keydown", reader.keyHandler);
    if (reader.escHandler) document.removeEventListener("keydown", reader.escHandler);
    if (reader.resizeHandler) {
      window.removeEventListener("resize", reader.resizeHandler);
      window.removeEventListener("orientationchange", reader.resizeHandler);
    }
    try { if (reader.rendition) reader.rendition.destroy(); } catch {}
    try { if (reader.book) reader.book.destroy(); } catch {}
    if (reader.url) { try { URL.revokeObjectURL(reader.url); } catch {} }
    if (reader.overlay && reader.overlay.parentNode) reader.overlay.parentNode.removeChild(reader.overlay);
    reader = null;
    // Refresca la vista de debajo: el % nuevo debe verse en card/ficha al volver
    rerender();
  }

  function openReader(book) {
    loadFile(book.id).then(function (blob) {
      if (!blob) { api.showToast("No encuentro el fichero de este libro (¿import de metadatos?). Vuelve a añadirlo.", "error", 6000); return; }
      if (book.kind === "epub") openEpubReader(book, blob);
      else openSimpleReader(book, blob);
    }).catch(function (err) {
      api.showToast("No se pudo abrir: " + err.message, "error", 5000);
    });
  }

  function isTouchDevice() {
    try {
      if (typeof window !== "undefined" && window.matchMedia) {
        if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) return true;
        if (window.matchMedia("(hover: none)").matches && ("ontouchstart" in window || (navigator && navigator.maxTouchPoints > 0))) return true;
      }
      if (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0 && ("ontouchstart" in window)) return true;
    } catch {}
    return false;
  }

  function blobToArrayBuffer(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      try {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(fr.error || new Error("No se pudo leer el fichero")); };
        fr.readAsArrayBuffer(blob);
      } catch (e) { reject(e); }
    });
  }

  function blobToText(blob) {
    if (blob.text) return blob.text();
    return new Promise(function (resolve, reject) {
      try {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || "")); };
        fr.onerror = function () { reject(fr.error || new Error("No se pudo leer el fichero")); };
        fr.readAsText(blob);
      } catch (e) { reject(e); }
    });
  }

  function buildOverlay(book, onReady, opts) {
    var overlay = el("div", "lib-reader");
    if (isTouchDevice()) overlay.classList.add("is-touch");
    if (opts && opts.noNav) overlay.classList.add("lib-nav-off");
    var top = el("div", "lib-reader-top");
    var close = el("button", "lib-btn", "✕");
    close.type = "button";
    close.addEventListener("click", closeReader);
    top.appendChild(close);
    var title = el("h4", "", book.title || "Lectura");
    top.appendChild(title);
    var info = el("small", "", "");
    top.appendChild(info);
    top.appendChild(el("span", "lib-spacer"));
    var tools = el("div", "lib-reader-tools");
    // Botón sutil para ocultar/mostrar el panel de ajustes (temas, letra, páginas, índice)
    var toolsToggle = el("button", "lib-btn lib-tools-toggle", "···");
    toolsToggle.type = "button";
    toolsToggle.title = "Mostrar u ocultar ajustes";
    toolsToggle.setAttribute("aria-label", "Mostrar u ocultar el panel de ajustes");
    top.appendChild(toolsToggle);
    // Opción móvil para quitar/poner las flechas de movimiento (persistente por libro)
    var hideNav = el("button", "lib-btn lib-hide-nav", "Sin flechas");
    hideNav.type = "button";
    hideNav.title = "Quitar o mostrar las flechas de página";
    hideNav.setAttribute("aria-label", "Quitar o mostrar las flechas de página");
    top.appendChild(hideNav);
    top.appendChild(tools);
      var body = el("div", "lib-reader-body");
      // Móvil: tapzones de borde + flechas flotantes (solo EPUB; en PDF/TXT el overlay lleva lib-nav-off)
      var tapL = el("div", "lib-tapzone lib-tapzone-left");
      var tapR = el("div", "lib-tapzone lib-tapzone-right");
      var arrL = el("button", "lib-nav-arrow lib-nav-left", "‹");
      arrL.type = "button";
      arrL.setAttribute("aria-label", "Página anterior");
      var arrR = el("button", "lib-nav-arrow lib-nav-right", "›");
      arrR.type = "button";
      arrR.setAttribute("aria-label", "Página siguiente");
      body.appendChild(tapL); body.appendChild(tapR); body.appendChild(arrL); body.appendChild(arrR);
      overlay.appendChild(top);
      overlay.appendChild(body);
    var bottom = el("div", "lib-reader-bottom");
    var track = el("div", "lib-track");
    var fill = el("span");
    fill.style.width = "0%";
    track.appendChild(fill);
    bottom.appendChild(track);
    var pctLbl = el("small", "", "0%");
    pctLbl.style.cssText = "color:#94a3b8;min-width:38px;text-align:right";
    bottom.appendChild(pctLbl);
    var pageLbl = el("small", "", "");
    pageLbl.style.cssText = "color:#64748b;min-width:78px;text-align:right;white-space:nowrap";
    bottom.appendChild(pageLbl);
    overlay.appendChild(bottom);
    document.body.appendChild(overlay);
    var escHandler = function (e) { if (e.key === "Escape") { e.preventDefault(); closeReader(); } };
    document.addEventListener("keydown", escHandler);
    // Navegación por teclado del lector: la rendition activa está en reader.rendition
    var keyHandler = function (e) {
      if (!reader || !reader.rendition) return;
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); reader.rendition.next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); reader.rendition.prev(); }
    };
    document.addEventListener("keydown", keyHandler);
    reader = { overlay: overlay, top: top, tools: tools, toolsToggle: toolsToggle, info: info, body: body, fill: fill, pctLbl: pctLbl, pageLbl: pageLbl, bookId: book.id, escHandler: escHandler, keyHandler: keyHandler, url: null, lastProgress: null, updateFromLocation: null, locationsReady: false, tapL: tapL, tapR: tapR, arrL: arrL, arrR: arrR, hideNav: hideNav, navHidden: !!book.hideNav, toolsHidden: false };
    // Panel de ajustes colapsable (persistente global); en táctil empieza oculto para dejar sitio a la lectura
    try {
      var storedTools = localStorage.getItem("readly_tools_hidden");
      reader.toolsHidden = storedTools == null ? isTouchDevice() : storedTools === "1";
    } catch (e) { reader.toolsHidden = isTouchDevice(); }
    (function paintTools() {
      overlay.classList.toggle("lib-tools-hidden", !!reader.toolsHidden);
      toolsToggle.style.opacity = reader.toolsHidden ? ".45" : ".95";
      toolsToggle.title = reader.toolsHidden ? "Mostrar ajustes" : "Ocultar ajustes";
    })();
    reader.paintTools = function () {
      overlay.classList.toggle("lib-tools-hidden", !!reader.toolsHidden);
      toolsToggle.style.opacity = reader.toolsHidden ? ".45" : ".95";
      toolsToggle.title = reader.toolsHidden ? "Mostrar ajustes" : "Ocultar ajustes";
    };
    toolsToggle.addEventListener("click", function () {
      reader.toolsHidden = !reader.toolsHidden;
      try { localStorage.setItem("readly_tools_hidden", reader.toolsHidden ? "1" : "0"); } catch (e) {}
      reader.paintTools();
    });
    // Flechas de movimiento: quitar/poner (persistente por libro). El toque en los
    // bordes para pasar página sigue activo aunque se oculten las flechas.
    reader.applyNavPref = function () {
      var hide = !!reader.navHidden;
      [tapL, tapR].forEach(function (n) { if (n) n.style.display = ""; });
      [arrL, arrR].forEach(function (n) { if (n) n.style.display = hide ? "none" : ""; });
      overlay.classList.toggle("lib-nav-hidden", hide);
      hideNav.textContent = hide ? "Con flechas" : "Sin flechas";
    };
    hideNav.addEventListener("click", function () {
      reader.navHidden = !reader.navHidden;
      reader.applyNavPref();
      var cur = findBook(book.id);
      if (cur) { cur.hideNav = reader.navHidden; saveBooks(); }
    });
    reader.applyNavPref();
    if (onReady) onReady(body);
    return { overlay: overlay, body: body, tools: tools, info: info, fill: fill, pctLbl: pctLbl };
  }

  function setProgress(percentage, label) {
    if (!reader) return;
    var p = Math.max(0, Math.min(100, Math.round((percentage || 0) * 100)));
    reader.fill.style.width = p + "%";
    reader.pctLbl.textContent = p + "%";
    if (label != null) reader.info.textContent = label;
  }

  function setPages(text) {
    if (reader && reader.pageLbl) reader.pageLbl.textContent = text || "";
  }

  function persistProgress(bookId, progress) {
    var cur = findBook(bookId);
    if (!cur) return;
    cur.progress = progress;
    cur.status = cur.status === "todo" ? "reading" : cur.status;
    saveBooks();
  }

  function openEpubReader(book, blob) {
    var ui = buildOverlay(book);
    setProgress(book.progress && book.progress.percentage || 0, "Cargando lector…");
    loadEpubJs().then(function () {
      return blobToArrayBuffer(blob);
    }).then(function (buf) {
      if (!reader || reader.bookId !== book.id) return; // se cerró mientras cargaba
      var epubBook = window.ePub(buf);
      reader.book = epubBook;
      reader.themeName = book.theme || "sepia";
      reader.fontSize = book.fontSize || 100;
      // Spread persistido; en pantallas estrechas, 1 página siempre es lo legible
      reader.spread = (window.innerWidth >= 700 && book.spread) ? book.spread : "none";

      // CRÍTICO: epub.js da percentage=0/undefined en relocated hasta que se
      // generan las locations del libro. Se generan en background y al terminar
      // se recalcula la posición actual (así el % es real y estable).
      reader.locationsReady = false;
      epubBook.ready.then(function () {
        return epubBook.locations.generate(1200);
      }).then(function () {
        if (!reader || reader.bookId !== book.id) return;
        reader.locationsReady = true;
        try {
          var loc = reader.rendition.currentLocation();
          if (loc && loc.start) reader.updateFromLocation(loc);
        } catch {}
      }).catch(function () {});

      var view = el("div", "lib-reader-view");
      reader.body.appendChild(view);

      // Handler central de posición: %, página y capítulo → UI + persistencia
      reader.updateFromLocation = function (location) {
        if (!reader || reader.bookId !== book.id || !location) return;
        var pctVal = null;
        if (location.end && typeof location.end.percentage === "number" && location.end.percentage > 0) pctVal = location.end.percentage;
        else if (location.start && typeof location.start.percentage === "number" && location.start.percentage > 0) pctVal = location.start.percentage;
        if ((pctVal == null) && reader.locationsReady && epubBook.locations && epubBook.locations.percentageFrom) {
          try {
            var fromCfi = epubBook.locations.percentageFrom(location.start.cfi);
            if (typeof fromCfi === "number" && !isNaN(fromCfi)) pctVal = fromCfi;
          } catch {}
        }
        var pageTxt = "";
        try {
          // Página global del libro: locations.length() = total de páginas lógicas
          if (reader.locationsReady && epubBook.locations && epubBook.locations.length && typeof pctVal === "number" && pctVal > 0) {
            var total = epubBook.locations.length();
            pageTxt = "Pág. " + Math.max(1, Math.round(pctVal * total)) + "/" + total;
          }
        } catch {}
        var chapter = "";
        try {
          var tocItems = epubBook.navigation && epubBook.navigation.toc;
          if (Array.isArray(tocItems)) {
            var href = (location.start && location.start.href) || "";
            var best = null;
            tocItems.forEach(function (t) { if (t.href && href && href.indexOf(t.href.split("/").pop()) >= 0) best = t.label && t.label.trim(); });
            if (best) chapter = best;
          }
        } catch {}
        setProgress(pctVal || 0, chapter);
        setPages(pageTxt);
        reader.lastProgress = {
          cfi: location.start.cfi,
          percentage: pctVal || 0,
          chapter: chapter,
          page: pageTxt,
          updatedAt: Date.now(),
        };
        if (reader.persistProgressSoon) reader.persistProgressSoon();
      };

      makeRendition(book, epubBook, view, book.progress && book.progress.cfi);

      // Temas (claro / sépia / oscuro) con estado activo visible
      var THEME_LABELS = { sepia: "Sépia", light: "Claro", dark: "Oscuro" };
      var themeBtns = {};
      THEMES.forEach(function (t) {
        var tb = el("button", "lib-btn" + (reader.themeName === t ? " lib-btn-primary" : ""), THEME_LABELS[t]);
        tb.type = "button";
        tb.addEventListener("click", function () { if (reader.applyTheme) reader.applyTheme(t); });
        themeBtns[t] = tb;
        ui.tools.appendChild(tb);
      });
      reader.markThemeBtns = function (name) {
        Object.keys(themeBtns).forEach(function (k) {
          themeBtns[k].classList.toggle("lib-btn-primary", k === name);
        });
      };
      reader.markThemeBtns(reader.themeName);
      var fsBtn = el("button", "lib-btn", "A −");
      fsBtn.type = "button";
      fsBtn.title = "Reducir letra";
      fsBtn.setAttribute("aria-label", "Reducir tamaño de letra");
      fsBtn.addEventListener("click", function () { if (reader.applyFontSize) reader.applyFontSize(-10); });
      var fsBtn2 = el("button", "lib-btn", "A +");
      fsBtn2.type = "button";
      fsBtn2.title = "Aumentar letra";
      fsBtn2.setAttribute("aria-label", "Aumentar tamaño de letra");
      fsBtn2.addEventListener("click", function () { if (reader.applyFontSize) reader.applyFontSize(10); });
      var fontLbl = el("small", "", (reader.fontSize || 100) + "%");
      fontLbl.style.cssText = "color:#64748b;min-width:42px;text-align:center";
      reader.fontLbl = fontLbl;
      ui.tools.appendChild(fsBtn);
      ui.tools.appendChild(fontLbl);
      ui.tools.appendChild(fsBtn2);

      // 1 o 2 páginas (spread)
      var one = el("button", "lib-btn" + (reader.spread === "none" ? " lib-btn-primary" : ""), "1 pág");
      var two = el("button", "lib-btn" + (reader.spread !== "none" ? " lib-btn-primary" : ""), "2 pág");
      one.type = "button"; two.type = "button";
      one.title = "Una página"; two.title = "Dos páginas";
      one.addEventListener("click", function () { setSpread(book, "none"); });
      two.addEventListener("click", function () { setSpread(book, "auto"); });
      ui.tools.appendChild(one);
      ui.tools.appendChild(two);
      reader.spreadBtns = function () {
        one.classList.toggle("lib-btn-primary", reader.spread === "none");
        two.classList.toggle("lib-btn-primary", reader.spread !== "none");
      };

      var tocBtn = el("button", "lib-btn", "Índice");
      tocBtn.type = "button";
      ui.tools.appendChild(tocBtn);

      var swipeBtn = el("button", "lib-btn" + (swipeOn(book) ? " lib-btn-primary" : ""), "Deslizar");
      swipeBtn.type = "button";
      swipeBtn.title = "Pasar página deslizando (dedo o ratón)";
      swipeBtn.setAttribute("aria-label", "Activar o desactivar el deslizamiento para pasar página");
      swipeBtn.addEventListener("click", function () {
        var cur = findBook(book.id);
        var on = !(cur ? swipeOn(cur) : swipeOn(book));
        reader.swipeOn = on;
        swipeBtn.classList.toggle("lib-btn-primary", on);
        if (cur) { cur.swipe = on; saveBooks(); }
      });
      ui.tools.appendChild(swipeBtn);

      // TOC
      var toc = el("div", "lib-toc");
      reader.body.appendChild(toc);
      tocBtn.addEventListener("click", function () { toc.classList.toggle("open"); });
      epubBook.loaded.navigation.then(function (nav) {
        (nav.toc || []).slice(0, 200).forEach(function (item) {
          var b = el("button", "", item.label && item.label.trim() ? item.label.trim() : "Capítulo");
          b.type = "button";
          b.addEventListener("click", function () {
            if (reader && reader.rendition) reader.rendition.display(item.href).catch(function () {});
            toc.classList.remove("open");
          });
          toc.appendChild(b);
        });
      }).catch(function () {});
      reader.toc = toc;
    }).catch(function (err) {
      api.showToast(err.message || "No se pudo abrir el EPUB", "error", 6000);
      closeReader();
    });
  }

  // Crea la rendition (y la re-crea al cambiar spread) conservando posición y tema
  function makeRendition(book, epubBook, view, startCFI) {
    // Safari/iOS: con width/height "100%" epub.js mide el contenedor como 0 y el
    // libro sale en blanco. Se mide en píxeles y se re-mide en resize/rotación.
    function size() {
      var r = reader && reader.body ? reader.body.getBoundingClientRect() : null;
      var w = r && r.width ? Math.floor(r.width) : window.innerWidth;
      var h = r && r.height ? Math.floor(r.height) : window.innerHeight - 110;
      return { w: Math.max(200, w), h: Math.max(200, h) };
    }
    var sz = size();
    var rendition = epubBook.renderTo(view, { width: sz.w, height: sz.h, flow: "paginated", spread: reader.spread || "none", allowScriptedContent: false });
    reader.rendition = rendition;
    reader.view = view;

    // Re-mide al girar el móvil o redimensionar la ventana (rotación incluida)
    var resizeHandler = function () {
      if (!reader || !reader.rendition) return;
      if (reader.swipeCancel) { try { reader.swipeCancel(); } catch (e) {} }
      var s2 = size();
      try { reader.rendition.resize(s2.w, s2.h); } catch {}
    };
    window.addEventListener("resize", resizeHandler);
    window.addEventListener("orientationchange", resizeHandler);
    reader.resizeHandler = resizeHandler;

    var THEME_BG = { light: "#faf9f5", sepia: "#f4ecd8", dark: "#0d1017" };
    var THEME_FG = { light: "#1a1a1a", sepia: "#3b3021", dark: "#c9d1d9" };
    function paintTheme(name) {
      try {
        rendition.themes.register(name, {
          body: { background: THEME_BG[name] + " !important", color: THEME_FG[name] + " !important" },
          "p, div, span, h1, h2, h3, h4, h5, h6, li, blockquote": { color: THEME_FG[name] + " !important" },
          "a, a *": { color: (name === "dark" ? "#a78bfa" : "#0e7490") + " !important" },
        });
      } catch (e) {
        rendition.themes.register(name, { body: { background: THEME_BG[name], color: THEME_FG[name] } });
      }
      rendition.themes.select(name);
      try { rendition.themes.override("background", THEME_BG[name], true); } catch (e) {}
      try { rendition.themes.override("color", THEME_FG[name], true); } catch (e) {}
    }
    ["light", "sepia", "dark"].forEach(function (t) { paintTheme(t); });
    paintTheme(reader.themeName || "sepia");
    rendition.themes.fontSize((reader.fontSize || 100) + "%");
    view.style.background = THEME_BG[reader.themeName] || THEME_BG.sepia;
    if (reader.markThemeBtns) reader.markThemeBtns(reader.themeName);

    function applyTheme(name) {
      if (THEMES.indexOf(name) < 0) return;
      reader.themeName = name;
      if (reader.rendition) paintTheme(name);
      if (reader.view) reader.view.style.background = THEME_BG[name] || THEME_BG.sepia;
      if (reader.markThemeBtns) reader.markThemeBtns(name);
      var cur = findBook(book.id);
      if (cur) { cur.theme = name; saveBooks(); }
    }
    reader.applyTheme = applyTheme;

    function applyFontSize(delta) {
      var next = Math.max(80, Math.min(220, (reader.fontSize || 100) + (typeof delta === "number" ? delta : 0)));
      reader.fontSize = next;
      if (reader.rendition) reader.rendition.themes.fontSize(next + "%");
      if (reader.fontLbl) reader.fontLbl.textContent = next + "%";
      var cur = findBook(book.id);
      if (cur) { cur.fontSize = next; saveBooks(); }
    }
    reader.applyFontSize = applyFontSize;

    // Debounce compartido de persistencia (usado desde reader.updateFromLocation)
    reader.persistTimer = null;
    reader.persistProgressSoon = function () {
      if (reader.persistTimer) clearTimeout(reader.persistTimer);
      reader.persistTimer = setTimeout(function () {
        if (reader.lastProgress) persistProgress(book.id, reader.lastProgress);
      }, 1000);
    };

    rendition.on("relocated", function (location) {
      if (!reader || reader.bookId !== book.id) return;
      if (reader.updateFromLocation) reader.updateFromLocation(location);
    });

    // Móvil: tapzones de borde + flechas flotantes (solo EPUB; el botón «Sin flechas»
    // vive en la barra superior y lo cablea buildOverlay). Aquí solo se cablean las
    // zonas/flechas a la rendition activa y se sincroniza la preferencia del libro.
    if (reader.tapL && !reader.tapL._wired) {
      reader.tapL._wired = true;
      var goPrev = function (e) { e.preventDefault(); if (reader.rendition) reader.rendition.prev(); };
      var goNext = function (e) { e.preventDefault(); if (reader.rendition) reader.rendition.next(); };
      reader.tapL.addEventListener("click", goPrev);
      reader.tapR.addEventListener("click", goNext);
      reader.arrL.addEventListener("click", goPrev);
      reader.arrR.addEventListener("click", goNext);
    }
    reader.navHidden = !!book.hideNav;
    if (reader.applyNavPref) reader.applyNavPref();
    // Swipe para pasar página (conmutador en ajustes; el gesto se ignora si está off)
    if (typeof reader.swipeOn !== "boolean") reader.swipeOn = swipeOn(book);
    if (reader.swipeDetach) { try { reader.swipeDetach(); } catch (e) {} reader.swipeDetach = null; reader.swipeCancel = null; }
    attachSwipeNav(book, rendition, view);
    var startTarget = startCFI || undefined;
    (startTarget ? rendition.display(startTarget) : rendition.display()).then(function () {
      if (book.progress && book.progress.percentage) setProgress(book.progress.percentage, book.progress.chapter || "");
    }).catch(function () {
      // CFI inválido (p. ej. de otro fichero): al principio
      return rendition.display().catch(function () {});
    });
    return rendition;
  }

  // ---------- swipe: pasar página deslizando (dedo o ratón) con transición ----------
  // La página sigue al puntero en vivo; al soltar, la actual sale deslizándose y la
  // nueva entra desde el lado correspondiente. El contenido vive en un iframe, así que
  // los gestos se capturan dentro de cada documento vía hooks.content.

  function swipeOn(book) { return !book || book.swipe !== false; }

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
  }

  function attachSwipeNav(book, rendition, view) {
    var st = { pid: null, sx: 0, sy: 0, dx: 0, t0: 0, locked: false, vertical: false, anim: false, ateUntil: 0, edge: null, w: 0 };
    function width() {
      try {
        var r = view.getBoundingClientRect();
        if (r && r.width) return Math.floor(r.width);
      } catch (e) {}
      return window.innerWidth || 300;
    }
    function setX(px, animate) {
      if (animate && !reducedMotion()) view.classList.add("lib-swipe-anim");
      else view.classList.remove("lib-swipe-anim");
      view.style.transform = px ? ("translate3d(" + Math.round(px) + "px,0,0)") : "";
    }
    function afterTransition(ms) {
      return new Promise(function (res) {
        var done = false;
        function fin() {
          if (done) return; done = true;
          try { view.removeEventListener("transitionend", fin); } catch (e) {}
          res();
        }
        try { view.addEventListener("transitionend", fin); } catch (e) {}
        setTimeout(fin, (ms || 240) + 140);
      });
    }
    function nextRelocated(timeout) {
      return new Promise(function (res) {
        var done = false, t = null;
        function fin() {
          if (done) return; done = true;
          try { rendition.off("relocated", fin); } catch (e) {}
          if (t) clearTimeout(t);
          res();
        }
        try { rendition.on("relocated", fin); }
        catch (e) { res(); return; }
        t = setTimeout(fin, timeout || 900);
      });
    }
    function userSelect(doc, val) {
      try { if (doc && doc.documentElement) doc.documentElement.style.userSelect = val || ""; } catch (e) {}
    }
    function endDrag(doc) {
      st.pid = null; st.locked = false; st.vertical = false;
      try { view.classList.remove("lib-swipe-drag"); } catch (e) {}
      userSelect(doc, "");
    }
    function cancelDrag(snap) {
      if (st.pid == null && !st.anim) return;
      st.pid = null; st.locked = false; st.vertical = false;
      try { view.classList.remove("lib-swipe-drag"); } catch (e) {}
      if (snap !== false) setX(0, true);
      st.dx = 0;
    }
    reader.swipeDetach = function () {
      cancelDrag(false);
      setX(0, false);
      try { view.classList.remove("lib-swipe-drag"); view.classList.remove("lib-swipe-anim"); } catch (e) {}
    };
    reader.swipeCancel = function () { cancelDrag(true); };

    function onDown(e) {
      if (!reader || reader.swipeOn === false || st.anim) return;
      if (st.pid != null) return; // un solo puntero
      try { if (e.pointerType === "mouse" && e.button !== 0) return; } catch (err) {}
      var x = e.clientX, y = e.clientY;
      if (typeof x !== "number") return;
      st.pid = e.pointerId;
      st.sx = x; st.sy = y; st.dx = 0;
      st.t0 = Date.now();
      st.locked = false; st.vertical = false;
      st.w = width();
      try {
        var loc = rendition.currentLocation && rendition.currentLocation();
        st.edge = { start: !!(loc && loc.atStart), end: !!(loc && loc.atEnd) };
      } catch (err) { st.edge = { start: false, end: false }; }
    }
    function onMove(e) {
      if (e.pointerId !== st.pid || st.anim) return;
      if (st.vertical) return;
      var dx = e.clientX - st.sx, dy = e.clientY - st.sy;
      if (!st.locked) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dy) > Math.abs(dx) * 1.2) { st.vertical = true; st.pid = null; return; } // scroll vertical: no interferir
        st.locked = true;
        try { view.classList.add("lib-swipe-drag"); } catch (err) {}
        try {
          var d = (e.view && e.view.document) || null;
          if (d && d.getSelection) d.getSelection().removeAllRanges();
          userSelect(d, "none");
        } catch (err) {}
      }
      // Resistencia elástica en los bordes del libro
      var rdx = dx;
      if ((dx > 0 && st.edge && st.edge.start) || (dx < 0 && st.edge && st.edge.end)) rdx = dx * 0.35;
      st.dx = rdx;
      setX(rdx, false);
      try { e.preventDefault(); } catch (err) {}
    }
    function onUp(e) {
      if (e.pointerId !== st.pid) return;
      var doc = null;
      try { doc = (e.view && e.view.document) || null; } catch (err) {}
      var wasLocked = st.locked, dx = st.dx, dt = Math.max(1, Date.now() - st.t0);
      endDrag(doc);
      if (!wasLocked) { st.dx = 0; return; } // fue un tap: lo gestionan tapzones/enlaces
      st.ateUntil = Date.now() + 400; // suprime el click posterior al arrastre
      var w = st.w || width();
      var vel = dx / dt;
      var thr = Math.max(72, w * 0.22);
      var dir = dx < 0 ? "next" : "prev";
      var blocked = (dir === "next" && st.edge && st.edge.end) || (dir === "prev" && st.edge && st.edge.start);
      st.dx = 0;
      if (blocked || !(Math.abs(dx) > thr || (Math.abs(vel) > 0.55 && Math.abs(dx) > 24))) {
        setX(0, true); // rebote elástico
        return;
      }
      navigate(dir, w);
    }
    function onCancel(e) {
      if (e.pointerId !== st.pid) return;
      var doc = null;
      try { doc = (e.view && e.view.document) || null; } catch (err) {}
      endDrag(doc);
      setX(0, true);
      st.dx = 0;
    }
    function navigate(dir, w) {
      if (st.anim) return;
      if (reducedMotion()) {
        try { if (dir === "next") rendition.next(); else rendition.prev(); } catch (e) {}
        setX(0, false);
        return;
      }
      st.anim = true;
      var outX = dir === "next" ? -w : w;
      setX(outX, true);
      afterTransition(240).then(function () {
        if (!reader || reader.rendition !== rendition) return null;
        var p = nextRelocated(900);
        try { if (dir === "next") rendition.next(); else rendition.prev(); } catch (e) {}
        return p;
      }).then(function (ok) {
        if (ok == null || !reader || reader.rendition !== rendition) return null;
        view.classList.remove("lib-swipe-anim");
        view.style.transform = "translate3d(" + (dir === "next" ? w : -w) + "px,0,0)";
        void view.offsetWidth; // reflow para que la transición de entrada se anime
        view.classList.add("lib-swipe-anim");
        view.style.transform = "translate3d(0,0,0)";
        return afterTransition(240);
      }).then(function () {
        try { view.classList.remove("lib-swipe-anim"); } catch (e) {}
        view.style.transform = "";
        st.anim = false;
      });
    }
    function wireDoc(d) {
      if (!d || !d.documentElement || d.documentElement.__libSwipe) return;
      d.documentElement.__libSwipe = true;
      try { d.documentElement.style.touchAction = "pan-y"; } catch (e) {}
      d.addEventListener("click", function (ev) {
        if (Date.now() < st.ateUntil) { ev.preventDefault(); ev.stopPropagation(); }
      }, true);
      d.documentElement.addEventListener("pointerdown", onDown);
      d.addEventListener("pointermove", onMove);
      d.addEventListener("pointerup", onUp);
      d.addEventListener("pointercancel", onCancel);
    }
    try {
      rendition.hooks.content.register(function (contents) {
        try {
          var d = (contents && (contents.document || contents.doc)) ||
            (contents && contents.window && contents.window.document) || null;
          if (d) wireDoc(d);
        } catch (e) {}
      });
    } catch (e) {}
  }

  function setSpread(book, spread) {
    if (!reader || !reader.book) return;
    if (reader.spread === spread) return;
    if (reader.swipeDetach) { try { reader.swipeDetach(); } catch (e) {} }
    reader.spread = spread;
    reader.spreadBtns();
    var cur = findBook(book.id);
    if (cur) { cur.spread = spread; saveBooks(); }
    // Captura posición actual → destruye rendition → re-crea con el nuevo spread → reanuda
    var cfi = null;
    try { var loc = reader.rendition.currentLocation(); if (loc && loc.start && loc.start.cfi) cfi = loc.start.cfi; } catch {}
    if (!cfi && reader.lastProgress && reader.lastProgress.cfi) cfi = reader.lastProgress.cfi;
    setProgress(book.progress && book.progress.percentage || 0, "Reordenando…");
    try { reader.rendition.destroy(); } catch {}
    reader.body.querySelectorAll(".lib-reader-view").forEach(function (v) { v.remove(); });
    var view = el("div", "lib-reader-view");
    reader.body.appendChild(view);
    makeRendition(book, reader.book, view, cfi || (book.progress && book.progress.cfi));
    // Reengancha el TOC al nuevo cuerpo (se perdió al limpiar la vista)
    if (reader.toc) reader.body.appendChild(reader.toc);
  }

  var TXT_THEMES = {
    sepia: { bg: "#f4ecd8", fg: "#3b3021" },
    light: { bg: "#faf9f5", fg: "#1a1a1a" },
    dark: { bg: "#0d1017", fg: "#c9d1d9" },
  };
  function openSimpleReader(book, blob) {
    var ui = buildOverlay(book, null, { noNav: true });
    if (book.kind === "pdf") {
      var url = URL.createObjectURL(blob);
      reader.url = url;
      var frame = document.createElement("iframe");
      frame.className = "lib-pdfframe";
      frame.src = url;
      ui.body.appendChild(frame);
      setProgress(0, "PDF — usa el visor del navegador");
    } else {
      // TXT: vista con scroll + temas y letra (igual que EPUB), progreso por offset con throttle
      var txtTheme = book.theme && TXT_THEMES[book.theme] ? book.theme : "dark";
      var txtSize = book.fontSize || 100;
      var txtView = null;
      function paintTxt() {
        if (!txtView) return;
        var t = TXT_THEMES[txtTheme] || TXT_THEMES.dark;
        var px = Math.round(14 * (txtSize / 100));
        txtView.style.background = t.bg;
        txtView.style.color = t.fg;
        txtView.style.fontSize = px + "px";
      }
      var tBtns = {};
      THEMES.forEach(function (t) {
        var tb = el("button", "lib-btn" + (txtTheme === t ? " lib-btn-primary" : ""), t === "sepia" ? "Sépia" : (t === "light" ? "Claro" : "Oscuro"));
        tb.type = "button";
        tb.addEventListener("click", function () {
          txtTheme = t;
          Object.keys(tBtns).forEach(function (k) { tBtns[k].classList.toggle("lib-btn-primary", k === t); });
          paintTxt();
          var cur = findBook(book.id);
          if (cur) { cur.theme = t; saveBooks(); }
        });
        tBtns[t] = tb;
        ui.tools.appendChild(tb);
      });
      var dec = el("button", "lib-btn", "A −");
      dec.type = "button";
      dec.setAttribute("aria-label", "Reducir tamaño de letra");
      var inc = el("button", "lib-btn", "A +");
      inc.type = "button";
      inc.setAttribute("aria-label", "Aumentar tamaño de letra");
      var sizeLbl = el("small", "", txtSize + "%");
      sizeLbl.style.cssText = "color:#64748b;min-width:42px;text-align:center";
      dec.addEventListener("click", function () {
        txtSize = Math.max(80, Math.min(220, txtSize - 10));
        sizeLbl.textContent = txtSize + "%";
        paintTxt();
        var cur = findBook(book.id);
        if (cur) { cur.fontSize = txtSize; saveBooks(); }
      });
      inc.addEventListener("click", function () {
        txtSize = Math.max(80, Math.min(220, txtSize + 10));
        sizeLbl.textContent = txtSize + "%";
        paintTxt();
        var cur = findBook(book.id);
        if (cur) { cur.fontSize = txtSize; saveBooks(); }
      });
      ui.tools.appendChild(dec);
      ui.tools.appendChild(sizeLbl);
      ui.tools.appendChild(inc);
      blobToText(blob).then(function (txt) {
        if (!reader || reader.bookId !== book.id) return;
        var view = el("div", "lib-reader-view");
        view.style.cssText = "overflow:auto;padding:40px 18%;font-family:var(--font-mono,monospace);line-height:1.75;white-space:pre-wrap;transition:background .25s,color .25s";
        view.textContent = txt;
        txtView = view;
        paintTxt();
        ui.body.appendChild(view);
        setProgress(0, "TXT");
        var lastSave = 0;
        view.addEventListener("scroll", function () {
          if (!reader || reader.bookId !== book.id) return;
          var p = view.scrollTop / Math.max(1, view.scrollHeight - view.clientHeight);
          setProgress(p, "TXT");
          var now = Date.now();
          if (now - lastSave < 1500) return;
          lastSave = now;
          persistProgress(book.id, { offset: view.scrollTop, percentage: p, updatedAt: now });
        });
        if (book.progress && book.progress.offset) view.scrollTop = book.progress.offset;
      }).catch(function (err) {
        api.showToast("No se pudo leer el TXT: " + err.message, "error", 5000);
        closeReader();
      });
    }
  }

  IndexLy.register({
    setup: function (ctx) {
      api = ctx;
      ensureStyles();
      ensureBooks(function () {});
      ctx.addSection({ id: "readly", label: "ReadLy", render: renderPage });
      // Documentación en /ayuda
      if (typeof ctx.addDocSection === "function") {
        ctx.addDocSection({
          id: "readly",
          title: "ReadLy — lee tus libros en IndexLy",
          html:
            "<p><strong>ReadLy</strong> añade una pestaña donde guardar y <strong>leer tus EPUB," +
            " PDF y TXT</strong> dentro de IndexLy, con un lector a pantalla completa y minimalista." +
            " Los ficheros se guardan en tu navegador y <strong>tu progreso de lectura se guarda" +
            " solo</strong>: cierras, vuelves y continúas en la misma página.</p>" +
            "<ul>" +
            "<li><strong>Añadir libros</strong>: botón «＋ Añadir libros» (multi-selección). También" +
            " se intenta completar la ficha (carátula, autor, año, páginas) desde Google Books," +
            " gratis y sin claves; puedes rebuscarla desde la ficha.</li>" +
            "<li><strong>Leer</strong>: «Abrir libro» en la ficha o «Continuar (n%)». Dentro del" +
            " lector: índice de capítulos, tamaño de letra, temas claro/sépia/oscuro, barra de" +
            " progreso y flechas del teclado (o espacio) para pasar página, y puedes elegir <strong>1 o 2 páginas</strong> por vista. El botón «···» oculta el panel de ajustes para leer sin distracciones, y en móvil «Sin flechas» oculta las flechas pero mantiene el toque en los bordes para pasar página. También puedes pasar página deslizando con el dedo o el ratón (botón «Deslizar»). Optimizado para móvil: barras compactas y botones táctiles. <kbd>Esc</kbd> cierra." +
            " La barra violeta bajo la carátula marca el progreso.</li>" +
            "<li><strong>Estados</strong>: Leyendo / Pendiente / Terminado / Abandonado, con filtros" +
            " en la biblioteca.</li>" +
            "<li><strong>Fuentes enlazadas</strong>: en cada ficha puedes enlazar elementos de tus" +
            " índices (por ejemplo la descarga original del Hub).</li>" +
            "<li><strong>Copia total</strong>: «⤓ Exportar» guarda todos tus libros, ajustes y" +
            " progreso en un JSON; «⤒ Importar» los restaura y te avisa si algún libro ya existe" +
            " (elige entre añadir solo los nuevos o sobreescribir duplicados). Los ficheros" +
            " hay que volver a añadirlos.</li>" +
            "</ul>" +
            "<p><strong>Privacidad</strong>: biblioteca, ficheros y progreso viven en tu navegador." +
            " Solo se consultan Google Books/OpenLibrary para fichas y el CDN de epub.js la primera" +
            " vez que abres un EPUB.</p>",
        });
      }
    },
  });
})();
