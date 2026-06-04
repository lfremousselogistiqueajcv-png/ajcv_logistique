// ════════════════════════════════════════
// CONFIG — À modifier
// ════════════════════════════════════════
const CFG = {
  API_URL:  'https://script.google.com/macros/s/AKfycbyQdrBxSQaDvgS2Q-ZcXoL-cRgK26FEaQ4CN-HG-FFovZhtIdDfoqbR8zngmVhQk-wpgA/exec',
  API_KEY:  'AJCV974REUNION',
  DEPOT:    { lat: -21.372694, lng: 55.602137 },
  REFRESH:  30 * 60 * 1000, // 30 min — le cache affiche les données instantanément
};

// ════════════════════════════════════════
// MODE APPS SCRIPT HTML vs DRIVE
// ════════════════════════════════════════
const GSR = typeof google !== 'undefined' && google.script && google.script.run;

// Appel serveur unifié : google.script.run (Apps Script) ou fetch (Drive)
function gsRun(fnName, args) {
  return new Promise((resolve, reject) => {
    if (GSR) {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(e => reject(new Error(e.message || String(e))))
        [fnName](...(Array.isArray(args) ? args : [args]));
    } else {
      reject(new Error('Mode Drive — utiliser fetch'));
    }
  });
}

// ════════════════════════════════════════
// ÉTAT
// ════════════════════════════════════════
let state = {
  livreur: null, zone: null, code: null,
  livraisons: [], livActive: null,
  activeTab: 'livraisons',
  ordreOptimise: null, routeInfo: null,
  lastCount: 0, mapInited: false,
};
let map, markersLayer;

// ════════════════════════════════════════
// SPLASH + INIT
// ════════════════════════════════════════
setTimeout(() => {
  document.getElementById('splash').classList.add('hidden');
  try {
    const saved = localStorage.getItem('ajcv_session');
    if (saved) {
      const s = JSON.parse(saved);
      // Vérifier expiration STRICTE — déconnexion si expiré
      if (s.token && s.tokenExpiry && Date.now() < s.tokenExpiry) {
        Object.assign(state, s);
        // Si livreur sans zone sauvegardée → sélecteur
        if (state.role === 'Livreur' && !state.zone) {
          afficherSelecteurZone();
        } else {
          lancerApp();
        }
        return;
      } else {
        // Token expiré → déconnexion forcée
        try { localStorage.removeItem('ajcv_session'); } catch(_) {}
        console.log('Session expirée — reconnexion requise');
      }
    }
  } catch(_) {
    // localStorage bloqué dans iframe — aller au login
  }
  // Pré-remplir login/MDP si sauvegardés
  try {
    const creds = localStorage.getItem('ajcv_credentials');
    if (creds) {
      const { login: savedLogin, mdp: savedMdp } = JSON.parse(creds);
      const loginInput = document.getElementById('loginInput');
      const mdpInput   = document.getElementById('mdpInput');
      const remember   = document.getElementById('rememberMdp');
      if (loginInput && savedLogin) loginInput.value = savedLogin;
      if (mdpInput   && savedMdp)   mdpInput.value   = savedMdp;
      if (remember) remember.checked = true;
      checkLogin();
    }
  } catch(_) {}
  document.getElementById('login').classList.add('active');
}, 1500);

// ════════════════════════════════════════
// LOGIN
// ════════════════════════════════════════
function selectLivreur(el, nom) {
  document.querySelectorAll('.livreur-btn').forEach(b => b.classList.remove('sel'));
  el.classList.add('sel');
  state.livreur = nom;
  checkLogin();
}
function selectZone(el, zone, cls) {
  document.querySelectorAll('.zone-btn').forEach(b => b.className = 'zone-btn');
  el.classList.add('sel-' + cls);
  state.zone = zone;
  checkLogin();
}
// Sélecteur de zone pour livreurs remplaçants (zone non assignée)
function afficherSelecteurZone() {
  document.getElementById('login').classList.remove('active');
  // Afficher un mini-écran de sélection de zone
  const loginDiv = document.getElementById('login');
  loginDiv.innerHTML = `
    <div class="login-card">
      <div style="text-align:center;margin-bottom:16px">
        <div style="font-size:32px">🗺️</div>
        <div style="font-size:15px;font-weight:700;color:var(--text)">Choisissez votre zone</div>
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Bonjour ${state.prenom} — Sélectionnez votre zone du jour</div>
      </div>
      <button onclick="choisirZone('${Z1}')"
        style="width:100%;padding:14px;background:#e8f5e9;border:2px solid #2e7d32;border-radius:10px;font-size:14px;font-weight:700;color:#2e7d32;cursor:pointer;margin-bottom:10px">
        🟢 Zone 1 — Sud & Sud-Ouest
      </button>
      <button onclick="choisirZone('${Z2}')"
        style="width:100%;padding:14px;background:#e3f2fd;border:2px solid #1565C0;border-radius:10px;font-size:14px;font-weight:700;color:#1565C0;cursor:pointer;margin-bottom:10px">
        🔵 Zone 2 — Est & Nord-Est
      </button>
      <button onclick="choisirZone('${Z3}')"
        style="width:100%;padding:14px;background:#fff3e0;border:2px solid #e65100;border-radius:10px;font-size:14px;font-weight:700;color:#e65100;cursor:pointer;margin-bottom:10px">
        🟠 Zone 3 — Ouest & Nord
      </button>
      <button onclick="logout()" style="width:100%;padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--text2);cursor:pointer;margin-top:6px">
        ← Changer de compte
      </button>
    </div>`;
  loginDiv.classList.add('active');
}

const Z1 = '🟢 Zone 1 — Livreur 1';
const Z2 = '🔵 Zone 2 — Livreur 2';
const Z3 = '🟠 Zone 3 — Livreur 3';

function choisirZone(zone) {
  state.zone = zone;
  try { 
    const saved = JSON.parse(localStorage.getItem('ajcv_session')||'{}');
    saved.zone = zone;
    localStorage.setItem('ajcv_session', JSON.stringify(saved));
  } catch(_) {}
  document.getElementById('login').classList.remove('active');
  lancerApp();
}

function checkLogin() {
  const login = document.getElementById('loginInput').value.trim();
  const mdp   = document.getElementById('mdpInput').value.trim();
  document.getElementById('btnLogin').disabled = !(login && mdp);
}

async function connexion() {
  const login    = document.getElementById('loginInput').value.trim();
  const mdp      = document.getElementById('mdpInput').value.trim();
  const btnLogin = document.getElementById('btnLogin');
  const errDiv   = document.getElementById('loginError');

  btnLogin.disabled = true;
  btnLogin.textContent = 'Connexion...';
  errDiv.style.display = 'none';

  try {
    let data;
    if (GSR) {
      data = await gsRun('gsr_login', [login, mdp]);
    } else {
      const url  = `${CFG.API_URL}?action=login&key=${CFG.API_KEY}&login=${encodeURIComponent(login)}&mdp=${encodeURIComponent(mdp)}`;
      const resp = await fetch(url);
      data = await resp.json();
    }

    if (data.error) {
      errDiv.textContent = '❌ ' + data.error;
      errDiv.style.display = 'block';
      btnLogin.disabled = false;
      btnLogin.textContent = 'Se connecter';
      return;
    }

    // Stocker le token avec expiration
    const tokenExpiry = Date.now() + (data.expiresIn * 60 * 1000);
    state.token       = data.token;
    state.role        = data.role;
    state.prenom      = data.prenom;
    state.livreur     = data.prenom + (data.nom ? ' ' + data.nom : '');
    state.login       = login;
    state.tokenExpiry = tokenExpiry;
    state.zone        = data.zone || '';

    // Sauvegarder MDP si case cochée
    const rememberMdp = document.getElementById('rememberMdp');
    try {
      if (rememberMdp && rememberMdp.checked) {
        localStorage.setItem('ajcv_credentials', JSON.stringify({ login, mdp }));
      } else {
        localStorage.removeItem('ajcv_credentials');
      }
    } catch(_) {}

    try { localStorage.setItem('ajcv_session', JSON.stringify({
      token: state.token, tokenExpiry, role: state.role,
      prenom: state.prenom, livreur: state.livreur,
      login, zone: state.zone
    })); } catch(_) {}

    // Si livreur sans zone assignée → afficher sélecteur
    if (state.role === 'Livreur' && !state.zone) {
      afficherSelecteurZone();
    } else {
      document.getElementById('login').classList.remove('active');
      lancerApp();
    }

  } catch(err) {
    errDiv.textContent = '❌ Erreur de connexion. Vérifiez votre réseau.';
    errDiv.style.display = 'block';
    btnLogin.disabled = false;
    btnLogin.textContent = 'Se connecter';
  }
}

