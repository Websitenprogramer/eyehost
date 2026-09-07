function siteRoot() {
  let path = location.pathname.replace(/\/(?:index|me)\.html$/i, '/');
  if (!path.endsWith('/')) path += '/';
  return path;
}

if (/\/index\.html$/i.test(location.pathname)) {
  history.replaceState(null, '', siteRoot() + location.search + location.hash);
}

function goShop(ev) {
  if (ev) ev.preventDefault();
  const home = location.origin + siteRoot();
  if (PAGE === 'shop') {
    history.replaceState(null, '', siteRoot() + location.search);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return false;
  }
  location.href = home;
  return false;
}

function resolveApi() {
  const configured = String(window.EYEHOST_API || '').replace(/\/$/, '');
  if (!configured) return '';
  try {
    if (location.host === new URL(configured).host) return '';
  } catch { /* ignore */ }
  return configured;
}
const API = resolveApi();
const PAGE = document.body.getAttribute('data-page') || 'shop';
const FALLBACK_PLANS = [
  { id: 'starter', name: 'Starter', ram: '2G', cpu: '1 vCore', disk: '15 GB NVMe', players: 10, backups: 1, loc: 'Deutschland', ddos: true, days: 30, price: 4.99, desc: 'Für Tests und kleine Welten' },
  { id: 'plus', name: 'Plus', ram: '4G', cpu: '2 vCores', disk: '30 GB NVMe', players: 20, backups: 3, loc: 'Deutschland', ddos: true, days: 30, price: 8.99, desc: 'Für Freunde und Plugins' },
  { id: 'pro', name: 'Pro', ram: '8G', cpu: '3 vCores', disk: '60 GB NVMe', players: 40, backups: 7, loc: 'Deutschland', ddos: true, days: 30, price: 14.99, desc: 'Mehr Power, Events, Mods' },
  { id: 'panel', kind: 'panel', name: 'Panel', ram: 'Dein Root', cpu: 'SSH', disk: 'Auf deinem VPS', players: '–', backups: '–', loc: 'Dein Server', ddos: false, days: 30, price: 9.99, desc: 'Eigenes Eye Host Panel. Nach dem Kauf verbindest du deinen Root-Server.' },
];
let token = localStorage.getItem('eh3') || '';
let me = '';
let role = '';
let authMode = 'login';
let openTicketId = '';
let tkTimer = null;
let apiLive = false;

function $(id) { return document.getElementById(id); }

async function api(path, method, body, serverId) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: token,
    'ngrok-skip-browser-warning': '1',
  };
  if (serverId) headers['X-Server-Id'] = serverId;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(API + path, {
      method: method || 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {
      return { ok: false, msg: 'Website-Server ist gerade nicht erreichbar.' };
    }
    if (r.ok && data && data.ok !== false) apiLive = true;
    return data;
  } catch (e) {
    return { ok: false, msg: 'Website-Server ist gerade nicht erreichbar. Der Host-PC muss laufen.' };
  } finally {
    clearTimeout(t);
  }
}

function toast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 2800);
}

function openAuth(mode) {
  authMode = mode;
  $('auth-title').textContent = mode === 'register' ? 'Registrieren' : 'Anmelden';
  $('auth-go').textContent = mode === 'register' ? 'Konto erstellen' : 'Anmelden';
  if ($('au-mail')) $('au-mail').style.display = 'none';
  $('auth-err').textContent = '';
  $('auth-modal').classList.add('on');
}

function closeAuth() {
  $('auth-modal').classList.remove('on');
}

async function submitAuth() {
  const username = $('au-user').value.trim();
  const password = $('au-pass').value;
  const path = authMode === 'register' ? '/api/register' : '/api/login';
  const body = { username, password };
  const r = await api(path, 'POST', body);
  if (!r.ok) {
    $('auth-err').textContent = r.msg || 'Fehler';
    return;
  }
  token = r.token;
  me = r.username;
  role = r.role || 'user';
  localStorage.setItem('eh3', token);
  localStorage.setItem('eh3u', me);
  closeAuth();
  if (PAGE === 'shop') {
    renderUser();
    toast('Angemeldet. Derselbe Login gilt für Mein Bereich.');
    return;
  }
  renderUser();
  loadServers();
  loadTickets();
}

