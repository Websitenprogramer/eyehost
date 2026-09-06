const PUBLIC_API = String(window.EYEHOST_API || '').replace(/\/$/, '');
const API = (!PUBLIC_API || location.host === new URL(PUBLIC_API).host) ? '' : PUBLIC_API;
const PAGE = document.body.getAttribute('data-page') || 'shop';
let token = localStorage.getItem('eh3') || '';
let me = '';
let role = '';
let authMode = 'login';
let openTicketId = '';
let tkTimer = null;

function $(id) { return document.getElementById(id); }

async function api(path, method, body, serverId) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: token,
    'ngrok-skip-browser-warning': '1',
  };
  if (serverId) headers['X-Server-Id'] = serverId;
  try {
    const r = await fetch(API + path, {
      method: method || 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return await r.json();
  } catch (e) {
    return { ok: false, msg: 'Website-Server ist gerade nicht erreichbar. Der Host-PC muss laufen.' };
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
  if ($('au-mail')) $('au-mail').style.display = mode === 'register' ? '' : 'none';
  $('auth-err').textContent = '';
  $('auth-modal').classList.add('on');
}

function closeAuth() {
  $('auth-modal').classList.remove('on');
}

async function submitAuth() {
  const username = $('au-user').value.trim();
  const password = $('au-pass').value;
  const email = $('au-mail') ? $('au-mail').value.trim() : '';
  const path = authMode === 'register' ? '/api/register' : '/api/login';
  const body = authMode === 'register' ? { username, password, email } : { username, password };
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
  const loggedIn = !!token;
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
    : 'Noch kein Server. Kauf dir eins im Shop.';
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
      </div>
    </div>`).join('');
}

async function ctrl(id, action) {
  const r = await api('/api/' + action, 'POST', {}, id);
  toast(r.ok ? (action === 'start' ? 'Server startet…' : action === 'stop' ? 'Server stoppt…' : 'Server startet neu…') : (r.msg || 'Fehler'));
  setTimeout(loadServers, 2000);
}

async function buy(planId) {
  if (!token) {
    openAuth('login');
    toast('Bitte zuerst anmelden.');
    return;
  }
  const r = await api('/api/shop/buy', 'POST', { planId });
  if (r.ok && r.redirect) {
    toast('Weiter zu Paysafecard…');
    location.href = r.redirect;
    return;
  }
  toast(r.msg || 'Zahlung nicht möglich. Paysafe-Keys im Panel eintragen.');
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
  if (!token) {
    renderUser();
    if (PAGE === 'me') openAuth('login');
    return;
  }
  const meR = await api('/api/me');
  if (!meR.ok) {
    token = '';
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
    loadServers();
    loadTickets();
  }
}

boot();