function toggleMdp() {
  const inp = document.getElementById('mdpInput');
  const eye = document.getElementById('eyeIcon');
  if (inp.type === 'password') { inp.type = 'text'; eye.textContent = '🙈'; }
  else { inp.type = 'password'; eye.textContent = '👁'; }
}

function logout() {
  localStorage.removeItem('ajcv_session');
  location.reload();
}

function lancerApp() {
  document.getElementById('app').classList.add('active');
  document.getElementById('hAvatar').textContent = state.prenom ? state.prenom[0] : (state.livreur ? state.livreur[0] : '?');
  document.getElementById('hName').textContent   = state.prenom || state.livreur || 'Livreur';
  // Afficher la zone simplifiée dans le header
  const zoneLabel = state.zone === '🟢 Zone 1 — Livreur 1' ? 'Zone 1 — Sud' :
                    state.zone === '🔵 Zone 2 — Livreur 2' ? 'Zone 2 — Est' :
                    state.zone === '🟠 Zone 3 — Livreur 3' ? 'Zone 3 — Ouest' :
                    state.zone || state.role || '';
  document.getElementById('hZone').textContent = zoneLabel;
  // Initialiser le calendrier à aujourd'hui
  const dp = document.getElementById('datePicker');
  if (dp) dp.value = new Date().toISOString().split('T')[0];
  chargerLivraisons();
  setInterval(chargerLivraisons, CFG.REFRESH);
}

// ════════════════════════════════════════
// CHARGEMENT DONNÉES
// ════════════════════════════════════════
function getDateSelectionnee() {
  const picker = document.getElementById('datePicker');
  if (!picker || !picker.value) return '';
  // Format JJ/MM/AAAA pour l'API
  const d = new Date(picker.value);
  return ('0'+d.getDate()).slice(-2)+'/'+('0'+(d.getMonth()+1)).slice(-2)+'/'+d.getFullYear();
}

function getJourSelectionne() {
  const picker = document.getElementById('datePicker');
  if (!picker || !picker.value) return '';  // vide = toutes les dates
  const d = new Date(picker.value);
  return ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'][d.getDay()];
}

function changerDate() {
  chargerLivraisons();
}

// ── Clé de cache pour la date et zone actuelles ──────────────────────────────
// Forcer le rafraîchissement manuellement
async function rafraichirMaintenant() {
  // Vider le cache de la date actuelle pour forcer rechargement
  try { localStorage.removeItem(cacheKey()); } catch(_) {}
  showToast('🔄 Rechargement...', '');
  await chargerLivraisons();
}

function cacheKey() {
  return 'ajcv_livraisons_' + (state.zone||'') + '_' + getDateSelectionnee();
}
function cacheKeyOptim() {
  return 'ajcv_optim_' + (state.zone||'') + '_' + getDateSelectionnee();
}
function sauvegarderOptimCache(ordre, routeInfo) {
  try { localStorage.setItem(cacheKeyOptim(), JSON.stringify({ ordre, routeInfo, ts: Date.now() })); } catch(_) {}
}
function restaurerOptimCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKeyOptim()) || 'null');
    if (!cached || !cached.ordre || !cached.ordre.length) return false;
    if (Date.now() - (cached.ts||0) > 20 * 3600 * 1000) return false; // expire 20h
    state.ordreOptimise = cached.ordre;
    state.routeInfo     = cached.routeInfo;
    return true;
  } catch(_) { return false; }
}

async function chargerLivraisons() {
  // 1. Afficher le cache instantanément si disponible
  try {
    const cached = localStorage.getItem(cacheKey());
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.livraisons && parsed.livraisons.length > 0) {
        state.livraisons = parsed.livraisons;
        state.lastCount  = parsed.livraisons.length;
        // Restaurer aussi l'optimisation si disponible
        const optimRestauree = restaurerOptimCache();
        renderTab();
        if (state.mapInited) updateMapMarkers();
        if (optimRestauree) {
          showToast('📦 Données et tournée restaurées', '');
        } else {
          showToast('🔄 Actualisation...', '');
        }
      }
    }
  } catch(_) {}

  // 2. Charger les données fraîches en arrière-plan (timeout 45s)
  try {
    let data;
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 45000); // timeout 45s
    if (GSR) {
      data = await gsRun('gsr_getLivraisons', [state.token||'', state.zone||'', getDateSelectionnee()]);
    } else {
      const url  = `${CFG.API_URL}?action=livraisons&key=${CFG.API_KEY}&token=${encodeURIComponent(state.token||'')}&zone=${encodeURIComponent(state.zone||'')}&date=${encodeURIComponent(getDateSelectionnee())}&t=${Date.now()}`;
      const resp = await fetch(url, { signal: controller.signal });
      data = await resp.json();
    }
    clearTimeout(fetchTimeout);

    const prev = state.lastCount;
    const nouvelles = data.livraisons || [];

    // Mettre en cache pour le prochain chargement
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({ livraisons: nouvelles, ts: Date.now() }));
    } catch(_) {}

    state.livraisons = nouvelles;
    state.lastCount  = nouvelles.length;

    // Notification si nouvelles livraisons
    if (prev > 0 && state.lastCount > prev) {
      const diff = state.lastCount - prev;
      notifier(`${diff} nouvelle(s) livraison(s) ajoutée(s) !`);
      const badge = document.getElementById('notifBadge');
      badge.textContent = diff;
      badge.classList.add('show');
    }

    renderTab();
    if (state.mapInited) updateMapMarkers();
    showToast('', ''); // masquer le toast

  } catch(err) {
    // Timeout ou erreur réseau
    if (state.livraisons.length === 0) {
      showToast('❌ Pas de connexion — réessayez', 'error');
    } else {
      // Cache disponible — afficher l'heure de la dernière synchro
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
        if (cached && cached.ts) {
          const heure = new Date(cached.ts).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
          showToast('📦 Cache du ' + heure + ' · Vérifiez votre connexion', '');
        }
      } catch(_) {
        showToast('⚠️ Données en cache — connexion lente', '');
      }
    }
  }
}

// ════════════════════════════════════════
// TABS
// ════════════════════════════════════════
function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach((t,i) => {
    t.classList.toggle('active', ['livraisons','carte','done'][i] === tab);
  });
  renderTab();
  // Fix Leaflet dans iframe : forcer redimensionnement quand on arrive sur la carte
  if (tab === 'carte') {
    setTimeout(() => { if (map) { map.invalidateSize(true); } }, 100);
    setTimeout(() => { if (map) { map.invalidateSize(true); updateMapMarkers(); } }, 500);
    setTimeout(() => { if (map) map.invalidateSize(true); }, 1000);
  }
}

function renderTab() {
  if (state.activeTab === 'livraisons') renderLivraisons(false);
  else if (state.activeTab === 'carte') renderCarte();
  else if (state.activeTab === 'done') renderLivraisons(true);
}

