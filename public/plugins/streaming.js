/* IndexLy Plugin
   id: streaming-demo
   name: Sección Streaming
   version: 1.0.0
   description: Añade una sección Streaming: detecta elementos con vídeo (YouTube, Vimeo, mp4), reprodúcelos en un modal, filtra por "Con vídeo" y prueba a añadir un catálogo demo.
   permissions: network, ui, storage
*/
(function () {
  var api = null;
  var esc = function (s) { return String(s == null ? "" : s); };
  var state = { query: "" };

  var YT_RE = /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/;
  var VIMEO_RE = /vimeo\.com\/(?:video\/)?(\d+)/;
  var FILE_RE = /\.(mp4|webm|ogv|ogg|mov)(\?.*)?$/i;

  function classify(link) {
    if (!link || typeof link !== "string") return null;
    var m = link.match(YT_RE);
    if (m) return { type: "youtube", id: m[1] };
    m = link.match(VIMEO_RE);
    if (m) return { type: "vimeo", id: m[1] };
    if (FILE_RE.test(link)) return { type: "file", url: link };
    return null;
  }
  function isPlayable(g) { return !!classify(g && g.link); }

  function ensureStyles() {
    if (document.getElementById("strm-styles")) return;
    var s = document.createElement("style");
    s.id = "strm-styles";
    s.textContent = [
      ".strm-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;color:#7dd3fc;background:rgba(14,165,233,0.10);border:1px solid rgba(14,165,233,0.25);border-radius:999px;padding:2px 8px;margin-top:6px;width:max-content}",
      ".strm-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".strm-search{flex:1 1 220px;min-width:0;background:#070a12;border:1px solid #1e293b;border-radius:999px;padding:10px 14px;color:#e2e8f0;font-size:13px;outline:none}",
      ".strm-search:focus{border-color:#24344f;box-shadow:0 0 0 3px rgba(14,165,233,0.08)}",
      ".strm-count{margin:12px 0 0;font-size:12px;color:#94a3b8}",
      ".strm-grid{margin-top:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}",
      ".strm-card{background:#0a0f1c;border:1px solid #1e293b;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}",
      ".strm-card strong{font-size:12.5px;color:#e2e8f0;line-height:1.35}",
      ".strm-card small{font-size:11px;color:#64748b}",
      ".strm-play{margin-top:auto;align-self:flex-start;background:#fff;color:#0f172a;border:none;border-radius:999px;padding:7px 14px;font-size:11.5px;font-weight:600;cursor:pointer}",
      ".strm-play:hover{opacity:0.88}",
      ".strm-player{position:relative;padding-top:56.25%;border-radius:12px;overflow:hidden;background:#000}",
      ".strm-player iframe{position:absolute;inset:0;width:100%;height:100%;border:0}",
      ".strm-video{width:100%;border-radius:12px;background:#000;display:block}",
      ".strm-caption{margin:10px 0 0;font-size:12px;color:#94a3b8}",
      ".strm-history{margin-top:18px;border-top:1px solid #1e293b;padding-top:12px}",
      ".strm-history h5{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.02em;color:#94a3b8}",
      ".strm-hist-row{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:12px;color:#cbd5e1}",
      ".strm-hist-row button{background:transparent;border:none;color:#f87171;cursor:pointer;font-size:11px}",
      ".strm-empty{margin:12px 0;font-size:12px;color:#64748b}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function playerHtml(game) {
    var c = classify(game.link);
    if (!c) return "";
    var inner;
    if (c.type === "youtube") {
      inner = '<div class="strm-player"><iframe src="https://www.youtube-nocookie.com/embed/' + esc(c.id) + '" title="Reproductor" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>';
    } else if (c.type === "vimeo") {
      inner = '<div class="strm-player"><iframe src="https://player.vimeo.com/video/' + esc(c.id) + '" title="Reproductor" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>';
    } else {
      inner = '<video class="strm-video" controls autoplay playsinline src="' + esc(c.url) + '"></video>';
    }
    return inner + '<p class="strm-caption">' + esc(game.title) + "</p>";
  }

  function openPlayer(game) {
    if (!isPlayable(game)) return;
    api.modal({
      title: "Streaming — " + game.title,
      html: playerHtml(game),
      actions: [
        { label: "Cerrar" },
        { label: "Abrir original", onClick: function () { api.openLink(game.link); } },
      ],
    });
    api.storage.get("history").then(function (h) {
      h = Array.isArray(h) ? h : [];
      h.unshift({ title: game.title, link: game.link, at: Date.now() });
      return api.storage.set("history", h.slice(0, 50));
    }).catch(function () {});
  }

  function historyHtml(h) {
    if (!h || !h.length) return "";
    var rows = h.slice(0, 5).map(function (it) {
      return '<div class="strm-hist-row"><span>' + esc(it.title) + '</span><button type="button" data-strm-hist="' + esc(it.link) + '">quitar</button></div>';
    }).join("");
    return '<div class="strm-history"><h5>Vistos recientemente</h5>' + rows + '<button type="button" id="strm-hist-clear" class="strm-hist-row" style="align-self:flex-start">Borrar historial</button></div>';
  }

  function renderList(listEl, countEl, games) {
    var q = state.query.trim().toLowerCase();
    var playable = games.filter(isPlayable);
    var shown = q ? playable.filter(function (g) { return String(g.title || "").toLowerCase().indexOf(q) >= 0; }) : playable;
    countEl.textContent = shown.length === 1 ? "1 elemento con vídeo" : shown.length.toLocaleString("es-ES") + " elementos con vídeo";
    if (!shown.length) {
      listEl.innerHTML = '<p class="strm-empty">Sin elementos con vídeo' + (q ? " para esa búsqueda" : "") + '.</p>';
      return;
    }
    listEl.innerHTML = shown.slice(0, 60).map(function (g) {
      return '<div class="strm-card"><strong>' + esc(g.title) + "</strong><small>" + esc(g.source || "") + "</small>" +
        '<button type="button" class="strm-play" data-strm-play="1">▶ Ver</button></div>';
    }).join("");
    var buttons = listEl.querySelectorAll("[data-strm-play]");
    Array.prototype.forEach.call(buttons, function (btn, i) {
      btn.addEventListener("click", function () { openPlayer(shown[i]); });
    });
  }

  function renderSection(root) {
    ensureStyles();
    root.innerHTML =
      '<div class="strm-toolbar">' +
      '<input type="text" class="strm-search" placeholder="Buscar entre los elementos con vídeo…" aria-label="Buscar en Streaming" />' +
      '<button type="button" class="strm-play" id="strm-demo-catalog">Añadir catálogo demo</button>' +
      "</div>" +
      '<p class="strm-count"></p>' +
      '<div class="strm-grid"></div>' +
      '<div class="strm-history-slot"></div>';

    var input = root.querySelector(".strm-search");
    var countEl = root.querySelector(".strm-count");
    var listEl = root.querySelector(".strm-grid");
    var histSlot = root.querySelector(".strm-history-slot");
    input.value = state.query;

    function refresh() {
      renderList(listEl, countEl, api.getAllGames());
      api.storage.get("history").then(function (h) {
        histSlot.innerHTML = historyHtml(h);
        var clear = histSlot.querySelector("#strm-hist-clear");
        if (clear) clear.addEventListener("click", function () {
          api.storage.set("history", []).then(function () { refresh(); });
        });
        var qs = histSlot.querySelectorAll("[data-strm-hist]");
        Array.prototype.forEach.call(qs, function (b) {
          b.addEventListener("click", function () {
            api.storage.get("history").then(function (cur) {
              cur = (Array.isArray(cur) ? cur : []).filter(function (it) { return it.link !== b.getAttribute("data-strm-hist"); });
              return api.storage.set("history", cur);
            }).then(function () { refresh(); });
          });
        });
      }).catch(function () {});
    }

    input.addEventListener("input", function () {
      state.query = input.value;
      renderList(listEl, countEl, api.getAllGames());
    });

    var demoBtn = root.querySelector("#strm-demo-catalog");
    if (api.getIndexes().some(function (i) { return i.name === "Catálogo demo streaming"; })) {
      demoBtn.disabled = true;
      demoBtn.textContent = "Catálogo demo añadido";
      demoBtn.style.opacity = "0.5";
      demoBtn.style.cursor = "not-allowed";
    }
    demoBtn.addEventListener("click", function () {
      api.addSource({
        name: "Catálogo demo streaming",
        mapping: { titleKey: "titulo", linkKey: "url" },
        rawData: {
          items: [
            { titulo: "Big Buck Bunny (cortometraje libre)", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", tipo: "animación" },
            { titulo: "Sintel — tráiler (Blender)", url: "https://www.youtube.com/watch?v=eRsGyueVLvQ", tipo: "animación" },
            { titulo: "Tears of Steel (cortometraje libre)", url: "https://www.youtube.com/watch?v=R6MlUcmOul8", tipo: "sci-fi" },
            { titulo: "The New Vimeo Player (demo)", url: "https://vimeo.com/76979871", tipo: "demo" },
            { titulo: "Flower — vídeo CC0 (mdn, mp4 directo)", url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", tipo: "naturaleza" },
            { titulo: "Elemento sin vídeo (para comparar)", url: "", tipo: "otro" },
          ],
        },
      });
      demoBtn.disabled = true;
      demoBtn.textContent = "Catálogo demo añadido";
      demoBtn.style.opacity = "0.5";
      demoBtn.style.cursor = "not-allowed";
    });

    refresh();
  }

  IndexLy.register({
    setup: function (ctx) {
      api = ctx;
      esc = ctx.escapeHtml;
      ensureStyles();
      ctx.addSection({ id: "streaming", label: "Streaming", render: renderSection });
      ctx.addChip({ id: "video", label: "Con vídeo", test: isPlayable });
      ctx.addCardAction({
        id: "ver",
        label: "▶ Ver",
        match: isPlayable,
        onClick: openPlayer,
      });
      ctx.on("items:hydrate", function (e) {
        if (!e || !e.el || !isPlayable(e.game)) return;
        if (e.el.querySelector(".strm-badge")) return;
        var info = e.el.querySelector(".game-info-container") || e.el.querySelector(".grid-body");
        if (!info) return;
        var b = document.createElement("span");
        b.className = "strm-badge";
        b.textContent = "▶ vídeo";
        info.appendChild(b);
      });
    },
  });
})();
