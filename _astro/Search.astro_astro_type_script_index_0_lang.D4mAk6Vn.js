function e(e){let t=e.name||`Fuente Desconocida`;return(e.downloads||[]).map((e,n)=>({id:`${t}-${n}`,source:t,title:e.title||`Sin título`,fileSize:e.fileSize?e.fileSize.trim():`Tamaño desconocido`,uploadDate:e.uploadDate||``,link:e.uris&&e.uris.length>0?e.uris[0]:``}))}function t(e){return new Promise((t,n)=>{e.oncomplete=e.onsuccess=()=>t(e.result),e.onabort=e.onerror=()=>n(e.error)})}function n(e,n){let r,i=()=>{if(r)return r;let i=indexedDB.open(e);return i.onupgradeneeded=()=>i.result.createObjectStore(n),r=t(i),r.then(e=>{e.onclose=()=>r=void 0},()=>{r=void 0}),r};return(e,t)=>i().then(r=>t(r.transaction(n,e).objectStore(n)))}var r;function i(){return r||=n(`keyval-store`,`keyval`),r}function a(e,n=i()){return n(`readonly`,n=>t(n.get(e)))}function o(e,n,r=i()){return r(`readwrite`,r=>(r.put(n,e),t(r.transaction)))}var s=[],c=[],l=50,u=document.getElementById(`json-input`),d=document.getElementById(`search-input`),f=document.getElementById(`results`),p=document.getElementById(`indexes-list`),m=document.getElementById(`load-more-btn`),h=document.getElementById(`stats-container`);async function g(){try{let t=await a(`indexly_saved_indexes`);t&&(s=t.map(t=>{let n=e(t.rawData);return{id:t.id,name:t.name,active:t.active,rawData:t.rawData,games:n}}),s.length>0&&d.removeAttribute(`disabled`))}catch(e){console.error(`Error al cargar los índices desde IndexedDB:`,e)}v()}async function _(){try{await o(`indexly_saved_indexes`,s.map(e=>({id:e.id,name:e.name,active:e.active,rawData:e.rawData})))}catch(e){console.error(`Error al guardar en IndexedDB:`,e),alert(`⚠️ Hubo un error al guardar los índices en la base de datos del navegador.`)}}u.addEventListener(`change`,async t=>{let n=t.target;if(!n.files||n.files.length===0)return;let r=Array.from(n.files);n.value=``;let i=0,a=[];for(let t of r)try{let n=await t.text(),r=JSON.parse(n),o=e(r),c=r.name||t.name.replace(`.json`,``);if(s.some(e=>e.name.toLowerCase()===c.toLowerCase())){a.push(c);continue}let l={id:Date.now().toString()+Math.random().toString(36).substring(2,7),name:c,active:!0,rawData:r,games:o};s.push(l),i++}catch(e){console.error(`Error al procesar el archivo ${t.name}:`,e),alert(`❌ Error al procesar "${t.name}". Revisa la consola (F12).`)}a.length>0&&alert(`⚠️ Los siguientes índices ya estaban cargados y se han omitido:\n• ${a.join(`
• `)}`),i>0&&(d.removeAttribute(`disabled`),await _(),v())}),window.toggleIndex=async function(e){let t=s.find(t=>t.id===e);t&&(t.active=!t.active,await _(),v())},window.removeIndex=async function(e){s=s.filter(t=>t.id!==e),s.length===0&&(d.setAttribute(`disabled`,`true`),d.value=``),await _(),v()};function v(){y();let e=[];s.forEach(t=>{t.active&&(e=e.concat(t.games))});let t=d.value.toLowerCase();c=t.trim()===``?e:e.filter(e=>e.title.toLowerCase().includes(t)),l=50,x()}function y(){if(s.length===0){p.innerHTML=`<div class="empty-state"><div class="empty-icon">◇</div><p class="no-indexes">Sin fuentes aún.<br><span>Sube uno o varios .json para empezar.</span></p></div>`;return}p.innerHTML=s.map(e=>`
      <div class="index-pill ${e.active?`active`:`inactive`}">
        <div class="index-pill-info">
          <span class="status-dot"></span>
          <div class="index-text">
            <strong>${b(e.name)}</strong>
            <small>${e.games.length} juegos</small>
          </div>
        </div>
        <div class="index-pill-actions">
          <button class="action-btn toggle" onclick="toggleIndex('${e.id}')" title="${e.active?`Desactivar`:`Activar`}">
            ${e.active?`Desactivar`:`Activar`}
          </button>
          <button class="action-btn delete" onclick="removeIndex('${e.id}')" title="Eliminar índice" aria-label="Eliminar">
            ✕
          </button>
        </div>
      </div>
    `).join(``)}function b(e){let t=document.createElement(`div`);return t.textContent=e,t.innerHTML}function x(){if(s.length===0){f.innerHTML=``,h.innerHTML=``,m.style.display=`none`,d.placeholder=`Sube un JSON arriba para empezar...`;return}let e=c.length;if(d.placeholder=`Buscar entre ${e} juegos…`,e===0){let e=d.value.trim();f.innerHTML=`<div class="empty-results"><p class="no-results">${e?`Sin resultados para “${b(e)}”`:`No hay juegos en los índices activos.`}</p><span>Prueba con otro término o activa más fuentes.</span></div>`,h.innerHTML=``,m.style.display=`none`;return}h.innerHTML=`<span class="stats-dot"></span> Mostrando <strong>${Math.min(l,e)}</strong> de <strong>${e}</strong> resultados`,f.innerHTML=c.slice(0,l).map(e=>`
      <div class="game-card">
        <div class="game-info-container">
          <h3>${b(e.title)}</h3>
          <p class="game-meta">
            <span class="source-badge">${b(e.source)}</span>
            <span class="meta-dot">·</span>
            <span>${b(e.fileSize)}</span>
          </p>
        </div>
        ${e.link?`<a href="${b(e.link)}" target="_blank" rel="noopener" class="magnet-link">Descargar <span aria-hidden="true">↗</span></a>`:`<span class="no-magnet">Sin enlace</span>`}
      </div>
    `).join(``),m.style.display=l<e?`inline-flex`:`none`}d.addEventListener(`input`,()=>v()),m.addEventListener(`click`,()=>{l+=50,x()}),document.addEventListener(`keydown`,e=>{e.key===`/`&&document.activeElement!==d&&!e.ctrlKey&&!e.metaKey&&(e.preventDefault(),d.focus())}),g();