// ════════════════════════════════════════
// LISTE LIVRAISONS
// ════════════════════════════════════════
function renderLivraisons(showDone) {
  // Cacher la carte, montrer le content normal
  const mapContainer = document.getElementById('map-container');
  if (mapContainer) mapContainer.style.display = 'none';
  const content = document.getElementById('content');
  content.style.display = 'block';
  const livs    = state.livraisons.filter(l => showDone
    ? l.statut === '✅ Livré'
    : l.statut !== '✅ Livré');

  const total  = state.livraisons.length;
  const livres = state.livraisons.filter(l => l.statut === '✅ Livré').length;
  const nl     = state.livraisons.filter(l => l.statut === '❌ Non livré').length;
  const att    = state.livraisons.filter(l => !l.statut || l.statut === 'À livrer').length;

  let html = `<div class="kpi-banner">
    <div class="kpi-tile"><div class="kpi-val b">${total}</div><div class="kpi-lbl">Total</div></div>
    <div class="kpi-tile"><div class="kpi-val g">${livres}</div><div class="kpi-lbl">Livrés</div></div>
    <div class="kpi-tile"><div class="kpi-val r">${nl}</div><div class="kpi-lbl">Non livrés</div></div>
    <div class="kpi-tile"><div class="kpi-val o">${att}</div><div class="kpi-lbl">En attente</div></div>
  </div>`;

  if (!showDone) {
    // Bannière optimisation
    if (state.routeInfo) {
      html += `<div class="route-info">
        <div class="route-stat"><div class="route-val">${state.routeInfo.totalKm} km</div><div class="route-lbl">Distance totale</div></div>
        <div class="route-divider"></div>
        <div class="route-stat"><div class="route-val">${state.routeInfo.totalMin} min</div><div class="route-lbl">Durée estimée</div></div>
        <div class="route-divider"></div>
        <div class="route-stat" style="cursor:pointer" onclick="ouvrirMaps()">
          <div class="route-val" style="font-size:20px">🗺️</div>
          <div class="route-lbl">Google Maps</div>
        </div>
      </div>`;
    }
    html += `<div class="optimize-bar">
      <div class="optimize-info">
        <strong>🧭 Optimisation de tournée</strong>
        Trafic temps réel · Algorithme 2-opt
      </div>
      <button onclick="rafraichirMaintenant()" style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:8px;padding:8px 10px;font-size:14px;cursor:pointer;margin-right:6px" title="Rafraîchir les données">🔄</button>
      <button class="btn-optimize" id="btnOptimize" onclick="optimiserTournee()" title="Calculer l'ordre optimal des livraisons">
        ✨ Optimiser
      </button>
    </div>`;
  }

  if (livs.length === 0) {
    html += `<div class="empty">
      <div class="empty-icon">${showDone ? '🎉' : '📭'}</div>
      <div class="empty-title">${showDone ? 'Aucune livraison effectuée' : 'Toutes les livraisons sont faites !'}</div>
      <div class="empty-sub">${showDone ? '' : 'Excellent travail ! 🎉'}</div>
    </div>`;
    content.innerHTML = html;
    return;
  }

  // Trier selon l'ordre optimisé si disponible
  let sorted = [...livs];
  if (state.ordreOptimise && !showDone) {
    // Normaliser : minuscules + sans espaces multiples pour comparaison fiable
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

    const ordreMap = {};
    state.ordreOptimise.forEach((s, i) => {
      const cle = norm(s.client) + '|' + norm(s.ville);
      ordreMap[cle] = i + 1;
      if (s.bl) ordreMap['bl:' + s.bl] = i + 1;
    });
    sorted.sort((a, b) => {
      const posA = ordreMap['bl:' + a.bl] || ordreMap[norm(a.client) + '|' + norm(a.ville)] || 999;
      const posB = ordreMap['bl:' + b.bl] || ordreMap[norm(b.client) + '|' + norm(b.ville)] || 999;
      return posA - posB;
    });
  }

  html += '<div class="list-section">';
  html += `<div class="section-label">${showDone ? 'Livrées aujourd\'hui' : `${livs.length} à livrer`}</div>`;

  sorted.forEach((l, i) => {
    // Trouver le segment optimisé — comparaison normalisée
    const normStr = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
    let seg = null;
    if (state.ordreOptimise) {
      if (l.bl) seg = state.ordreOptimise.find(s => s.bl && s.bl === l.bl);
      if (!seg)  seg = state.ordreOptimise.find(s =>
        normStr(s.client) === normStr(l.client) && normStr(s.ville) === normStr(l.ville)
      );
      if (!seg)  seg = state.ordreOptimise.find(s =>
        normStr(s.client) === normStr(l.client)
      );
    }
    // Utiliser l'ordre réel du segment, pas i+1
    const ordre   = seg ? seg.ordre : (state.ordreOptimise ? (i + 1) : null);
    const statCls = getStatutClass(l.statut);
    const est     = seg ? seg.segment : null;
    // indexOf utilise la référence exacte de l'objet — fiable même avec doublons
    const idxReel = state.livraisons.indexOf(l);
    html += `<div class="liv-card ${l.statut === '✅ Livré' ? 'done' : ''}" onclick="ouvrirDetail(${idxReel}, false)">
      ${ordre ? `<div class="liv-order">${ordre}</div>` : ''}
      <div class="liv-card-inner">
        <div class="liv-client">${l.client}</div>
        <div class="liv-adresse">📍 ${l.adresse ? l.adresse + ' · ' : ''}${l.ville || '—'}${est ? ` · ⏱ ${est.description}` : ''}</div>
        ${((l.contrainte && l.contrainte !== 'LIBRE') || (seg && seg.contrainte && seg.contrainte !== 'LIBRE')) ? `<div style="font-size:11px;color:#FF8F00;font-weight:600;margin-top:3px">⚠️ ${l.contrainte || seg.contrainte}</div>` : ''}
        ${(l.horaires || (seg && seg.horaires)) ? `<div style="font-size:11px;color:#64B5F6;margin-top:2px">🕐 ${l.horaires || seg.horaires}</div>` : ''}
        ${((l.priorite && l.priorite.includes('PRIORITAIRE')) || (seg && seg.priorite && seg.priorite.includes('PRIORITAIRE'))) ? `<div style="font-size:11px;color:#EF5350;font-weight:700;margin-top:2px">🚨 PRIORITAIRE</div>` : ''}
        <div class="liv-meta">
          <span class="pill ${statCls}">${l.statut || 'À livrer'}</span>
          ${l.bl ? `<span style="font-size:11px;color:var(--text3)">BL: ${l.bl}</span>` : ''}
          ${l.nbColis ? `<span style="font-size:11px;color:var(--text3)">${l.nbColis} colis</span>` : ''}
        </div>
      </div>
      <div class="liv-actions">
        <button class="liv-action call" onclick="event.stopPropagation();appeler('${l.tel1}')">
          <span class="icon">📞</span>Appeler
        </button>
        <button class="liv-action waze" onclick="event.stopPropagation();ouvrirWaze(${JSON.stringify(l).replace(/"/g,'&quot;')})">
          <span class="icon">🚗</span>Waze
        </button>
        <button class="liv-action sig" onclick="event.stopPropagation();ouvrirSignature(${i}, ${showDone})">
          <span class="icon">✍️</span>Signer
        </button>
        <button class="liv-action statut" onclick="event.stopPropagation();ouvrirModalStatut(${i}, ${showDone})">
          <span class="icon">📋</span>Statut
        </button>
      </div>
    </div>`;
  });
  html += '</div>';
  content.innerHTML = html;
}

// ════════════════════════════════════════
// CARTE
// ════════════════════════════════════════
function renderCarte() {
  // Cacher le content normal, montrer le map-container statique
  document.getElementById('content').style.display = 'none';
  const mapContainer = document.getElementById('map-container');
  mapContainer.style.display = 'block';
  // Positionner sous le header + tabbar dynamiquement
  const header = document.querySelector('.app-header');
  const tabbar = document.querySelector('.tab-bar');
  const topOffset = (header ? header.offsetHeight : 60) + (tabbar ? tabbar.offsetHeight : 56);
  mapContainer.style.top = topOffset + 'px';

  setTimeout(() => {
    if (map) { map.invalidateSize(true); }
    if (!state.mapInited) {
      map = L.map('map', { center: [CFG.DEPOT.lat, CFG.DEPOT.lng], zoom: 11 });
      L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&key=AIzaSyC63POtdRy95lSJ_GEQKlw2NI_ndcAbJ4Q', {
        attribution: '© OpenStreetMap', maxZoom: 18
      }).addTo(map);
      markersLayer = L.layerGroup().addTo(map);

      // Marqueur dépôt
      const depotIcon = L.divIcon({
        html: '<div style="width:20px;height:20px;border-radius:50%;background:#FFB300;border:3px solid #0D1B4B;display:flex;align-items:center;justify-content:center;font-size:10px">🏭</div>',
        iconSize: [20,20], iconAnchor: [10,10], className: ''
      });
      L.marker([CFG.DEPOT.lat, CFG.DEPOT.lng], { icon: depotIcon })
        .bindTooltip('Dépôt AJCV — Saint-Joseph', { permanent: false })
        .addTo(map);

      state.mapInited = true;

      // Fix iframe — redimensionnement
      setTimeout(() => { map.invalidateSize(); }, 300);
      setTimeout(() => { map.invalidateSize(); }, 800);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && state.activeTab === 'carte') setTimeout(() => { map.invalidateSize(); }, 300);
      });
      window.addEventListener('resize', () => {
        if (state.activeTab === 'carte') setTimeout(() => { map.invalidateSize(); }, 200);
      });
    } else {
      setTimeout(() => { map.invalidateSize(true); }, 150);
    }
    updateMapMarkers();
  }, 100);
}

