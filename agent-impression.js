#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   AGENT D'IMPRESSION AJCV — Raspberry Pi + Zebra ZD220T (CUPS raw)
   ─────────────────────────────────────────────────────────────────────
   Lit la table print_jobs de Supabase (polling), imprime chaque job en
   ZPL brut via `lp -d <file> -o raw`, met à jour le statut.
   Zéro dépendance npm : Node ≥ 18 (fetch natif).
   Config : fichier .env à côté (voir .env.exemple).
   ═══════════════════════════════════════════════════════════════════════ */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Config (.env simple : CLE=valeur) ──────────────────────────────────
(function chargerEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(l => {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
  } catch (_) { /* pas de .env : variables d'environnement systemd */ }
})();

const URL_SB   = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY      = process.env.SUPABASE_SERVICE_KEY || '';
const PRINTER  = process.env.PRINTER || 'ZebraZD220';
const POLL_MS  = Math.max(1000, parseInt(process.env.POLL_MS) || 2000);

if (!URL_SB || !KEY) { console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_KEY manquants (.env)'); process.exit(1); }

const H = {
  'apikey': KEY,
  'Authorization': 'Bearer ' + KEY,
  'Content-Type': 'application/json'
};
const REST = URL_SB + '/rest/v1/print_jobs';

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ── Impression d'un fichier ZPL via CUPS (raw) ─────────────────────────
function imprimer(fichier, file) {
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', file, '-o', 'raw', fichier], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim()));
      resolve((stdout || '').trim());
    });
  });
}

// ── Un cycle : prendre un job pending, l'imprimer, le clôturer ─────────
async function cycle() {
  // 1) le plus ancien job en attente
  const r = await fetch(REST + '?statut=eq.pending&order=created_at.asc&limit=1', { headers: H });
  if (!r.ok) throw new Error('lecture jobs HTTP ' + r.status);
  const jobs = await r.json();
  if (!jobs.length) return false;
  const job = jobs[0];

  // 2) verrou optimiste : pending -> printing (si déjà pris, on passe)
  const lock = await fetch(REST + '?id=eq.' + job.id + '&statut=eq.pending', {
    method: 'PATCH',
    headers: Object.assign({ 'Prefer': 'return=representation' }, H),
    body: JSON.stringify({ statut: 'printing', demarre_le: new Date().toISOString() })
  });
  const locked = lock.ok ? await lock.json() : [];
  if (!locked.length) return true; // pris par ailleurs : on repart

  // 3) impression
  const copies = Math.min(50, Math.max(1, parseInt(job.copies) || 1));
  const file = (job.imprimante || PRINTER).replace(/[^A-Za-z0-9_.-]/g, '') || PRINTER;
  const tmp = path.join(os.tmpdir(), 'ajcv_job_' + job.id + '.zpl');
  try {
    fs.writeFileSync(tmp, job.zpl, 'utf8');
    for (let i = 0; i < copies; i++) await imprimer(tmp, file);
    await fetch(REST + '?id=eq.' + job.id, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ statut: 'done', termine_le: new Date().toISOString(), erreur: null })
    });
    log('🖨️  imprimé', job.id, 'BL', job.bl || '—', '×' + copies, 'sur', file);
  } catch (e) {
    await fetch(REST + '?id=eq.' + job.id, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ statut: 'error', termine_le: new Date().toISOString(), erreur: String(e.message || e).slice(0, 500) })
    }).catch(() => {});
    log('❌ échec', job.id, ':', e.message || e);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  return true; // on retente immédiatement (file possiblement non vide)
}

// ── Ménage : purge des jobs done > 7 jours (1×/heure) ──────────────────
async function menage() {
  try {
    const lim = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    await fetch(REST + '?statut=eq.done&termine_le=lt.' + encodeURIComponent(lim), { method: 'DELETE', headers: H });
  } catch (_) {}
}

// ── Boucle principale ──────────────────────────────────────────────────
let erreursDeSuite = 0;
async function boucle() {
  try {
    const encore = await cycle();
    erreursDeSuite = 0;
    setTimeout(boucle, encore ? 150 : POLL_MS);
  } catch (e) {
    erreursDeSuite++;
    const attente = Math.min(60000, POLL_MS * Math.pow(2, Math.min(5, erreursDeSuite))); // backoff, max 60 s
    log('⚠️ ', e.message || e, '→ nouvel essai dans', Math.round(attente / 1000), 's');
    setTimeout(boucle, attente);
  }
}

log('▶️  Agent impression AJCV — file CUPS :', PRINTER, '· polling', POLL_MS + 'ms');
log('    Supabase :', URL_SB.replace(/^https?:\/\//, '').split('.')[0] + '.…');
boucle();
setInterval(menage, 3600 * 1000);
menage();