function logout() {
  api('/api/logout', 'POST');
  token = '';
  me = '';
  role = '';
  localStorage.removeItem('eh3');
  localStorage.removeItem('eh3u');
  resetTicketChat();
  renderUser();
  if (PAGE === 'me') {
    if ($('srv-list')) $('srv-list').innerHTML = '';
    if ($('srv-hint')) $('srv-hint').textContent = 'Bitte anmelden.';
    openAuth('login');
  }
}

function renderUser() {
  const loggedIn = !!(token && me);
  if ($('nav-area')) $('nav-area').hidden = !loggedIn;
  if ($('area-bar')) $('area-bar').hidden = !loggedIn;
  const box = $('authbox');
  if (!box) return;
  if (!loggedIn) {
    box.innerHTML = `
      <button class="btn btn-n btn-sm" type="button" onclick="openAuth('login')">Anmelden</button>
      ${PAGE === 'shop' ? '<button class="btn btn-p btn-sm" type="button" onclick="openAuth(\'register\')">Registrieren</button>' : ''}`;
    return;
  }
  box.innerHTML = `
    <span class="who">${esc(me || 'Account')}</span>
    ${PAGE === 'shop' ? '<a class="btn btn-p btn-sm" href="me.html">Mein Bereich</a>' : `<a class="btn btn-n btn-sm" href="${panelUrl()}">Volle Konsole</a>`}
    <button class="btn btn-n btn-sm" type="button" onclick="logout()">Abmelden</button>`;
}