function updateMapMarkers() {
  if (!markersLayer) return;
  markersLayer.clearLayers();

  const COMMUNE_COORDS = {
    'SAINT-PIERRE':[-21.3393,55.4781],'LE TAMPON':[-21.2706,55.5140],
    'SAINT-JOSEPH':[-21.3791,55.6188],'SAINT-LOUIS':[-21.2708,55.4072],
    "L'ÉTANG-SALÉ":[-21.2619,55.3497],'LES AVIRONS':[-21.2328,55.3261],
    'ENTRE-DEUX':[-21.2208,55.4833],'SAINT-PHILIPPE':[-21.3600,55.7700],
    'CILAOS':[-21.1333,55.4667],'PETITE-ÎLE':[-21.3333,55.5833],
    'SAINT-DENIS':[-20.8823,55.4504],'SAINT-BENOÎT':[-21.0338,55.7203],
    'SAINT-ANDRÉ':[-20.9639,55.6531],'SAINTE-MARIE':[-20.8978,55.5236],
    'SAINTE-SUZANNE':[-20.9137,55.5939],'BRAS-PANON':[-21.0014,55.6494],
    'SAINTE-ROSE':[-21.1167,55.8000],'SAINT-PAUL':[-21.0043,55.2692],
    'LE PORT':[-20.9340,55.2899],'LA POSSESSION':[-20.9276,55.3367],
    'SAINT-LEU':[-21.1557,55.2843],'TROIS-BASSINS':[-21.1000,55.3000],
  };

  state.livraisons.forEach((l, idx) => {
    let lat = parseFloat(l.lat), lng = parseFloat(l.lng);
    // Valider que les coords sont bien à La Réunion
    if (!coordsValides(lat, lng)) {
      const key = (l.ville || '').toUpperCase().trim();
      const coords = COMMUNE_COORDS[key];
      if (!coords) return;
      lat = coords[0] + (Math.random()-.5)*.008;
      lng = coords[1] + (Math.random()-.5)*.008;
    }

    let col = '#FFB300';
    if (l.statut === '✅ Livré')         col = '#22C55E';
    else if (l.statut === '❌ Non livré') col = '#EF4444';
    else if (l.statut === '🔄 Reporté')  col = '#A855F7';

    let ordre = '';
    if (state.ordreOptimise) {
      let idx = -1;
      if (l.bl) idx = state.ordreOptimise.findIndex(s => s.bl && s.bl === l.bl);
      if (idx === -1) idx = state.ordreOptimise.findIndex(s => s.client === l.client && s.ville === l.ville);
      ordre = idx !== -1 ? idx + 1 : '';
    }

    const icon = L.divIcon({
      html: `<div style="width:28px;height:28px;border-radius:50%;background:${col};border:2.5px solid rgba(255,255,255,.8);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.4)">${ordre || '·'}</div>`,
      iconSize: [28,28], iconAnchor: [14,14], className: ''
    });

    const m = L.marker([lat, lng], { icon }).addTo(markersLayer);
    m.bindTooltip(`<b>${l.client}</b><br>${l.ville}<br>${l.statut || 'À livrer'}`, { direction:'top' });
    // Utiliser client+ville comme clé unique (BL peut être vide)
    m.on('click', () => ouvrirDetailParClient(l.client, l.ville));
  });

  // Ajuster la vue sur les marqueurs
  try {
    const bounds = markersLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30,30] });
  } catch(_) {}

  // Tracer la route optimisée via OSRM (vraies routes routières)
  if (state.ordreOptimise && state.ordreOptimise.length > 1) {
    tracerRouteOSRM();
  }
}

// ── Validation coordonnées La Réunion ────────────────────────────────────────
// Bounds stricts : lat [-21.45, -20.85] / lng [55.20, 55.85]
function coordsValides(lat, lng) {
  const la = parseFloat(String(lat).replace(',','.')), lo = parseFloat(String(lng).replace(',','.'));
  return !isNaN(la) && !isNaN(lo) &&
         la >= -21.45 && la <= -20.85 &&
         lo >= 55.20  && lo <= 55.85;
}

async function tracerRouteOSRM() {
  // Filtrer STRICTEMENT les stops avec coordonnées valides dans La Réunion
  const coordsStops = state.ordreOptimise.filter(s =>
    coordsValides(s.lat, s.lng)
  );

  if (coordsStops.length === 0) return;

  // Si certains stops ont des coords hors Réunion → fallback direct
  const totalStops = state.ordreOptimise.length;
  const stopsHorsReunion = totalStops - coordsStops.length;
  if (stopsHorsReunion > 0) {
    console.warn(stopsHorsReunion + ' stop(s) avec coordonnées hors La Réunion ignorés');
  }

  try {
    const coordsList = [
      { lat: CFG.DEPOT.lat, lng: CFG.DEPOT.lng },
      ...coordsStops,
      { lat: CFG.DEPOT.lat, lng: CFG.DEPOT.lng }
    ];

    // OSRM attend : lng,lat
    const coordsStr = coordsList.map(c => `${c.lng},${c.lat}`).join(';');
    const osrmUrl   = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=false`;

    const resp = await fetch(osrmUrl);
    if (!resp.ok) throw new Error('OSRM HTTP ' + resp.status);
    const data = await resp.json();

    if (!data.routes || !data.routes[0]) throw new Error('Pas de route');

    // Vérifier que la route reste dans La Réunion (bbox)
    const coords = data.routes[0].geometry.coordinates;
    const horsReunion = coords.some(c => !coordsValides(c[1], c[0]));
    if (horsReunion) throw new Error('Route hors La Réunion détectée');

    // Convertir GeoJSON [lng,lat] → Leaflet [lat,lng]
    const latlngs = coords.map(c => [c[1], c[0]]);
    L.polyline(latlngs, { color: '#FFB300', weight: 4, opacity: 0.85 }).addTo(markersLayer);

    // Mettre à jour km/min avec valeurs OSRM
    const totalKmOSRM  = Math.round(data.routes[0].distance / 100) / 10;
    const totalMinOSRM = Math.round(data.routes[0].duration / 60);
    if (state.routeInfo) {
      state.routeInfo.totalKm  = totalKmOSRM;
      state.routeInfo.totalMin = totalMinOSRM;
      const rvKm  = document.querySelector('.route-val');
      const rvMin = document.querySelectorAll('.route-val')[1];
      if (rvKm)  rvKm.textContent  = totalKmOSRM + ' km';
      if (rvMin) rvMin.textContent = totalMinOSRM + ' min';
    }

  } catch(err) {
    // Fallback propre : lignes droites entre stops (reste sur l'île)
    console.warn('OSRM fallback :', err.message);
    const points = [
      [CFG.DEPOT.lat, CFG.DEPOT.lng],
      ...coordsStops.map(s => [parseFloat(s.lat), parseFloat(s.lng)]),
      [CFG.DEPOT.lat, CFG.DEPOT.lng]
    ];
    L.polyline(points, { color: '#FFB300', weight: 3, opacity: .6, dashArray: '8,4' }).addTo(markersLayer);
  }
}

// ════════════════════════════════════════
// OPTIMISATION TOURNÉE — côté navigateur
// OSRM appelé directement depuis le téléphone (pas via Apps Script)
// ════════════════════════════════════════

// ── Validation coordonnées La Réunion ────
function estDansReunion(lat, lng) {
  const la = parseFloat(String(lat).replace(',','.')), lo = parseFloat(String(lng).replace(',','.'));
  return !isNaN(la) && !isNaN(lo) && la >= -21.45 && la <= -20.85 && lo >= 55.20 && lo <= 55.85;
}

// ── Matrice OSRM depuis le navigateur ────
async function getMatriceOSRM(depot, stops) {
  const points = [depot, ...stops];
  const coordsStr = points.map(p => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/table/v1/driving/${coordsStr}?annotations=duration,distance`;

  // Timeout compatible tous navigateurs Android (pas AbortSignal.timeout)
  const fetchAvecTimeout = (url, ms) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal })
      .then(r => { clearTimeout(timer); return r; })
      .catch(e => { clearTimeout(timer); throw e; });
  };

  // Afficher l'info dans un toast pour debug sur téléphone
  showToast('📡 OSRM ' + points.length + ' points...', '');

  try {
    const resp = await fetchAvecTimeout(url, 20000); // 20 secondes
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (data.code === 'Ok' && data.durations) {
      const total = data.durations.flat().reduce((a,b) => a + (b||0), 0);
      if (total > 0) {
        showToast('✅ OSRM OK — ' + points.length + ' points', 'success');
        return { durations: data.durations, distances: data.distances };
      }
    }
    throw new Error('Réponse OSRM invalide: ' + JSON.stringify(data).substring(0,50));
  } catch(e) {
    showToast('⚠️ OSRM: ' + e.message.substring(0,40), 'error');
    return construireMatriceHaversine(depot, stops);
  }
}

