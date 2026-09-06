/**
 * Eye Host v3.2 — Minecraft Panel
 * node server.js → http://localhost:3000
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const INST = new Map();
const SERVERS_ROOT = process.env.SERVERS_ROOT || 'C:/Users/noahs/Desktop/EyeHost-Servers';

const ROOT = __dirname;
const SETTINGS_FILE = path.join(ROOT, 'eyehost-settings.json');

const DEFAULTS = {
  webPort: parseInt(process.env.PORT || '3000', 10),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'admin123',
  mcDir: process.env.MC_DIR || 'C:/Users/noahs/Desktop/MCServer',
  mcJar: process.env.MC_JAR || 'auto',
  javaArgs: process.env.JAVA_ARGS || '-Xmx2G -Xms1G',
  javaPath: process.env.JAVA_PATH || '',
  dataFile: process.env.DATA_FILE || path.join(ROOT, 'eyehost-data.json'),
  modlogFile: process.env.MODLOG_FILE || path.join(ROOT, 'modlog-data.json'),
  modlogSecret: process.env.MODLOG_SECRET || 'change-me',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  paysafeUser: process.env.PAYSAFE_USER || '',
  paysafeKey: process.env.PAYSAFE_KEY || '',
  paysafeAccountId: process.env.PAYSAFE_ACCOUNT || '',
  paysafeEnv: process.env.PAYSAFE_ENV || 'test',
  paysafeWebhookSecret: process.env.PAYSAFE_WEBHOOK_SECRET || '',
};

const CONFIG = { ...DEFAULTS, ...loadSettings() };

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Settings load:', e.message);
  }
  return {};
}

function saveSettings() {
  const keep = {
    mcDir: CONFIG.mcDir,
    mcJar: CONFIG.mcJar,
    javaArgs: CONFIG.javaArgs,
    javaPath: CONFIG.javaPath,
    publicBaseUrl: CONFIG.publicBaseUrl || '',
    paysafeUser: CONFIG.paysafeUser || '',
    paysafeKey: CONFIG.paysafeKey || '',
    paysafeAccountId: CONFIG.paysafeAccountId || '',
    paysafeEnv: CONFIG.paysafeEnv === 'live' ? 'live' : 'test',
    paysafeWebhookSecret: CONFIG.paysafeWebhookSecret || '',
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(keep, null, 2));
}

let DB = { users: [], sessions: {}, servers: [], orders: [], tickets: [], plans: null };

function loadDB() {
  try {
    if (fs.existsSync(CONFIG.dataFile)) {
      DB = { ...DB, ...JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8')) };
    }
  } catch (e) {
    console.error('DB load:', e.message);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(CONFIG.dataFile, JSON.stringify(DB, null, 2));
  } catch (e) {
    console.error('DB save:', e.message);
  }
}

loadDB();

let MODLOG = { staff: {}, events: [], rankRequirements: {}, currentWeek: '', lastSync: null };

function loadModlog() {
  try {
    if (fs.existsSync(CONFIG.modlogFile)) {
      MODLOG = { ...MODLOG, ...JSON.parse(fs.readFileSync(CONFIG.modlogFile, 'utf8')) };
    }
  } catch (e) {
    console.error('ModLog load:', e.message);
  }
}

function saveModlog() {
  try {
    fs.writeFileSync(CONFIG.modlogFile, JSON.stringify(MODLOG, null, 2));
  } catch (e) {
    console.error('ModLog save:', e.message);
  }
}

loadModlog();

function modlogStaffKey(entry) {
  return entry.uuid || entry.name || 'unknown';
}

function applyModlogSync(body) {
  if (body.rankRequirements) MODLOG.rankRequirements = body.rankRequirements;
  if (body.currentWeek) MODLOG.currentWeek = body.currentWeek;
  MODLOG.lastSync = body.timestamp || new Date().toISOString();
  const list = Array.isArray(body.staff) ? body.staff : [];
  for (const s of list) {
    const key = modlogStaffKey(s);
    MODLOG.staff[key] = { ...MODLOG.staff[key], ...s, updatedAt: MODLOG.lastSync };
  }
}

function applyModlogEvent(event) {
  if (!event) return;
  MODLOG.events.unshift({ id: Date.now() + Math.random(), ...event, at: new Date().toISOString() });
  if (MODLOG.events.length > 300) MODLOG.events.length = 300;
}

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const week = Math.ceil((((d - new Date(Date.UTC(year, 0, 1))) / 86400000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function buildRankProgress(totals, requirements) {
  const hours = (totals.onlineMinutes || 0) / 60;
  const bans = totals.bans || 0;
  return Object.entries(requirements).map(([name, req]) => {
    const needH = req.hours || 0;
    const needB = req.bans || 0;
    const hPct = needH ? Math.min(100, Math.round((hours / needH) * 100)) : 100;
    const bPct = needB ? Math.min(100, Math.round((bans / needB) * 100)) : 100;
    return { name, hours, needH, bans, needB, hPct, bPct, done: hours >= needH && bans >= needB };
  });
}

function getModlogStats() {
  const week = MODLOG.currentWeek || isoWeekKey(new Date());
  const staffList = Object.values(MODLOG.staff || {});
  let weekOnline = 0;
  let weekBans = 0;
  let weekKicks = 0;
  const enriched = staffList.map((s) => {
    const ws = (s.weeks && s.weeks[week]) || { onlineMinutes: 0, bans: 0, kicks: 0 };
    weekOnline += ws.onlineMinutes || 0;
    weekBans += ws.bans || 0;
    weekKicks += ws.kicks || 0;
    return { ...s, weekStats: ws, rankProgress: buildRankProgress(s.totals || {}, MODLOG.rankRequirements || {}) };
  }).sort((a, b) => (b.weekStats.onlineMinutes || 0) - (a.weekStats.onlineMinutes || 0));
  return {
    ok: true,
    currentWeek: week,
    lastSync: MODLOG.lastSync,
    summary: { weekOnline, weekBans, weekKicks, staffCount: enriched.length },
    staff: enriched,
    events: MODLOG.events.slice(0, 50),
    rankRequirements: MODLOG.rankRequirements || {},
  };
}

if (!DB.users.find((u) => u.username === CONFIG.adminUser)) {
  DB.users.push({
    id: 'admin',
    username: CONFIG.adminUser,
    password: CONFIG.adminPass,
    role: 'admin',
    createdAt: new Date().toISOString(),
  });
}
if (!Array.isArray(DB.servers)) DB.servers = [];
if (!DB.servers.length) {
  DB.servers.push({
    id: 'main',
    name: 'MCServer',
    dir: CONFIG.mcDir,
    port: 25565,
    ownerId: 'admin',
    sharedWith: [],
    createdAt: new Date().toISOString(),
  });
}
if (!Array.isArray(DB.orders)) DB.orders = [];
if (!Array.isArray(DB.tickets)) DB.tickets = [];
for (const t of DB.tickets) {
  if (!Array.isArray(t.messages)) {
    t.messages = t.message
      ? [{ id: 'm0', userId: t.userId, username: t.username, role: 'user', text: t.message, at: t.at }]
      : [];
  }
}
for (const u of DB.users) {
  u.balance = 0;
  if (!u.email) u.email = u.username === 'admin' ? 'admin@eyehost.local' : '';
}
DB.servers = (DB.servers || []).filter((s) => s.id !== 'bdb0ff85');
DB.orders = [];
for (const o of DB.orders) {
  if (!o.status) o.status = o.serverId ? 'done' : 'pending';
}
const MAIN = DB.servers.find((s) => s.id === 'main');
if (MAIN) MAIN.locked = true;
saveDB();

const DEFAULT_PLANS = [
  {
    id: 'starter', name: 'Starter', ram: '2G', cpu: '1 vCore', disk: '15 GB NVMe',
    players: 10, backups: 1, loc: 'Deutschland', ddos: true, days: 30, price: 4.99,
    desc: 'Für Tests und kleine Welten',
  },
  {
    id: 'plus', name: 'Plus', ram: '4G', cpu: '2 vCores', disk: '30 GB NVMe',
    players: 20, backups: 3, loc: 'Deutschland', ddos: true, days: 30, price: 8.99,
    desc: 'Für Freunde und Plugins',
  },
  {
    id: 'pro', name: 'Pro', ram: '8G', cpu: '3 vCores', disk: '60 GB NVMe',
    players: 40, backups: 7, loc: 'Deutschland', ddos: true, days: 30, price: 14.99,
    desc: 'Mehr Power, Events, Mods',
  },
];

function shopPlans() {
  return Array.isArray(DB.plans) && DB.plans.length ? DB.plans : DEFAULT_PLANS;
}

function paysafeReady() {
  return !!(CONFIG.paysafeUser && CONFIG.paysafeKey);
}

function paysafeBase() {
  return CONFIG.paysafeEnv === 'live' ? 'https://api.paysafe.com' : 'https://api.test.paysafe.com';
}

function publicBase(req) {
  if (CONFIG.publicBaseUrl) return String(CONFIG.publicBaseUrl).replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host || `localhost:${CONFIG.webPort}`;
  return `${proto}://${host}`;
}

function paysafeRequest(method, pathName, body) {
  return new Promise((resolve) => {
    const u = new URL(pathName, paysafeBase());
    const payload = body ? JSON.stringify(body) : '';
    const auth = Buffer.from(`${CONFIG.paysafeUser}:${CONFIG.paysafeKey}`).toString('base64');
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'EyeHost/3.4',
          ...(CONFIG.paysafeAccountId ? { 'X-Paysafe-Account': CONFIG.paysafeAccountId } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = {};
          try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
          resolve({ status: r.statusCode || 0, data });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, data: { error: { message: e.message } } }));
    req.setTimeout(20000, () => {
      req.destroy();
      resolve({ status: 0, data: { error: { message: 'Paysafe Timeout' } } });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function redirectFromHandle(data) {
  const links = data && data.links;
  if (!Array.isArray(links)) return '';
  const hit = links.find((l) => l.rel === 'redirect_payment' || l.rel === 'redirect_onboarding');
  return hit && hit.href ? hit.href : '';
}

function fulfillPaidOrder(order) {
  if (!order || order.status === 'done') return { ok: true, order };
  const buyer = DB.users.find((u) => u.id === order.userId);
  if (!buyer) return { ok: false, msg: 'Käufer nicht gefunden.' };
  const made = createGameServer(buyer, order.planName || 'Server', {
    planId: order.planId,
    ram: order.ram,
    players: order.players,
    days: order.days,
  });
  if (!made.ok) return made;
  order.status = 'done';
  order.paid = true;
  order.serverId = made.server.id;
  order.paidAt = new Date().toISOString();
  saveDB();
  return { ok: true, order, server: made.server };
}

async function completePaysafeOrder(order) {
  if (!order || order.status === 'done') return { ok: true, order };
  if (!order.paymentHandleId && !order.paymentHandleToken) return { ok: false, msg: 'Keine Zahlung.' };
  let token = order.paymentHandleToken;
  if (order.paymentHandleId) {
    const look = await paysafeRequest('GET', `/paymenthub/v1/paymenthandles/${order.paymentHandleId}`);
    const st = look.data && look.data.status;
    if (look.data && look.data.paymentHandleToken) token = look.data.paymentHandleToken;
    if (['FAILED', 'EXPIRED', 'CANCELLED', 'ERROR'].includes(st)) {
      order.status = 'failed';
      saveDB();
      return { ok: false, msg: 'Zahlung fehlgeschlagen.' };
    }
    if (st && st !== 'PAYABLE' && st !== 'COMPLETED') {
      return { ok: false, msg: 'Zahlung noch nicht fertig. PIN bitte auf der Paysafecard-Seite eingeben.' };
    }
  }
  const cents = Math.round(Number(order.price) * 100);
  const pay = await paysafeRequest('POST', '/paymenthub/v1/payments', {
    merchantRefNum: `${order.id}-cap-${Date.now()}`,
    amount: cents,
    currencyCode: 'EUR',
    settleWithAuth: true,
    paymentHandleToken: token,
  });
  const st = pay.data && pay.data.status;
  if (pay.status >= 200 && pay.status < 300 && (st === 'COMPLETED' || st === 'PENDING' || st === 'PROCESSING' || pay.data.id)) {
    order.paymentId = pay.data.id || '';
    return fulfillPaidOrder(order);
  }
  return { ok: false, msg: (pay.data && pay.data.error && pay.data.error.message) || 'Zahlung nicht bestätigt.' };
}

const lastBuyAt = new Map();

function findUserByLogin(login) {
  const key = String(login || '').trim().toLowerCase();
  return DB.users.find((u) => u.username.toLowerCase() === key || String(u.email || '').toLowerCase() === key);
}

function findUserByEmail(email) {
  const key = String(email || '').trim().toLowerCase();
  return DB.users.find((u) => String(u.email || '').toLowerCase() === key);
}

function instNow() {
  const id = als.getStore()?.server?.id || '_none';
  if (!INST.has(id)) {
    INST.set(id, {
      process: null,
      logs: [],
      logOffset: 0,
      logInode: '',
      players: new Set(),
      pidCache: { at: 0, pid: null },
    });
  }
  return INST.get(id);
}

function canUseServer(user, server) {
  if (!user || !server) return false;
  if (user.role === 'admin') return true;
  if (server.ownerId === user.id) return true;
  return (server.sharedWith || []).includes(user.id);
}

function isOwner(user, server) {
  if (!user || !server) return false;
  return user.role === 'admin' || server.ownerId === user.id;
}

function usernameOf(id) {
  return DB.users.find((u) => u.id === id)?.username || '?';
}

function publicServer(s, user) {
  const i = INST.get(s.id);
  const owner = DB.users.find((u) => u.id === s.ownerId);
  return {
    id: s.id,
    name: s.name,
    port: s.port,
    dir: s.dir,
    owner: owner?.username || '?',
    ownerEmail: owner?.email || '',
    mine: s.ownerId === user.id,
    gifted: (s.sharedWith || []).includes(user.id),
    locked: !!s.locked || s.id === 'main',
    plan: s.planId || null,
    ram: s.ram || '',
    expiresAt: s.expiresAt || null,
    sharedWith: (s.sharedWith || []).map((id) => {
      const u = DB.users.find((x) => x.id === id);
      return u ? u.email || u.username : '?';
    }),
    running: !!(i && i.process && !i.process.killed),
  };
}

function serversFor(user) {
  return DB.servers.filter((s) => canUseServer(user, s)).map((s) => publicServer(s, user));
}

function nextPort() {
  const used = new Set(DB.servers.map((s) => Number(s.port) || 0));
  let port = 25565;
  while (used.has(port)) port += 1;
  return port;
}

function findTemplateJar() {
  const dir = path.resolve(CONFIG.mcDir);
  if (!fs.existsSync(dir)) return null;
  const jars = fs.readdirSync(dir).filter((f) => /^paper.+\.jar$/i.test(f));
  if (!jars.length) return null;
  return path.join(dir, jars.sort().at(-1));
}

function createGameServer(user, name, extra = {}) {
  const clean = String(name || '').trim().slice(0, 40);
  if (clean.length < 2) return { ok: false, msg: 'Name zu kurz.' };
  const id = crypto.randomBytes(4).toString('hex');
  const slug = clean.replace(/[^a-zA-Z0-9_-]/g, '_') || id;
  const dir = path.join(SERVERS_ROOT, `${slug}-${id}`);
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  const jar = findTemplateJar();
  if (jar) fs.copyFileSync(jar, path.join(dir, path.basename(jar)));
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  const port = nextPort();
  const players = extra.players || 20;
  const ram = extra.ram || '2G';
  fs.writeFileSync(
    path.join(dir, 'server.properties'),
    `motd=${clean}\nserver-port=${port}\nmax-players=${players}\nonline-mode=true\nwhite-list=false\npvp=true\ngamemode=survival\ndifficulty=easy\n`,
  );
  const rec = {
    id,
    name: clean,
    dir,
    port,
    ownerId: user.id,
    sharedWith: [],
    locked: false,
    planId: extra.planId || null,
    ram,
    expiresAt: extra.days ? new Date(Date.now() + extra.days * 86400000).toISOString() : null,
    createdAt: new Date().toISOString(),
  };
  DB.servers.push(rec);
  saveDB();
  return { ok: true, server: publicServer(rec, user) };
}

function assignByEmail(rec, email, actor) {
  if (!rec || rec.locked || rec.id === 'main') {
    return { ok: false, msg: 'Diesen Server kannst du nicht vergeben.' };
  }
  const target = findUserByEmail(email) || findUserByLogin(email);
  if (!target) return { ok: false, msg: 'Kein Konto mit dieser E-Mail. Die Person muss sich erst registrieren.' };
  rec.ownerId = target.id;
  rec.sharedWith = (rec.sharedWith || []).filter((id) => id !== target.id);
  if (actor && actor.id !== target.id && !(rec.sharedWith || []).includes(actor.id) && actor.role !== 'admin') {
    rec.sharedWith.push(actor.id);
  }
  saveDB();
  return { ok: true, server: publicServer(rec, actor) };
}

function createSession(userId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  DB.sessions[token] = { userId, role, expires: Date.now() + 86400000 * 7 };
  saveDB();
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = DB.sessions[token];
  if (!s || s.expires < Date.now()) return null;
  return s;
}

function getToken(req) {
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('token='));
  if (cookie) return cookie.split('=')[1];
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

function isAdmin(req) {
  const s = getSession(getToken(req));
  return s && s.role === 'admin';
}

function isAuth(req) {
  return !!getSession(getToken(req));
}

const MAX_LOG = 2000;

function addLog(line) {
  const st = instNow();
  const text = String(line).replace(/\r/g, '').trim();
  if (!text) return;
  st.logs.push({ time: new Date().toISOString(), text });
  if (st.logs.length > MAX_LOG) st.logs.shift();
  const join = text.match(/: (\S+) joined the game/);
  const leave = text.match(/: (\S+) left the game/);
  if (join) st.players.add(join[1]);
  if (leave) st.players.delete(leave[1]);
}

function mcRoot() {
  const s = als.getStore()?.server;
  return path.resolve(s?.dir || CONFIG.mcDir);
}

function detectJar() {
  const dir = mcRoot();
  if (!fs.existsSync(dir)) return CONFIG.mcJar === 'auto' ? '' : CONFIG.mcJar;
  const jars = fs.readdirSync(dir).filter((f) => /^paper.+\.jar$/i.test(f));
  if (CONFIG.mcJar && CONFIG.mcJar !== 'auto') {
    if (fs.existsSync(path.join(dir, CONFIG.mcJar))) return CONFIG.mcJar;
  }
  return jars.sort().at(-1) || '';
}

function detectJava() {
  if (CONFIG.javaPath && fs.existsSync(CONFIG.javaPath)) return CONFIG.javaPath;
  const candidates = [
    'C:\\Program Files\\Eclipse Adoptium\\jdk-25.0.3.9-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.8.9-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'java';
}

function findMcPid() {
  const st = instNow();
  if (Date.now() - st.pidCache.at < 2000) return st.pidCache.pid;
  let pid = null;
  try {
    const jar = detectJar();
    const dirHint = mcRoot().replace(/\\/g, '\\\\');
    const script = `
      Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
        Where-Object { $_.CommandLine -and ($_.CommandLine -match 'paper' -or $_.CommandLine -match '${dirHint.replace(/'/g, '')}') } |
        Select-Object -First 1 -ExpandProperty ProcessId
    `;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 6000,
    }).trim();
    if (/^\d+$/.test(out)) pid = parseInt(out, 10);
    if (!pid && jar) {
      const out2 = execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -like '*${jar}*' } | Select-Object -First 1 -ExpandProperty ProcessId`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 6000 }).trim();
      if (/^\d+$/.test(out2)) pid = parseInt(out2, 10);
    }
  } catch {
    pid = null;
  }
  st.pidCache = { at: Date.now(), pid };
  return pid;
}

function isMcRunning() {
  const st = instNow();
  if (st.process && !st.process.killed) return true;
  return !!findMcPid();
}

function pullLatestLog() {
  const st = instNow();
  const file = path.join(mcRoot(), 'logs', 'latest.log');
  if (!fs.existsSync(file)) return;
  const stat = fs.statSync(file);
  const key = `${stat.ino || 0}:${stat.birthtimeMs || 0}:${stat.mtimeMs}`;
  if (st.logInode && st.logInode.split(':').slice(0, 2).join(':') !== key.split(':').slice(0, 2).join(':') && stat.size < st.logOffset) {
    st.logOffset = 0;
  }
  if (stat.size < st.logOffset) st.logOffset = 0;
  if (stat.size === st.logOffset) return;
  if (stat.size - st.logOffset > 2_000_000) {
    st.logOffset = Math.max(0, stat.size - 200_000);
  }
  const buf = Buffer.alloc(stat.size - st.logOffset);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, buf.length, st.logOffset);
  fs.closeSync(fd);
  st.logOffset = stat.size;
  st.logInode = key;
  buf.toString('utf8').split(/\r?\n/).forEach(addLog);
}

function startMC() {
  const st = instNow();
  if (isMcRunning()) return { ok: false, msg: 'Server läuft bereits.' };
  const jar = detectJar();
  if (!jar) return { ok: false, msg: `Keine Paper-JAR in ${mcRoot()}` };
  const jarPath = path.join(mcRoot(), jar);
  if (!fs.existsSync(jarPath)) return { ok: false, msg: `JAR nicht gefunden: ${jarPath}` };
  const java = detectJava();
  const args = [...String(CONFIG.javaArgs || '').split(/\s+/).filter(Boolean), '-jar', jar, 'nogui'];
  st.process = spawn(java, args, {
    cwd: mcRoot(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  st.process.stdout.on('data', () => {});
  st.process.stderr.on('data', (d) => {
    String(d).split(/\r?\n/).filter(Boolean).forEach((line) => addLog(`[java] ${line}`));
  });
  st.process.on('exit', (code) => {
    addLog(`[EyeHost] Server beendet (Exit ${code})`);
    st.process = null;
    st.pidCache = { at: 0, pid: null };
  });
  addLog(`[EyeHost] Starte ${jar} mit ${java}`);
  st.pidCache = { at: 0, pid: null };
  return { ok: true };
}

function killPid(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true }, () => resolve());
  });
}

async function stopMC() {
  const st = instNow();
  if (st.process && st.process.stdin.writable) {
    try {
      st.process.stdin.write('stop\n');
      addLog('> stop');
    } catch {
      /* ignore */
    }
    const child = st.process;
    await new Promise((resolve) => {
      const t = setTimeout(async () => {
        if (st.process === child) {
          child.kill();
          st.process = null;
        }
        resolve();
      }, 12000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    st.pidCache = { at: 0, pid: null };
    return { ok: true };
  }
  const pid = findMcPid();
  if (!pid) return { ok: false, msg: 'Server läuft nicht.' };
  addLog(`[EyeHost] Stoppe externen Paper-Prozess (PID ${pid})`);
  await killPid(pid);
  st.pidCache = { at: 0, pid: null };
  return { ok: true };
}

async function restartMC() {
  if (isMcRunning()) {
    const stopped = await stopMC();
    if (!stopped.ok) return stopped;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return startMC();
}

function sendCmd(cmd) {
  const st = instNow();
  const line = String(cmd || '').trim();
  if (!line) return { ok: false, msg: 'Leerer Befehl.' };
  if (st.process && st.process.stdin.writable) {
    st.process.stdin.write(line + '\n');
    addLog(`> ${line}`);
    return { ok: true };
  }
  return { ok: false, msg: 'Konsole nur wenn der Server über das Panel gestartet wurde. Stoppen und hier neu starten.' };
}

function cpuLoad() {
  const cpus = os.cpus();
  if (!cpus.length) return 0;
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return total ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

function getStatus() {
  const st = instNow();
  const rec = als.getStore()?.server;
  pullLatestLog();
  const jar = detectJar();
  const pid = st.process ? st.process.pid : findMcPid();
  return {
    ok: true,
    running: isMcRunning(),
    owned: !!st.process,
    pid,
    serverId: rec?.id,
    serverName: rec?.name,
    players: [...st.players],
    playerCount: st.players.size,
    memUsed: Math.round((os.totalmem() - os.freemem()) / 1048576),
    memTotal: Math.round(os.totalmem() / 1048576),
    cpuLoad: cpuLoad(),
    uptime: Math.floor(process.uptime()),
    mcDir: mcRoot(),
    mcJar: jar,
    javaArgs: CONFIG.javaArgs,
    javaPath: detectJava(),
    localIP: getLocalIP(),
    port: rec?.port || readProps()['server-port'] || '25565',
  };
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function getPropsPath() {
  return path.join(mcRoot(), 'server.properties');
}

function readProps() {
  const p = getPropsPath();
  if (!fs.existsSync(p)) return {};
  const props = {};
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (l.startsWith('#') || !l.includes('=')) continue;
    const [k, ...v] = l.split('=');
    props[k.trim()] = v.join('=').trim();
  }
  return props;
}

function writeProps(updates) {
  const p = getPropsPath();
  if (!fs.existsSync(p)) return { ok: false, msg: 'server.properties nicht gefunden.' };
  let content = fs.readFileSync(p, 'utf8');
  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^(${key}=).*`, 'm');
    if (regex.test(content)) content = content.replace(regex, `$1${val}`);
    else content += `\n${key}=${val}`;
  }
  fs.writeFileSync(p, content, 'utf8');
  return { ok: true };
}

function safeTarget(rel) {
  const base = mcRoot();
  const target = rel ? path.resolve(base, rel) : base;
  const relTo = path.relative(base, target);
  if (relTo.startsWith('..') || path.isAbsolute(relTo)) return null;
  return target;
}

function listFiles(dir) {
  const t = safeTarget(dir);
  if (!t) return { ok: false, msg: 'Zugriff verweigert.' };
  if (!fs.existsSync(t)) return { ok: false, msg: 'Nicht gefunden.' };
  const entries = fs.readdirSync(t, { withFileTypes: true }).map((e) => {
    const stat = fs.statSync(path.join(t, e.name));
    return { name: e.name, isDir: e.isDirectory(), size: stat.size, modified: stat.mtime.toISOString() };
  });
  return { ok: true, path: dir || '', entries };
}

function readFileSafe(p) {
  const t = safeTarget(p);
  if (!t || !fs.existsSync(t)) return { ok: false, msg: 'Nicht gefunden.' };
  if (fs.statSync(t).size > 2_097_152) return { ok: false, msg: 'Datei zu groß (max 2 MB).' };
  try {
    return { ok: true, content: fs.readFileSync(t, 'utf8') };
  } catch {
    return { ok: false, msg: 'Binärdatei.' };
  }
}

function writeFileSafe(p, content) {
  const t = safeTarget(p);
  if (!t) return { ok: false, msg: 'Zugriff verweigert.' };
  try {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, content, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

function deleteEntry(p) {
  const t = safeTarget(p);
  if (!t || !fs.existsSync(t)) return { ok: false, msg: 'Nicht gefunden.' };
  try {
    fs.rmSync(t, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

function listInstalledPlugins() {
  const dir = path.join(mcRoot(), 'plugins');
  if (!fs.existsSync(dir)) return { ok: true, plugins: [] };
  const plugins = fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.jar'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, plugins };
}

function deletePlugin(name) {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\') || !name.toLowerCase().endsWith('.jar')) {
    return { ok: false, msg: 'Ungültiger Name.' };
  }
  const file = path.join(mcRoot(), 'plugins', name);
  if (!fs.existsSync(file)) return { ok: false, msg: 'Plugin nicht gefunden.' };
  fs.unlinkSync(file);
  return { ok: true };
}

function backupsDir() {
  const dir = path.join(mcRoot(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listBackups() {
  const dir = backupsDir();
  const backups = fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.zip'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
  return { ok: true, backups };
}

function createBackup() {
  const worlds = ['world', 'world_nether', 'world_the_end'].filter((w) => fs.existsSync(path.join(mcRoot(), w)));
  if (!worlds.length) return Promise.resolve({ ok: false, msg: 'Keine Welten gefunden.' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(backupsDir(), `world-${stamp}.zip`);
  const src = worlds.map((w) => `"${path.join(mcRoot(), w)}"`).join(',');
  return new Promise((resolve) => {
    addLog(`[EyeHost] Backup startet…`);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `Compress-Archive -Path ${src} -DestinationPath "${dest}" -Force`],
      { windowsHide: true, timeout: 180000 },
      (err) => {
        if (err) {
          addLog(`[EyeHost] Backup fehlgeschlagen: ${err.message}`);
          return resolve({ ok: false, msg: err.message });
        }
        addLog(`[EyeHost] Backup fertig: ${path.basename(dest)}`);
        resolve({ ok: true, file: path.basename(dest) });
      },
    );
  });
}

function deleteBackup(name) {
  if (!name || name.includes('..') || !name.toLowerCase().endsWith('.zip')) {
    return { ok: false, msg: 'Ungültiger Name.' };
  }
  const file = path.join(backupsDir(), name);
  if (!fs.existsSync(file)) return { ok: false, msg: 'Backup nicht gefunden.' };
  fs.unlinkSync(file);
  return { ok: true };
}

function sanitizeName(name) {
  return path.basename(String(name || 'upload.bin')).replace(/[<>:"|?*\x00-\x1f]/g, '_');
}

function readRawBody(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Datei zu groß (max 80 MB).'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function saveUpload(dir, name, buffer) {
  const safe = sanitizeName(name);
  if (!safe) return { ok: false, msg: 'Ungültiger Dateiname.' };
  const rel = dir ? `${String(dir).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/${safe}` : safe;
  const t = safeTarget(rel);
  if (!t) return { ok: false, msg: 'Zugriff verweigert.' };
  try {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, buffer);
    addLog(`[EyeHost] Upload: ${rel} (${buffer.length} Bytes)`);
    return { ok: true, path: rel, name: safe };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

function spigetJson(apiPath) {
  return new Promise((resolve) => {
    const url = `https://api.spiget.org/v2/${apiPath}`;
    const req = https.get(url, { headers: { 'User-Agent': 'EyeHost/3.2 (panel)' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ ok: true, data: JSON.parse(data), pages: res.headers['x-page-count'] || '' });
        } catch {
          resolve({ ok: false, msg: 'Spiget-Antwort ungültig.' });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, msg: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, msg: 'Spiget Timeout' }); });
  });
}

