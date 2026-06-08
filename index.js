const express      = require('express');
const cors         = require('cors');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const fetch        = require('node-fetch');
const nodemailer   = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CONFIG ─────────────────────────────────────────────────────────────────
// ── SÉCURITÉ ENTREPRISE ────────────────────────────────────────────────────────
const loginAttempts = {}; // { login: { count, lockUntil, lastIP } }
const MAX_ATTEMPTS  = 5;
const LOCK_DURATION = 15 * 60 * 1000; // 15 minutes
const auditLog      = [];              // Dernières 500 actions

function checkBruteForce(login) {
  const a = loginAttempts[login];
  if (!a) return null;
  if (a.lockUntil && Date.now() < a.lockUntil) {
    const restant = Math.ceil((a.lockUntil - Date.now()) / 60000);
    return `Compte temporairement bloqué. Réessayez dans ${restant} minute(s).`;
  }
  if (a.lockUntil && Date.now() >= a.lockUntil) delete loginAttempts[login];
  return null;
}

function recordAttempt(login, success, ip) {
  if (success) { delete loginAttempts[login]; return; }
  if (!loginAttempts[login]) loginAttempts[login] = { count: 0 };
  loginAttempts[login].count++;
  loginAttempts[login].lastIP = ip;
  if (loginAttempts[login].count >= MAX_ATTEMPTS) {
    loginAttempts[login].lockUntil = Date.now() + LOCK_DURATION;
    console.warn(`🔒 Compte bloqué: ${login} (${loginAttempts[login].count} tentatives) depuis ${ip}`);
  }
}

function logAudit(login, action, detail, ip) {
  auditLog.unshift({ ts: new Date().toISOString(), login, action, detail, ip });
  if (auditLog.length > 500) auditLog.pop();
}

function checkPasswordStrength(mdp) {
  if (!mdp || mdp.length < 8) return 'Minimum 8 caractères';
  if (!/[A-Z]/.test(mdp)) return 'Au moins une majuscule requise';
  if (!/[0-9]/.test(mdp)) return 'Au moins un chiffre requis';
  return null; // OK
}

// Nettoyer les tentatives expirées toutes les heures
setInterval(() => {
  const now = Date.now();
  Object.keys(loginAttempts).forEach(k => {
    if (loginAttempts[k].lockUntil && now > loginAttempts[k].lockUntil + 60000) delete loginAttempts[k];
  });
}, 3600000);


const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const JWT_SECRET   = process.env.JWT_SECRET   || 'ajcv_secret_974_reunion';
const GMAPS_KEY    = process.env.GMAPS_KEY     || '';
const EMAIL_USER   = process.env.EMAIL_USER    || '';
const EMAIL_PASS   = process.env.EMAIL_PASS    || '';
const ODOO_API_KEY = process.env.ODOO_API_KEY  || '';
const BREVO_API_KEY= process.env.BREVO_API_KEY || '';
const DEPOT        = { lat: -21.372694, lng: 55.602137 };

// ── SUPABASE ────────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expirée' }); }
}