// Matrice haversine de secours — au moins les distances sont correctes
function construireMatriceHaversine(depot, stops) {
  const points = [depot, ...stops];
  const n = points.length;
  const durations = [], distances = [];
  for (let i = 0; i < n; i++) {
    durations.push([]); distances.push([]);
    for (let j = 0; j < n; j++) {
      if (i === j) { durations[i].push(0); distances[i].push(0); continue; }
      // haversine retourne des km — facteur 1.3 pour tenir compte des routes en lacets
      const kmVol  = haversineClient(points[i].lat, points[i].lng, points[j].lat, points[j].lng);
      const kmRoute = kmVol * 1.3;
      distances[i].push(kmRoute * 1000);          // en mètres
      durations[i].push(kmRoute / 30 * 3600);     // 30 km/h moyenne La Réunion → secondes
    }
  }
  return { durations, distances };
}

function durM(m, from, to) { return (m.durations[from] && m.durations[from][to]) || 9999; }
function disM(m, from, to) { return (m.distances[from] && m.distances[from][to]) || 0; }

function coutTotalClient(route, m) {
  if (!route.length) return 0;
  let t = durM(m, 0, route[0] + 1);
  for (let i = 0; i < route.length - 1; i++) t += durM(m, route[i] + 1, route[i+1] + 1);
  t += durM(m, route[route.length-1] + 1, 0);
  return t;
}

function nnOSRM(m, n, start) {
  const restants = Array.from({length: n}, (_, i) => i);
  const route = [];
  let current = start || 0;
  if (start > 0) { route.push(start - 1); restants.splice(start - 1, 1); current = start; }
  while (restants.length > 0) {
    let minD = Infinity, minPos = 0;
    restants.forEach((idx, pos) => { const d = durM(m, current, idx+1); if (d < minD) { minD = d; minPos = pos; } });
    route.push(restants[minPos]); current = restants[minPos] + 1; restants.splice(minPos, 1);
  }
  return route;
}

// 2-opt contraint : n'échange que des stops du même secteur (Est/Centre/Ouest)
function twoOptSecteur(route, m, stops, pivotLng) {
  function sec(s) { return s.lng >= pivotLng ? 0 : s.lng >= 55.38 ? 1 : 2; }
  let best = route.slice(), imp = true;
  while (imp) {
    imp = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const si = sec(stops[best[i]]), sj = sec(stops[best[j]]);
        if (si !== sj) continue;
        const avant = durM(m, i===0?0:best[i-1]+1, best[i]+1) + durM(m, best[j]+1, j===best.length-1?0:best[j+1]+1);
        const apres = durM(m, i===0?0:best[i-1]+1, best[j]+1) + durM(m, best[i]+1, j===best.length-1?0:best[j+1]+1);
        if (apres < avant - 1) {
          best = best.slice(0,i).concat(best.slice(i,j+1).reverse()).concat(best.slice(j+1));
          imp = true;
        }
      }
    }
  }
  return best;
}

function twoOptClient(route, m) {
  let best = route.slice(), imp = true;
  while (imp) {
    imp = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const avant = durM(m, i===0?0:best[i-1]+1, best[i]+1) + durM(m, best[j]+1, j===best.length-1?0:best[j+1]+1);
        const apres = durM(m, i===0?0:best[i-1]+1, best[j]+1) + durM(m, best[i]+1, j===best.length-1?0:best[j+1]+1);
        if (apres < avant - 1) { best = best.slice(0,i).concat(best.slice(i,j+1).reverse()).concat(best.slice(j+1)); imp = true; }
      }
    }
  }
  return best;
}

function orOptClient(route, m, segLen) {
  let best = route.slice(), imp = true;
  while (imp) {
    imp = false;
    for (let i = 0; i < best.length - segLen + 1; i++) {
      const seg = best.slice(i, i + segLen);
      const sans = best.slice(0, i).concat(best.slice(i + segLen));
      const coutBase = coutTotalClient(best, m);
      for (let j = 0; j <= sans.length; j++) {
        const cand = sans.slice(0, j).concat(seg).concat(sans.slice(j));
        if (coutTotalClient(cand, m) < coutBase - 1) { best = cand; imp = true; break; }
      }
    }
  }
  return best;
}

