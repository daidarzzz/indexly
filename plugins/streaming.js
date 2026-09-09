/* IndexLy Plugin
   id: streaming-demo
    name: Streaming
    version: 2.1.0
    description: Página de Streaming con canales: marca índices como "de streaming" en su mapeo, elige canal en la barra lateral izquierda y reproduce con iframe (YouTube, Vimeo, Twitch, Dailymotion, mp4…) o botón al enlace externo. Con carátulas, modo cine y pantalla completa automática.
   permissions: network, ui, storage
*/
(function () {
  var api = null;
  var pageRoot = null; // contenedor de la sección (lo fija renderPage)
  var state = { channelId: null, videoLink: null, videoTitle: null, justOpened: false, fsAuto: true };
  var fsBound = false;

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
    if (m) return { type: "iframe", platform: "youtube", label: "YouTube", src: "https://www.youtube-nocookie.com/embed/" + m[1] + "?autoplay=1&rel=0" };
    m = link.match(VIMEO_RE);
    if (m) return { type: "iframe", platform: "vimeo", label: "Vimeo", src: "https://player.vimeo.com/video/" + m[1] + "?autoplay=1" };
    m = link.match(DM_RE);
    if (m) return { type: "iframe", platform: "dailymotion", label: "Dailymotion", src: "https://geo.dailymotion.com/player.html?video=" + m[1] };
    m = link.match(TW_VID_RE);
    if (m) return { type: "iframe", platform: "twitch", label: "Twitch", src: "https://player.twitch.tv/?video=" + m[1] + "&parent=" + location.hostname + "&autoplay=true" };
    m = link.match(TW_CHAN_RE);
    if (m) return { type: "iframe", platform: "twitch", label: "Twitch", src: "https://player.twitch.tv/?channel=" + m[1] + "&parent=" + location.hostname + "&autoplay=true" };
    if (FILE_RE.test(link)) return { type: "video", platform: "file", label: "Directo", src: link };
    if (/^https?:\/\//i.test(link)) {
      if (NOEMBED_RE.test(link)) return { type: "external", platform: "external", label: "Externo", src: link };
      // intento de iframe genérico: algunos sitios bloquean incrustación (X-Frame-Options)
      return { type: "iframe", platform: "generic", label: "Web", src: link, risky: true };
    }
    return null;
  }

  // ---------- carátulas 100% locales (sin red extra) ----------

  function hueFor(s) {
    var h = 0;
    var str = String(s || "x");
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  // Identidad de "canal" por plataforma: color de marca (apagado) + glifo.
  // Lo genérico usa el eléctrico de IndexLy para que también se vea de la casa.
  var PLAT_STYLE = {
    youtube: { color: "#f87171", glyph: "▶" },
    vimeo: { color: "#38bdf8", glyph: "V" },
    dailymotion: { color: "#818cf8", glyph: "D" },
    twitch: { color: "#a78bfa", glyph: "T" },
    file: { color: "#34d399", glyph: "⬇" },
    external: { color: "#fbbf24", glyph: "↗" },
    generic: { color: "#0ea5e9", glyph: "◉" },
  };

  function thumbArt(platform, title) {
    var st = PLAT_STYLE[platform] || PLAT_STYLE.generic;
    var h = hueFor(String(title) + "|" + platform);
    var side = (h % 2 === 0) ? "18%" : "82%";
    return {
      color: st.color,
      glyph: st.glyph,
      bg: "radial-gradient(90% 110% at " + side + " 0%, " + st.color + "33 0%, transparent 55%)," +
        "radial-gradient(120% 100% at 50% 0%, hsl(" + hueFor(title) + " 24% 20%) 0%, #0b101c 72%)",
    };
  }

  function platPill(platform, label) {
    var st = PLAT_STYLE[platform] || PLAT_STYLE.generic;
    var s = el("span", "strm-kind", label || platform || "Web");
    s.style.color = st.color;
    s.style.borderColor = st.color + "40";
    s.style.background = st.color + "14";
    return s;
  }

  // ---------- pantalla completa ----------

  function currentStage() { return pageRoot ? pageRoot.querySelector(".strm-stage") : null; }

  function syncFsBtn() {
    if (!pageRoot) return;
    var b = pageRoot.querySelector("#strm-fs-btn");
    if (!b) return;
    var on = !!(document.fullscreenElement || document.webkitFullscreenElement) ||
      (currentStage() && currentStage().classList.contains("strm-pseudo-fs"));
    b.textContent = on ? "⛶ Salir" : "⛶ Pantalla completa";
  }

  function onFsChange() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      try { document.body.style.overflow = ""; } catch (e) {}
    }
    syncFsBtn();
  }

  function enterPseudoFs(stageEl) {
    var st = stageEl || currentStage();
    if (!st || st.classList.contains("strm-pseudo-fs")) return;
    st.classList.add("strm-pseudo-fs");
    try { document.body.style.overflow = "hidden"; } catch (e) {}
    syncFsBtn();
  }

  function exitFsSilent() {
    try {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (e) {}
    var st = currentStage();
    if (st) st.classList.remove("strm-pseudo-fs");
    try { document.body.style.overflow = ""; } catch (e) {}
  }

  function enterFs() {
    var st = currentStage();
    if (!st) return;
    if (st.classList.contains("strm-pseudo-fs") || document.fullscreenElement === st) return;
    try {
      if (st.requestFullscreen) {
        var p = st.requestFullscreen();
        if (p && p.catch) p.catch(function () { if (!document.fullscreenElement) enterPseudoFs(st); });
      } else if (st.webkitRequestFullscreen) st.webkitRequestFullscreen();
      else enterPseudoFs(st);
    } catch (e) { enterPseudoFs(st); }
  }

  function toggleFs() {
    var st = currentStage();
    var pseudo = st && st.classList.contains("strm-pseudo-fs");
    if (document.fullscreenElement || document.webkitFullscreenElement || pseudo) {
      exitFsSilent();
      syncFsBtn();
    } else enterFs();
  }

  function tryAutoFs(stageEl) {
    if (!state.fsAuto || !stageEl) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    enterFs();
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
      ".strm-page{display:flex;gap:14px;align-items:stretch;min-height:520px}",
      ".strm-side{width:224px;flex-shrink:0;display:flex;flex-direction:column;gap:6px}",
      ".strm-side-title{font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;padding:4px 2px}",
      ".strm-chan{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#0a0f1c;border:1px solid #1e293b;border-radius:12px;padding:9px 10px;color:#e2e8f0;font-size:12.5px;font-weight:500;cursor:pointer;transition:background .15s,border-color .15s,transform .15s;box-shadow:0 2px 8px rgba(0,0,0,0.2);font-family:inherit}",
      ".strm-chan:hover{background:#0d1528;border-color:#24344f;transform:translateY(-1px)}",
      ".strm-chan.active{background:rgba(14,165,233,0.12);border-color:rgba(14,165,233,0.4);color:#fff;box-shadow:0 0 0 1px rgba(14,165,233,0.15),0 4px 14px rgba(0,0,0,0.3)}",
      ".strm-chan-avatar{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-size:14px;font-weight:800;color:#fff;flex-shrink:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.16);text-shadow:0 1px 6px rgba(0,0,0,0.5)}",
      ".strm-chan.active .strm-chan-avatar{border-color:rgba(14,165,233,0.5)}",
      ".strm-chan-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".strm-chan-count{font-size:10px;font-family:var(--font-mono,monospace);color:#64748b;flex-shrink:0}",
      ".strm-chan-off{font-size:9px;color:#f59e0b;flex-shrink:0}",
      ".strm-side-hint{font-size:11px;color:#64748b;line-height:1.5;padding:8px 2px}",
      ".strm-side-foot{margin-top:auto;padding-top:10px;display:flex;flex-direction:column;gap:6px}",
      ".strm-side-foot .strm-btn{width:100%}",
      ".strm-btn.on{color:#7dd3fc;border-color:rgba(14,165,233,0.4);background:rgba(14,165,233,0.1)}",
      ".strm-btn{background:transparent;border:1px solid #1e293b;border-radius:999px;color:#94a3b8;padding:7px 12px;font-size:11.5px;font-weight:600;cursor:pointer;transition:all .15s}",
      ".strm-btn:hover{background:#152033;color:#e2e8f0;border-color:#24344f}",
      ".strm-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".strm-btn-primary{background:#fff;border-color:#fff;color:#0f172a}",
      ".strm-btn-primary:hover{background:#f1f5f9;color:#0f172a}",
      ".strm-main{flex:1;min-width:0;background:linear-gradient(180deg,#0d1424 0%,#0a0f1c 100%);border:1px solid #1e293b;border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:14px;box-shadow:0 4px 14px rgba(0,0,0,0.25)}",
      ".strm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".strm-head h4{margin:0;font-size:15px;font-weight:600;color:#f1f5f9;letter-spacing:-0.01em}",
      ".strm-head small{font-size:11px;color:#64748b}",
      ".strm-spacer{flex:1}",
      "@keyframes strmFadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
      ".strm-anim{animation:strmFadeUp .3s ease both}",
      "@media (prefers-reduced-motion:reduce){.strm-anim{animation:none}.strm-card,.strm-thumb-play{transition:none}}",
      ".strm-vids{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;overflow:auto;padding:2px}",
      ".strm-card{position:relative;background:linear-gradient(180deg,#10151f 0%,#0d1320 100%);border:1px solid #1a2332;border-radius:14px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;box-shadow:0 4px 14px rgba(0,0,0,0.28);transition:transform .2s cubic-bezier(.2,.7,.3,1),border-color .2s,box-shadow .2s;min-width:0}",
      ".strm-card:hover{transform:translateY(-3px);border-color:var(--plat,#24344f);box-shadow:0 14px 30px rgba(0,0,0,0.5),0 0 0 1px var(--plat,#24344f)}",
      ".strm-card:focus-visible{outline:2px solid #0ea5e9;outline-offset:2px}",
      ".strm-thumb{position:relative;aspect-ratio:16/9;overflow:hidden;background:#0b111e;display:flex;align-items:center;justify-content:center;flex-shrink:0}",
      ".strm-thumb::before{content:\"\";position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,0.1) 1px,transparent 1px);background-size:13px 13px;mask-image:linear-gradient(180deg,black,transparent 82%);-webkit-mask-image:linear-gradient(180deg,black,transparent 82%);pointer-events:none}",
      ".strm-thumb-wm{position:absolute;right:-6px;bottom:-24px;font-size:84px;font-weight:800;line-height:1;color:var(--plat,#0ea5e9);opacity:.16;pointer-events:none;user-select:none;font-family:inherit}",
      ".strm-thumb-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(.9);width:40px;height:40px;border-radius:50%;background:#f1f5f9;color:#0f172a;display:grid;place-items:center;font-size:13px;padding-left:2px;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;z-index:1}",
      ".strm-card:hover .strm-thumb-play,.strm-card:focus-visible .strm-thumb-play{opacity:1;transform:translate(-50%,-50%) scale(1)}",
      "@media (hover:none){.strm-thumb-play{display:none}}",
      ".strm-card-body{padding:10px 11px 11px;display:flex;flex-direction:column;gap:4px;align-items:flex-start;flex:1;min-width:0}",
      ".strm-card-body strong{font-size:12.5px;font-weight:600;color:#f1f5f9;letter-spacing:-0.01em;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".strm-card-body small{font-size:10.5px;color:#8b94a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}",
      ".strm-kind{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;padding:2px 7px;border-radius:999px;border:1px solid;width:max-content}",
      ".strm-empty{margin:auto;text-align:center;color:#64748b;font-size:12.5px;line-height:1.6;max-width:44ch;padding:30px 10px}",
      ".strm-title-xl{margin:0;font-size:20px;font-weight:800;letter-spacing:-0.02em;line-height:1.25;color:#f8fafc}",
      ".strm-meta{margin:0;font-size:12px;font-weight:500;color:#8b94a5}",
      ".strm-stage{position:relative;border-radius:16px;overflow:hidden;border:1px solid #1a2332;background:#000;flex-shrink:0;box-shadow:0 18px 50px rgba(0,0,0,0.5),0 0 80px rgba(14,165,233,0.06)}",
      ".strm-player{position:relative;padding-top:56.25%;background:#000}",
      ".strm-player iframe{position:absolute;inset:0;width:100%;height:100%;border:0}",
      ".strm-video{width:100%;aspect-ratio:16/9;background:#000;display:block;border:0}",
      ".strm-caption{margin:0;font-size:12px;color:#64748b}",
      ".strm-fallback{border:1px dashed rgba(251,191,36,0.3);background:rgba(251,191,36,0.05);border-radius:16px;padding:28px 22px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}",
      ".strm-fallback p{margin:0;font-size:13px;font-weight:600;color:#fbbf24;line-height:1.5}",
      ".strm-fallback small{color:#64748b;font-size:11px}",
      ".strm-pseudo-fs{position:fixed!important;inset:0!important;z-index:90!important;background:#000!important;border-radius:0!important;border:0!important;box-shadow:none!important;padding:14px!important;display:flex!important;flex-direction:column!important;gap:10px!important}",
      ".strm-pseudo-fs .strm-player{flex:1;min-height:0;padding-top:0}",
      ".strm-pseudo-fs .strm-video{flex:1;min-height:0;aspect-ratio:auto;object-fit:contain}",
      ".strm-fs-close{display:none;position:absolute;top:22px;right:22px;z-index:5;width:36px;height:36px;place-items:center;background:rgba(7,10,18,0.7);border:1px solid rgba(255,255,255,0.2);color:#e2e8f0;border-radius:50%;font-size:15px;cursor:pointer;font-family:inherit}",
      ".strm-pseudo-fs .strm-fs-close{display:grid}",
      "@media (max-width:640px){.strm-page{flex-direction:column}.strm-side{width:100%;flex-direction:row;overflow-x:auto;padding-bottom:4px}.strm-side-title,.strm-side-hint{display:none}.strm-side-foot{display:contents}.strm-side-foot .strm-btn{width:auto;flex-shrink:0;min-height:38px}.strm-chan{width:auto;flex-shrink:0}.strm-chan-avatar{width:30px;height:30px}.strm-main{padding:14px}.strm-vids{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}.strm-title-xl{font-size:17px}.strm-thumb-wm{font-size:64px;bottom:-18px}}",
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
    state.justOpened = true;
    rerender();
  }

  // ---------- vistas ----------

  function renderSidebar(side) {
    side.innerHTML = "";
    side.appendChild(el("div", "strm-side-title", "Canales"));
    var chans = getChannels();
    if (!chans.length) {
      side.appendChild(el("p", "strm-side-hint", "Sin canales. Abre el mapeo de un índice (icono de ajustes) y activa el interruptor «Es un índice de streaming»."));
    }
    chans.forEach(function (ch) {
      var btn = el("button", "strm-chan" + (state.channelId === ch.id ? " active" : ""));
      btn.type = "button";
      var av = el("span", "strm-chan-avatar", (ch.name || "?").charAt(0).toUpperCase());
      av.style.background = thumbArt("generic", ch.name).bg;
      btn.appendChild(av);
      btn.appendChild(el("span", "strm-chan-name", ch.name));
      if (!ch.active) btn.appendChild(el("span", "strm-chan-off", "inactiva"));
      btn.appendChild(el("span", "strm-chan-count", String(playableCount(ch))));
      btn.addEventListener("click", function () {
        exitFsSilent();
        state.channelId = ch.id;
        state.videoLink = null;
        state.videoTitle = null;
        rerender();
      });
      side.appendChild(btn);
    });
    var foot = el("div", "strm-side-foot");
    var fsT = el("button", "strm-btn" + (state.fsAuto ? " on" : ""), "⛶ FS automática");
    fsT.type = "button";
    fsT.title = "Pantalla completa automática al abrir un stream";
    fsT.addEventListener("click", function () {
      state.fsAuto = !state.fsAuto;
      api.storage.set("str_auto_fs", state.fsAuto).catch(function () {});
      fsT.className = "strm-btn" + (state.fsAuto ? " on" : "");
    });
    foot.appendChild(fsT);
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
    var grid = el("div", "strm-vids strm-anim");
    games.forEach(function (g) {
      var emb = buildEmbed(g.link);
      var art = thumbArt(emb.platform, g.title);
      var card = el("article", "strm-card");
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", (g.title || "Sin título") + " — reproducir");
      card.style.setProperty("--plat", art.color);
      var th = el("div", "strm-thumb");
      th.style.background = art.bg;
      var wm = el("span", "strm-thumb-wm", art.glyph);
      wm.setAttribute("aria-hidden", "true");
      th.appendChild(wm);
      var play = el("span", "strm-thumb-play", "▶");
      play.setAttribute("aria-hidden", "true");
      th.appendChild(play);
      card.appendChild(th);
      var cb = el("div", "strm-card-body");
      cb.appendChild(platPill(emb.platform, emb.label));
      cb.appendChild(el("strong", "", g.title || "Sin título"));
      var sub = [];
      if (g.subtitle) sub.push(g.subtitle);
      if (g.meta && g.meta.tipo) sub.push(g.meta.tipo);
      if (sub.length) cb.appendChild(el("small", "", sub.join(" · ")));
      card.appendChild(cb);
      var open = function () { openVideo(channel, g); };
      card.addEventListener("click", open);
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
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
    var embTop = buildEmbed(state.videoLink);
    var head = el("div", "strm-head");
    var back = el("button", "strm-btn", "← " + channel.name);
    back.type = "button";
    back.addEventListener("click", function () {
      exitFsSilent();
      state.videoLink = null;
      state.videoTitle = null;
      rerender();
    });
    head.appendChild(back);
    head.appendChild(el("span", "strm-spacer"));
    var fsBtn = el("button", "strm-btn", "⛶ Pantalla completa");
    fsBtn.type = "button";
    fsBtn.id = "strm-fs-btn";
    fsBtn.addEventListener("click", toggleFs);
    head.appendChild(fsBtn);
    var extTop = el("button", "strm-btn", "Abrir externo ↗");
    extTop.type = "button";
    extTop.addEventListener("click", function () { api.openLink(state.videoLink); });
    head.appendChild(extTop);
    main.appendChild(head);
    main.appendChild(el("h2", "strm-title-xl", state.videoTitle || "Reproduciendo"));
    main.appendChild(el("p", "strm-meta", channel.name + (embTop ? " · " + embTop.label : "")));

    var emb = embTop;
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
      var stageV = el("div", "strm-stage strm-anim");
      var v = document.createElement("video");
      v.className = "strm-video";
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      v.preload = "metadata";
      v.src = emb.src;
      stageV.appendChild(v);
      var closeV = el("button", "strm-fs-close", "✕");
      closeV.type = "button";
      closeV.setAttribute("aria-label", "Salir de pantalla completa");
      closeV.addEventListener("click", toggleFs);
      stageV.appendChild(closeV);
      main.appendChild(stageV);
      main.appendChild(el("p", "strm-caption", "Vídeo directo · se abre en pantalla completa automáticamente (desactívalo en la barra lateral)."));
      if (state.justOpened) { state.justOpened = false; tryAutoFs(stageV); } else syncFsBtn();
      return;
    }
    if (emb.type === "external") {
      main.appendChild(fallbackPanel("Este enlace no se puede incrustar aquí.", state.videoLink));
      return;
    }
    // iframe (YouTube/Vimeo/Twitch/Dailymotion/intento genérico)
    var linkAtOpen = state.videoLink;
    var stage = el("div", "strm-stage strm-anim");
    var wrap = el("div", "strm-player");
    var frame = document.createElement("iframe");
    frame.src = emb.src;
    frame.title = state.videoTitle || "Reproductor";
    frame.allowFullscreen = true;
    frame.setAttribute("allow", "autoplay; fullscreen; encrypted-media; picture-in-picture");
    frame.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
    var loaded = false;
    frame.addEventListener("load", function () { loaded = true; });
    wrap.appendChild(frame);
    stage.appendChild(wrap);
    var close = el("button", "strm-fs-close", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Salir de pantalla completa");
    close.addEventListener("click", toggleFs);
    stage.appendChild(close);
    main.appendChild(stage);
    var note = el("p", "strm-caption", emb.risky
      ? "Intentando incrustar el enlace. Si el sitio lo bloquea, usa «Abrir externo»."
      : "Reproduciendo incrustado · se abre en pantalla completa automáticamente (desactívalo en la barra lateral).");
    main.appendChild(note);
    if (state.justOpened) { state.justOpened = false; tryAutoFs(stage); } else syncFsBtn();
    // Watchdog: si el iframe no dispara load en 7s, muestra el panel de fallback
    setTimeout(function () {
      if (!loaded && state.videoLink === linkAtOpen && wrap.isConnected) {
        exitFsSilent();
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
      empty.innerHTML = "Selecciona un canal en la barra lateral.<br>Si no hay ninguno, marca un índice como «de streaming» en su mapeo.";
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
      api.storage.get("str_auto_fs").then(function (v) {
        state.fsAuto = v !== false;
        if (pageRoot) rerender();
      }).catch(function () {});
      if (!fsBound) {
        fsBound = true;
        document.addEventListener("fullscreenchange", onFsChange);
        if ("onwebkitfullscreenchange" in document) document.addEventListener("webkitfullscreenchange", onFsChange);
      }
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
          state.justOpened = true;
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
