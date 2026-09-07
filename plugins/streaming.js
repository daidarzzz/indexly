/* IndexLy Plugin
   id: streaming-demo
   name: Streaming
   version: 2.0.0
   description: Página de Streaming con canales: marca índices como "de streaming" en su mapeo, elige canal en la barra lateral izquierda y reproduce con iframe (YouTube, Vimeo, Twitch, Dailymotion, mp4…) o botón al enlace externo.
   permissions: network, ui, storage
*/
(function () {
  var api = null;
  var pageRoot = null; // contenedor de la sección (lo fija renderPage)
  var state = { channelId: null, videoLink: null, videoTitle: null };

  var YT_RE = /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/;
  var VIMEO_RE = /vimeo\.com\/(?:video\/)?(\d+)/;
  var DM_RE = /(?:dailymotion\.com\/video\/|dai\.ly\/)([a-z0-9]+)/i;
  var TW_VID_RE = /twitch\.tv\/videos\/(\d+)/;
  var TW_CHAN_RE = /twitch\.tv\/([A-Za-z0-9_]{3,})(?:\/|$)/;
  var FILE_RE = /\.(mp4|webm|ogv|ogg|mov|m4v)(\?.*)?$/i;
  var NOEMBED_RE = /\.(zip|rar|7z|exe|apk|iso|pdf|json|xml|csv)(\?|#|$)/i;

  // Resuelve cómo reproducir un enlace: iframe embebible, <video> o solo externo.
  function buildEmbed(link) {
    if (!link || typeof link !== "string") return null;
    var m = link.match(YT_RE);
    if (m) return { type: "iframe", src: "https://www.youtube-nocookie.com/embed/" + m[1] + "?autoplay=1&rel=0" };
    m = link.match(VIMEO_RE);
    if (m) return { type: "iframe", src: "https://player.vimeo.com/video/" + m[1] + "?autoplay=1" };
    m = link.match(DM_RE);
    if (m) return { type: "iframe", src: "https://geo.dailymotion.com/player.html?video=" + m[1] };
    m = link.match(TW_VID_RE);
    if (m) return { type: "iframe", src: "https://player.twitch.tv/?video=" + m[1] + "&parent=" + location.hostname + "&autoplay=true" };
    m = link.match(TW_CHAN_RE);
    if (m) return { type: "iframe", src: "https://player.twitch.tv/?channel=" + m[1] + "&parent=" + location.hostname + "&autoplay=true" };
    if (FILE_RE.test(link)) return { type: "video", src: link };
    if (/^https?:\/\//i.test(link)) {
      if (NOEMBED_RE.test(link)) return { type: "external", src: link };
      // intento de iframe genérico: algunos sitios bloquean incrustación (X-Frame-Options)
      return { type: "iframe", src: link, risky: true };
    }
    return null;
  }

  function playableCount(index) {
    var n = 0;
    var games = index.games || [];
    for (var i = 0; i < games.length; i++) if (buildEmbed(games[i].link)) n++;
    return n;
  }

  function ensureStyles() {
    if (document.getElementById("strm-styles")) return;
    var s = document.createElement("style");
    s.id = "strm-styles";
    s.textContent = [
      ".strm-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;color:#7dd3fc;background:rgba(14,165,233,0.10);border:1px solid rgba(14,165,233,0.25);border-radius:999px;padding:2px 8px;margin-top:6px;width:max-content}",
      ".strm-page{display:flex;gap:14px;align-items:stretch;min-height:480px}",
      ".strm-side{width:210px;flex-shrink:0;display:flex;flex-direction:column;gap:6px}",
      ".strm-side-title{font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;padding:4px 2px}",
      ".strm-chan{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:#0a0f1c;border:1px solid #1e293b;border-radius:10px;padding:10px 12px;color:#e2e8f0;font-size:12.5px;font-weight:500;cursor:pointer;transition:background .15s,border-color .15s}",
      ".strm-chan:hover{background:#0d1528;border-color:#24344f}",
      ".strm-chan.active{background:rgba(14,165,233,0.12);border-color:rgba(14,165,233,0.35);color:#fff}",
      ".strm-chan-dot{width:7px;height:7px;border-radius:50%;background:#334155;flex-shrink:0}",
      ".strm-chan.active .strm-chan-dot{background:#0ea5e9;box-shadow:0 0 0 3px rgba(14,165,233,0.18)}",
      ".strm-chan-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".strm-chan-count{font-size:10px;font-family:var(--font-mono,monospace);color:#64748b;flex-shrink:0}",
      ".strm-chan-off{font-size:9px;color:#f59e0b;flex-shrink:0}",
      ".strm-side-hint{font-size:11px;color:#64748b;line-height:1.5;padding:8px 2px}",
      ".strm-side-foot{margin-top:auto;padding-top:10px}",
      ".strm-btn{background:transparent;border:1px solid #1e293b;border-radius:999px;color:#94a3b8;padding:7px 12px;font-size:11.5px;font-weight:600;cursor:pointer;transition:all .15s}",
      ".strm-btn:hover{background:#152033;color:#e2e8f0;border-color:#24344f}",
      ".strm-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".strm-btn-primary{background:#fff;border-color:#fff;color:#0f172a}",
      ".strm-btn-primary:hover{background:#f1f5f9;color:#0f172a}",
      ".strm-main{flex:1;min-width:0;background:#0a0f1c;border:1px solid #1e293b;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px}",
      ".strm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".strm-head h4{margin:0;font-size:15px;font-weight:600;color:#f1f5f9;letter-spacing:-0.01em}",
      ".strm-head small{font-size:11px;color:#64748b}",
      ".strm-spacer{flex:1}",
      ".strm-vids{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;overflow:auto}",
      ".strm-card{background:#070a12;border:1px solid #1e293b;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;cursor:pointer;transition:border-color .15s,transform .15s}",
      ".strm-card:hover{border-color:#24344f;transform:translateY(-2px)}",
      ".strm-card strong{font-size:12.5px;color:#e2e8f0;line-height:1.4}",
      ".strm-card small{font-size:10.5px;color:#64748b}",
      ".strm-kind{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#7dd3fc;background:rgba(14,165,233,0.10);border:1px solid rgba(14,165,233,0.25);border-radius:999px;padding:2px 7px;width:max-content}",
      ".strm-kind.ext{color:#fbbf24;background:rgba(251,191,36,0.08);border-color:rgba(251,191,36,0.25)}",
      ".strm-empty{margin:auto;text-align:center;color:#64748b;font-size:12.5px;line-height:1.6;max-width:44ch;padding:30px 10px}",
      ".strm-player{position:relative;padding-top:56.25%;border-radius:12px;overflow:hidden;background:#000;flex-shrink:0}",
      ".strm-player iframe{position:absolute;inset:0;width:100%;height:100%;border:0}",
      ".strm-video{width:100%;border-radius:12px;background:#000;display:block}",
      ".strm-caption{margin:0;font-size:12px;color:#94a3b8}",
      ".strm-fallback{border:1px dashed rgba(251,191,36,0.3);background:rgba(251,191,36,0.05);border-radius:12px;padding:22px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}",
      ".strm-fallback p{margin:0;font-size:12px;color:#fbbf24;line-height:1.5}",
      ".strm-fallback small{color:#64748b;font-size:11px}",
      "@media (max-width:640px){.strm-page{flex-direction:column}.strm-side{width:100%;flex-direction:row;overflow-x:auto;padding-bottom:4px}.strm-side-title,.strm-side-hint,.strm-side-foot{display:none}.strm-chan{width:auto;flex-shrink:0}}",
    ].join("\n");
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function isStreamingChannel(i) { return !!(i.flags && i.flags.streaming); }
  function getChannels() { return api.getIndexes().filter(isStreamingChannel); }
  function currentChannel() {
    return getChannels().find(function (i) { return i.id === state.channelId; }) || null;
  }
  function rerender() { if (pageRoot) renderPage(pageRoot); }

  function openVideo(channel, game) {
    state.channelId = channel.id;
    state.videoLink = game.link || "";
    state.videoTitle = game.title || "";
    rerender();
  }

  // ---------- vistas ----------

  function renderSidebar(side) {
    side.innerHTML = "";
    side.appendChild(el("div", "strm-side-title", "Canales"));
    var chans = getChannels();
    if (!chans.length) {
      side.appendChild(el("p", "strm-side-hint", "Sin canales. Abre el mapeo de un índice (icono de ajustes) y activa la casilla «Es un índice de streaming»."));
    }
    chans.forEach(function (ch) {
      var btn = el("button", "strm-chan" + (state.channelId === ch.id ? " active" : ""));
      btn.type = "button";
      btn.appendChild(el("span", "strm-chan-dot"));
      btn.appendChild(el("span", "strm-chan-name", ch.name));
      if (!ch.active) btn.appendChild(el("span", "strm-chan-off", "inactiva"));
      btn.appendChild(el("span", "strm-chan-count", String(playableCount(ch))));
      btn.addEventListener("click", function () {
        state.channelId = ch.id;
        state.videoLink = null;
        state.videoTitle = null;
        rerender();
      });
      side.appendChild(btn);
    });
    var foot = el("div", "strm-side-foot");
    var demo = el("button", "strm-btn");
    demo.type = "button";
    demo.textContent = "＋ Catálogo demo";
    demo.addEventListener("click", function () {
      api.addSource({
        name: "Catálogo demo streaming",
        flags: { streaming: true },
        mapping: { titleKey: "titulo", linkKey: "url" },
        rawData: {
          items: [
            { titulo: "Big Buck Bunny (cortometraje libre)", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", tipo: "animación" },
            { titulo: "Sintel — tráiler (Blender)", url: "https://www.youtube.com/watch?v=eRsGyueVLvQ", tipo: "animación" },
            { titulo: "Tears of Steel (cortometraje libre)", url: "https://www.youtube.com/watch?v=R6MlUcmOul8", tipo: "sci-fi" },
            { titulo: "The New Vimeo Player (demo)", url: "https://vimeo.com/76979871", tipo: "demo" },
            { titulo: "Flower — vídeo CC0 (mp4 directo)", url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", tipo: "naturaleza" },
            { titulo: "Wikipedia (enlace externo, no incrustable)", url: "https://es.wikipedia.org/wiki/Streaming", tipo: "externo" },
            { titulo: "Sin enlace", url: "", tipo: "otro" },
          ],
        },
      });
      // pluginAddSource lanza updateApp → la sección se re-renderiza con el canal nuevo
    });
    foot.appendChild(demo);
    side.appendChild(foot);
  }

  function renderGrid(main, channel) {
    var head = el("div", "strm-head");
    head.appendChild(el("h4", "", channel.name));
    var playable = playableCount(channel);
    head.appendChild(el("small", "", (playable === 1 ? "1 vídeo" : playable + " vídeos") + (channel.active ? "" : " · canal inactivo")));
    main.appendChild(head);

    var games = (channel.games || []).filter(function (g) { return !!buildEmbed(g.link); });
    if (!games.length) {
      var empty = el("div", "strm-empty");
      empty.textContent = channel.games && channel.games.length
        ? "Ningún elemento de este canal tiene enlace de vídeo."
        : "Este canal no tiene elementos.";
      main.appendChild(empty);
      return;
    }
    var grid = el("div", "strm-vids");
    games.forEach(function (g) {
      var emb = buildEmbed(g.link);
      var card = el("div", "strm-card");
      var kindLabel = emb.type === "iframe" ? "iframe" : (emb.type === "video" ? "vídeo" : "externo");
      card.appendChild(el("span", "strm-kind" + (emb.type === "external" ? " ext" : ""), kindLabel));
      card.appendChild(el("strong", "", g.title || "Sin título"));
      var sub = [];
      if (g.subtitle) sub.push(g.subtitle);
      if (g.meta && g.meta.tipo) sub.push(g.meta.tipo);
      if (sub.length) card.appendChild(el("small", "", sub.join(" · ")));
      card.addEventListener("click", function () { openVideo(channel, g); });
      grid.appendChild(card);
    });
    main.appendChild(grid);
  }

  function fallbackPanel(msg, link) {
    var box = el("div", "strm-fallback");
    box.appendChild(el("p", "", msg));
    box.appendChild(el("small", "", "Algunas webs bloquean su visualización dentro de otras páginas (X-Frame-Options)."));
    var btn = el("button", "strm-btn strm-btn-primary", "Abrir enlace externo ↗");
    btn.type = "button";
    btn.addEventListener("click", function () { api.openLink(link); });
    box.appendChild(btn);
    return box;
  }

  function renderPlayer(main, channel) {
    var head = el("div", "strm-head");
    var back = el("button", "strm-btn", "← " + channel.name);
    back.type = "button";
    back.addEventListener("click", function () {
      state.videoLink = null;
      state.videoTitle = null;
      rerender();
    });
    head.appendChild(back);
    head.appendChild(el("span", "strm-spacer"));
    var extTop = el("button", "strm-btn", "Abrir externo ↗");
    extTop.type = "button";
    extTop.addEventListener("click", function () { api.openLink(state.videoLink); });
    head.appendChild(extTop);
    main.appendChild(head);
    main.appendChild(el("h4", "", state.videoTitle || "Reproduciendo"));

    var emb = buildEmbed(state.videoLink);
    if (!emb) {
      var box = el("div", "strm-fallback");
      if (state.videoLink) {
        box.appendChild(el("p", "", "No se puede reproducir este enlace aquí."));
        var btn = el("button", "strm-btn strm-btn-primary", "Abrir enlace externo ↗");
        btn.type = "button";
        btn.addEventListener("click", function () { api.openLink(state.videoLink); });
        box.appendChild(btn);
      } else {
        box.appendChild(el("p", "", "Este elemento no tiene enlace."));
      }
      main.appendChild(box);
      return;
    }
    if (emb.type === "video") {
      var v = document.createElement("video");
      v.className = "strm-video";
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      v.src = emb.src;
      main.appendChild(v);
      main.appendChild(el("p", "strm-caption", "Vídeo directo · " + channel.name));
      return;
    }
    if (emb.type === "external") {
      main.appendChild(fallbackPanel("Este enlace no se puede incrustar aquí.", state.videoLink));
      return;
    }
    // iframe (YouTube/Vimeo/Twitch/Dailymotion/intento genérico)
    var linkAtOpen = state.videoLink;
    var wrap = el("div", "strm-player");
    var frame = document.createElement("iframe");
    frame.src = emb.src;
    frame.allowFullscreen = true;
    frame.setAttribute("allow", "autoplay; fullscreen; encrypted-media; picture-in-picture");
    frame.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
    var loaded = false;
    frame.addEventListener("load", function () { loaded = true; });
    wrap.appendChild(frame);
    main.appendChild(wrap);
    var note = el("p", "strm-caption", emb.risky
      ? "Intentando incrustar el enlace. Si el sitio lo bloquea, usa «Abrir externo»."
      : "Reproduciendo incrustado · " + channel.name);
    main.appendChild(note);
    // Watchdog: si el iframe no dispara load en 7s, muestra el panel de fallback
    setTimeout(function () {
      if (!loaded && state.videoLink === linkAtOpen && wrap.isConnected) {
        wrap.style.display = "none";
        note.style.display = "none";
        main.insertBefore(fallbackPanel("Parece que este sitio no permite ser incrustado (iframe).", linkAtOpen), note);
      }
    }, 7000);
  }

  function renderPage(root) {
    ensureStyles();
    pageRoot = root;
    root.innerHTML = "";
    var page = el("div", "strm-page");
    var side = el("div", "strm-side");
    var main = el("div", "strm-main");
    page.appendChild(side);
    page.appendChild(main);
    root.appendChild(page);

    renderSidebar(side);
    var ch = currentChannel();
    if (!ch) {
      var empty = el("div", "strm-empty");
      empty.innerHTML = "Selecciona un canal en la barra lateral.<br>Si no hay ninguno, marca un índice como «de streaming» en su mapeo o añade el catálogo demo.";
      main.appendChild(empty);
      return;
    }
    if (state.videoLink) renderPlayer(main, ch);
    else renderGrid(main, ch);
  }

  IndexLy.register({
    setup: function (ctx) {
      api = ctx;
      ensureStyles();
      // Checkbox en el mapeo de cada índice: marca qué fuentes son canales.
      // addIndexFlag es API reciente: si el host es antiguo, se ignora sin romper.
      if (typeof ctx.addIndexFlag === "function") {
        ctx.addIndexFlag({ id: "streaming", label: "Es un índice de streaming", hint: "Aparecerá como canal en la sección Streaming" });
      }
      ctx.addSection({ id: "streaming", label: "Streaming", render: renderPage });
      ctx.addChip({ id: "video", label: "Con vídeo", test: function (g) { return !!buildEmbed(g && g.link); } });
      // Botón "▶ Ver" en las cards: abre la página de Streaming con ese vídeo cargado
      ctx.addCardAction({
        id: "ver",
        label: "▶ Ver",
        match: function (g) { return !!buildEmbed(g && g.link); },
        onClick: function (g) {
          var ch = getChannels().find(function (c) { return c.name === g.source; });
          if (ch) state.channelId = ch.id;
          state.videoLink = g.link || "";
          state.videoTitle = g.title || "";
          if (typeof window.pluginOpenSection === "function") window.pluginOpenSection("streaming");
          else ctx.showToast("Abre la sección Streaming para verlo", "info");
        },
      });
      ctx.on("items:hydrate", function (e) {
        if (!e || !e.el || !buildEmbed(e.game && e.game.link)) return;
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