async function optimiserTourneeClient() {
  function parseCoord(v) { return parseFloat(String(v).replace(',','.')); }

  const stops = state.livraisons
    .filter(l => l.statut !== '✅ Livré' && estDansReunion(parseCoord(l.lat), parseCoord(l.lng)))
    .map(l => ({ ...l, lat: parseCoord(l.lat), lng: parseCoord(l.lng) }));

  if (stops.length === 0) { showToast('❌ Aucun stop GPS valide', 'error'); return null; }
  if (stops.length === 1) {
    return { ordre: [{...stops[0], ordre:1, segment:{km:0, min:0, description:'Direct'}}], totalKm:0, totalMin:0, mapsUrl:'' };
  }

  const depot = { lat: CFG.DEPOT.lat, lng: CFG.DEPOT.lng };
  const GMAPS_KEY = 'AIzaSyCKBVLFrwt53HtqljrxnSL5_H-ww-y22pc';

  // ── GOOGLE MAPS DIRECTIONS API avec optimisation des waypoints ────────────
  // Limite : 25 waypoints max par requête → on découpe si nécessaire
  try {
    showToast('🗺️ Optimisation Google Maps...', '');

    const origin      = `${depot.lat},${depot.lng}`;
    const destination = `${depot.lat},${depot.lng}`;

    // Google Maps accepte max 25 waypoints intermédiaires
    // Si plus de 23 stops, on fait plusieurs requêtes
    const BATCH = 23;
    let ordreOptimise = [];

    if (stops.length <= BATCH) {
      // Une seule requête
      const waypoints = stops.map(s => `${s.lat},${s.lng}`).join('|');
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&waypoints=optimize:true|${waypoints}&region=re&language=fr&key=${GMAPS_KEY}`;

      const resp = await fetch(url);
      const data = await resp.json();

      if (data.status !== 'OK') throw new Error('Google Maps: ' + data.status);

      // L'API retourne waypoint_order = ordre optimisé des stops
      const ordre = data.routes[0].waypoint_order;
      const legs  = data.routes[0].legs;

      ordreOptimise = ordre.map((idx, i) => {
        const s   = stops[idx];
        const leg = legs[i];
        const km  = Math.round((leg.distance.value / 1000) * 10) / 10;
        const min = Math.round(leg.duration.value / 60);
        return Object.assign({}, s, {
          ordre: i + 1,
          segment: { km, min, description: min + ' min' }
        });
      });

    } else {
      // Trop de stops → découper en batches géographiques
      // Trier d'abord par géographie pour que les batches soient cohérents
      const stopsTries = stops.slice().sort((a,b) => b.lng - a.lng);
      const batches = [];
      for (let i = 0; i < stopsTries.length; i += BATCH) {
        batches.push(stopsTries.slice(i, i + BATCH));
      }

      let compteur = 1;
      for (let b = 0; b < batches.length; b++) {
        const batch   = batches[b];
        const orig    = b === 0 ? origin : `${batches[b-1][batches[b-1].length-1].lat},${batches[b-1][batches[b-1].length-1].lng}`;
        const dest    = b === batches.length-1 ? destination : `${batch[batch.length-1].lat},${batch[batch.length-1].lng}`;
        const wpts    = batch.map(s => `${s.lat},${s.lng}`).join('|');
        const url     = `https://maps.googleapis.com/maps/api/directions/json?origin=${orig}&destination=${dest}&waypoints=optimize:true|${wpts}&region=re&language=fr&key=${GMAPS_KEY}`;

        const resp = await fetch(url);
        const data = await resp.json();
        if (data.status !== 'OK') throw new Error('Google Maps batch: ' + data.status);

        const ordre = data.routes[0].waypoint_order;
        const legs  = data.routes[0].legs;
        ordre.forEach((idx, i) => {
          const s   = batch[idx];
          const leg = legs[i];
          const km  = Math.round((leg.distance.value / 1000) * 10) / 10;
          const min = Math.round(leg.duration.value / 60);
          ordreOptimise.push(Object.assign({}, s, {
            ordre: compteur++,
            segment: { km, min, description: min + ' min' }
          }));
        });
      }
    }

    // Calculer totaux
    const totalKm  = Math.round(ordreOptimise.reduce((s,o) => s + (o.segment.km||0), 0) * 10) / 10;
    const totalMin = Math.round(ordreOptimise.reduce((s,o) => s + (o.segment.min||0), 0));

    // URL Google Maps avec l'ordre optimisé
    const waypoints = ordreOptimise.map(s => `${s.lat},${s.lng}`).join('/');
    const mapsUrl   = `https://www.google.com/maps/dir/${depot.lat},${depot.lng}/${waypoints}/${depot.lat},${depot.lng}`;

    return { ordre: ordreOptimise, totalKm, totalMin, mapsUrl };

  } catch(err) {
    console.warn('Google Maps API error:', err.message);
    showToast('⚠️ Calcul hors ligne...', '');
  }

  // ── FALLBACK : ordre géographique si Google Maps inaccessible ─────────────
  const PIVOT_LNG = 55.45;
  function secteur(s) {
    if (s.lng >= PIVOT_LNG) return 0;
    if (s.lng >= 55.38)     return 1;
    return 2;
  }

  try {
    const mHav = construireMatriceHaversine(depot, stops);
    const geoH = stops.map((_,i)=>i).sort((a,b) => {
      const sa = secteur(stops[a]), sb = secteur(stops[b]);
      if (sa !== sb) return sa - sb;
      return stops[b].lng - stops[a].lng;
    });
    let route = geoH.slice();
    route = twoOptSecteur(route, mHav, stops, PIVOT_LNG);
    route = orOptClient(route, mHav, 1);
    route = orOptClient(route, mHav, 2);
    route = twoOptSecteur(route, mHav, stops, PIVOT_LNG);

    // Construire résultat
    // prev = index matrice du point précédent (0=dépôt, sinon stop[i-1]+1)
    let totalKm = 0, totalMin = 0;
    const ordreFinal = route.map((idx, i) => {
      const s    = stops[idx];
      const prev = i === 0 ? 0 : route[i - 1] + 1; // index dans matrice
      const curr = idx + 1;                          // index dans matrice
      const durSec = matrice.durations[prev] ? (matrice.durations[prev][curr] || 0) : 0;
      const disMet = matrice.distances[prev] ? (matrice.distances[prev][curr] || 0) : 0;
      const min  = Math.round(durSec / 60);
      const km   = Math.round(disMet / 100) / 10; // mètres → km
      totalKm  += km; totalMin += min;
      return Object.assign({}, s, { ordre: i+1, segment: { km, min, description: min > 0 ? min + ' min' : 'Direct' } });
    });

    const waypoints = ordreFinal.map(s => s.lat+','+s.lng).join('/');
    const mapsUrl   = `https://www.google.com/maps/dir/${depot.lat},${depot.lng}/${waypoints}/${depot.lat},${depot.lng}`;
    return { ordre: ordreFinal, totalKm: Math.round(totalKm*10)/10, totalMin: Math.round(totalMin), mapsUrl };

  } catch(err) {
    console.warn('OSRM indisponible, matrice haversine:', err.message);
    showToast('⚠️ Calcul hors ligne...', '');
    // Fallback haversine — même logique géographique 3 secteurs
    try {
      const mHav = construireMatriceHaversine(depot, stops);
      // Même tri géographique que ci-dessus
      const geoH = stops.map((_,i)=>i).sort((a,b) => {
        const sa = secteur(stops[a]), sb = secteur(stops[b]);
        if (sa !== sb) return sa - sb;
        return stops[b].lng - stops[a].lng;
      });
      let route = geoH.slice();
      route = twoOptSecteur(route, mHav, stops, PIVOT_LNG);
      route = orOptClient(route, mHav, 1);
      route = orOptClient(route, mHav, 2);
      route = twoOptSecteur(route, mHav, stops, PIVOT_LNG);

      let totalKm = 0, totalMin = 0;
      const ordreFinal = route.map((idx, i) => {
        const s = stops[idx];
        const prev = i === 0 ? 0 : route[i-1] + 1;
        const curr = idx + 1;
        const durSec = mHav.durations[prev][curr] || 0;
        const disMet = mHav.distances[prev][curr] || 0;
        const min = Math.round(durSec / 60);
        const km  = Math.round(disMet / 100) / 10;
        totalKm += km; totalMin += min;
        return Object.assign({}, s, { ordre: i+1, segment: { km, min, description: min > 0 ? '~'+min+' min (estimé)' : 'Direct' } });
      });
      const waypoints = ordreFinal.map(s => s.lat+','+s.lng).join('/');
      const mapsUrl = `https://www.google.com/maps/dir/${depot.lat},${depot.lng}/${waypoints}/${depot.lat},${depot.lng}`;
      return { ordre: ordreFinal, totalKm: Math.round(totalKm*10)/10, totalMin: Math.round(totalMin), mapsUrl };
    } catch(e2) {
      return null;
    }
  }
}

