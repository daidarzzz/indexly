/* IndexLy Plugin
   id: vistas
   name: Vistas+
   version: 1.1.0
   description: Sustituye el toggle de vista por un menú de 5 vistas: Lista, Compacta, Tabla, Cuadrícula y Pósters. Puro CSS sobre el render nativo de IndexLy (usa los propios botones list/grid del host), así que búsqueda, orden, paginación, badges y botones de otros plugins siguen funcionando en todas las vistas. Los Pósters llevan degradado aurora animado con destello sutil, conservando el color propio de cada resultado. Sin configuración.
   permissions: ui, storage
*/
(function () {
  var api = null;

  // Cada vista = base nativa (list|grid, vía los botones del host) + clase CSS opcional
  var VIEWS = [
    { id: "list", label: "Lista", base: "list", cls: "" },
    { id: "dense", label: "Compacta", base: "list", cls: "plxv-dense" },
    { id: "table", label: "Tabla", base: "list", cls: "plxv-table" },
    { id: "grid", label: "Cuadrícula", base: "grid", cls: "" },
    { id: "posters", label: "Pósters", base: "grid", cls: "plxv-posters" },
  ];
  var ICONS = {
    list: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>',
    dense: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 5h16M4 9.5h16M4 14h16M4 18.5h16"/></svg>',
    table: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M11 4v16"/></svg>',
    grid: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    posters: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="3" width="7" height="18" rx="1.5"/><rect x="13" y="3" width="7" height="12" rx="1.5"/></svg>',
  };

  var current = "list";
  var searchSeq = 0;
  var hueObserver = null;

  // ---------- hidratación del hue por card ----------

  // El host pinta cada cover con un gradiente inline determinista del título.
  // Extraemos su hue y lo exponemos como --pl-h para que el CSS de pósters
  // pueda teñir degradado, destello, borde y sombra con el color de cada card.
  function hydrateHues(root) {
    var scope = root || document.getElementById("results");
    if (!scope || !scope.querySelectorAll) return;
    var covers = scope.querySelectorAll(".grid-cover");
    for (var i = 0; i < covers.length; i++) {
      var c = covers[i];
      if (c.getAttribute("data-plxv-h")) continue;
      var m = /hsl\((\d+)/.exec(c.style.background || "");
      if (!m) continue;
      // En la card (no en el cover) para que borde y sombra de hover hereden el hue
      var host = c.closest(".grid-card") || c;
      host.style.setProperty("--pl-h", m[1]);
      c.setAttribute("data-plxv-h", "1");
    }
  }

  function ensureHueObserver() {
    if (hueObserver || typeof MutationObserver === "undefined") return;
    var results = document.getElementById("results");
    if (!results) return;
    hueObserver = new MutationObserver(function () { hydrateHues(); });
    hueObserver.observe(results, { childList: true, subtree: true });
  }

  function viewById(id) {
    for (var i = 0; i < VIEWS.length; i++) if (VIEWS[i].id === id) return VIEWS[i];
    return VIEWS[0];
  }

  // ---------- estilos ----------

  function ensureStyles() {
    if (document.getElementById("plxv-styles")) return;
    var s = document.createElement("style");
    s.id = "plxv-styles";
    s.textContent = [
      // El toggle nativo se sustituye por el menú del plugin
      ".view-toggle { display: none !important; }",
      ".plxv-seg { display: flex; align-items: center; gap: 2px; }",
      ".plxv-seg-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; background: transparent; border: none; border-radius: 999px; color: #64748b; cursor: pointer; transition: background .15s, color .15s; }",
      ".plxv-seg-btn:hover { color: #cbd5e1; background: rgba(255,255,255,0.04); }",
      ".plxv-seg-btn.active { background: #fff; color: #0f172a; box-shadow: 0 1px 6px rgba(0,0,0,0.15); }",
      ".plxv-seg-btn:focus-visible { outline: 1px solid #0ea5e9; outline-offset: 2px; }",
      "@media (max-width: 640px) { .plxv-seg { order: 3; width: 100%; } .plxv-seg-btn { flex: 1; height: 32px; } }",

      // Vista Compacta — filas apretadas para escanear rápido
      "#results.plxv-dense { gap: 6px; }",
      "#results.plxv-dense .game-card { padding: 6px 10px; border-radius: 10px; }",
      "#results.plxv-dense .game-card h3 { font-size: 13px; -webkit-line-clamp: 1; }",
      "#results.plxv-dense .game-subtitle, #results.plxv-dense .game-meta { display: none; }",
      "#results.plxv-dense .magnet-link { padding: 5px 10px; font-size: 12px; }",

      // Vista Tabla — columnas alineadas, acción siempre visible
      "#results.plxv-table { gap: 4px; }",
      "#results.plxv-table .game-card { align-items: center; padding: 7px 12px; border-radius: 10px; }",
      "#results.plxv-table .game-info-container { display: flex; align-items: center; gap: 12px; min-width: 0; }",
      "#results.plxv-table .game-card h3 { flex: 1; min-width: 0; margin: 0; font-size: 13.5px; -webkit-line-clamp: 1; }",
      "#results.plxv-table .game-subtitle { display: none; }",
      "#results.plxv-table .game-meta { margin: 0; flex-shrink: 0; }",
      "#results.plxv-table .magnet-link, #results.plxv-table .no-magnet { opacity: 1; visibility: visible; transform: none; pointer-events: auto; }",

      // Vista Pósters — escaparate con covers grandes y degradado "aurora".
      // El hue por card (--pl-h) lo hidrata el JS a partir del gradiente inline
      // nativo: cada póster conserva su color propio sin tocar el host.
      "#results.plxv-posters { gap: 14px; }",
      "#results.plxv-posters .grid-cover { height: 190px; background: radial-gradient(120% 150% at 85% -10%, hsl(var(--pl-h, 210) 90% 60% / 0.55), transparent 55%), radial-gradient(120% 140% at 0% 110%, hsl(calc(var(--pl-h, 210) + 60) 75% 45% / 0.40), transparent 60%), linear-gradient(165deg, hsl(var(--pl-h, 210) 40% 13%), hsl(calc(var(--pl-h, 210) + 30) 50% 8%)) !important; transition: transform .35s ease; }",
      "#results.plxv-posters .grid-card:hover .grid-cover { transform: scale(1.04); }",
      // Destello sutil que cruza el cover en bucle (::before está libre en el host)
      "#results.plxv-posters .grid-cover::before { content: \"\"; position: absolute; top: 0; bottom: 0; left: 0; width: 60%; background: linear-gradient(100deg, transparent, hsl(var(--pl-h, 210) 90% 80% / 0.12) 45%, hsl(calc(var(--pl-h, 210) + 40) 90% 85% / 0.10) 55%, transparent); filter: blur(6px); transform: translateX(-110%) skewX(-14deg); animation: plxv-sheen 9s ease-in-out infinite; pointer-events: none; }",
      "@keyframes plxv-sheen { 0% { transform: translateX(-110%) skewX(-14deg); } 55%, 100% { transform: translateX(320%) skewX(-14deg); } }",
      // En hover, glow superior teñido del hue (sustituye al patrón de puntos nativo)
      "#results.plxv-posters .grid-cover::after { -webkit-mask-image: none; mask-image: none; background: radial-gradient(90% 70% at 50% 0%, hsl(var(--pl-h, 210) 80% 70% / 0.20), transparent 70%); opacity: 0; transition: opacity .35s ease; }",
      "#results.plxv-posters .grid-card:hover .grid-cover::after { opacity: 1; }",
      // Hover de la card: lift + sombra y borde teñidos del hue propio
      "#results.plxv-posters .grid-card:hover { transform: translateY(-4px); border-color: hsl(var(--pl-h, 210) 60% 55% / 0.45); box-shadow: 0 18px 40px hsl(var(--pl-h, 210) 70% 28% / 0.35); }",
      "@media (prefers-reduced-motion: reduce) { #results.plxv-posters .grid-cover::before { animation: none; display: none; } #results.plxv-posters .grid-card:hover, #results.plxv-posters .grid-card:hover .grid-cover { transform: none; } }",
      "#results.plxv-posters .grid-cover__initial { width: 56px; height: 56px; font-size: 24px; border-radius: 14px; }",
      "#results.plxv-posters .grid-body { gap: 8px; }",
      "#results.plxv-posters .grid-title { font-size: 15.5px; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }",
      "#results.plxv-posters .grid-subtitle { white-space: normal; }",
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---------- mecánica ----------

  // Cambia la base nativa clicando los PROPIOS botones del host: así el orden,
  // la paginación, el sync de URL y la persistencia de IndexLy siguen mandando.
  function hostClick(base) {
    var btn = document.querySelector('.view-btn[data-view="' + base + '"]');
    if (btn && !btn.classList.contains("active")) btn.click();
  }

  function syncSegButtons() {
    var seg = document.getElementById("plxv-seg");
    if (!seg) return;
    Array.prototype.forEach.call(seg.children, function (b) {
      var on = b.getAttribute("data-plxv") === current;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function applyView(id, persist) {
    var v = viewById(id);
    current = v.id;
    hostClick(v.base);
    // El render del host sustituye hijos de #results pero nunca su clase de
    // contenedor: las clases de vista persisten sin hooks de render.
    var results = document.getElementById("results");
    if (results) {
      results.classList.remove("plxv-dense", "plxv-table", "plxv-posters");
      if (v.cls) results.classList.add(v.cls);
    }
    if (v.cls === "plxv-posters") {
      ensureHueObserver();
      hydrateHues();
    }
    syncSegButtons();
    if (persist !== false) api.storage.set("view", v.id).catch(function () {});
  }

  // Menú inyectado en .controls justo donde estaba el toggle nativo (idempotente)
  function ensureSeg() {
    var controls = document.querySelector(".controls");
    if (!controls) return;
    var seg = document.getElementById("plxv-seg");
    if (!seg) {
      seg = document.createElement("div");
      seg.id = "plxv-seg";
      seg.className = "plxv-seg";
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", "Vista de resultados");
      VIEWS.forEach(function (v) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "plxv-seg-btn";
        b.setAttribute("data-plxv", v.id);
        b.title = "Vista: " + v.label;
        b.setAttribute("aria-label", v.label);
        b.setAttribute("aria-pressed", "false");
        b.innerHTML = ICONS[v.id]; // SVG estático del propio plugin
        b.addEventListener("click", function () { applyView(v.id); });
        seg.appendChild(b);
      });
      controls.appendChild(seg);
    }
    syncSegButtons();
  }

  IndexLy.register({
    setup: function (ctx) {
      api = ctx;
      ensureStyles();
      ensureSeg();
      // Red de seguridad: si .controls se reconstruyera, el menú se re-inyecta solo
      ctx.on("state:change", ensureSeg);
      // Restaura la vista guardada (sin re-persistir)
      ctx.storage.get("view").then(function (v) {
        applyView(viewById(v).id, false);
      }).catch(function () { applyView("list", false); });
    },
  });
})();
