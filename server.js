const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
const path    = require('path');

const PORT          = process.env.PORT || 3000;
const POLL_INTERVAL = 60 * 1000;
const LEETIFY_BASE  = 'https://api-public.cs-prod.leetify.com';
const FACEIT_BASE   = 'https://open.faceit.com/data/v4';

// ─── Supabase config ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ─── AES-256-GCM encryption ───────────────────────────────────────────────────
const ENC_KEY = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌  SUPABASE_URL and SUPABASE_KEY environment variables are required.');
  process.exit(1);
}
if (ENC_KEY.length !== 32) {
  console.error('❌  ENCRYPTION_KEY must be a 64-char hex string. Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

function encrypt(obj) {
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const plain     = JSON.stringify(obj);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag       = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(b64) {
  const buf       = Buffer.from(b64, 'base64');
  const iv        = buf.slice(0, 12);
  const tag       = buf.slice(12, 28);
  const encrypted = buf.slice(28);
  const decipher  = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  const plain     = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// ─── Default settings ─────────────────────────────────────────────────────────
function defaultSettings() {
  return {
    showName:     true,
    showPlatform: true,
    showBorder:   true,
    tierColors:   true,
    fontStyle:    'Barlow Condensed',
    fontSize:     'normal',
    widgetWidth:  420,
    widgetHeight: 'auto',
    matchCount:   8,
    bgOpacity:    96,
    bgColor:      '#0a0a0f',
    accentColor:  '#e4a630',
    textColor:    '#ffffff',
    badgeSize:    'normal',
    showScore:    false,
    showMap:      true,
    showDivider:  true,
    flipLayout:   false,
    nameFontSize: 22,
    eloFontSize:  20,
  };
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
const SB_HEADERS = {
  'Content-Type':  'application/json',
  'apikey':        SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Prefer':        'return=minimal',
};

async function dbUpsert(token, config, settings) {
  const encrypted_data = encrypt({ config, settings });
  const body = JSON.stringify({
    id:             token,
    token,
    encrypted_data,
    last_active:    new Date().toISOString(),
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/setups?on_conflict=token`, {
    method:  'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase upsert failed: ${err}`);
  }
}

async function dbUpdateSettings(token, settings) {
  // Read existing row, update only settings
  const existing = await dbGetByToken(token);
  if (!existing) throw new Error('Token not found');
  await dbUpsert(token, existing.config, settings);
}

async function dbUpdateLastActive(token) {
  await fetch(`${SUPABASE_URL}/rest/v1/setups?token=eq.${token}`, {
    method:  'PATCH',
    headers: SB_HEADERS,
    body:    JSON.stringify({ last_active: new Date().toISOString() }),
  });
}

async function dbGetByToken(token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/setups?token=eq.${encodeURIComponent(token)}&select=encrypted_data`, {
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation' },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows || rows.length === 0) return null;
  const decrypted = decrypt(rows[0].encrypted_data);
  // Handle old format (config only) vs new format ({ config, settings })
  if (decrypted.config) return decrypted;
  return { config: decrypted, settings: defaultSettings() };
}

async function dbGetAll() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/setups?select=token,encrypted_data`, {
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation' },
  });
  if (!res.ok) return [];
  return await res.json();
}

// ─── In-memory runtime state ──────────────────────────────────────────────────
const sessions = {};

function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

function freshState(playerName) {
  return {
    playerName:  playerName || 'CS2 PLAYER',
    rating:      null,
    faceitElo:   null,
    faceitLevel: null,
    matches:     [],
    lastFetch:   null,
    error:       null,
    status:      'starting',
  };
}

// ─── Poll ─────────────────────────────────────────────────────────────────────
async function poll(token) {
  const session = sessions[token];
  if (!session) return;
  const { config } = session;
  console.log(`[Poll][${token.slice(0,8)}] Fetching for ${config.steamId}...`);
  try {
    const res = await fetch(`${LEETIFY_BASE}/v3/profile?steam64_id=${config.steamId}`, {
      headers: { '_leetify_key': config.leetifyKey, 'Accept': 'application/json' },
      timeout: 10000,
    });
    if (!res.ok) throw new Error(`Leetify ${res.status}: ${res.statusText}`);
    const profile = await res.json();

    session.state.playerName = profile.name || config.playerName;
    session.state.rating     = (profile.ranks && profile.ranks.premier) || null;

    const raw = profile.recent_matches || [];
    session.state.matches = raw.slice(0, 12).map(m => {
      const result = m.outcome === 'win' ? 'W' : m.outcome === 'loss' ? 'L' : 'D';
      const score  = Array.isArray(m.score) && m.score.length === 2 ? `${m.score[0]}:${m.score[1]}` : '?:?';
      const map    = (m.map_name || '').replace(/^de_/i, '').toUpperCase();
      return { result, score, map, platform: 'leetify', timestamp: m.finished_at || null };
    });

    session.state.lastFetch = new Date().toISOString();
    session.state.error     = null;
    session.state.status    = 'ok';

    if (config.faceitUsername && config.faceitKey) {
      try {
        const fH = { 'Accept': 'application/json', 'Authorization': `Bearer ${config.faceitKey}` };
        const fPRes = await fetch(`${FACEIT_BASE}/players?nickname=${encodeURIComponent(config.faceitUsername)}&game=cs2`, { headers: fH, timeout: 8000 });
        if (fPRes.ok) {
          const fData = await fPRes.json();
          const cs2   = fData.games && fData.games.cs2;
          session.state.faceitElo   = cs2 ? cs2.faceit_elo  : null;
          session.state.faceitLevel = cs2 ? cs2.skill_level : null;
          const playerId = fData.player_id;
          if (playerId) {
            const fHRes = await fetch(`${FACEIT_BASE}/players/${playerId}/history?game=cs2&limit=12`, { headers: fH, timeout: 8000 });
            if (fHRes.ok) {
              const fHist = await fHRes.json();
              const faceitMatches = (fHist.items || []).map(m => {
                const teams = m.teams || {}, teamKeys = Object.keys(teams);
                let result = '?', score = '?:?';
                for (const key of teamKeys) {
                  if ((teams[key].players || []).some(p => p.player_id === playerId)) {
                    result = (m.results && m.results.winner === key) ? 'W' : 'L';
                    const s = m.results && m.results.score;
                    if (s) { const ok = teamKeys.find(k => k !== key); score = `${s[key]??'?'}:${ok?(s[ok]??'?'):'?'}`; }
                    break;
                  }
                }
                const map = ((m.voting?.map?.pick?.[0]) || m.map || '').replace(/^de_/i,'').toUpperCase();
                return { result, score, map, platform: 'faceit', timestamp: m.finished_at ? new Date(m.finished_at * 1000).toISOString() : null };
              });
              const merged = [...session.state.matches, ...faceitMatches]
                .filter(m => m.timestamp).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
              const noTs = session.state.matches.filter(m => !m.timestamp);
              session.state.matches = [...merged, ...noTs].slice(0, 12);
            }
          }
        }
      } catch(e) { console.warn(`[Faceit][${token.slice(0,8)}] ${e.message}`); }
    }
    console.log(`[Poll][${token.slice(0,8)}] OK — ${session.state.matches.length} matches`);
  } catch(err) {
    console.error(`[Poll][${token.slice(0,8)}] ${err.message}`);
    session.state.error  = err.message;
    session.state.status = 'error';
  }
}

function startSession(token, config, settings) {
  if (sessions[token]) clearInterval(sessions[token].interval);
  sessions[token] = {
    config,
    settings: { ...defaultSettings(), ...(settings || {}) },
    state:    freshState(config.playerName),
    lastActive: Date.now(),
    interval: null,
  };
  poll(token);
  sessions[token].interval = setInterval(() => poll(token), POLL_INTERVAL);
}

async function restoreSessionsFromDB() {
  console.log('[Startup] Restoring sessions from Supabase...');
  try {
    const rows = await dbGetAll();
    for (const row of rows) {
      try {
        const decrypted = decrypt(row.encrypted_data);
        // Handle old format (config only) vs new format ({ config, settings })
        const config   = decrypted.config   || decrypted;
        const settings = decrypted.settings || defaultSettings();
        startSession(row.token, config, settings);
        console.log(`[Startup] Restored ${row.token.slice(0,8)}... for ${config.steamId}`);
      } catch(e) {
        console.warn(`[Startup] Failed to restore ${row.token.slice(0,8)}: ${e.message}`);
      }
    }
    console.log(`[Startup] Restored ${rows.length} session(s).`);
  } catch(e) {
    console.error(`[Startup] Could not restore sessions: ${e.message}`);
  }
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));

// ── POST /setup — create new widget ──────────────────────────────────────────
app.post('/setup', async (req, res) => {
  // Accept both JSON and form-urlencoded
  const body = req.body || {};
  const { steamId, leetifyKey, playerName, faceitUsername, faceitKey, settings: rawSettings } = body;
  if (!steamId || !leetifyKey) return res.status(400).send('Steam ID and Leetify API key are required.');

  const config   = { steamId, leetifyKey, playerName: playerName || 'CS2 PLAYER', faceitUsername, faceitKey };
  const settings = { ...defaultSettings(), ...(rawSettings || {}) };
  const token    = createToken();

  try {
    await dbUpsert(token, config, settings);
  } catch(e) {
    console.error('[Setup] DB write failed:', e.message);
    return res.status(500).send('Failed to save session. Please try again.');
  }

  startSession(token, config, settings);
  console.log(`[Session] Created ${token.slice(0,8)}... for ${steamId}`);

  const proto     = req.headers['x-forwarded-proto'] || 'http';
  const host      = req.headers.host;
  const widgetUrl  = `${proto}://${host}/widget?token=${token}`;
  const settingsUrl = `${proto}://${host}/settings?token=${token}`;

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Widget Ready</title>
  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Barlow:wght@400;600&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#07070d;color:#fff;font-family:'Barlow',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#0d0d18;border:1px solid rgba(255,255,255,0.07);border-top:3px solid #e4a630;border-radius:8px;padding:40px 48px;max-width:640px;width:100%}
    h1{font-family:'Barlow Condensed',sans-serif;font-size:32px;font-weight:900;letter-spacing:2px;color:#e4a630;margin-bottom:8px}
    p{color:rgba(255,255,255,0.5);font-size:13px;margin-bottom:20px;line-height:1.6}
    .label{font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;color:rgba(255,255,255,0.25);text-transform:uppercase;margin-bottom:6px;margin-top:20px}
    .url-box{background:#0a0a0f;border:1px solid rgba(255,255,255,0.1);border-radius:5px;padding:12px 16px;font-family:monospace;font-size:12px;color:#5dde8b;word-break:break-all;margin-bottom:12px}
    .btns{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
    .btn-gold{background:#e4a630;color:#0a0a0f;border:none;border-radius:4px;padding:10px 22px;font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:15px;letter-spacing:1px;cursor:pointer}
    .btn-gold:hover{background:#f0b840}
    .btn-outline{background:transparent;color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:10px 22px;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:15px;letter-spacing:1px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
    .btn-outline:hover{color:#fff;border-color:rgba(255,255,255,0.3)}
    .note{padding:12px 16px;border-radius:5px;font-size:12px;color:rgba(255,255,255,0.4);line-height:1.6;margin-bottom:10px}
    .note-gold{background:rgba(228,166,48,0.05);border:1px solid rgba(228,166,48,0.15)}
    .note-green{background:rgba(93,222,139,0.05);border:1px solid rgba(93,222,139,0.12)}
    .note strong{color:#e4a630}
    .note-green strong{color:#5dde8b}
  </style>
  </head><body><div class="card">
  <div style="font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;letter-spacing:3px;color:rgba(255,255,255,0.25);text-transform:uppercase;margin-bottom:6px">CS2 Stream Widget</div>
  <h1>YOUR WIDGET IS READY</h1>
  <p>Your widget link is permanent. Paste it into OBS as a Browser Source and it will keep working even after server restarts.</p>

  <div class="label">Widget URL — paste into OBS</div>
  <div class="url-box" id="wurl">${widgetUrl}</div>
  <div class="btns">
    <button class="btn-gold" onclick="navigator.clipboard.writeText('${widgetUrl}');this.textContent='✓ COPIED!';this.style.background='#5dde8b'">COPY WIDGET URL</button>
    <a class="btn-outline" href="${widgetUrl}" target="_blank">PREVIEW ↗</a>
    <button class="btn-outline" onclick="location.reload()">START OVER</button>
  </div>

  <div class="label">Settings URL — change appearance later</div>
  <div class="url-box" id="surl">${settingsUrl}</div>
  <div class="btns">
    <button class="btn-gold" onclick="navigator.clipboard.writeText('${settingsUrl}');this.textContent='✓ COPIED!';this.style.background='#5dde8b'">COPY SETTINGS URL</button>
    <a class="btn-outline" href="${settingsUrl}" target="_blank">OPEN SETTINGS ↗</a>
  </div>

  <div class="note note-gold"><strong>📺 OBS Setup:</strong> Browser Source → paste Widget URL → Width: ${settings.widgetWidth}px → Height: ~130px → ✓ Shutdown source when not visible</div>
  <div class="note note-green"><strong>🔒 Persistent &amp; Encrypted:</strong> Your credentials are AES-256 encrypted in the database. Your widget never expires. Bookmark both URLs — keep them private.</div>
  </div></body></html>`);
});

// ── GET /widget ───────────────────────────────────────────────────────────────
app.get('/widget', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/');
  if (!sessions[token]) {
    try {
      const stored = await dbGetByToken(token);
      if (!stored) return res.redirect('/');
      startSession(token, stored.config, stored.settings);
    } catch(e) {
      console.error('[Widget] DB lookup failed:', e.message);
      return res.redirect('/');
    }
  }
  sessions[token].lastActive = Date.now();
  dbUpdateLastActive(token).catch(() => {});
  res.sendFile(path.join(__dirname, 'public', 'widget.html'));
});

// ── GET /settings — serve settings page ──────────────────────────────────────
app.get('/settings', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/');
  if (!sessions[token]) {
    try {
      const stored = await dbGetByToken(token);
      if (!stored) return res.redirect('/');
      startSession(token, stored.config, stored.settings);
    } catch(e) { return res.redirect('/'); }
  }
  sessions[token].lastActive = Date.now();
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// ── GET /api/settings — return current settings ───────────────────────────────
app.get('/api/settings', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'No token.' });
  if (!sessions[token]) {
    try {
      const stored = await dbGetByToken(token);
      if (!stored) return res.status(401).json({ error: 'Invalid token.' });
      startSession(token, stored.config, stored.settings);
    } catch(e) { return res.status(500).json({ error: 'DB error.' }); }
  }
  res.json({ settings: sessions[token].settings, playerName: sessions[token].state.playerName });
});

// ── POST /api/settings — save updated settings ────────────────────────────────
app.post('/api/settings', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'No token.' });
  if (!sessions[token]) {
    try {
      const stored = await dbGetByToken(token);
      if (!stored) return res.status(401).json({ error: 'Invalid token.' });
      startSession(token, stored.config, stored.settings);
    } catch(e) { return res.status(500).json({ error: 'DB error.' }); }
  }

  const newSettings = { ...defaultSettings(), ...req.body };
  sessions[token].settings  = newSettings;
  sessions[token].lastActive = Date.now();

  try {
    await dbUpdateSettings(token, newSettings);
    res.json({ ok: true, settings: newSettings });
  } catch(e) {
    console.error('[Settings] DB write failed:', e.message);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

// ── GET /api/matches — return live state + settings ───────────────────────────
app.get('/api/matches', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'Invalid or expired session.' });
  if (!sessions[token]) {
    try {
      const stored = await dbGetByToken(token);
      if (!stored) return res.status(401).json({ error: 'Invalid or expired session.' });
      startSession(token, stored.config, stored.settings);
    } catch(e) { return res.status(500).json({ error: 'Failed to load session.' }); }
  }
  sessions[token].lastActive = Date.now();
  dbUpdateLastActive(token).catch(() => {});
  const s = sessions[token].state;
  res.json({
    playerName:  s.playerName,
    rating:      s.rating,
    faceitElo:   s.faceitElo,
    faceitLevel: s.faceitLevel,
    matches:     s.matches,
    lastFetch:   s.lastFetch,
    status:      s.status,
    error:       s.error,
    settings:    sessions[token].settings,
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🎮 CS2 Widget running on port ${PORT}`);
  console.log(`🔧 Setup: http://localhost:${PORT}/\n`);
  await restoreSessionsFromDB();
});