function haversineClient(lat1, lon1, lat2, lon2) {
  const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function optimiserHaversineClient(stops, depot) {
  const restants = stops.slice(), ordre = [];
  let cur = depot;
  while (restants.length > 0) {
    let minD=Infinity, minI=0;
    restants.forEach((s,i)=>{ const d=haversineClient(cur.lat,cur.lng,s.lat,s.lng); if(d<minD){minD=d;minI=i;} });
    ordre.push(restants[minI]); cur=restants[minI]; restants.splice(minI,1);
  }
  let totalKm=0, totalMin=0;
  const ordreFinal = ordre.map((s,i)=>{
    const prev=i===0?depot:ordre[i-1];
    const km=Math.round(haversineClient(prev.lat,prev.lng,s.lat,s.lng)*10)/10;
    const min=Math.round(km*3.5);
    totalKm+=km; totalMin+=min;
    return Object.assign({},s,{ordre:i+1,segment:{km,min,description:'Estimé'}});
  });
  const waypoints=ordreFinal.map(s=>s.lat+','+s.lng).join('/');
  const mapsUrl=`https://www.google.com/maps/dir/${depot.lat},${depot.lng}/${waypoints}/${depot.lat},${depot.lng}`;
  return { ordre:ordreFinal, totalKm:Math.round(totalKm*10)/10, totalMin:Math.round(totalMin), mapsUrl };
}

async function optimiserTournee() {
  const btn = document.getElementById('btnOptimize');
  if (btn) { btn.classList.add('loading'); btn.textContent = '⏳ Calcul...'; }

  try {
    // ── Optimisation via google.script.run (mode Apps Script) ou fetch (mode Drive)
    showToast('🗺️ Optimisation en cours...', '');
    let data;
    if (GSR) {
      data = await gsRun('gsr_optimiserTournee', [state.token||'', state.zone||'', getDateSelectionnee()]);
    } else {
      const url  = `${CFG.API_URL}?action=optimiserTournee&key=${CFG.API_KEY}&token=${encodeURIComponent(state.token||'')}&zone=${encodeURIComponent(state.zone||'')}&date=${encodeURIComponent(getDateSelectionnee())}`;
      const resp = await fetch(url);
      data = await resp.json();
    }

    if (data.success) {
      state.ordreOptimise = data.ordre;
      if (map) { setTimeout(()=>map.invalidateSize(true),200); setTimeout(()=>map.invalidateSize(true),600); }
      state.routeInfo = { totalKm: data.totalKm, totalMin: data.totalMin, mapsUrl: data.mapsUrl };
      // Sauvegarder l'optimisation en cache — ne pas recalculer à chaque ouverture
      sauvegarderOptimCache(data.ordre, state.routeInfo);
      renderLivraisons(false);
      if (state.activeTab === 'carte') { setTimeout(() => updateMapMarkers(), 300); }
      showToast(`✅ ${data.totalKm} km · ${data.totalMin} min — tournée sauvegardée`, 'success');
      if (btn) { btn.classList.remove('loading'); btn.textContent = '✨ Optimiser'; }
      return;
    }

    // ── Fallback local si Apps Script échoue ──
    showToast('⚠️ Calcul local...', '');
    const result = await optimiserTourneeClient();
    if (result && result.ordre) {
      state.ordreOptimise = result.ordre;
      if (map) { setTimeout(()=>map.invalidateSize(true),200); }
      state.routeInfo = { totalKm: result.totalKm, totalMin: result.totalMin, mapsUrl: result.mapsUrl };
      sauvegarderOptimCache(result.ordre, state.routeInfo);
      renderLivraisons(false);
      if (state.activeTab === 'carte') { setTimeout(() => updateMapMarkers(), 300); }
      showToast(`✅ ${result.totalKm} km · ${result.totalMin} min — tournée sauvegardée`, 'success');
    } else {
      showToast('❌ Optimisation impossible', 'error');
    }

  } catch(err) {
    showToast('❌ Erreur réseau', 'error');
  }

  if (btn) { btn.classList.remove('loading'); btn.textContent = '✨ Optimiser'; }
  if (state.activeTab === 'carte') updateMapMarkers();
}

function ouvrirMaps() {
  if (state.routeInfo && state.routeInfo.mapsUrl) {
    window.open(state.routeInfo.mapsUrl, '_blank');
  }
}

// ════════════════════════════════════════
// DÉTAIL CLIENT
// ════════════════════════════════════════
function ouvrirDetailBL(bl) {
  const idx = state.livraisons.findIndex(l => l.bl === bl);
  if (idx === -1) return;
  ouvrirDetail(idx, false);
}

function ouvrirDetailParClient(client, ville) {
  const norm = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  let idx = state.livraisons.findIndex(l =>
    norm(l.client) === norm(client) && norm(l.ville) === norm(ville)
  );
  if (idx === -1) idx = state.livraisons.findIndex(l => norm(l.client) === norm(client));
  if (idx !== -1) ouvrirDetail(idx, false);
}

function ouvrirDetail(idx, showDone) {
  const livs  = state.livraisons.filter(l => showDone ? l.statut === '✅ Livré' : l.statut !== '✅ Livré');
  const l     = livs[idx];
  if (!l) return;
  state.livActive = l;

  document.getElementById('detail-title').textContent = l.client;
  document.getElementById('detail-sub').textContent   = `${l.ville || '—'} · BL: ${l.bl || '—'}`;

  const statCls = getStatutClass(l.statut);
  let tel2html  = l.tel2 ? `<div class="detail-row"><span class="detail-label">Tél 2</span><span class="detail-val"><a href="tel:${l.tel2}">${l.tel2}</a></span></div>` : '';
  let emailHtml = l.email ? `<div class="detail-row"><span class="detail-label">Email</span><span class="detail-val" style="font-size:11px;color:var(--blue)">${l.email}</span></div>` : '';
  let obsHtml   = l.indications ? `<div class="detail-row"><span class="detail-label">Indications</span><span class="detail-val" style="color:var(--orange);font-size:12px">${l.indications}</span></div>` : '';

  // Segment route si optimisé
  let routeHtml = '';
  if (state.ordreOptimise) {
    // Chercher par BL si disponible, sinon par client+ville
    let seg = l.bl ? state.ordreOptimise.find(s => s.bl && s.bl === l.bl) : null;
    if (!seg) seg = state.ordreOptimise.find(s => s.client === l.client && s.ville === l.ville);
    if (seg && seg.segment) {
      routeHtml = `<div class="detail-section">
        <div class="detail-section-title">🧭 Trajet optimisé</div>
        <div class="detail-row"><span class="detail-label">Distance</span><span class="detail-val" style="color:var(--gold)">${seg.segment.km.toFixed(1)} km</span></div>
        <div class="detail-row"><span class="detail-label">Durée estimée</span><span class="detail-val" style="color:var(--gold)">${seg.segment.description}</span></div>
        <div class="detail-row"><span class="detail-label">Ordre de passage</span><span class="detail-val" style="color:var(--gold)">N° ${seg.ordre}</span></div>
      </div>`;
    }
  }

  document.getElementById('detail-body').innerHTML = `
    <div class="detail-section">
      <div class="detail-section-title">Informations client</div>
      <div class="detail-row"><span class="detail-label">Adresse</span><span class="detail-val">${l.adresse || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Ville</span><span class="detail-val">${l.cp || ''} ${l.ville || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Tél 1</span><span class="detail-val"><a href="tel:${l.tel1 || ''}">${l.tel1 || '—'}</a></span></div>
      ${tel2html}${emailHtml}${obsHtml}
    </div>
    ${(l.contrainte && l.contrainte !== 'LIBRE') || l.horaires || (l.priorite && l.priorite.includes('PRIORITAIRE')) ? `
    <div class="detail-section" style="border-left:3px solid #FF8F00;padding-left:10px;background:rgba(255,143,0,0.05);border-radius:6px;margin-bottom:8px">
      <div class="detail-section-title" style="color:#FF8F00">⚠️ Contraintes de livraison</div>
      ${l.priorite && l.priorite.includes('PRIORITAIRE') ? '<div class="detail-row"><span class="detail-label">Priorité</span><span style="color:#EF5350;font-weight:700">🚨 PRIORITAIRE</span></div>' : ''}
      ${l.contrainte && l.contrainte !== 'LIBRE' ? '<div class="detail-row"><span class="detail-label">Contrainte</span><span style="color:#FF8F00;font-weight:600">' + l.contrainte + '</span></div>' : ''}
      ${l.horaires ? '<div class="detail-row"><span class="detail-label">Horaires</span><span style="color:#64B5F6;font-weight:600">🕐 ' + l.horaires + '</span></div>' : ''}
    </div>` : ''}
    <div class="detail-section">
      <div class="detail-section-title">Livraison</div>
      <div class="detail-row"><span class="detail-label">Jour</span><span class="detail-val">${l.jour || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Date</span><span class="detail-val">${l.date || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">N° BL</span><span class="detail-val" style="font-family:monospace">${l.bl || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Nb colis</span><span class="detail-val">${l.nbColis || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Statut</span><span class="detail-val"><span class="pill ${statCls}">${l.statut || 'À livrer'}</span></span></div>
    </div>
    ${routeHtml}
    <div class="detail-actions">
      <button class="btn-action btn-call" onclick="appeler('${l.tel1 || ''}')">📞 Appeler</button>
      <button class="btn-action btn-waze" onclick="ouvrirWaze(${JSON.stringify(l).replace(/"/g,'&quot;')})">🚗 Waze</button>
      <button class="btn-action btn-sig btn-full" onclick="ouvrirSignature(-1, false)">✍️ Faire signer le destinataire</button>
      <button class="btn-action btn-statut-d btn-full" onclick="ouvrirModalStatut(-1, false)">📋 Mettre à jour le statut</button>
    </div>`;

  document.getElementById('detail-view').classList.add('active');
}

function closeDetail() {
  document.getElementById('detail-view').classList.remove('active');
}

// ════════════════════════════════════════
// ACTIONS
// ════════════════════════════════════════
function appeler(tel) {
  if (!tel) { showToast('Numéro non disponible', 'error'); return; }
  window.location.href = 'tel:' + tel;
}

function ouvrirWaze(l) {
  let url;
  // Utiliser les coordonnées GPS seulement si elles sont valides ET dans La Réunion
  if (coordsValides(l.lat, l.lng)) {
    url = `https://waze.com/ul?ll=${l.lat},${l.lng}&navigate=yes&z=17`;
  } else {
    // Recherche par adresse avec "La Réunion" forcé pour éviter la France métro
    const adresse = [l.adresse, l.cp, l.ville, 'La Réunion'].filter(Boolean).join(' ');
    url = `https://waze.com/ul?q=${encodeURIComponent(adresse)}&navigate=yes`;
  }
  window.open(url, '_blank');
}

// ════════════════════════════════════════
// MODAL STATUT
// ════════════════════════════════════════
function ouvrirModalStatut(idx, showDone) {
  const l = idx === -1 ? state.livActive : (() => {
    const livs = state.livraisons.filter(l => showDone ? l.statut === '✅ Livré' : l.statut !== '✅ Livré');
    return livs[idx];
  })();
  if (!l) return;
  state.livActive = l;
  document.getElementById('modal-client-info').textContent = `${l.client} · BL: ${l.bl || '—'}`;
  document.getElementById('modal-statut').value = l.statut || 'À livrer';
  document.getElementById('modal-code').value   = state.code || '';
  document.getElementById('modalStatut').classList.add('active');
}

function fermerModal() {
  document.getElementById('modalStatut').classList.remove('active');
}

async function confirmerStatut() {
  const l      = state.livActive;
  const statut = document.getElementById('modal-statut').value;
  const code   = document.getElementById('modal-code').value.trim();

  if (!code) { showToast('Code zone obligatoire', 'error'); return; }
  if (!l.bl)  { showToast('N° BL manquant', 'error'); return; }

  fermerModal();

  try {
    let data;
    if (GSR) {
      data = await gsRun('gsr_marquerLivre', [state.token||'', l.bl||'', l.zone||'', statut, l.client||'', l.ville||'']);
    } else {
      const url  = `${CFG.API_URL}?action=marquerLivre&key=${CFG.API_KEY}&token=${encodeURIComponent(state.token||'')}&bl=${encodeURIComponent(l.bl)}&zone=${encodeURIComponent(l.zone||'')}&statut=${encodeURIComponent(statut)}`;
      const resp = await fetch(url);
      data = await resp.json();
    }

    if (data.success) {
      l.statut = statut;
      showToast('✅ Statut mis à jour', 'success');
      renderTab();
      closeDetail();
    } else {
      showToast('❌ ' + (data.error || 'Code incorrect'), 'error');
    }
  } catch(_) {
    showToast('❌ Erreur réseau', 'error');
  }
}

// ════════════════════════════════════════
// SIGNATURE
// ════════════════════════════════════════
const canvas  = document.getElementById('sigCanvas');
const ctx     = canvas.getContext('2d');
let drawing   = false, hasSig = false;

function ouvrirSignature(idx, showDone) {
  const l = idx === -1 ? state.livActive : (() => {
    const livs = state.livraisons.filter(l => showDone ? l.statut === '✅ Livré' : l.statut !== '✅ Livré');
    return livs[idx];
  })();
  if (!l) return;
  state.livActive = l;

  document.getElementById('sig-recap').innerHTML =
    `<strong style="color:var(--text)">${l.client}</strong> · ${l.ville || ''}<br>BL: <strong style="color:var(--gold)">${l.bl || '—'}</strong> · ${l.nbColis || '—'} colis`;
  document.getElementById('sigNom').value   = '';
  document.getElementById('sigColis').value = l.nbColis || '';
  document.getElementById('sigObs').value   = '';
  document.getElementById('sigEmail').value = '';
  // Afficher info si email déjà dans la fiche
  const emailInfo = document.getElementById('sigEmailInfo');
  if (l.email) {
    emailInfo.textContent = '✅ Email fiche client : ' + l.email + ' (sera utilisé automatiquement)';
    emailInfo.style.color = 'var(--green)';
  } else {
    emailInfo.textContent = 'Aucun email dans la fiche client — saisir ici si nécessaire';
    emailInfo.style.color = 'var(--text3)';
  }
  clearSig();
  document.getElementById('sig-modal').classList.add('active');
  setTimeout(resizeCanvas, 150);
}

function fermerSignature() {
  document.getElementById('sig-modal').classList.remove('active');
}

function resizeCanvas() {
  const wrap  = document.getElementById('sigWrap');
  const ratio = window.devicePixelRatio || 1;
  canvas.width  = wrap.offsetWidth * ratio;
  canvas.height = 160 * ratio;
  ctx.scale(ratio, ratio);
  ctx.strokeStyle = '#111827';
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
}

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  if (e.touches) return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('mousedown',  e => { drawing=true; ctx.beginPath(); const p=getPos(e); ctx.moveTo(p.x,p.y); });
canvas.addEventListener('mousemove',  e => { if(!drawing) return; const p=getPos(e); ctx.lineTo(p.x,p.y); ctx.stroke(); setSigned(true); });
canvas.addEventListener('mouseup',    () => drawing=false);
canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing=true; ctx.beginPath(); const p=getPos(e); ctx.moveTo(p.x,p.y); }, {passive:false});
canvas.addEventListener('touchmove',  e => { e.preventDefault(); if(!drawing) return; const p=getPos(e); ctx.lineTo(p.x,p.y); ctx.stroke(); setSigned(true); }, {passive:false});
canvas.addEventListener('touchend',   () => drawing=false);