function panelUrl() {
  const base = (API || '') + '/panel';
  return token ? base + '#eh3=' + encodeURIComponent(token) : base;
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function loadServers() {
  if (!token || !$('srv-list')) return;
  const r = await api('/api/servers');
  if (!r.ok) {
    $('srv-hint').textContent = r.msg || 'Nicht eingeloggt.';
    $('srv-list').innerHTML = '';
    return;
  }
  const list = r.servers || [];
  $('srv-hint').textContent = list.length
    ? 'Start, Stop und Restart direkt hier.'
    : 'Noch kein Minecraft-Paket. Panel für deinen Root-Server liegt oben.';
  $('srv-list').innerHTML = list.map((s) => `
    <div class="card srv">
      <div class="srv-top">
        <div>
          <div class="srv-name">${esc(s.name)}</div>
          <div class="note">Port ${esc(s.port)} · ${esc(s.ram || '')} ${s.plan ? '· ' + esc(s.plan) : ''}</div>
        </div>
        <div class="pill ${s.running ? 'on' : ''}">${s.running ? 'Online' : 'Offline'}</div>
      </div>
      <div class="row">
        <button class="btn btn-p btn-sm" type="button" onclick="ctrl('${s.id}','start')">Start</button>
        <button class="btn btn-n btn-sm" type="button" onclick="ctrl('${s.id}','stop')">Stop</button>
        <button class="btn btn-n btn-sm" type="button" onclick="ctrl('${s.id}','restart')">Neustart</button>
        <a class="btn btn-n btn-sm" href="${panelUrl()}">Konsole</a>
        ${s.canDelete ? `<button class="btn btn-r btn-sm" type="button" onclick="delSrv('${s.id}','${esc(s.name)}')">Löschen</button>` : ''}
      </div>
    </div>`).join('');
}

async function loadNodes() {
  if (!token || !$('node-list')) return;
  const r = await api('/api/nodes');
  const box = $('node-list');
  const hint = $('node-hint');
  if (!r.ok) {
    if (hint) hint.textContent = r.msg || 'Panel nicht ladbar.';
    box.innerHTML = '';
    return;
  }
  const list = r.nodes || [];
  if (hint) {
    hint.textContent = list.length
      ? 'IP, SSH-Port, User und Passwort vom Root-Server eintragen. Danach ist das Panel verbunden.'
      : 'Noch kein Panel. Im Shop „Panel“ kaufen, dann erscheint hier die Verbindung.';
  }
  if (!list.length) {
    box.innerHTML = '<a class="btn btn-p" href="./#shop">Panel kaufen</a>';
    return;
  }
  box.innerHTML = list.map((n) => `
    <div class="card srv node-card">
      <div class="srv-top">
        <div>
          <div class="srv-name">${esc(n.name)}</div>
          <div class="note">${n.host ? esc(n.sshUser + '@' + n.host + ':' + n.sshPort) : 'Noch kein Root-Server verbunden'}</div>
        </div>
        <div class="pill ${n.connected ? 'on' : ''}">${n.connected ? 'Verbunden' : 'Offen'}</div>
      </div>
      ${n.lastMsg ? `<p class="note">${esc(n.lastMsg)}</p>` : ''}
      <input class="inp" id="n-name-${n.id}" placeholder="Name" value="${esc(n.name)}"/>
      <input class="inp" id="n-host-${n.id}" placeholder="IP oder Domain vom Root-Server" value="${esc(n.host)}"/>
      <div class="row" style="margin-top:8px">
        <input class="inp" id="n-port-${n.id}" placeholder="SSH-Port" value="${esc(n.sshPort || 22)}" style="margin:0;width:110px"/>
        <input class="inp" id="n-user-${n.id}" placeholder="User (root)" value="${esc(n.sshUser || 'root')}" style="margin:0;flex:1"/>
      </div>
      <input class="inp" id="n-pass-${n.id}" type="password" placeholder="${n.hasPass ? 'Passwort lassen oder neu setzen' : 'SSH-Passwort'}"/>
      <div class="row">
        <button class="btn btn-p btn-sm" type="button" onclick="connectNode('${n.id}')">Root-Server verbinden</button>
        <button class="btn btn-r btn-sm" type="button" onclick="delNode('${n.id}')">Panel löschen</button>
      </div>
    </div>`).join('');
}

async function connectNode(id) {
  const host = ($('n-host-' + id) || {}).value;
  const r = await api('/api/nodes/' + id + '/connect', 'POST', {
    name: ($('n-name-' + id) || {}).value,
    host,
    port: ($('n-port-' + id) || {}).value,
    user: ($('n-user-' + id) || {}).value,
    password: ($('n-pass-' + id) || {}).value,
  });
  toast(r.ok ? (r.msg || (r.reachable ? 'Root-Server verbunden.' : 'Gespeichert.')) : (r.msg || 'Fehler'));
  if (r.ok) loadNodes();
}

async function delNode(id) {
  if (!confirm('Dieses Panel wirklich löschen?')) return;
  const r = await api('/api/nodes/' + id, 'DELETE');
  toast(r.ok ? 'Panel gelöscht.' : (r.msg || 'Fehler'));
  if (r.ok) loadNodes();
}

async function delSrv(id, name) {
  if (!confirm('"' + name + '" wirklich löschen?')) return;
  const r = await api('/api/servers/' + id, 'DELETE');
  toast(r.ok ? 'Server gelöscht.' : (r.msg || 'Fehler'));
  if (r.ok) loadServers();
}

async function ctrl(id, action) {
  const r = await api('/api/' + action, 'POST', {}, id);
  toast(r.ok ? (action === 'start' ? 'Server startet…' : action === 'stop' ? 'Server stoppt…' : 'Server startet neu…') : (r.msg || 'Fehler'));
  setTimeout(loadServers, 2000);
}

let shopCache = [];

function money(n) {
  return Number(n || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function specLines(p) {
  if (p.kind === 'panel' || p.id === 'panel') {
    return [
      ['Typ', 'Eigenes Panel', 'Kein Minecraft-Paket auf unserem Host — du bekommst das Panel für deinen Root-Server.'],
      ['Anbindung', 'SSH / IP', 'Nach dem Kauf trägst du IP, Port, User und Passwort deines VPS ein.'],
      ['Server', 'Dein Root / VPS', 'Java, RAM und Welt laufen bei dir. Wir liefern nur das Panel.'],
      ['Steuerung', 'Eye Host', 'Wenn der Root erreichbar ist, steuerst du ihn über Mein Bereich.'],
      ['Laufzeit', (p.days || 30) + ' Tage', 'Nach der Zahlung ist das Panel so lange aktiv.'],
    ];
  }
  return [
    ['RAM', p.ram || '–', 'Arbeitsspeicher. Mehr RAM = mehr Plugins und eine größere Welt ohne Lag.'],
    ['CPU', p.cpu || '–', 'Rechenkerne für Chunks, Redstone und Events.'],
    ['SSD', p.disk || '–', 'NVMe-Speicher für Welt, Plugins und Backups.'],
    ['Spieler', p.players != null ? String(p.players) : '–', 'Empfohlene Slots, damit der Server flüssig bleibt.'],
    ['Backups', p.backups != null ? String(p.backups) : '–', 'Wie viele Sicherungen wir für das Paket vorsehen.'],
    ['Standort', p.loc || 'Deutschland', 'Rechenzentrum. DE = niedrige Ping-Zeiten.'],
    ['Schutz', p.ddos ? 'DDoS inklusive' : 'Standard', 'Schutz gegen Angriffe auf den Server.'],
    ['Laufzeit', (p.days || 30) + ' Tage', 'Nach der Zahlung ist das Paket so lange aktiv.'],
  ];
}

function renderShop(plans) {
  const box = $('shop-list');
  if (!box) return;
  shopCache = plans || [];
  if (!shopCache.length) {
    box.innerHTML = '<div class="card"><p class="note">Shop lädt nicht. Der Host-PC muss laufen.</p></div>';
    return;
  }
  box.innerHTML = shopCache.map((p) => `
    <article class="card ${p.id === 'plus' || p.id === 'panel' ? 'on' : ''}">
      ${p.id === 'plus' ? '<div class="badge">Beliebt</div>' : ''}
      ${p.id === 'panel' ? '<div class="badge">Root-Server</div>' : ''}
      <h3>${esc(p.name)}</h3>
      <p class="plan-desc">${esc(p.desc || '')}</p>
      <div class="price">${money(p.price)}<span> / 30 Tage</span></div>
      <div class="specs">
        ${specLines(p).map(([k, v]) => `<div class="spec"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      </div>
      <div class="card-actions">
        <button class="btn btn-n" type="button" onclick="openSpecs('${p.id}')">Specs ansehen</button>
        <button class="btn btn-p" type="button" onclick="buy('${p.id}')">Jetzt zahlen</button>
      </div>
    </article>`).join('');
}

function openSpecs(id) {
  const p = shopCache.find((x) => x.id === id);
  if (!p || !$('spec-box')) return;
  $('spec-box').innerHTML = `
    <div class="spec-head">
      <div>
        <h3 style="margin:0">${esc(p.name)}</h3>
        <p class="note" style="margin:6px 0 0">${esc(p.desc || '')}</p>
      </div>
      <div class="price" style="font-size:28px">${money(p.price)}<span> / 30 Tage</span></div>
    </div>
    <div class="spec-grid">
      ${specLines(p).map(([k, v, why]) => `
        <div class="spec-tile">
          <small>${esc(k)}</small>
          <b>${esc(v)}</b>
          <p>${esc(why)}</p>
        </div>`).join('')}
    </div>
    <div class="card-actions">
      <button class="btn btn-n" type="button" onclick="closeSpecs()">Schließen</button>
      <button class="btn btn-p" type="button" onclick="closeSpecs();buy('${p.id}')">Dieses Paket kaufen</button>
    </div>`;
  $('spec-modal').classList.add('on');
}

function closeSpecs() {
  if ($('spec-modal')) $('spec-modal').classList.remove('on');
}

async function loadShop() {
  if (PAGE !== 'shop' || !$('shop-list')) return;
  renderShop(FALLBACK_PLANS);
  const r = await api('/api/shop');
  if (r.ok && Array.isArray(r.plans) && r.plans.length) renderShop(r.plans);
}

async function buy(planId) {
  if (!token) {
    openAuth('login');
    toast('Bitte zuerst anmelden.');
    return;
  }
  const r = await api('/api/shop/buy', 'POST', { planId, instant: role === 'admin' });
  if (!r.ok && !apiLive) {
    toast('Kaufen geht erst, wenn der Host online ist. Pakete siehst du trotzdem.');
    return;
  }
  if (r.ok && r.instant) {
    toast(r.kind === 'panel' ? 'Panel ist da. Jetzt Root-Server verbinden.' : 'Server ist angelegt.');
    location.href = r.kind === 'panel' ? 'me.html#nodes' : 'me.html';
    return;
  }
  if (r.ok && r.redirect) {
    toast('Weiter zu Paysafecard…');
    location.href = r.redirect;
    return;
  }
  toast(r.msg || 'Zahlung nicht möglich. Im Admin die Paysafe-Keys eintragen.');
}

function tkStatus(s) {
  return ({ open: 'Offen', answered: 'Support hat geantwortet', closed: 'Geschlossen' }[s] || s);
}

function renderTickets(list) {
  const box = $('tk-list');
  if (!box) return;
  const visible = role === 'admin' ? list : list.filter((t) => t.status !== 'closed');
  box.innerHTML = visible.length
    ? visible.map((t) => `
      <button class="tk-item ${t.id === openTicketId ? 'on' : ''}" type="button" onclick="openTicket('${t.id}')">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <div style="font-weight:700">${esc(t.subject)}</div>
          ${t.unread ? '<span class="psc">NEU</span>' : ''}
        </div>
        <div class="note" style="font-size:11px;margin-top:3px">${esc(tkStatus(t.status))} · ${esc(t.username || '')}</div>
        <div class="note" style="font-size:12px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.last || '')}</div>
      </button>`).join('')
    : '<div style="padding:16px" class="note">Noch keine Tickets.</div>';
}

function resetTicketChat() {
  openTicketId = '';
  if (tkTimer) { clearInterval(tkTimer); tkTimer = null; }
  if ($('tk-head')) $('tk-head').innerHTML = '<div class="note">Wähle links ein Ticket</div>';
  if ($('tk-msgs')) $('tk-msgs').innerHTML = '';
  if ($('tk-reply')) $('tk-reply').classList.remove('on');
  if ($('tk-list')) $('tk-list').innerHTML = '';
}

async function loadTickets() {
  if (!token || !$('tk-list')) {
    if (!token) resetTicketChat();
    return;
  }
  const r = await api('/api/tickets');
  if (!r.ok) {
    renderTickets([]);
    return;
  }
  renderTickets(r.tickets || []);
  if (openTicketId && (r.tickets || []).some((t) => t.id === openTicketId)) {
    openTicket(openTicketId, true);
  } else if (role !== 'admin' && openTicketId) {
    resetTicketChat();
  }
}

async function openTicket(id, quiet) {
  if (!token) {
    openAuth('login');
    return;
  }
  openTicketId = id;
  const r = await api('/api/tickets/' + id);
  if (!r.ok) {
    if (!quiet) toast(r.msg || 'Fehler');
    return;
  }
  const t = r.ticket;
  document.querySelectorAll('.tk-item').forEach((el) => {
    el.classList.toggle('on', (el.getAttribute('onclick') || '').includes("'" + id + "'"));
  });
  const staff = role === 'admin';
  const closed = t.status === 'closed';
  $('tk-head').innerHTML = `
    <div>
      <div style="font-weight:700">${esc(t.subject)}</div>
      <div class="note">${esc(tkStatus(t.status))} · ${esc(t.username || '')}</div>
    </div>
    <div class="row" style="margin:0">
      ${staff && closed
        ? `<button class="btn btn-n btn-sm" type="button" onclick="setTicketStatus('${t.id}','open')">Wieder öffnen</button>`
        : `<button class="btn btn-r btn-sm" type="button" onclick="setTicketStatus('${t.id}','closed')">Schließen</button>`}
    </div>`;
  const msgs = t.messages || [];
  $('tk-msgs').innerHTML = msgs.length ? msgs.map((m) => {
    const fromOpener = m.userId ? m.userId === t.userId : m.role !== 'staff';
    const who = fromOpener ? (m.username === me ? 'Du' : (m.username || 'Kunde')) : 'Support';
    return `
      <div class="tk-b ${fromOpener ? 'staff' : 'user'}">
        <small>${esc(who)} · ${new Date(m.at).toLocaleString('de-DE')}</small>
        ${esc(m.text)}
      </div>`;
  }).join('') : '<div class="note">Noch keine Nachrichten.</div>';
  $('tk-msgs').scrollTop = $('tk-msgs').scrollHeight;
  $('tk-reply').classList.toggle('on', staff || !closed);
  $('tk-reply-in').placeholder = staff ? 'Antwort als Support…' : 'Nachricht an den Support…';
  if (tkTimer) clearInterval(tkTimer);
  tkTimer = setInterval(() => {
    if (token && openTicketId) openTicket(openTicketId, true);
  }, 4000);
}

async function replyTicket() {
  if (!token) { openAuth('login'); return; }
  if (!openTicketId) return;
  const message = $('tk-reply-in').value.trim();
  if (!message) return;
  const r = await api('/api/tickets/' + openTicketId + '/reply', 'POST', { message });
  if (!r.ok) { toast(r.msg || 'Fehler'); return; }
  $('tk-reply-in').value = '';
  await loadTickets();
}

async function setTicketStatus(id, status) {
  if (!token) { openAuth('login'); return; }
  const action = status === 'closed' ? 'close' : 'open';
  const r = await api('/api/tickets/' + id + '/' + action, 'POST', {});
  toast(r.ok ? (status === 'closed' ? 'Ticket geschlossen' : 'Ticket wieder offen') : (r.msg || 'Fehler'));
  if (r.ok) {
    if (status === 'closed' && role !== 'admin') resetTicketChat();
    else openTicketId = id;
    await loadTickets();
  }
}

async function sendTicket() {
  if (!token) {
    openAuth('login');
    toast('Bitte zuerst anmelden.');
    return;
  }
  const subject = $('tk-sub').value.trim();
  const message = $('tk-msg').value.trim();
  if (!message) { toast('Bitte eine Nachricht schreiben'); return; }
  const r = await api('/api/tickets', 'POST', { subject, message });
  toast(r.ok ? 'Ticket erstellt.' : (r.msg || 'Fehler'));
  if (r.ok) {
    $('tk-sub').value = '';
    $('tk-msg').value = '';
    openTicketId = r.ticket.id;
    await loadTickets();
  }
}

async function boot() {
  renderUser();
  if (PAGE === 'shop') loadShop();
  if (!token) {
    if (PAGE === 'me') openAuth('login');
    return;
  }
  const meR = await api('/api/me');
  if (!meR.ok) {
    token = '';
    me = '';
    role = '';
    localStorage.removeItem('eh3');
    localStorage.removeItem('eh3u');
    renderUser();
    if (PAGE === 'me') openAuth('login');
    return;
  }
  me = meR.username;
  role = meR.role || 'user';
  localStorage.setItem('eh3u', me);
  renderUser();
  if (PAGE === 'me') {
    loadNodes();
    loadServers();
    loadTickets();
  }
}

boot();