async function spigetCatalog(query, page) {
  const size = 24;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const pathPart = query
    ? `search/resources/${encodeURIComponent(query)}?size=${size}&page=${p}&sort=-downloads`
    : `resources?size=${size}&page=${p}&sort=-downloads`;
  const r = await spigetJson(pathPart);
  if (!r.ok) return r;
  const list = Array.isArray(r.data) ? r.data : [];
  const results = list.map((item) => ({
    id: item.id,
    name: item.name,
    tag: item.tag || item.description || '',
    downloads: item.downloads,
    rating: item.rating,
    external: !!(item.file && item.file.external),
    fileType: item.file && item.file.type,
    icon: pluginIconSrc(item),
  }));
  return { ok: true, results, page: p, size };
}

function pluginIconSrc(item) {
  if (item && item.icon && item.icon.data) {
    return `data:image/png;base64,${item.icon.data}`;
  }
  if (item && item.icon && item.icon.url) {
    const u = String(item.icon.url);
    if (u.startsWith('http')) return u;
    return `https://www.spigotmc.org/${u.replace(/^\//, '')}`;
  }
  return item && item.id ? `/api/plugins/icon/${item.id}` : '';
}

const iconCache = new Map();

function servePluginIcon(id, res) {
  if (!/^\d+$/.test(String(id))) {
    res.writeHead(404);
    return res.end();
  }
  const cached = iconCache.get(id);
  if (cached && Date.now() - cached.at < 3_600_000) {
    res.writeHead(200, { 'Content-Type': cached.type, 'Cache-Control': 'public, max-age=3600' });
    return res.end(cached.buf);
  }
  const req = https.get(`https://api.spiget.org/v2/resources/${id}/icon`, {
    headers: { 'User-Agent': 'EyeHost/3.2 (panel)' },
  }, (img) => {
    const chunks = [];
    img.on('data', (c) => chunks.push(c));
    img.on('end', () => {
      const buf = Buffer.concat(chunks);
      const type = img.headers['content-type'] || 'image/png';
      if (img.statusCode !== 200 || buf.length < 32) {
        res.writeHead(204);
        return res.end();
      }
      iconCache.set(id, { buf, type, at: Date.now() });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
      res.end(buf);
    });
  });
  req.on('error', () => {
    res.writeHead(204);
    res.end();
  });
  req.setTimeout(10000, () => {
    req.destroy();
    if (!res.headersSent) {
      res.writeHead(204);
      res.end();
    }
  });
}