function setSigned(v) {
  hasSig = v;
  document.getElementById('sigHint').style.opacity = v ? '0' : '1';
}
function clearSig() {
  if (canvas.width) ctx.clearRect(0, 0, canvas.width/(window.devicePixelRatio||1), canvas.height/(window.devicePixelRatio||1));
  setSigned(false);
}

async function envoyerSignature() {
  const l      = state.livActive;
  const nom    = document.getElementById('sigNom').value.trim();
  const colis  = document.getElementById('sigColis').value.trim();
  const obs    = document.getElementById('sigObs').value.trim();

  if (!nom)    { showToast('Nom du signataire obligatoire', 'error'); return; }
  if (!colis)  { showToast('Nombre de colis obligatoire', 'error'); return; }
  if (!hasSig) { showToast('Signature obligatoire', 'error'); return; }

  const btn = document.getElementById('btnValiderSig');
  btn.disabled    = true;
  btn.textContent = '⏳ Envoi...';

  const now       = new Date();
  const dateHeure = now.toLocaleDateString('fr-FR') + ' ' + now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});

  const emailManuel = document.getElementById('sigEmail').value.trim();
  const payload = {
    action:        'enregistrerSignature',
    token:         state.token || '',    // Token de session
    livreur:       state.prenom || state.livreur || '',
    bl:            l.bl || '',
    client:        l.client || '',
    nbColis:       colis,
    zone:          l.zone || '',
    dateHeure,
    signataire:    nom,
    adresse:       l.adresse || '',
    ville:         l.ville || '',
    observations:  obs,
    email:         l.email || '',        // Email fiche client
    emailManuel:   emailManuel,          // Email saisi manuellement (prioritaire)
    signature:     canvas.toDataURL('image/png'),
  };

  try {
    let data;
    if (GSR) {
      data = await gsRun('gsr_sauvegarderSignature', [state.token||'', JSON.stringify(payload)]);
    } else {
      const resp = await fetch(`${CFG.API_URL}?key=${CFG.API_KEY}&token=${encodeURIComponent(state.token||'')}`, {
        method: 'POST',
        body:   JSON.stringify(payload),
      });
      data = await resp.json();
    }

    btn.disabled    = false;
    btn.textContent = '✅ Valider et envoyer';

    if (data.success) {
      l.statut = '✅ Livré';
      fermerSignature();
      closeDetail();
      renderTab();
      let msg = '✅ Bon de réception enregistré !';
      if (data.emailEnvoye) msg += `\n📧 Email envoyé à ${data.emailFinal}`;
      else msg += '\n📧 Pas d\'email envoyé (aucun email renseigné)';
      showToast(msg, 'success');
      notifier('Bon de réception signé — ' + l.client);
    } else {
      showToast('❌ ' + (data.error || 'Erreur serveur'), 'error');
    }
  } catch(err) {
    btn.disabled    = false;
    btn.textContent = '✅ Valider et envoyer';
    showToast('❌ Erreur réseau', 'error');
  }
}

// ════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════
function notifier(msg) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('🚚 AJCV Livraisons', { body: msg, icon: '🚚' });
  }
}

function checkNotifications() {
  document.getElementById('notifBadge').classList.remove('show');
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  chargerLivraisons();
  showToast('🔄 Données actualisées', 'success');
}

// Demander permission au chargement
if ('Notification' in window) Notification.requestPermission();

// ════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════
function getStatutClass(statut) {
  const map = {'✅ Livré':'pill-livre','❌ Non livré':'pill-nonlivre','🔄 Reporté':'pill-reporte','📞 À rappeler':'pill-rappel'};
  return map[statut] || 'pill-attente';
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 3500);
}

// ── Installation PWA ─────────────────────────────────────────
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  // Afficher bouton installer
  const btn = document.getElementById('btnInstall');
  if (btn) btn.style.display = 'flex';
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  const btn = document.getElementById('btnInstall');
  if (btn) btn.style.display = 'none';
});

function installerApp() {
  if (!deferredPrompt) {
    alert('Pour installer : Menu Chrome (⋮) → Ajouter à l'écran d'accueil');
    return;
  }
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
}

// ── Service Worker ───────────────────────────────────────────
if ('serviceWorker' in navigator) {
  const swCode = `
    self.addEventListener('install', e => self.skipWaiting());
    self.addEventListener('activate', e => e.waitUntil(clients.claim()));
    self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => new Response('Hors ligne'))));
  `;
  const blob = new Blob([swCode], {type:'application/javascript'});
  const swUrl = URL.createObjectURL(blob);
  navigator.serviceWorker.register(swUrl).catch(()=>{});
}