function norm(s) { return String(s || '').toUpperCase().replace(/\s+/g,' ').trim(); }
// Normalisation forte des noms de commune (tirets, accents, ST→SAINT) pour le regroupement
function normVille(v) {
  return String(v || '')
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // enlever accents
    .replace(/[-']/g, ' ')                               // tirets/apostrophes → espace
    .replace(/\bSTE\b/g, 'SAINTE')
    .replace(/\bST\b/g, 'SAINT')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', message: 'AJCV Backend v2.0 — Supabase' }));

// ══════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════
app.post('/auth/login', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  try {
    const { login, mdp } = req.body;
    if (!login || !mdp) return res.status(400).json({ error: 'Login et mot de passe requis' });

    const loginUpper = login.trim().toUpperCase();

    // Vérifier brute force
    const blocked = checkBruteForce(loginUpper);
    if (blocked) return res.status(429).json({ error: blocked });

    const { data: users } = await supabase
      .from('utilisateurs')
      .select('*')
      .ilike('login', login.trim())
      .limit(1);

    // Utilisateur inexistant ou inactif
    if (!users || users.length === 0) {
      recordAttempt(loginUpper, false, ip);
      logAudit(loginUpper, 'LOGIN_FAILED', 'Utilisateur inexistant', ip);
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const user = users[0];

    // Compte désactivé
    if (!user.actif) {
      logAudit(loginUpper, 'LOGIN_BLOCKED', 'Compte désactivé', ip);
      return res.status(403).json({ error: 'Compte désactivé. Contactez votre administrateur.' });
    }

    // Vérifier MDP (plain text ou hashé bcrypt)
    const ok = user.mdp_hash === mdp || await bcrypt.compare(mdp, user.mdp_hash || '').catch(() => false);
    if (!ok) {
      recordAttempt(loginUpper, false, ip);
      const tentatives = loginAttempts[loginUpper]?.count || 0;
      const restantes = MAX_ATTEMPTS - tentatives;
      logAudit(loginUpper, 'LOGIN_FAILED', `MDP incorrect (${tentatives}/${MAX_ATTEMPTS})`, ip);
      if (restantes <= 0) return res.status(429).json({ error: `Compte bloqué 15 minutes après ${MAX_ATTEMPTS} échecs.` });
      return res.status(401).json({ error: `Identifiants incorrects. ${restantes} tentative(s) restante(s).` });
    }

    recordAttempt(loginUpper, true, ip);
    logAudit(loginUpper, 'LOGIN_OK', `Rôle: ${user.role}`, ip);

    const payload = { login: user.login, prenom: user.prenom, nom: user.nom || '', role: user.role, zone: user.zone || '' };
    const token   = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, expiresIn: 480, ...payload });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// LIVRAISONS
// ══════════════════════════════════════════════════════════════════════════
app.get('/livraisons', auth, async (req, res) => {
  try {
    const { zone, date } = req.query;

    let query = supabase.from('livraisons').select('*');
    // Filtre zone flexible : "2", "Zone 2", "🔵 Zone 2 — Livreur 2" → match par numéro
    if (zone && zone !== '' && zone !== 'undefined') {
      const m = String(zone).match(/[1-3]/);  // premier chiffre de zone (1, 2 ou 3)
      if (m) query = query.ilike('zone', `%${m[0]}%`);
    }
    if (date && date !== '' && date !== 'undefined') {
      const iso = dateToISO(date);
      // Plage [jour, jour+1[ : robuste pour colonne DATE ou TIMESTAMP
      const next = new Date(iso + 'T00:00:00');
      next.setDate(next.getDate() + 1);
      const nextIso = next.toISOString().split('T')[0];
      query = query.gte('date_livraison', iso).lt('date_livraison', nextIso);
    }

    const { data: livraisons, error } = await query.order('created_at');
    if (error) throw error;
    console.log(`Livraisons: zone=${zone} date=${date}→${dateToISO(date)} → ${(livraisons||[]).length} résultats`);

    // Enrichir avec GPS et contraintes depuis table clients
    const noms = [...new Set(livraisons.map(l => l.client_nom))];
    const { data: clients } = await supabase.from('clients').select('nom,lat,lng,horaires,contrainte,priorite,email').in('nom', noms);
    const clientMap = {};
    (clients || []).forEach(c => { clientMap[norm(c.nom)] = c; });

    const enriched = livraisons.map(l => {
      const c = clientMap[norm(l.client_nom)] || {};
      return { ...l,
        client:     l.client_nom,
        nom:        l.client_nom,
        date:       formatDateFR(l.date_livraison),
        statut:     l.statut || '📦 À livrer',
        adresse:    l.adresse || c.adresse || '',
        ville:      l.ville || c.ville || '',
        cp:         l.cp || c.cp || '',
        tel1:       l.tel1 || c.tel1 || '',
        lat:        c.lat || '', lng: c.lng || '',
        horaires:   l.horaires   || c.horaires   || '',
        contrainte: l.contrainte || c.contrainte  || 'LIBRE',
        priorite:   l.priorite   || c.priorite    || 'NORMALE',
        email:      l.email      || c.email       || '',
      };
    });

    res.json({ livraisons: enriched, total: enriched.length });

  } catch (err) {
    console.error('Livraisons error:', err);
    res.status(500).json({ error: 'Erreur chargement livraisons' });
  }
});

// ── MISE À JOUR STATUT ─────────────────────────────────────────────────────
app.patch('/livraisons/statut', auth, async (req, res) => {
  try {
    const { id, bl, statut, remarque } = req.body;
    if (!statut) return res.status(400).json({ error: 'Statut requis' });
    if (!id && !bl) return res.status(400).json({ error: 'ID ou BL requis' });

    const update = { statut, remarque: remarque || null, livreur: req.user.prenom, updated_at: new Date() };
    let q = supabase.from('livraisons').update(update);
    q = id ? q.eq('id', id) : q.eq('bl', bl);
    const { error } = await q;
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('Statut error:', err);
    res.status(500).json({ error: 'Erreur mise à jour statut' });
  }
});

// ── SIGNATURE ──────────────────────────────────────────────────────────────
app.post('/livraisons/signature', auth, async (req, res) => {
  try {
    const { bl, client, ville, zone, signataire, nbColis, observations, signature, dateHeure, emailManuel, remplacement, livraisonId, conforme } = req.body;

    // Mettre à jour statut livraison
    await supabase.from('livraisons')
      .update({ statut: '✅ Livré', signataire, date_heure_livraison: new Date(), updated_at: new Date() })
      .eq('bl', bl);

    // Enregistrer signature — 3 tentatives progressives (gère colonnes manquantes)
    const tentatives = [
      { bl, client, ville, zone, livreur: req.user.prenom, signataire, nb_colis: nbColis, observations: observations||'', date_heure: dateHeure, signature_base64: signature, conforme: conforme===true },
      { bl, client, ville, zone, livreur: req.user.prenom, signataire, nb_colis: nbColis, observations: observations||'', date_heure: dateHeure, signature_base64: signature },
      { bl, client, ville, zone, livreur: req.user.prenom, signataire, nb_colis: nbColis, observations: observations||'', date_heure: dateHeure },
    ];
    let sigSauvee = false;
    for (let t = 0; t < tentatives.length; t++) {
      const { error: e } = await supabase.from('signatures').insert(tentatives[t]);
      if (!e) { console.log(`✅ Signature enregistrée (tentative ${t+1}):`, client); sigSauvee = true; break; }
      console.warn(`⚠️ Tentative ${t+1} échouée:`, e.message);
    }
    if (!sigSauvee) console.error('❌ Signature non enregistrée — vérifiez la structure de la table signatures');

    // Trouver email
    let emailFinal = emailManuel || '';
    if (!emailFinal) {
      const { data } = await supabase.from('clients').select('email').ilike('nom', client).limit(1);
      emailFinal = data?.[0]?.email || '';
    }

    // Mettre à jour la livraison (rapide) AVANT de répondre
    const majLiv = { statut: '✅ Livré', livreur: req.user.prenom, nb_colis: parseInt(nbColis)||1, updated_at: new Date() };
    if (livraisonId) {
      await supabase.from('livraisons').update(majLiv).eq('id', livraisonId).then(()=>{}, ()=>{});
    } else if (bl) {
      await supabase.from('livraisons').update(majLiv).eq('bl', bl).then(()=>{}, ()=>{});
    }

    // ⚡ RÉPONDRE IMMÉDIATEMENT — ne jamais bloquer l'appli sur l'envoi d'email
    const emailVaPartir = !!(emailFinal && (BREVO_API_KEY || (EMAIL_USER && EMAIL_PASS)));
    res.json({ success: true, emailQueued: emailVaPartir, emailFinal });

    // 📧 Envoyer l'email EN ARRIÈRE-PLAN (Brevo HTTP en priorité, après la réponse)
    if (emailVaPartir) {
      envoyerEmail({
        to: emailFinal,
        subject: `${remplacement?'[ANNULE ET REMPLACE] ':''}Bon de réception AJCV — ${client} — BL ${bl}`,
        html: `<h2>Bon de réception AJCV Logistique</h2>
          <p><b>Client:</b> ${client} — ${ville}</p>
          <p><b>BL:</b> ${bl} | <b>Colis:</b> ${nbColis}</p>
          <p><b>Signataire:</b> ${signataire}</p>
          <p><b>Date/Heure:</b> ${dateHeure}</p>
          ${observations ? `<p style="color:#c0392b"><b>Réserves:</b> ${observations}</p>` : ''}
          <p><b>Conformité:</b> ${conforme ? '✅ Déclarée conforme' : 'Non confirmée'}</p>`,
        pdfBase64: (signature||'').replace(/^data:image\/png;base64,/, ''),
        pdfName: `signature_${bl}.png`,
      }).then(r => console.log('✅ Email envoyé à', emailFinal, 'via', r.provider))
        .catch(e => console.error('❌ Email error:', e.message));
    }
    return;
  } catch (err) {
    console.error('Signature error:', err);
    res.status(500).json({ error: 'Erreur signature' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// OPTIMISATION TOURNÉE
// ══════════════════════════════════════════════════════════════════════════
app.post('/tournee/optimiser', auth, async (req, res) => {
  try {
    const { zone, date, force } = req.body;

    // Vérifier le cache UNIQUEMENT si on ne force pas le recalcul
    if (date && !force) {
      const { data: existing } = await supabase.from('tournees')
        .select('*').eq('date_tournee', dateToISO(date)).eq('zone', zone || '').limit(1);
      if (existing && existing[0]?.ordre_json) {
        return res.json({ success: true, fromCache: true, ...existing[0].ordre_json });
      }
    }

    // Récupérer les livraisons du jour avec GPS (filtres robustes)
    let query = supabase.from('livraisons').select('*');
    if (zone && zone !== '' && zone !== 'undefined') {
      const m = String(zone).match(/[1-3]/);
      if (m) query = query.ilike('zone', `%${m[0]}%`);
    }
    if (date && date !== '' && date !== 'undefined') {
      const iso = dateToISO(date);
      const next = new Date(iso + 'T00:00:00'); next.setDate(next.getDate()+1);
      query = query.gte('date_livraison', iso).lt('date_livraison', next.toISOString().split('T')[0]);
    }
    query = query.neq('statut', '✅ Livré');
    const { data: livraisons } = await query;
    console.log(`Optimisation: zone=${zone} date=${date} → ${(livraisons||[]).length} livraisons`);

    // Enrichir avec GPS — récupérer TOUS les clients et matcher par nom normalisé
    if (!livraisons || livraisons.length === 0) return res.json({ success: false, error: 'Aucune livraison à optimiser pour cette zone/date' });
    const { data: clients } = await supabase.from('clients').select('nom,lat,lng,contrainte,priorite');
    const clientMap = {};
    (clients || []).forEach(c => { clientMap[norm(c.nom)] = c; });

    // Construire les stops avec GPS depuis la fiche client
    const stops = livraisons.map(l => {
      const c = clientMap[norm(l.client_nom)] || {};
      const lat = parseFloat(c.lat), lng = parseFloat(c.lng);
      const hasGPS = !isNaN(lat) && !isNaN(lng) && lat >= -21.45 && lat <= -20.85 && lng >= 55.20 && lng <= 55.85;
      return {
        client: l.client_nom, ville: l.ville || '', bl: l.bl || '',
        nb_colis: l.nb_colis || 1,
        lat: hasGPS ? lat : null, lng: hasGPS ? lng : null, hasGPS,
        contrainte: c.contrainte || 'LIBRE', priorite: c.priorite || 'NORMALE',
      };
    });
    if (stops.length === 0) return res.json({ success: false, error: 'Aucune livraison pour cette zone/date' });

    const stopsGPS = stops.filter(s => s.hasGPS);
    const stopsSansGPS = stops.filter(s => !s.hasGPS);
    console.log(`Optimisation: ${stops.length} stops (${stopsGPS.length} GPS, ${stopsSansGPS.length} sans GPS)`);

    // Haversine
    const hav = (a, b) => {
      if (!a.lat || !b.lat) return 999;
      const R = 6371, dLat = (b.lat-a.lat)*Math.PI/180, dLng = (b.lng-a.lng)*Math.PI/180;
      const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
      return R*2*Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
    };

    // ══ GROUPEMENT PAR COMMUNE — TOUJOURS (respect strict des communes) ══
    // 1) Grouper tous les stops par commune (orthographe normalisée)
    const groupes = {};
    stops.forEach(s => { const v = normVille(s.ville)||'AUTRE'; (groupes[v]=groupes[v]||[]).push(s); });
    const communeNoms = Object.keys(groupes);

    // 2) Centroïde de chaque commune (basé sur les stops GPS)
    const centroides = communeNoms.map(v => {
      const g = groupes[v].filter(s => s.hasGPS);
      if (g.length) return { ville:v, lat:g.reduce((a,x)=>a+x.lat,0)/g.length, lng:g.reduce((a,x)=>a+x.lng,0)/g.length, hasGPS:true };
      return { ville:v, lat:-21.1, lng:55.5, hasGPS:false };  // sans GPS → centre Réunion (sera mis en fin)
    });

    // 3) Ordonner les communes — Google Maps optimize sur les centroïdes (≤25 communes) sinon plus proche voisin
    let ordreCommunes = centroides.map(c => c.ville);
    let sourceDistance = 'estimation';
    const centroidesGPS = centroides.filter(c => c.hasGPS);

    if (centroidesGPS.length >= 2 && centroidesGPS.length <= 25 && GMAPS_KEY) {
      try {
        const origin = `${DEPOT.lat},${DEPOT.lng}`;
        const wp = 'optimize:true|' + centroidesGPS.map(c => `${c.lat},${c.lng}`).join('|');
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${origin}&waypoints=${encodeURIComponent(wp)}&region=re&language=fr&key=${GMAPS_KEY}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.status === 'OK' && data.routes[0]) {
          const ordreGPS = data.routes[0].waypoint_order.map(i => centroidesGPS[i].ville);
          const sansGPSvilles = centroides.filter(c => !c.hasGPS).map(c => c.ville);
          ordreCommunes = [...ordreGPS, ...sansGPSvilles];  // communes sans GPS à la fin
          sourceDistance = 'google';
          console.log('✅ Ordre des communes (Google Maps):', ordreGPS.join(' → '));
        } else {
          console.warn('⚠️ Google Maps communes status:', data.status, data.error_message||'');
        }
      } catch (e) { console.warn('⚠️ Google Maps communes:', e.message); }
    }
    // Secours : plus proche voisin sur les centroïdes
    if (sourceDistance !== 'google') {
      const rest = [...centroides]; const ordered = []; let pos = { lat:DEPOT.lat, lng:DEPOT.lng };
      while (rest.length) { rest.sort((a,b)=>hav(pos,a)-hav(pos,b)); const p=rest.shift(); ordered.push(p.ville); if(p.hasGPS) pos={lat:p.lat,lng:p.lng}; }
      ordreCommunes = ordered;
    }

    // 4) Construire l'ordre final : commune par commune, plus proche voisin à l'intérieur
    let posS = { lat:DEPOT.lat, lng:DEPOT.lng };
    const ordreFinal = [];
    ordreCommunes.forEach(ville => {
      const gps = groupes[ville].filter(s => s.hasGPS);
      const sansGPS = groupes[ville].filter(s => !s.hasGPS);
      const g = [...gps];
      while (g.length) {
        g.sort((a,b)=>hav(posS,a)-hav(posS,b));
        const p = g.shift();
        const km = Math.round(hav(posS,p)*1.35*10)/10;
        const min = Math.max(2, Math.round(km/30*60));
        ordreFinal.push({ ...p, segment:{ km, min, description:`≈ ${min} min` } });
        posS = { lat:p.lat, lng:p.lng };
      }
      // Stops sans GPS de cette commune : ajoutés à la suite
      sansGPS.forEach(s => ordreFinal.push({ ...s, segment:{ km:0, min:3, description:'≈ 3 min' } }));
    });

    // 5) Distances réelles via Google Maps si la route finale a ≤ 25 stops GPS (sans ré-optimiser)
    const finalGPS = ordreFinal.filter(s => s.hasGPS);
    if (finalGPS.length >= 1 && finalGPS.length <= 25 && GMAPS_KEY) {
      try {
        const origin = `${DEPOT.lat},${DEPOT.lng}`;
        const wp = finalGPS.map(s => `${s.lat},${s.lng}`).join('|');  // PAS d'optimize → garde notre ordre commune
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${origin}&waypoints=${encodeURIComponent(wp)}&region=re&language=fr&key=${GMAPS_KEY}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.status === 'OK' && data.routes[0]) {
          const legs = data.routes[0].legs;
          let li = 0;
          ordreFinal.forEach(s => {
            if (s.hasGPS && legs[li]) {
              s.segment = { km: Math.round(legs[li].distance.value/1000*10)/10, min: Math.round(legs[li].duration.value/60), description: `${Math.round(legs[li].duration.value/60)} min` };
              li++;
            }
          });
          sourceDistance = 'google-routes';
        }
      } catch (e) { console.warn('⚠️ Distances Google:', e.message); }
    }

    // 6) Numéroter + totaux
    let totalKm = 0, totalMin = 0;
    const ordreOptimise = ordreFinal.map((s, i) => {
      totalKm += s.segment?.km || 0;
      totalMin += s.segment?.min || 0;
      return { ...s, ordre: i + 1 };
    });

    const mapsUrl = `https://www.google.com/maps/dir/${DEPOT.lat},${DEPOT.lng}/` +
      ordreOptimise.filter(s=>s.hasGPS).map(s=>`${s.lat},${s.lng}`).join('/') + `/${DEPOT.lat},${DEPOT.lng}`;

    const result = {
      ordre: ordreOptimise,
      totalKm: Math.round(totalKm*10)/10,
      totalMin, mapsUrl, sourceDistance,
      nbStops: ordreOptimise.length, nbCommunes: ordreCommunes.length, nbSansGPS: stopsSansGPS.length,
    };
    console.log(`Optimisation OK: ${ordreOptimise.length} stops, ${ordreCommunes.length} communes, ${result.totalKm}km`);

    if (date) {
      await supabase.from('tournees').upsert({
        date_tournee: dateToISO(date), zone: zone || '', livreur: req.user.prenom,
        ordre_json: result, total_km: result.totalKm, total_min: result.totalMin, maps_url: mapsUrl
      }, { onConflict: 'date_tournee,zone' });
    }

    res.json({ success: true, ...result });

  } catch (err) {
    console.error('Optimisation error:', err);
    res.status(500).json({ error: 'Erreur optimisation' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// CLIENTS
// ══════════════════════════════════════════════════════════════════════════
app.get('/clients', auth, async (req, res) => {
  try {
    const { zone } = req.query;
    let query = supabase.from('clients').select('*').eq('actif', true).order('nom');
    // Zone peut être "2", "Zone 2", ou "🔵 Zone 2 — Livreur 2" → on filtre par le chiffre
    if (zone && zone !== '' && zone !== 'Toutes zones' && zone !== 'undefined') {
      const zNum = (String(zone).match(/[1-3]/)||[])[0]||'';
      if (zNum) query = query.ilike('zone', `%${zNum}%`);
      else query = query.ilike('zone', `%${zone}%`);
    }
    const { data: clients, error } = await query;
    if (error) throw error;
    res.json({ clients, total: clients.length });
  } catch (err) {
    res.status(500).json({ error: 'Erreur clients' });
  }
});

app.patch('/clients/:nom', auth, async (req, res) => {
  try {
    const nom = decodeURIComponent(req.params.nom);
    const { horaires, contrainte, priorite } = req.body;
    const { error } = await supabase.from('clients')
      .update({ horaires: horaires || '', contrainte: contrainte || 'LIBRE', priorite: priorite || 'NORMALE' })
      .ilike('nom', nom);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur client' });
  }
});

// ── HELPERS ────────────────────────────────────────────────────────────────
function dateToISO(dateFR) {
  if (!dateFR) return null;
  if (dateFR.includes('-')) return dateFR; // déjà ISO
  const [d, m, y] = dateFR.split('/');
  return `${y}-${m?.padStart(2,'0')}-${d?.padStart(2,'0')}`;
}

function formatDateFR(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

// ── AUDIT LOG ─────────────────────────────────────────────────────────────────
app.get('/admin/audit', auth, async (req, res) => {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Accès refusé' });
  res.json({ logs: auditLog.slice(0, 100) });
});

// ── DÉBLOQUER COMPTE ───────────────────────────────────────────────────────────
app.post('/admin/unlock/:login', auth, async (req, res) => {
  if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Accès refusé' });
  delete loginAttempts[req.params.login.toUpperCase()];
  logAudit(req.user.login, 'UNLOCK_ACCOUNT', req.params.login, 'admin');
  res.json({ success: true });
});

// ── OTP EMAIL (optionnel) ─────────────────────────────────────────────────────
const otpStore = {}; // { login: { code, expiry } }

app.post('/auth/send-otp', async (req, res) => {
  try {
    const { login } = req.body;
    const { data: users } = await supabase.from('utilisateurs').select('email,prenom').eq('login', login).eq('actif', true).limit(1);
    if (!users?.[0]?.email) return res.status(404).json({ error: 'Aucun email enregistré pour ce compte. Contactez votre administrateur.' });

    const code   = String(Math.floor(100000 + Math.random() * 900000));
    const expiry = Date.now() + 10 * 60 * 1000; // 10 minutes
    otpStore[login] = { code, expiry };

    if (EMAIL_USER && EMAIL_PASS) {
      const transporter = nodemailer.createTransport({ service:'gmail', auth:{ user:EMAIL_USER, pass:EMAIL_PASS } });
      await transporter.sendMail({
        from:    EMAIL_USER,
        to:      users[0].email,
        subject: 'Code de connexion AJCV — ' + code,
        html:    `<h2>🔐 Code de connexion AJCV</h2><p>Bonjour ${users[0].prenom},</p><p>Votre code : <b style="font-size:28px;letter-spacing:4px">${code}</b></p><p>Valable 10 minutes.</p>`
      });
    }
    res.json({ success: true, email: users[0].email.replace(/(.{2}).*(@.*)/, '$1***$2') });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/verify-otp', async (req, res) => {
  const { login, code } = req.body;
  const otp = otpStore[login];
  if (!otp || otp.code !== code || Date.now() > otp.expiry) {
    return res.status(401).json({ error: 'Code invalide ou expiré' });
  }
  delete otpStore[login];
  res.json({ success: true });
});

// ── START ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ AJCV Backend v2.0 démarré sur port ${PORT}`);
  console.log(`🗄️  Supabase: ${SUPABASE_URL ? 'connecté' : 'NON CONFIGURÉ'}`);
});

// ── AJOUTER LIVRAISON ──────────────────────────────────────────────────────
app.get('/livraisons/check-bl', auth, async (req, res) => {
  try {
    const bl = String(req.query.bl || '').trim();
    if (!bl) return res.json({ exists: false });
    const { data } = await supabase.from('livraisons').select('client_nom,date_livraison').eq('bl', bl).limit(1);
    res.json({ exists: !!(data && data.length), client: data?.[0]?.client_nom || '', date: data?.[0]?.date_livraison || '' });
  } catch (err) {
    res.json({ exists: false });
  }
});

app.post('/livraisons', auth, async (req, res) => {
  try {
    // Détrompeur : empêcher les doublons de N° BL
    const bl = String(req.body.bl || '').trim();
    if (bl) {
      const { data: existant } = await supabase.from('livraisons').select('id,client_nom,date_livraison').eq('bl', bl).limit(1);
      if (existant && existant.length > 0) {
        return res.status(409).json({
          error: 'BL_DUPLICATE',
          message: `Le N° BL "${bl}" existe déjà (client : ${existant[0].client_nom || '?'})`,
          existant: existant[0]
        });
      }
    }
    const { error, data } = await supabase.from('livraisons').insert(req.body).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── IMPORT MASSE LIVRAISONS ────────────────────────────────────────────────────
app.post('/livraisons/bulk', auth, async (req, res) => {
  try {
    const livraisons = req.body.livraisons;
    if (!Array.isArray(livraisons) || livraisons.length === 0)
      return res.status(400).json({ error: 'Aucune livraison fournie' });
    // Convertir les dates et détecter zone si absente
    const prepared = livraisons.map(l => {
      const obj = { ...l };
      if (obj.date_livraison) obj.date_livraison = dateToISO(obj.date_livraison);
      if (!obj.zone && obj.ville) obj.zone = detecterZone(obj.ville, obj.cp);
      if (!obj.statut) obj.statut = '📦 À livrer';
      return obj;
    });
    let total = 0;
    const BATCH = 50;
    for (let i = 0; i < prepared.length; i += BATCH) {
      const batch = prepared.slice(i, i + BATCH);
      const { error } = await supabase.from('livraisons').insert(batch);
      if (!error) total += batch.length;
      else console.warn('Bulk livraisons error:', error.message);
    }
    logAudit(req.user.login, 'IMPORT_LIVRAISONS', total + ' livraisons', 'admin');
    res.json({ success: true, total, message: total + ' livraisons importées' });
  } catch (err) {
    console.error('Bulk livraisons error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SUPPRIMER LIVRAISON ────────────────────────────────────────────────────
app.delete('/livraisons/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('livraisons').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DÉTECTION ZONE AUTOMATIQUE ────────────────────────────────────────────────
function detecterZone(ville, cp) {
  // Détection par code postal (prioritaire)
  const cpStr = String(cp || '').trim();
  const cpZones = {
    '🟢 Zone 1 — Livreur 1': ['97480','97410','97432','97430','97421','97436','97427',
      '97450','97425','97414','97442','97413','97429','97411','97422'],
    '🔵 Zone 2 — Livreur 2': ['97417','97400','97490','97438','97440','97441',
      '97412','97470','97439','97431','97433','97437'],
    '🟠 Zone 3 — Livreur 3': ['97460','97423','97420','97419','97424','97426',
      '97435','97434','97418','97416','97415'],
  };
  for (const [zone, codes] of Object.entries(cpZones)) {
    if (codes.includes(cpStr)) return zone;
  }
  // Fallback par nom de commune
  const v = String(ville || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
  const villeZones = {
    '🟢 Zone 1 — Livreur 1': ['SAINT-JOSEPH','SAINT-PIERRE','TAMPON','SAINT-LOUIS',
      'ETANG-SALE','AVIRONS','PETITE-ILE','ENTRE-DEUX','SAINT-PHILIPPE','CILAOS',
      'BASSE-VALLEE','RIVIERE','RAVINE'],
    '🔵 Zone 2 — Livreur 2': ['SAINT-DENIS','SAINTE-CLOTILDE','SAINTE-MARIE',
      'SAINT-ANDRE','SAINTE-SUZANNE','BRAS-PANON','SAINT-BENOIT','SAINTE-ROSE',
      'PLAINE-DES-PALMISTES','SALAZIE','SAINTE-ANNE'],
    '🟠 Zone 3 — Livreur 3': ['SAINT-PAUL','GUILLAUME','LE PORT','POSSESSION',
      'SAINT-LEU','TROIS-BASSINS','SAINT-GILLES','SALINE','BRULE'],
  };
  for (const [zone, villes] of Object.entries(villeZones)) {
    if (villes.some(z => v.includes(z))) return zone;
  }
  return '';
}

// ── AJOUTER CLIENT (avec géocodage GPS) ────────────────────────────────────────
app.post('/clients', auth, async (req, res) => {
  try {
    const client = req.body;

    // Zone automatique si non fournie
    if (!client.zone && client.ville) {
      client.zone = detecterZone(client.ville, client.cp);
    }

    // Géocodage automatique si adresse fournie
    if (GMAPS_KEY && client.adresse && client.ville) {
      try {
        const q   = encodeURIComponent(`${client.adresse} ${client.cp||''} ${client.ville} La Réunion`);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&region=re&key=${GMAPS_KEY}`;
        const r   = await fetch(url);
        const geo = await r.json();
        if (geo.status === 'OK' && geo.results[0]) {
          const loc = geo.results[0].geometry.location;
          const lat = loc.lat, lng = loc.lng;
          // Valider bounds La Réunion
          if (lat >= -21.45 && lat <= -20.85 && lng >= 55.20 && lng <= 55.85) {
            client.lat = lat; client.lng = lng;
          }
        }
      } catch(e) { console.warn('Geocoding error:', e.message); }
    }

    const { error, data } = await supabase.from('clients').insert(client).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── IMPORT MASSE CLIENTS (sans géocodage immédiat) ────────────────────────────
app.post('/clients/bulk', auth, async (req, res) => {
  try {
    const clients = req.body.clients;
    if (!Array.isArray(clients) || clients.length === 0)
      return res.status(400).json({ error: 'Aucun client fourni' });

    const prepared = clients.map(c => ({
      ...c,
      zone: c.zone || detecterZone(c.ville, c.cp),
      actif: true,
    }));

    let total = 0;
    const BATCH = 50;
    for (let i = 0; i < prepared.length; i += BATCH) {
      const batch = prepared.slice(i, i + BATCH);
      const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'nom' });
      if (!error) total += batch.length;
      else console.warn('Bulk insert error:', error.message);
    }

    geocoderEnArrierePlan(prepared.filter(c => !c.lat && c.adresse && c.ville));

    res.json({ success: true, total, message: total + ' clients importés. Géocodage GPS en cours en arrière-plan...' });

  } catch (err) {
    console.error('Bulk clients error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function envoyerEmail({ to, subject, html, pdfBase64, pdfName }) {
  // Priorité 1 : Brevo API HTTP (fonctionne partout, pas de port SMTP bloqué)
  if (BREVO_API_KEY) {
    const body = {
      sender: { name: 'AJCV Logistique', email: EMAIL_USER || 'noreply@ajcv.re' },
      to: [{ email: to }],
      subject, htmlContent: html,
    };
    if (EMAIL_USER && to !== EMAIL_USER) body.bcc = [{ email: EMAIL_USER }];
    if (pdfBase64) body.attachment = [{ content: pdfBase64, name: pdfName || 'document.png' }];
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept':'application/json', 'api-key': BREVO_API_KEY, 'content-type':'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error('Brevo: ' + (data.message || resp.status));
    return { provider: 'brevo', id: data.messageId };
  }
  // Priorité 2 : SMTP Gmail (secours, peut être bloqué par l'hébergeur)
  if (EMAIL_USER && EMAIL_PASS) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 8000,
      tls: { rejectUnauthorized: false },
    });
    const opts = { from: EMAIL_USER, to: EMAIL_USER === to ? to : `${to}, ${EMAIL_USER}`, subject, html };
    if (pdfBase64) opts.attachments = [{ filename: pdfName || 'document.png', content: pdfBase64, encoding: 'base64' }];
    const info = await transporter.sendMail(opts);
    return { provider: 'smtp', id: info.messageId };
  }
  throw new Error('Aucune méthode email configurée (BREVO_API_KEY ou EMAIL_USER+EMAIL_PASS)');
}

async function geocoderAdresse(adresse, cp, ville) {
  if (!GMAPS_KEY) return null;
  try {
    const q = encodeURIComponent((adresse||'') + ' ' + (cp||'') + ' ' + (ville||'') + ' La Reunion');
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + q + '&region=re&key=' + GMAPS_KEY;
    const r = await fetch(url);
    const geo = await r.json();
    if (geo.status === 'OK' && geo.results[0]) {
      const loc = geo.results[0].geometry.location;
      if (loc.lat >= -21.45 && loc.lat <= -20.85 && loc.lng >= 55.20 && loc.lng <= 55.85) {
        return { lat: loc.lat, lng: loc.lng };
      }
    }
  } catch(e) { console.warn('Geocode error:', e.message); }
  return null;
}

async function geocoderEnArrierePlan(clients) {
  if (!GMAPS_KEY || clients.length === 0) return;
  console.log('Geocoding ' + clients.length + ' clients...');
  let ok = 0;
  for (const client of clients) {
    try {
      await new Promise(r => setTimeout(r, 200));
      const q   = encodeURIComponent(client.adresse + ' ' + (client.cp||'') + ' ' + client.ville + ' La Reunion');
      const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + q + '&region=re&key=' + GMAPS_KEY;
      const r   = await fetch(url);
      const geo = await r.json();
      if (geo.status === 'OK' && geo.results[0]) {
        const loc = geo.results[0].geometry.location;
        if (loc.lat >= -21.45 && loc.lat <= -20.85 && loc.lng >= 55.20 && loc.lng <= 55.85) {
          await supabase.from('clients').update({ lat: loc.lat, lng: loc.lng }).eq('nom', client.nom);
          ok++;
        }
      }
    } catch(e) {}
  }
  console.log('Geocoding done: ' + ok + '/' + clients.length);
}

// ── ADMIN — UTILISATEURS ───────────────────────────────────────────────────
app.get('/admin/users', auth, async (req, res) => {
  try {
    if (!['Admin'].includes(req.user.role)) return res.status(403).json({ error: 'Accès refusé' });
    const { data, error } = await supabase.from('utilisateurs').select('login,prenom,nom,role,zone,actif').order('role');
    if (error) throw error;
    res.json({ users: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CHANGER MOT DE PASSE ───────────────────────────────────────────────────
// ── CRÉER UTILISATEUR ──────────────────────────────────────────────────────────
app.post('/admin/users', auth, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Acces refuse' });
    const { login, mdp, prenom, nom, role, zone, email, tel } = req.body;
    if (!login || !mdp || !prenom) return res.status(400).json({ error: 'Login, mot de passe et prenom requis' });
    const { data: existing } = await supabase.from('utilisateurs').select('login').eq('login', login.toUpperCase()).limit(1);
    if (existing && existing.length > 0) return res.status(400).json({ error: 'Ce login existe deja' });
    const hash = await bcrypt.hash(mdp, 12);
    const { error } = await supabase.from('utilisateurs').insert({
      login: login.toUpperCase(), mdp_hash: hash, prenom, nom: nom||'',
      role: role||'Livreur', zone: zone||'', email: email||'', tel: tel||'', actif: true
    });
    if (error) throw error;
    logAudit(req.user.login, 'CREATE_USER', login.toUpperCase(), 'admin');
    res.json({ success: true });
  } catch (err) { console.error('Create user:', err); res.status(500).json({ error: err.message }); }
});

// ── MODIFIER UTILISATEUR ───────────────────────────────────────────────────────
app.patch('/admin/users/:login', auth, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Acces refuse' });
    const { actif, email, tel, zone, role, prenom, nom } = req.body;
    const update = {};
    if (actif  !== undefined) update.actif  = actif;
    if (email  !== undefined) update.email  = email;
    if (tel    !== undefined) update.tel    = tel;
    if (zone   !== undefined) update.zone   = zone;
    if (role   !== undefined) update.role   = role;
    if (prenom !== undefined) update.prenom = prenom;
    if (nom    !== undefined) update.nom    = nom;
    const { error } = await supabase.from('utilisateurs').update(update).eq('login', req.params.login);
    if (error) throw error;
    logAudit(req.user.login, 'UPDATE_USER', req.params.login, 'admin');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SUPPRIMER UTILISATEUR ──────────────────────────────────────────────────────
app.delete('/admin/users/:login', auth, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Acces refuse' });
    if (req.params.login === req.user.login) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
    const { error } = await supabase.from('utilisateurs').delete().eq('login', req.params.login);
    if (error) throw error;
    logAudit(req.user.login, 'DELETE_USER', req.params.login, 'admin');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RESET MDP PAR ADMIN ────────────────────────────────────────────────────────
app.post('/admin/reset-mdp', auth, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Acces refuse' });
    const { login, newMdp } = req.body;
    if (!login || !newMdp) return res.status(400).json({ error: 'Login et nouveau MDP requis' });
    const hash = await bcrypt.hash(newMdp, 12);
    const { error } = await supabase.from('utilisateurs').update({ mdp_hash: hash }).eq('login', login);
    if (error) throw error;
    logAudit(req.user.login, 'RESET_PASSWORD', login, 'admin');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MODIFIER CLIENT PAR ID ────────────────────────────────────────────────────
app.patch('/clients/id/:id', auth, async (req, res) => {
  try {
    const fields = ['zone','horaires','contrainte','priorite','nom','ville','cp','adresse','tel1','tel2','email'];
    const update = {};
    fields.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
    const { error } = await supabase.from('clients').update(update).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SUPPRIMER CLIENT ──────────────────────────────────────────────────────────
app.delete('/clients/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('clients').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/auth/change-password', auth, async (req, res) => {
  try {
    const { ancien, nouveau } = req.body;
    // Validation force du mot de passe
    const weak = checkPasswordStrength(nouveau);
    if (weak) return res.status(400).json({ error: weak });
    const { data: users } = await supabase.from('utilisateurs').select('*').eq('login', req.user.login).limit(1);
    if (!users?.[0]) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const user = users[0];
    const ok = user.mdp_hash === ancien || await bcrypt.compare(ancien, user.mdp_hash||'').catch(()=>false);
    if (!ok) return res.status(401).json({ error: 'Ancien mot de passe incorrect' });
    const hash = await bcrypt.hash(nouveau, 12);
    await supabase.from('utilisateurs').update({ mdp_hash: hash }).eq('login', req.user.login);
    logAudit(req.user.login, 'CHANGE_PASSWORD', 'MDP changé par utilisateur', 'app');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// INTÉGRATION ODOO (serveur à serveur, authentification par clé API)
// ══════════════════════════════════════════════════════════════════════════

// Middleware : vérifie la clé API Odoo (header X-API-Key)
function odooAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key || '';
  if (!ODOO_API_KEY) return res.status(503).json({ error: 'Intégration Odoo non configurée (ODOO_API_KEY manquante)' });
  if (key !== ODOO_API_KEY) return res.status(401).json({ error: 'Clé API invalide' });
  next();
}

// — PING : tester la connexion —
app.get('/api/odoo/ping', odooAuth, (req, res) => {
  res.json({ success: true, message: 'AJCV API connectée ✅', server: 'AJCV Logistique', time: new Date().toISOString() });
});

// — RECEVOIR LES BLV (bons de livraison) DEPUIS ODOO —
// Body: { livraisons: [{ client, ville, cp, adresse, bl, nb_colis, date, tel1, tel2, indications, zone? }] }
app.post('/api/odoo/livraisons', odooAuth, async (req, res) => {
  try {
    const items = req.body.livraisons || req.body.items || (Array.isArray(req.body) ? req.body : []);
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Aucune livraison fournie (champ "livraisons" attendu)' });

    // Charger les clients pour récupérer le GPS par nom
    const { data: clients } = await supabase.from('clients').select('nom,lat,lng');
    const gpsMap = {};
    (clients || []).forEach(c => { gpsMap[norm(c.nom)] = c; });

    const prepared = items.map(it => {
      const c = gpsMap[norm(it.client || it.client_nom || it.nom)] || {};
      return {
        client_nom: it.client || it.client_nom || it.nom || '',
        ville: it.ville || it.commune || '',
        cp: String(it.cp || it.code_postal || ''),
        adresse: it.adresse || it.address || '',
        bl: it.bl || it.blv || it.name || it.numero || '',
        nb_colis: parseInt(it.nb_colis || it.colis || it.quantity || 1) || 1,
        date_livraison: dateToISO(it.date || it.date_livraison || it.scheduled_date || new Date().toISOString().split('T')[0]),
        tel1: it.tel1 || it.tel || it.phone || '',
        tel2: it.tel2 || it.mobile || '',
        indications: it.indications || it.note || it.comment || '',
        zone: it.zone || detecterZone(it.ville || it.commune, it.cp || it.code_postal),
        statut: 'À livrer',
        lat: c.lat || it.lat || null,
        lng: c.lng || it.lng || null,
      };
    }).filter(l => l.client_nom);

    // Dédup robuste : récupérer les BL déjà présents, puis MAJ ou insertion
    const blsEntrants = prepared.filter(p => p.bl).map(p => p.bl);
    let existantsBL = new Set();
    if (blsEntrants.length) {
      const { data: ex } = await supabase.from('livraisons').select('bl').in('bl', blsEntrants);
      existantsBL = new Set((ex || []).map(e => e.bl));
    }
    let insere = 0, maj = 0, nouveaux = [];
    for (const liv of prepared) {
      if (liv.bl && existantsBL.has(liv.bl)) {
        await supabase.from('livraisons').update(liv).eq('bl', liv.bl).then(()=>{maj++;}, ()=>{});
      } else {
        nouveaux.push(liv);
      }
    }
    // Insérer les nouveaux par lots
    for (let i = 0; i < nouveaux.length; i += 50) {
      const { error } = await supabase.from('livraisons').insert(nouveaux.slice(i, i+50));
      if (!error) insere += nouveaux.slice(i, i+50).length; else console.warn('Odoo insert:', error.message);
    }
    console.log(`📦 Odoo: ${insere} nouvelles, ${maj} mises à jour`);
    res.json({ success: true, recu: items.length, nouvelles: insere, mises_a_jour: maj });
  } catch (err) {
    console.error('Odoo livraisons error:', err);
    res.status(500).json({ error: err.message });
  }
});

// — RECEVOIR LES CLIENTS (nouveaux/màj) DEPUIS ODOO + GÉOCODAGE —
// Body: { clients: [{ nom, ville, cp, adresse, tel1, tel2, email, contrainte?, priorite? }] }
app.post('/api/odoo/clients', odooAuth, async (req, res) => {
  try {
    const items = req.body.clients || req.body.items || (Array.isArray(req.body) ? req.body : []);
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Aucun client fourni (champ "clients" attendu)' });

    const prepared = items.map(it => ({
      nom: it.nom || it.name || it.client || '',
      ville: it.ville || it.commune || it.city || '',
      cp: String(it.cp || it.code_postal || it.zip || ''),
      adresse: it.adresse || it.address || it.street || '',
      tel1: it.tel1 || it.tel || it.phone || '',
      tel2: it.tel2 || it.mobile || '',
      email: it.email || '',
      zone: it.zone || detecterZone(it.ville || it.commune, it.cp || it.code_postal),
      contrainte: it.contrainte || 'LIBRE',
      priorite: it.priorite || 'NORMALE',
      actif: true,
    })).filter(c => c.nom);

    // Upsert par nom (évite les doublons, met à jour les existants)
    let total = 0;
    const BATCH = 50;
    for (let i = 0; i < prepared.length; i += BATCH) {
      const batch = prepared.slice(i, i + BATCH);
      const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'nom' });
      if (!error) total += batch.length; else console.warn('Odoo clients upsert:', error.message);
    }

    // Géocodage en arrière-plan des nouveaux clients sans GPS
    geocoderEnArrierePlan(prepared.filter(c => c.adresse && c.ville));
    console.log(`🏪 Odoo: ${total} clients reçus (géocodage en cours)`);
    res.json({ success: true, recu: items.length, enregistre: total, message: 'Clients enregistrés, géocodage GPS en cours en arrière-plan' });
  } catch (err) {
    console.error('Odoo clients error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TEST EMAIL (diagnostic)
// ══════════════════════════════════════════════════════════════════════════
app.post('/admin/test-email', auth, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Accès refusé' });
    if (!BREVO_API_KEY && !(EMAIL_USER && EMAIL_PASS))
      return res.json({ success: false, error: 'Aucune config email : ajoutez BREVO_API_KEY (recommandé) ou EMAIL_USER+EMAIL_PASS dans Railway' });

    const dest = req.body.email || EMAIL_USER;
    const r = await envoyerEmail({
      to: dest,
      subject: '✅ Test email AJCV Logistique',
      html: '<h2>Configuration email réussie !</h2><p>Si vous lisez cet email, l\'envoi automatique des bons de réception fonctionne.</p><p>— AJCV Logistique</p>',
    });
    res.json({ success: true, message: 'Email de test envoyé à ' + dest + ' (via ' + r.provider + ')', provider: r.provider });
  } catch (e) {
    res.json({ success: false, error: e.message, code: e.code || '' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TEST GOOGLE MAPS (diagnostic clé GMAPS_KEY)
// ══════════════════════════════════════════════════════════════════════════
app.get('/admin/test-gmaps', auth, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Accès refusé' });
    if (!GMAPS_KEY) return res.json({ success: false, error: 'GMAPS_KEY non configurée dans Railway' });

    // Test 1 : Directions API (dépôt → Saint-Denis) avec un waypoint optimisé
    const origin = `${DEPOT.lat},${DEPOT.lng}`;
    const wp = 'optimize:true|-20.9054,55.6066|-20.8955,55.4955';  // 2 points Est
    const urlDir = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${origin}&waypoints=${encodeURIComponent(wp)}&region=re&key=${GMAPS_KEY}`;
    const rDir = await fetch(urlDir);
    const dDir = await rDir.json();

    // Test 2 : Geocoding API
    const urlGeo = `https://maps.googleapis.com/maps/api/geocode/json?address=82C+Rue+Raphael+Babet+97480+Saint-Joseph+La+Reunion&key=${GMAPS_KEY}`;
    const rGeo = await fetch(urlGeo);
    const dGeo = await rGeo.json();

    res.json({
      success: dDir.status === 'OK',
      directions: { status: dDir.status, erreur: dDir.error_message || null, optimise: dDir.routes?.[0]?.waypoint_order || null },
      geocoding: { status: dGeo.status, erreur: dGeo.error_message || null },
      diagnostic:
        dDir.status === 'OK' ? '✅ Tout fonctionne — l\'optimisation utilisera Google Maps' :
        dDir.status === 'REQUEST_DENIED' ? '❌ Clé refusée : API Directions non activée OU restriction de référent HTTP sur la clé (à retirer pour une clé serveur)' :
        dDir.status === 'OVER_QUERY_LIMIT' ? '❌ Quota dépassé OU facturation non activée sur le projet Google Cloud' :
        dDir.status === 'INVALID_REQUEST' ? '⚠️ Requête invalide (mais la clé semble OK)' :
        '❌ Statut inattendu : ' + dDir.status,
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// DOCUMENTS / BONS DE RÉCEPTION SIGNÉS
// ══════════════════════════════════════════════════════════════════════════
app.get('/admin/signatures', auth, async (req, res) => {
  try {
    if (!['Admin','Depot'].includes(req.user.role)) return res.status(403).json({ error: 'Accès refusé' });
    const { date, search } = req.query;
    let query = supabase.from('signatures').select('*').order('created_at', { ascending: false });
    if (date) {
      const iso = dateToISO(date);
      const next = new Date(iso + 'T00:00:00'); next.setDate(next.getDate()+1);
      query = query.gte('created_at', iso).lt('created_at', next.toISOString().split('T')[0]);
    }
    const { data, error } = await query.limit(200);
    if (error) throw error;
    let docs = data || [];
    if (search) {
      const q = search.toLowerCase();
      docs = docs.filter(d => (d.client||'').toLowerCase().includes(q) || (d.signataire||'').toLowerCase().includes(q));
    }
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Détail d'une signature (avec image base64)
app.get('/admin/signatures/:id', auth, async (req, res) => {
  try {
    if (!['Admin','Depot'].includes(req.user.role)) return res.status(403).json({ error: 'Accès refusé' });
    const { data, error } = await supabase.from('signatures').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json({ document: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GÉOCODAGE DES CLIENTS SANS GPS
// ══════════════════════════════════════════════════════════════════════════
app.post('/admin/geocode-clients', auth, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Accès refusé' });
    if (!GMAPS_KEY) return res.json({ success: false, error: 'GMAPS_KEY non configurée' });

    const { data: clients } = await supabase.from('clients').select('id,nom,adresse,cp,ville,lat,lng');
    const sansGPS = (clients || []).filter(c => {
      const lat = parseFloat(c.lat), lng = parseFloat(c.lng);
      return isNaN(lat) || isNaN(lng) || !c.lat || !c.lng;
    });

    if (sansGPS.length === 0) return res.json({ success: true, total: 0, geocodes: 0, echecs: 0, message: 'Tous les clients ont déjà un GPS' });

    let geocodes = 0, echecs = 0;
    const echecsListe = [];
    for (const c of sansGPS) {
      if (!c.adresse && !c.ville) { echecs++; echecsListe.push(c.nom + ' (pas d\'adresse)'); continue; }
      const gps = await geocoderAdresse(c.adresse, c.cp, c.ville);
      if (gps) {
        await supabase.from('clients').update({ lat: gps.lat, lng: gps.lng }).eq('id', c.id);
        geocodes++;
      } else {
        echecs++;
        echecsListe.push(c.nom);
      }
      await new Promise(r => setTimeout(r, 60)); // petit délai (respect quota Google)
    }
    logAudit(req.user.login, 'GEOCODE', geocodes + ' clients géocodés', 'admin');
    console.log(`🌍 Géocodage: ${geocodes} OK, ${echecs} échecs`);
    res.json({ success: true, total: sansGPS.length, geocodes, echecs, echecsListe: echecsListe.slice(0, 20) });
  } catch (err) {
    console.error('Geocode error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ATTRIBUTION DES ZONES PAR CODE POSTAL (clients sans zone)
// ══════════════════════════════════════════════════════════════════════════
app.post('/admin/assign-zones', auth, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Accès refusé' });
    // Récupérer tous les clients
    const { data: clients, error } = await supabase.from('clients').select('id,nom,ville,cp,zone');
    if (error) throw error;
    let updated = 0, skipped = 0;
    for (const c of clients) {
      const zoneActuelle = String(c.zone||'').match(/[1-3]/);
      if (zoneActuelle) { skipped++; continue; } // a déjà une zone
      const z = detecterZone(c.ville, c.cp);
      if (z) {
        await supabase.from('clients').update({ zone: z }).eq('id', c.id);
        updated++;
      }
    }
    logAudit(req.user.login, 'ASSIGN_ZONES', updated + ' zones attribuées', 'admin');
    res.json({ success: true, updated, skipped, total: clients.length });
  } catch (err) {
    console.error('Assign zones error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// VÉHICULES / CAMIONS (flotte)
// ══════════════════════════════════════════════════════════════════════════
// Liste des véhicules actifs (accessible à tous les utilisateurs connectés → livreur)
app.get('/vehicules', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('vehicules').select('*').eq('actif', true).order('plaque');
    if (error) throw error;
    res.json({ vehicules: data || [] });
  } catch (err) {
    res.json({ vehicules: [] });  // ne jamais bloquer le livreur
  }
});

// Ajouter un véhicule (Admin)
app.post('/admin/vehicules', auth, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Accès refusé' });
    const plaque = String(req.body.plaque || '').trim().toUpperCase();
    if (!plaque) return res.status(400).json({ error: 'Plaque requise' });
    const { data, error } = await supabase.from('vehicules')
      .insert({ plaque, description: req.body.description || '', actif: true })
      .select().single();
    if (error) throw error;
    logAudit(req.user.login, 'ADD_VEHICULE', plaque, 'admin');
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer un véhicule (Admin)
app.delete('/admin/vehicules/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Accès refusé' });
    const { error } = await supabase.from('vehicules').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// AFFECTATIONS VÉHICULES
// ══════════════════════════════════════════════════════════════════════════
app.post('/affectation', auth, async (req, res) => {
  try {
    const { plaque, zone, date } = req.body;
    if (!plaque) return res.status(400).json({ error: 'Plaque requise' });
    const dateJour = date ? dateToISO(date) : new Date().toISOString().split('T')[0];
    // Vérifier si déjà une affectation aujourd'hui pour ce livreur
    const { data: existing } = await supabase.from('affectations')
      .select('id').eq('date_jour', dateJour).eq('livreur', req.user.prenom).limit(1);
    if (existing && existing.length > 0) {
      // Mettre à jour la plaque
      await supabase.from('affectations').update({ plaque: plaque.toUpperCase(), zone: zone||'' }).eq('id', existing[0].id);
    } else {
      await supabase.from('affectations').insert({
        date_jour: dateJour, livreur: req.user.prenom, zone: zone||'',
        plaque: plaque.toUpperCase(), heure_debut: new Date()
      });
    }
    logAudit(req.user.login, 'AFFECTATION', `${plaque} zone ${zone}`, 'app');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/affectations', auth, async (req, res) => {
  try {
    if (!['Admin','Depot'].includes(req.user.role)) return res.status(403).json({ error: 'Accès refusé' });
    const { date } = req.query;
    let query = supabase.from('affectations').select('*').order('heure_debut', { ascending: false });
    if (date) query = query.eq('date_jour', dateToISO(date));
    const { data, error } = await query.limit(100);
    if (error) throw error;
    res.json({ affectations: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// KPI & ANALYTICS
// ══════════════════════════════════════════════════════════════════════════
app.get('/kpi', auth, async (req, res) => {
  try {
    const { debut, fin } = req.query;
    const dateDebut = debut || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const dateFin   = fin   || new Date().toISOString().split('T')[0];

    const { data: livraisons, error } = await supabase
      .from('livraisons')
      .select('*')
      .gte('date_livraison', dateDebut)
      .lte('date_livraison', dateFin)
      .order('date_livraison');

    if (error) throw error;

    const total     = livraisons.length;
    const livres    = livraisons.filter(l => l.statut === '✅ Livré').length;
    const nonlivres = livraisons.filter(l => l.statut === '❌ Non livré').length;
    const reportes  = livraisons.filter(l => l.statut === '🔄 Reporté').length;
    const attente   = livraisons.filter(l => !l.statut || l.statut === 'À livrer').length;
    const totalColis= livraisons.reduce((s,l) => s + (parseInt(l.nb_colis||l.colis)||0), 0);
    const tauxLivraison = total > 0 ? Math.round(livres/total*100) : 0;

    // Par zone
    const parZone = {};
    livraisons.forEach(l => {
      const z = l.zone || 'Non défini';
      if (!parZone[z]) parZone[z] = { total:0, livres:0, nonlivres:0, colis:0 };
      parZone[z].total++;
      if (l.statut === '✅ Livré')    parZone[z].livres++;
      if (l.statut === '❌ Non livré') parZone[z].nonlivres++;
      parZone[z].colis += parseInt(l.nb_colis||l.colis)||0;
    });

    // Par livreur
    const parLivreur = {};
    livraisons.forEach(l => {
      const liv = l.livreur || 'Non assigné';
      if (!parLivreur[liv]) parLivreur[liv] = { total:0, livres:0, nonlivres:0 };
      parLivreur[liv].total++;
      if (l.statut === '✅ Livré')    parLivreur[liv].livres++;
      if (l.statut === '❌ Non livré') parLivreur[liv].nonlivres++;
    });

    // Par jour
    const parJour = {};
    livraisons.forEach(l => {
      const d = l.date_livraison;
      if (!parJour[d]) parJour[d] = { total:0, livres:0, nonlivres:0 };
      parJour[d].total++;
      if (l.statut === '✅ Livré')    parJour[d].livres++;
      if (l.statut === '❌ Non livré') parJour[d].nonlivres++;
    });

    // Non livrés récurrents
    const nonLivresMap = {};
    livraisons.filter(l => l.statut === '❌ Non livré').forEach(l => {
      const k = l.client_nom + '|' + l.ville;
      nonLivresMap[k] = (nonLivresMap[k] || 0) + 1;
    });
    const nonLivresRecurrents = Object.entries(nonLivresMap)
      .sort((a,b) => b[1]-a[1])
      .slice(0,10)
      .map(([k,n]) => { const [client,ville] = k.split('|'); return {client,ville,nb:n}; });

    // Top clients les plus livrés
    const clientsMap = {};
    livraisons.filter(l => l.statut === '✅ Livré').forEach(l => {
      clientsMap[l.client_nom] = (clientsMap[l.client_nom]||0)+1;
    });
    const topClients = Object.entries(clientsMap)
      .sort((a,b) => b[1]-a[1]).slice(0,10)
      .map(([client,nb]) => ({client,nb}));

    // Signatures du mois
    const { count: nbSignatures } = await supabase
      .from('signatures').select('*', {count:'exact',head:true})
      .gte('created_at', dateDebut).lte('created_at', dateFin+'T23:59:59');

    // Convertir en tableaux pour le front
    const parZoneArr = Object.entries(parZone).map(([zone,v]) => ({
      zone, total:v.total, livres:v.livres, nonlivres:v.nonlivres,
      taux: v.total>0 ? Math.round(v.livres/v.total*100) : 0
    }));
    const parLivreurArr = Object.entries(parLivreur).map(([livreur,v]) => ({
      livreur, total:v.total, livres:v.livres, nonlivres:v.nonlivres,
      taux: v.total>0 ? Math.round(v.livres/v.total*100) : 0
    }));

    res.json({
      periode:    { debut: dateDebut, fin: dateFin },
      global:     { total, livres, nonlivres, reportes, attente, totalColis, tauxLivraison, nbSignatures: nbSignatures||0 },
      parZone:    parZoneArr,
      parLivreur: parLivreurArr,
      parJour,
      nonLivresRecurrents,
      topClients,
    });

  } catch (err) {
    console.error('KPI error:', err);
    res.status(500).json({ error: 'Erreur KPI' });
  }
});