function downloadPlugin(pluginId, pluginName) {
  return new Promise((resolve) => {
    const pluginsDir = path.join(mcRoot(), 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const safeName = String(pluginName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = path.join(pluginsDir, `${safeName}.jar`);
    addLog(`[EyeHost] Lade Plugin: ${pluginName}`);
    const file = fs.createWriteStream(dest);
    const doGet = (url, hops = 0) => {
      if (hops > 8) return resolve({ ok: false, msg: 'Zu viele Weiterleitungen.' });
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { headers: { 'User-Agent': 'EyeHost/3.2' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) return doGet(res.headers.location, hops + 1);
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return resolve({ ok: false, msg: `HTTP ${res.statusCode}` });
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          addLog(`[EyeHost] Plugin installiert: ${safeName}.jar`);
          resolve({ ok: true, file: `${safeName}.jar` });
        });
      }).on('error', (e) => {
        file.close();
        fs.unlink(dest, () => {});
        resolve({ ok: false, msg: e.message });
      });
    };
    doGet(`https://api.spiget.org/v2/resources/${pluginId}/download`);
  });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function serveFrontend(res) {
  const f = path.join(ROOT, 'panel.html');
  if (!fs.existsSync(f)) {
    res.writeHead(404);
    return res.end('panel.html not found');
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(fs.readFileSync(f));
}

function serveWebsite(res, rel) {
  const name = path.basename(rel);
  const root = path.resolve(ROOT, 'website');
  const f = path.resolve(root, name);
  if (!f.startsWith(root) || !fs.existsSync(f)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const type = name.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : name.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/html; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(fs.readFileSync(f));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Server-Id,ngrok-skip-browser-warning',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,PUT',
    });
    return res.end();
  }

  if (p === '/' || p === '/index.html') return serveWebsite(res, 'index.html');
  if (p === '/style.css' || p === '/app.js' || p === '/config.js') return serveWebsite(res, p.slice(1));
  if (p === '/panel' || p === '/app' || p === '/pay/return' || p === '/pay/ok' || p === '/pay/fail') {
    return serveFrontend(res);
  }
  if (p === '/api/pay/webhook' && req.method === 'POST') {
    const raw = await new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => resolve(b));
    });
    if (CONFIG.paysafeWebhookSecret) {
      const sig = req.headers['x-paysafe-signature'] || req.headers['signature'] || '';
      const expect = crypto.createHmac('sha256', CONFIG.paysafeWebhookSecret).update(raw).digest('hex');
      const ok = sig && (sig === expect || sig === `sha256=${expect}`);
      if (!ok) return json(res, { ok: false, msg: 'Bad signature.' }, 401);
    }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    const ref = body.merchantRefNum || (body.payload && body.payload.merchantRefNum) || '';
    const handleId = body.id || (body.payload && body.payload.id) || '';
    const order = DB.orders.find((o) => o.id === ref || o.paymentHandleId === handleId || o.merchantRefNum === ref);
    if (order && order.status !== 'done') await completePaysafeOrder(order);
    return json(res, { ok: true });
  }
  if (p.startsWith('/api/plugins/icon/') && req.method === 'GET') {
    return servePluginIcon(p.split('/').pop(), res);
  }

  if (p === '/api/modlog' && req.method === 'POST') {
    const b = await parseBody(req);
    if (b.secret !== CONFIG.modlogSecret) return json(res, { ok: false, msg: 'Unauthorized' }, 403);
    if (b.type === 'sync') applyModlogSync(b);
    else if (b.type === 'event') applyModlogEvent(b.event);
    saveModlog();
    return json(res, { ok: true });
  }

  if (p === '/api/register' && req.method === 'POST') {
    const b = await parseBody(req);
    const username = String(b.username || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (username.length < 3 || username.length > 20) return json(res, { ok: false, msg: 'Name: 3–20 Zeichen.' }, 400);
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return json(res, { ok: false, msg: 'Nur Buchstaben, Zahlen und _.' }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, { ok: false, msg: 'Bitte eine echte E-Mail angeben.' }, 400);
    if (password.length < 4) return json(res, { ok: false, msg: 'Passwort mindestens 4 Zeichen.' }, 400);
    if (DB.users.find((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return json(res, { ok: false, msg: 'Benutzername schon vergeben.' }, 400);
    }
    if (findUserByEmail(email)) return json(res, { ok: false, msg: 'E-Mail schon registriert.' }, 400);
    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      username,
      email,
      password,
      role: 'user',
      balance: 0,
      createdAt: new Date().toISOString(),
    };
    DB.users.push(user);
    saveDB();
    const token = createSession(user.id, user.role);
    res.writeHead(200, {
      'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Lax`,
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({
      ok: true, token, role: user.role, username: user.username, email: user.email, balance: user.balance || 0,
    }));
  }

  if (p === '/api/login' && req.method === 'POST') {
    const b = await parseBody(req);
    const user = findUserByLogin(b.username);
    if (!user || user.password !== b.password) return json(res, { ok: false, msg: 'Falscher Login oder Passwort.' }, 401);
    const token = createSession(user.id, user.role);
    res.writeHead(200, {
      'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Lax`,
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({
      ok: true, token, role: user.role, username: user.username, email: user.email || '', balance: user.balance || 0,
    }));
  }

  if (p === '/api/logout' && req.method === 'POST') {
    delete DB.sessions[getToken(req)];
    saveDB();
    return json(res, { ok: true });
  }

  if (!isAuth(req)) return json(res, { ok: false, msg: 'Nicht eingeloggt.' }, 401);
  const sess = getSession(getToken(req));
  const user = DB.users.find((u) => u.id === sess.userId);

  if (p === '/api/me') {
    return json(res, {
      ok: true,
      username: user?.username,
      email: user?.email || '',
      role: sess.role,
      balance: user?.balance || 0,
    });
  }
  if (p === '/api/shop' && req.method === 'GET') {
    return json(res, { ok: true, plans: shopPlans(), paysafe: paysafeReady() });
  }
  if (p === '/api/shop/buy' && req.method === 'POST') {
    const b = await parseBody(req);
    if (b.pin || b.paysafePin || b.cardNumber || b.cvv || b.pan) {
      return json(res, { ok: false, msg: 'Karten-PINs werden hier nicht angenommen.' }, 400);
    }
    const plan = shopPlans().find((x) => x.id === b.planId);
    if (!plan) return json(res, { ok: false, msg: 'Paket nicht gefunden.' }, 404);
    if (!paysafeReady()) {
      return json(res, { ok: false, msg: 'Paysafecard ist noch nicht eingerichtet. Der Host muss die API-Keys im Admin eintragen.' }, 503);
    }
    const now = Date.now();
    if ((lastBuyAt.get(user.id) || 0) > now - 8000) {
      return json(res, { ok: false, msg: 'Bitte kurz warten, Zahlung läuft schon.' }, 429);
    }
    lastBuyAt.set(user.id, now);
    const cents = Math.round(Number(plan.price) * 100);
    if (!Number.isFinite(cents) || cents < 100) return json(res, { ok: false, msg: 'Ungültiger Preis.' }, 400);
    const orderId = crypto.randomBytes(6).toString('hex');
    const base = publicBase(req);
    const consumerId = crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 20);
    const handle = await paysafeRequest('POST', '/paymenthub/v1/paymenthandles', {
      merchantRefNum: orderId,
      transactionType: 'PAYMENT',
      paymentType: 'PAYSAFECARD',
      amount: cents,
      currencyCode: 'EUR',
      customerIp: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim(),
      profile: { email: user.email || '' },
      PaysafeCard: {
        consumerId,
        minAgeRestriction: 16,
        countryRestriction: 'DE',
      },
      merchantDescriptor: { dynamicDescriptor: 'EyeHost', phone: '00000000' },
      returnLinks: [
        { rel: 'on_completed', href: `${base}/pay/return?order=${orderId}&ok=1`, method: 'GET' },
        { rel: 'on_failed', href: `${base}/pay/return?order=${orderId}&ok=0`, method: 'GET' },
        { rel: 'default', href: `${base}/pay/return?order=${orderId}`, method: 'GET' },
      ],
    });
    const redirect = redirectFromHandle(handle.data);
    if (!redirect) {
      const msg = (handle.data && handle.data.error && (handle.data.error.message || handle.data.error.code)) || 'Paysafe hat die Zahlung nicht gestartet.';
      return json(res, { ok: false, msg: String(msg) }, 502);
    }
    const order = {
      id: orderId,
      merchantRefNum: orderId,
      userId: user.id,
      username: user.username,
      email: user.email,
      planId: plan.id,
      planName: plan.name,
      name: plan.name,
      price: plan.price,
      cents,
      ram: plan.ram,
      players: plan.players,
      days: plan.days,
      payMethod: 'paysafecard',
      status: 'pending',
      paid: false,
      serverId: null,
      paymentHandleId: handle.data.id || '',
      paymentHandleToken: handle.data.paymentHandleToken || '',
      at: new Date().toISOString(),
    };
    DB.orders.unshift(order);
    saveDB();
    return json(res, { ok: true, redirect, orderId });
  }
  if (p === '/api/pay/finish' && req.method === 'POST') {
    const b = await parseBody(req);
    const order = DB.orders.find((o) => o.id === b.orderId);
    if (!order) return json(res, { ok: false, msg: 'Bestellung nicht gefunden.' }, 404);
    if (user.role !== 'admin' && order.userId !== user.id) return json(res, { ok: false, msg: 'Kein Zugriff.' }, 403);
    return json(res, await completePaysafeOrder(order));
  }
  if (p === '/api/orders' && req.method === 'GET') {
    const list = (user.role === 'admin' ? DB.orders : DB.orders.filter((o) => o.userId === user.id)).slice(0, 50);
    return json(res, { ok: true, orders: list });
  }
  if (p.startsWith('/api/orders/') && p.endsWith('/fulfill') && req.method === 'POST') {
    if (user.role !== 'admin') return json(res, { ok: false, msg: 'Nur der Host.' }, 403);
    const id = p.split('/')[3];
    const order = DB.orders.find((o) => o.id === id);
    if (!order) return json(res, { ok: false, msg: 'Bestellung nicht gefunden.' }, 404);
    return json(res, fulfillPaidOrder(order));
  }
  if (p === '/api/tickets' && req.method === 'GET') {
    const raw = user.role === 'admin'
      ? DB.tickets
      : DB.tickets.filter((t) => t.userId === user.id && t.status !== 'closed');
    const list = raw
      .map((t) => {
        const lastMsg = (t.messages && t.messages.length) ? t.messages[t.messages.length - 1] : null;
        return {
          id: t.id,
          subject: t.subject,
          status: t.status,
          username: t.username,
          email: t.email,
          at: t.at,
          lastAt: lastMsg ? lastMsg.at : t.at,
          last: lastMsg ? lastMsg.text : (t.message || ''),
          replies: (t.messages && t.messages.length) || 0,
          unread: user.role === 'admin' ? !!t.unreadForAdmin : !!t.unreadForUser,
        };
      })
      .sort((a, b) => {
        if (a.status === 'closed' && b.status !== 'closed') return 1;
        if (b.status === 'closed' && a.status !== 'closed') return -1;
        if (a.unread !== b.unread) return a.unread ? -1 : 1;
        return new Date(b.lastAt || 0) - new Date(a.lastAt || 0);
      })
      .slice(0, 80);
    return json(res, { ok: true, tickets: list, open: list.filter((t) => t.status !== 'closed').length });
  }
  if (p === '/api/tickets' && req.method === 'POST') {
    const b = await parseBody(req);
    const text = String(b.message || '').trim().slice(0, 2000);
    if (!text) return json(res, { ok: false, msg: 'Bitte eine Nachricht schreiben.' }, 400);
    const now = new Date().toISOString();
    const ticket = {
      id: crypto.randomBytes(5).toString('hex'),
      userId: user.id,
      email: user.email,
      username: user.username,
      subject: String(b.subject || 'Support').trim().slice(0, 80) || 'Support',
      status: 'open',
      at: now,
      messages: [{
        id: crypto.randomBytes(4).toString('hex'),
        userId: user.id,
        username: user.username,
        role: 'user',
        text,
        at: now,
      }],
    };
    ticket.unreadForAdmin = user.role !== 'admin';
    ticket.unreadForUser = false;
    DB.tickets.unshift(ticket);
    saveDB();
    return json(res, { ok: true, ticket });
  }
  if (p.startsWith('/api/tickets/') && req.method === 'GET') {
    const t = DB.tickets.find((x) => x.id === p.split('/')[3]);
    if (!t) return json(res, { ok: false, msg: 'Ticket nicht gefunden.' }, 404);
    if (user.role !== 'admin' && t.userId !== user.id) return json(res, { ok: false, msg: 'Kein Zugriff.' }, 403);
    if (user.role === 'admin') t.unreadForAdmin = false;
    else t.unreadForUser = false;
    saveDB();
    return json(res, { ok: true, ticket: t });
  }
  if (p.startsWith('/api/tickets/') && p.endsWith('/reply') && req.method === 'POST') {
    const t = DB.tickets.find((x) => x.id === p.split('/')[3]);
    if (!t) return json(res, { ok: false, msg: 'Ticket nicht gefunden.' }, 404);
    if (user.role !== 'admin' && t.userId !== user.id) return json(res, { ok: false, msg: 'Kein Zugriff.' }, 403);
    if (t.status === 'closed' && user.role !== 'admin') {
      return json(res, { ok: false, msg: 'Ticket ist geschlossen.' }, 400);
    }
    const b = await parseBody(req);
    const text = String(b.message || '').trim().slice(0, 2000);
    if (!text) return json(res, { ok: false, msg: 'Leere Nachricht.' }, 400);
    if (!Array.isArray(t.messages)) t.messages = [];
    const asSupport = user.role === 'admin' && user.id !== t.userId;
    t.messages.push({
      id: crypto.randomBytes(4).toString('hex'),
      userId: user.id,
      username: user.username,
      role: asSupport ? 'staff' : 'user',
      text,
      at: new Date().toISOString(),
    });
    t.status = asSupport ? 'answered' : 'open';
    if (asSupport) {
      t.unreadForUser = true;
      t.unreadForAdmin = false;
    } else {
      t.unreadForAdmin = true;
      t.unreadForUser = false;
    }
    saveDB();
    return json(res, { ok: true, ticket: t });
  }
  if (p.startsWith('/api/tickets/') && (p.endsWith('/close') || p.endsWith('/open')) && req.method === 'POST') {
    const t = DB.tickets.find((x) => x.id === p.split('/')[3]);
    if (!t) return json(res, { ok: false, msg: 'Ticket nicht gefunden.' }, 404);
    if (user.role !== 'admin' && t.userId !== user.id) return json(res, { ok: false, msg: 'Kein Zugriff.' }, 403);
    t.status = p.endsWith('/close') ? 'closed' : 'open';
    saveDB();
    return json(res, { ok: true, ticket: t });
  }
  if (p.startsWith('/api/tickets/') && req.method === 'PUT') {
    const t = DB.tickets.find((x) => x.id === p.split('/')[3]);
    if (!t) return json(res, { ok: false, msg: 'Ticket nicht gefunden.' }, 404);
    if (user.role !== 'admin' && t.userId !== user.id) return json(res, { ok: false, msg: 'Kein Zugriff.' }, 403);
    const b = await parseBody(req);
    if (b.status === 'closed' || b.status === 'open' || (user.role === 'admin' && b.status === 'answered')) {
      t.status = b.status;
    }
    saveDB();
    return json(res, { ok: true, ticket: t });
  }
  if (p === '/api/servers' && req.method === 'GET') {
    return json(res, { ok: true, servers: serversFor(user), balance: user.balance || 0 });
  }
  if (p === '/api/servers' && req.method === 'POST') {
    if (user.role !== 'admin') return json(res, { ok: false, msg: 'Server erstellen kann nur der Host.' }, 403);
    const b = await parseBody(req);
    const made = createGameServer(user, b.name);
    if (made.ok && String(b.email || '').trim()) {
      const rec = DB.servers.find((s) => s.id === made.server.id);
      const assigned = assignByEmail(rec, b.email, user);
      if (!assigned.ok) return json(res, { ok: true, server: made.server, warn: assigned.msg });
      return json(res, assigned);
    }
    return json(res, made);
  }
  if (p.startsWith('/api/servers/') && (p.endsWith('/share') || p.endsWith('/assign')) && req.method === 'POST') {
    const id = p.split('/')[3];
    const rec = DB.servers.find((s) => s.id === id);
    if (user.role !== 'admin') return json(res, { ok: false, msg: 'Nur der Host kann Server vergeben.' }, 403);
    if (!isOwner(user, rec)) return json(res, { ok: false, msg: 'Kein Zugriff.' }, 403);
    const b = await parseBody(req);
    return json(res, assignByEmail(rec, b.email || b.username, user));
  }
  if (p.startsWith('/api/servers/') && req.method === 'DELETE') {
    const id = p.split('/').pop();
    const rec = DB.servers.find((s) => s.id === id);
    if (!isOwner(user, rec)) return json(res, { ok: false, msg: 'Kein Zugriff.' }, 403);
    if (rec.id === 'main' || rec.locked) {
      return json(res, { ok: false, msg: 'Dieser Server bleibt und kann nicht gelöscht werden.' }, 400);
    }
    DB.servers = DB.servers.filter((s) => s.id !== id);
    saveDB();
    return json(res, { ok: true });
  }

  const sid = req.headers['x-server-id'] || url.searchParams.get('server') || '';
  const serverRec = DB.servers.find((s) => s.id === sid) || null;
  const needsServer = ![
    '/api/users', '/api/settings', '/api/modlog/stats', '/api/plugins/catalog', '/api/plugins/search',
  ].includes(p) && !p.startsWith('/api/users/') && !p.startsWith('/api/tickets') && !p.startsWith('/api/pay') && !p.startsWith('/api/shop');

  if (needsServer && !canUseServer(user, serverRec)) {
    return json(res, { ok: false, msg: 'Kein Server gewählt oder kein Zugriff.' }, 403);
  }

  return als.run({ server: serverRec, user }, () => routeServer(req, res, url, p, user));
});

async function routeServer(req, res, url, p, user) {
  if (p === '/api/status') return json(res, getStatus());
  if (p === '/api/console') {
    pullLatestLog();
    const st = instNow();
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    return json(res, { ok: true, logs: st.logs.slice(Math.max(0, since)), total: st.logs.length });
  }
  if (p === '/api/modlog/stats') return json(res, getModlogStats());

  if (p === '/api/start' && req.method === 'POST') return json(res, startMC());
  if (p === '/api/stop' && req.method === 'POST') return stopMC().then((r) => json(res, r));
  if (p === '/api/restart' && req.method === 'POST') return restartMC().then((r) => json(res, r));
  if (p === '/api/command' && req.method === 'POST') {
    return parseBody(req).then((b) => json(res, sendCmd(b.cmd || '')));
  }

  if (p === '/api/settings' && req.method === 'GET') {
    return json(res, {
      ok: true,
      settings: {
        mcDir: CONFIG.mcDir,
        mcJar: CONFIG.mcJar,
        javaArgs: CONFIG.javaArgs,
        javaPath: CONFIG.javaPath || detectJava(),
        publicBaseUrl: CONFIG.publicBaseUrl || '',
        paysafeUser: CONFIG.paysafeUser || '',
        paysafeKeySet: !!CONFIG.paysafeKey,
        paysafeAccountId: CONFIG.paysafeAccountId || '',
        paysafeEnv: CONFIG.paysafeEnv === 'live' ? 'live' : 'test',
        paysafeReady: paysafeReady(),
      },
    });
  }
  if (p === '/api/settings' && req.method === 'POST') {
    if (user.role !== 'admin') return json(res, { ok: false, msg: 'Kein Zugriff.' }, 403);
    return parseBody(req).then((b) => {
      if (b.mcDir) CONFIG.mcDir = b.mcDir;
      if (b.mcJar) CONFIG.mcJar = b.mcJar;
      if (b.javaArgs) CONFIG.javaArgs = b.javaArgs;
      if (typeof b.javaPath === 'string') CONFIG.javaPath = b.javaPath;
      if (typeof b.publicBaseUrl === 'string') CONFIG.publicBaseUrl = b.publicBaseUrl.trim();
      if (typeof b.paysafeUser === 'string') CONFIG.paysafeUser = b.paysafeUser.trim();
      if (typeof b.paysafeKey === 'string' && b.paysafeKey.trim() && b.paysafeKey.trim() !== '********') {
        CONFIG.paysafeKey = b.paysafeKey.trim();
      }
      if (typeof b.paysafeAccountId === 'string') CONFIG.paysafeAccountId = b.paysafeAccountId.trim();
      if (b.paysafeEnv === 'live' || b.paysafeEnv === 'test') CONFIG.paysafeEnv = b.paysafeEnv;
      saveSettings();
      json(res, { ok: true, paysafeReady: paysafeReady() });
    });
  }

  if (p === '/api/serverprops' && req.method === 'GET') return json(res, { ok: true, props: readProps() });
  if (p === '/api/serverprops' && req.method === 'POST') {
    const b = await parseBody(req);
    return json(res, writeProps(b.props || {}));
  }

  if (p === '/api/files') return json(res, listFiles(url.searchParams.get('dir') || ''));
  if (p === '/api/file' && req.method === 'GET') return json(res, readFileSafe(url.searchParams.get('path') || ''));
  if (p === '/api/file' && req.method === 'POST') {
    const b = await parseBody(req);
    return json(res, writeFileSafe(b.path, b.content));
  }
  if (p === '/api/file' && req.method === 'DELETE') {
    const b = await parseBody(req);
    return json(res, deleteEntry(b.path));
  }
  if (p === '/api/upload' && req.method === 'POST') {
    try {
      const buf = await readRawBody(req);
      const dir = url.searchParams.get('dir') || '';
      const name = url.searchParams.get('name') || 'upload.bin';
      return json(res, saveUpload(dir, name, buf));
    } catch (e) {
      return json(res, { ok: false, msg: e.message }, 400);
    }
  }

  if (p === '/api/plugins/installed' && req.method === 'GET') return json(res, listInstalledPlugins());
  if (p === '/api/plugins/installed' && req.method === 'DELETE') {
    const b = await parseBody(req);
    return json(res, deletePlugin(b.name));
  }
  if (p === '/api/plugins/search' || p === '/api/plugins/catalog') {
    const q = url.searchParams.get('q') || '';
    const page = url.searchParams.get('page') || '1';
    return json(res, await spigetCatalog(q, page));
  }
  if (p === '/api/plugins/install' && req.method === 'POST') {
    const b = await parseBody(req);
    return json(res, await downloadPlugin(b.id, b.name));
  }

  if (p === '/api/backups' && req.method === 'GET') return json(res, listBackups());
  if (p === '/api/backups' && req.method === 'POST') return json(res, await createBackup());
  if (p === '/api/backups' && req.method === 'DELETE') {
    const b = await parseBody(req);
    return json(res, deleteBackup(b.name));
  }

  if (p === '/api/users' && req.method === 'GET') {
    if (user.role !== 'admin') return json(res, { ok: false, msg: 'Kein Zugriff.' }, 403);
    return json(res, {
      ok: true,
      users: DB.users.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email || '',
        role: u.role,
        balance: u.balance || 0,
        createdAt: u.createdAt,
      })),
    });
  }
  if (p === '/api/users' && req.method === 'POST') {
    if (user.role !== 'admin') return json(res, { ok: false, msg: 'Kein Zugriff.' }, 403);
    const b = await parseBody(req);
    if (!b.username || !b.password) return json(res, { ok: false, msg: 'Username und Passwort erforderlich.' });
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, { ok: false, msg: 'E-Mail fehlt oder ungültig.' }, 400);
    if (DB.users.find((u) => u.username.toLowerCase() === String(b.username).toLowerCase())) {
      return json(res, { ok: false, msg: 'Benutzername bereits vergeben.' });
    }
    if (findUserByEmail(email)) return json(res, { ok: false, msg: 'E-Mail schon registriert.' }, 400);
    const created = {
      id: crypto.randomBytes(8).toString('hex'),
      username: String(b.username).trim(),
      email,
      password: b.password,
      role: b.role || 'user',
      balance: 0,
      createdAt: new Date().toISOString(),
    };
    DB.users.push(created);
    saveDB();
    return json(res, { ok: true, user: { id: created.id, username: created.username, email: created.email, role: created.role } });
  }
  if (p.startsWith('/api/users/') && req.method === 'DELETE') {
    const id = p.split('/').pop();
    if (id === 'admin') return json(res, { ok: false, msg: 'Admin kann nicht gelöscht werden.' });
    DB.users = DB.users.filter((u) => u.id !== id);
    Object.keys(DB.sessions).forEach((t) => { if (DB.sessions[t].userId === id) delete DB.sessions[t]; });
    saveDB();
    return json(res, { ok: true });
  }
  if (p.startsWith('/api/users/') && req.method === 'PUT') {
    const id = p.split('/').pop();
    const b = await parseBody(req);
    const user = DB.users.find((u) => u.id === id);
    if (!user) return json(res, { ok: false, msg: 'User nicht gefunden.' });
    if (b.password) user.password = b.password;
    if (b.role) user.role = b.role;
    saveDB();
    return json(res, { ok: true });
  }

  json(res, { ok: false, msg: 'Not found.' }, 404);
}

server.listen(CONFIG.webPort, () => {
  console.log(`\n  Eye Host v3.3`);
  console.log(`  Panel:  http://localhost:${CONFIG.webPort}`);
  console.log(`  Netz:   http://${getLocalIP()}:${CONFIG.webPort}`);
  console.log(`  MC-Dir: ${CONFIG.mcDir}`);
  console.log(`  JAR:    ${detectJar() || '(keine Paper-JAR gefunden)'}`);
  console.log(`  Java:   ${detectJava()}\n`);
});
