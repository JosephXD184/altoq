// ALTOQ · login con Google (Firebase), cuotas en tiempo real (The Odds API) y detector de valor (EV+).
import { modelFor, pendingReason, summaryFor, logPrediction, settleResults, registryStats } from './model.js';
const CFG = window.RUSHTOP_CONFIG || {};
const TZ = 'America/Lima';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('rushtop:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rushtop:' + k, JSON.stringify(v)); } catch {} },
};

const FC_LEAGUES = {
  soccer_epl: 'Premier League', soccer_spain_la_liga: 'LaLiga', soccer_italy_serie_a: 'Serie A',
  soccer_germany_bundesliga: 'Bundesliga', soccer_france_ligue_one: 'Ligue 1', soccer_brazil_campeonato: 'Brasileirão',
  soccer_peru_liga1: 'Liga 1 Perú', soccer_uefa_champs_league: 'Champions League', soccer_uefa_europa_league: 'Europa League',
  soccer_uefa_europa_conference_league: 'Conference League',
};
// Ruta equivalente en ESPN (partidos reales, marcadores y cuotas DraftKings sin API key)
const ESPN = {
  basketball_nba: 'basketball/nba', americanfootball_nfl: 'football/nfl',
  soccer_epl: 'soccer/eng.1', soccer_spain_la_liga: 'soccer/esp.1', soccer_italy_serie_a: 'soccer/ita.1',
  soccer_germany_bundesliga: 'soccer/ger.1', soccer_france_ligue_one: 'soccer/fra.1', soccer_brazil_campeonato: 'soccer/bra.1',
  soccer_peru_liga1: 'soccer/per.1', soccer_uefa_champs_league: 'soccer/uefa.champions', soccer_uefa_europa_league: 'soccer/uefa.europa',
  soccer_uefa_europa_conference_league: 'soccer/uefa.europa.conf',
};
const HAS_FIREBASE = !!(CFG.firebase && CFG.firebase.apiKey);
const HAS_ODDS = !!CFG.oddsApiKey;

const S = {
  liga: store.get('liga', 'nba'),
  fc: FC_LEAGUES[store.get('fc', 'soccer_epl')] ? store.get('fc', 'soccer_epl') : 'soccer_epl',
  tab: 'hoy',
  user: null,
  events: [],
  analysis: [],
  updated: null,
  remaining: null,
  live: store.get('live', true),
  fmt: store.get('fmt', 'dec'),
  timer: null,
  error: null,
};
const sportKey = () => ({ nba: 'basketball_nba', nfl: 'americanfootball_nfl', fc: S.fc }[S.liga]);

// ---------- Formato ----------
const fmtOdd = (d) => {
  if (d == null || !isFinite(d)) return 'N/D';
  if (S.fmt === 'us') return d >= 2 ? '+' + Math.round((d - 1) * 100) : String(Math.round(-100 / (d - 1)));
  return d.toFixed(2);
};
const pct = (x, n = 1) => (x * 100).toFixed(n) + '%';
const money = (x) => '$' + (Math.round(x * 100) / 100).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Todas las horas en hora de Lima (UTC-5)
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const limaDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }); // AAAA-MM-DD
const fmtDay = (iso) => {
  const diff = Math.round((new Date(limaDay(iso)) - new Date(limaDay(Date.now()))) / 864e5);
  if (diff === 0) return 'Hoy'; if (diff === 1) return 'Mañana'; if (diff === -1) return 'Ayer';
  return new Date(iso).toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'short', timeZone: TZ });
};
const isLive = (ev) => new Date(ev.commence_time) <= new Date();

// ---------- Autenticación ----------
// Cualquiera puede crear una cuenta gratis (correo + contraseña o Google).
// Sin cuenta se entra como invitado con acceso limitado.
// Si config.js no tiene Firebase, funciona un "modo de prueba" local (la cuenta solo vive en este navegador).
const GUEST = { uid: 'guest', name: 'Invitado', email: null, guest: true };
const isGuest = () => !S.user || !!S.user.guest;
let fb = null, authMode = 'signup';
const AUTH_ERR = {
  'auth/email-already-in-use': 'Ese correo ya tiene cuenta. Usa “Entrar”.',
  'auth/invalid-email': 'El correo no es válido.',
  'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/wrong-password': 'Correo o contraseña incorrectos.',
  'auth/user-not-found': 'No hay ninguna cuenta con ese correo.',
  'auth/too-many-requests': 'Demasiados intentos. Prueba en unos minutos.',
  'auth/popup-closed-by-user': 'Se cerró la ventana de Google antes de terminar.',
  'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase (Authentication > Settings > Authorized domains).',
  'auth/operation-not-allowed': 'Activa “Correo/contraseña” y “Google” en Firebase > Authentication > Sign-in method.',
  'auth/network-request-failed': 'Sin conexión. Revisa tu internet.',
};
const authMsg = (e) => AUTH_ERR[e?.code] || e?.message || 'No se pudo completar.';
async function initAuth() {
  $('#localNote').classList.toggle('hidden', HAS_FIREBASE);
  setAuthMode('signup');
  if (!HAS_FIREBASE) { enter(store.get('localUser', null) || GUEST); return; }
  enter(GUEST); // mientras carga Firebase, se ve la app como invitado
  try {
    const appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
    const authMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    const auth = authMod.getAuth(appMod.initializeApp(CFG.firebase));
    auth.languageCode = 'es';
    fb = { auth, ...authMod };
    authMod.onAuthStateChanged(auth, (u) => enter(u ? { uid: u.uid, name: u.displayName || u.email?.split('@')[0], email: u.email, photo: u.photoURL } : GUEST));
  } catch (e) { showAuthMsg('No se pudo cargar el sistema de cuentas: ' + e.message); }
}
function setAuthMode(m) {
  authMode = m;
  $('#tabLogin').classList.toggle('on', m === 'login'); $('#tabSignup').classList.toggle('on', m === 'signup');
  $('#nameRow').classList.toggle('hidden', m !== 'signup');
  $('#passRow').classList.toggle('hidden', !HAS_FIREBASE);
  $('#resetBtn').classList.toggle('hidden', m !== 'login' || !HAS_FIREBASE);
  $('#aPass').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
  $('#aSubmit').textContent = m === 'signup' ? 'Crear cuenta gratis' : 'Entrar';
  showAuthMsg('');
}
function showAuthMsg(err, ok) {
  $('#loginErr').classList.toggle('hidden', !err); $('#loginErr').textContent = err || '';
  $('#loginOk').classList.toggle('hidden', !ok); $('#loginOk').textContent = ok || '';
}
async function submitAuth(e) {
  e.preventDefault();
  const name = $('#aName').value.trim(), email = $('#aEmail').value.trim(), pass = $('#aPass').value;
  if (authMode === 'signup' && !name) return showAuthMsg('Escribe tu nombre.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showAuthMsg('Escribe un correo válido.');
  if (HAS_FIREBASE && pass.length < 6) return showAuthMsg('La contraseña debe tener al menos 6 caracteres.');
  $('#aSubmit').disabled = true;
  try {
    if (!HAS_FIREBASE) { // modo de prueba local
      const u = { uid: 'local-' + email.toLowerCase(), name: name || email.split('@')[0], email, local: true };
      store.set('localUser', u); enter(u);
    } else if (authMode === 'signup') {
      const cred = await fb.createUserWithEmailAndPassword(fb.auth, email, pass);
      await fb.updateProfile(cred.user, { displayName: name });
      enter({ uid: cred.user.uid, name, email, photo: null });
    } else {
      await fb.signInWithEmailAndPassword(fb.auth, email, pass);
    }
    $('#aPass').value = '';
  } catch (err) { showAuthMsg(authMsg(err)); }
  $('#aSubmit').disabled = false;
}
async function resetPassword() {
  const email = $('#aEmail').value.trim();
  if (!email) return showAuthMsg('Escribe tu correo arriba y vuelve a pulsar.');
  try { await fb.sendPasswordResetEmail(fb.auth, email); showAuthMsg('', 'Te enviamos un correo para cambiar la contraseña.'); }
  catch (err) { showAuthMsg(authMsg(err)); }
}
async function googleLogin() {
  if (!HAS_FIREBASE) return showAuthMsg('El acceso con Google se activa al configurar Firebase en config.js. Mientras tanto crea una cuenta de prueba con tu correo.');
  try { await fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider()); }
  catch (err) { showAuthMsg(authMsg(err)); }
}
async function logout() {
  if (fb) await fb.signOut(fb.auth);
  store.set('localUser', null);
  enter(GUEST);
}
function showLogin(mode) {
  if (mode) setAuthMode(mode);
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden'); $('#tabs').classList.add('hidden');
  window.scrollTo(0, 0);
}
function hideLogin() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden'); $('#tabs').classList.remove('hidden');
}
function enter(user) {
  const first = !S.user;
  S.user = user;
  hideLogin();
  const b = $('#accountBtn');
  b.textContent = isGuest() ? 'Crear cuenta' : (user.name || 'Mi cuenta').split(' ')[0];
  b.classList.toggle('in', !isGuest());
  updateSlipCount();
  if (first) { load(); schedule(); } else render();
}
// Tarjeta de "contenido bloqueado" para invitados
function lockCard(what) {
  return `<div class="card lock"><div class="lock-ic">🔒</div><div><b>${esc(what)}</b><p class="mut">Gratis para usuarios registrados. Crea tu cuenta en 20 segundos y desbloquea todo.</p></div>
    <div class="lock-b"><button class="btn google sm" data-act="signup">Crear cuenta gratis</button><button class="linkbtn" data-act="login">Ya tengo cuenta</button></div></div>`;
}

// ---------- Cuotas ----------
async function load() {
  const token = (S.loadToken = (S.loadToken || 0) + 1);
  let events = [], error = null;
  try {
    events = HAS_ODDS ? await fetchOdds() : await fetchEspn();
  } catch (e) { error = e.message; }
  if (token !== S.loadToken) return; // el usuario cambió de liga mientras cargaba
  S.events = events; S.error = error;
  S.analysis = S.events.map(analyzeEvent);
  S.updated = new Date();
  render();
  runModels(token);
}
// Calcula el modelo propio de cada partido (después de pintar, porque necesita bajar toda la temporada)
async function runModels(token) {
  const path = ESPN[sportKey()]; const mdl = path && modelFor(path);
  if (!mdl) { S.modelStatus = path ? pendingReason(path) : null; render(); return; }
  S.modelStatus = 'Calculando el modelo ' + mdl.name + '…'; render();
  try {
    const M = await mdl.fit();
    if (token !== S.loadToken) return;
    settleResults(M.games);
    for (const a of S.analysis) {
      const ev = a.ev;
      const sum = await summaryFor(ev.path, ev.id);
      const injuries = (teamId) => (sum?.injuries || []).find((t) => String(t.team?.id) === String(teamId))?.injuries || [];
      const leaders = (teamId) => {
        const t = (sum?.leaders || []).find((x) => String(x.team?.id) === String(teamId));
        const id = (n) => String(t?.leaders?.find((l) => l.name === n)?.leaders?.[0]?.athlete?.id || '');
        return { pass: id('passingYards'), rush: id('rushingYards'), rec: id('receivingYards') };
      };
      ev.pred = await mdl.predict(M, ev, { injuries, leaders, lines: ev.lines || {} });
      if (token !== S.loadToken) return;
      if (ev.pred) logPrediction(ev, ev.pred);
    }
    S.modelStatus = null;
  } catch (e) { S.modelStatus = 'No se pudo calcular el modelo: ' + e.message; }
  if (token === S.loadToken) render();
}
async function fetchOdds() {
  const u = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey()}/odds`);
  u.search = new URLSearchParams({ apiKey: CFG.oddsApiKey, regions: CFG.regions || 'eu', markets: CFG.markets || 'h2h', oddsFormat: 'decimal' });
  const r = await fetch(u);
  S.remaining = r.headers.get('x-requests-remaining');
  if (!r.ok) throw new Error(r.status === 401 ? 'API key inválida o sin créditos' : 'Error ' + r.status + ' al pedir cuotas');
  const data = await r.json();
  return data.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
}
function schedule() {
  clearInterval(S.timer);
  if (S.live) S.timer = setInterval(load, Math.max(30, CFG.refreshSeconds || 120) * 1000);
}

// ---------- Análisis de valor ----------
// Para cada mercado/línea: quitamos el margen de cada casa (normalizando 1/cuota), promediamos
// la probabilidad justa (con más peso a casas "sharp") y comparamos con la mejor cuota disponible.
// EV = prob_justa × mejor_cuota − 1
function analyzeEvent(ev) {
  const groups = {};
  for (const bk of ev.bookmakers || []) {
    for (const m of bk.markets || []) {
      const parts = {};
      for (const o of m.outcomes) {
        const line = m.key === 'h2h' ? 'ml' : String(Math.abs(o.point ?? 0));
        (parts[line] ||= []).push(o);
      }
      for (const [line, outs] of Object.entries(parts)) {
        if (outs.length < 2) continue;
        const g = (groups[m.key + '|' + line] ||= { market: m.key, line, n: 0, books: {} });
        g.n = Math.max(g.n, outs.length);
        const sum = outs.reduce((s, o) => s + 1 / o.price, 0);
        g.books[bk.key] = { title: bk.title, margin: sum - 1, outs: Object.fromEntries(outs.map((o) => [oid(o, m.key), { o, price: o.price, fair: 1 / o.price / sum }])) };
      }
    }
  }
  const markets = [];
  for (const g of Object.values(groups)) {
    const books = Object.entries(g.books).filter(([, b]) => Object.keys(b.outs).length === g.n);
    const ids = [...new Set(books.flatMap(([, b]) => Object.keys(b.outs)))];
    const outcomes = ids.map((id) => {
      let w = 0, f = 0, best = null, sample = null;
      for (const [key, b] of books) {
        const x = b.outs[id]; if (!x) continue;
        sample = x.o;
        const wt = (CFG.sharpBooks || {})[key] || 1;
        w += wt; f += wt * x.fair;
        if (!best || x.price > best.price) best = { price: x.price, book: b.title, key };
      }
      const fair = w ? f / w : null;
      const enough = books.length >= (CFG.minBooks || 3);
      return { id, label: outLabel(sample, g.market), name: sample.name, point: sample.point, fair, best, ev: enough && fair ? fair * best.price - 1 : null };
    });
    markets.push({ market: g.market, line: g.line, nBooks: books.length, books, outcomes });
  }
  markets.sort((a, b) => (a.market === 'h2h' ? -1 : 1) - (b.market === 'h2h' ? -1 : 1) || b.nBooks - a.nBooks);
  return { ev, markets };
}
const oid = (o, mk) => (mk === 'h2h' ? o.name : o.name + ' ' + o.point);
function outLabel(o, mk) {
  if (mk === 'totals') return (o.name === 'Over' ? 'Más de ' : 'Menos de ') + o.point;
  if (mk === 'spreads') return o.name + ' ' + (o.point > 0 ? '+' : '') + o.point;
  return o.name === 'Draw' ? 'Empate' : o.name;
}
const MKT = { h2h: 'Ganador', totals: 'Total (más/menos)', spreads: 'Hándicap' };
function valueBets() {
  const out = [];
  for (const a of S.analysis) for (const m of a.markets) {
    // Solo la línea más ofrecida de cada mercado (evita líneas alternativas poco líquidas)
    const main = a.markets.find((x) => x.market === m.market);
    if (m !== main) continue;
    for (const o of m.outcomes) if (o.ev != null && o.ev >= (CFG.minEV ?? 0.02) && o.ev < 0.3) out.push({ a, m, o });
  }
  return out.sort((x, y) => y.o.ev - x.o.ev);
}
const kelly = (p, d) => Math.max(0, ((d - 1) * p - (1 - p)) / (d - 1));

// ---------- Boleto ----------
const slipKey = () => 'slip:' + (S.user?.uid || 'anon');
const getSlip = () => store.get(slipKey(), []);
const setSlip = (s) => { store.set(slipKey(), s); updateSlipCount(); };
const updateSlipCount = () => { $('#slipCount').textContent = getSlip().length || ''; };
const bankroll = () => store.get('bank:' + (S.user?.uid || 'anon'), 1000);
function toggleSlip(a, m, o) {
  const id = a.ev.id + '|' + m.market + '|' + o.id;
  let s = getSlip();
  if (s.some((x) => x.id === id)) s = s.filter((x) => x.id !== id);
  else {
    const pModel = modelProb(a.ev, m.market, o);
    const soccer = a.ev.path?.startsWith('soccer');
    const k = pModel != null ? kelly(pModel, o.best.price) / 4 : 0;
    s.push({ id, game: matchName(a.ev, true), time: a.ev.commence_time, market: MKT[m.market], pick: o.label, price: o.best.price, book: o.best.book, pModel, stake: Math.max(1, Math.round(bankroll() * (soccer ? Math.min(0.01, k) : k))) });
  }
  setSlip(s); render();
}
// Probabilidad del modelo para una selección concreta (o null si el modelo no la cubre)
function modelProb(ev, market, o) {
  const p = ev.pred; if (!p) return null;
  if (market === 'h2h') return o.name === ev.home_team ? p.pHome : o.name === ev.away_team ? p.pAway : p.pDraw;
  if (market === 'totals') { const po = p.pOver ?? (o.point === 2.5 ? p.pOver25 : null); return po == null ? null : o.name === 'Over' ? po : 1 - po; }
  if (market === 'spreads' && p.pCoverHome != null && ev.lines?.spreadHome === (o.name === ev.home_team ? o.point : -o.point)) return o.name === ev.home_team ? p.pCoverHome : 1 - p.pCoverHome;
  return null;
}
const inSlip = (a, m, o) => getSlip().some((x) => x.id === a.ev.id + '|' + m.market + '|' + o.id);

// ---------- Vistas ----------
function render() {
  const v = $('#view');
  $('#status').classList.toggle('hidden', !!S.detail);
  if (S.detail) { v.innerHTML = viewDetail(); return; }
  renderStatus();
  if (S.error) { v.innerHTML = `<div class="card empty">⚠️ ${esc(S.error)}<br><br><button class="btn ghost sm" data-act="reload">Reintentar</button></div>`; return; }
  if (isGuest() && (S.tab === 'valor' || S.tab === 'boleto')) {
    v.innerHTML = `<h2>${S.tab === 'valor' ? 'Picks del modelo' : 'Mi boleto'}</h2>` + lockCard(S.tab === 'valor' ? 'Los picks del modelo y las alertas de “Revisar”' : 'Tu boleto personal con stakes sugeridos');
    return;
  }
  v.innerHTML = { hoy: viewHoy, valor: viewValor, boleto: viewBoleto, perfil: viewPerfil }[S.tab]();
}
function renderStatus() {
  const fc = S.liga === 'fc' ? `<select id="fcSel">${Object.entries(FC_LEAGUES).map(([k, n]) => `<option value="${k}" ${k === S.fc ? 'selected' : ''}>${n}</option>`).join('')}</select>` : '';
  $('#status').innerHTML = `
    <div class="toolbar">
      <span class="pill">Datos ESPN · cuotas ${HAS_ODDS ? 'The Odds API' : 'DraftKings'}</span>
      <label class="pill switch ${S.live ? 'live' : ''}"><input type="checkbox" id="liveChk" ${S.live ? 'checked' : ''} hidden><span class="dot"></span>${S.live ? 'En vivo' : 'Pausado'}</label>
      ${fc}
    </div>
    <div class="toolbar">
      <span>${S.updated ? 'Actualizado ' + S.updated.toLocaleTimeString('es-PE', { timeZone: TZ }) + ' (Lima)' : 'Cargando…'}${S.remaining != null ? ' · ' + S.remaining + ' peticiones' : ''}</span>
      <select id="fmtSel"><option value="dec" ${S.fmt === 'dec' ? 'selected' : ''}>Decimal</option><option value="us" ${S.fmt === 'us' ? 'selected' : ''}>Americana</option></select>
      <button class="pill" data-act="reload">↻</button>
    </div>
    ${S.modelStatus ? `<div class="mstatus">${esc(S.modelStatus)}</div>` : ''}`;
}
// Probabilidades a mostrar: las del modelo propio; si no hay modelo, la casa sin margen (rotulado como "Casa")
function probsOf(a) {
  const ev = a.ev, p = ev.pred;
  if (p) return { src: p.model, away: p.pAway, home: p.pHome, draw: p.pDraw };
  const h2h = a.markets.find((m) => m.market === 'h2h'); if (!h2h) return null;
  const f = (n) => h2h.outcomes.find((o) => o.name === n)?.fair;
  return { src: 'Casa sin margen', away: f(ev.away_team), home: f(ev.home_team), draw: f('Draw') ?? null };
}
const pctEs = (x) => (x == null ? '–' : Math.round(x * 100) + ' %');
const pct1 = (x) => (x == null ? 'N/D' : (x * 100).toFixed(1).replace('.', ',') + ' %');
const num1 = (x) => (x == null ? 'N/D' : x.toFixed(1).replace('.', ','));
const signed = (x) => (x > 0 ? '+' : '') + String(x).replace('.', ',');
// Orden de los equipos: fútbol = local primero (Local vs Visitante); NBA/NFL = visitante @ local
const homeFirst = (ev) => !!ev.path?.startsWith('soccer') || String(ev.sport_key || '').startsWith('soccer');
const ord = (ev, awayX, homeX) => (homeFirst(ev) ? [homeX, awayX] : [awayX, homeX]);
const matchName = (ev, full) => (homeFirst(ev) ? `${full ? ev.home_team : ev.home_abbr} vs ${full ? ev.away_team : ev.away_abbr}` : `${full ? ev.away_team : ev.away_abbr} @ ${full ? ev.home_team : ev.home_abbr}`);
const scoreTxt = (ev) => ord(ev, esc(ev.score?.[0]), esc(ev.score?.[1])).join('–');
function teamBlock(logo, abbr, rec) {
  return `<div class="tb">${logo ? `<img src="${esc(logo)}" alt="" loading="lazy">` : '<div class="nologo"></div>'}<b>${esc(abbr)}</b><span class="mut">${esc(rec?.total || '')}</span></div>`;
}
function centerBlock(ev) {
  if (ev.state === 'in') return `<div class="cb"><span class="tag live">EN VIVO</span><b class="score">${scoreTxt(ev)}</b><span class="mut tiny">${esc(ev.detail)}</span></div>`;
  if (ev.state === 'post') return `<div class="cb"><b class="score">${scoreTxt(ev)}</b><span class="mut tiny">${esc(ev.detail || 'Final')}</span></div>`;
  return `<div class="cb"><b class="time">${fmtTime(ev.commence_time)}</b><span class="mut tiny">hora Lima</span></div>`;
}
function probBar(p, ev) {
  if (!p || p.away == null || p.home == null) return `<div class="pfoot mut tiny" style="justify-content:center">${S.modelStatus && !S.modelStatus.includes('N/D') ? 'Calculando probabilidades…' : 'Probabilidades N/D'}</div>`;
  const tot = p.away + p.home + (p.draw || 0);
  const w = (x) => ((x / tot) * 100).toFixed(1) + '%';
  const fav = p.home >= p.away ? 'home' : 'away';
  const extra = ev.pred?.total != null ? ' · total ' + num1(ev.pred.total) : ev.pred?.xgHome != null ? ` · xG ${ord(ev, num1(ev.pred.xgAway), num1(ev.pred.xgHome)).join('–')}` : '';
  const seg = (side) => `<i class="${fav === side ? 'fav' : ''}" style="width:${w(p[side])}"></i>`;
  const [L, R] = ord(ev, 'away', 'home');
  return `<div class="pbar">${seg(L)}${p.draw ? `<i class="draw" style="width:${w(p.draw)}"></i>` : ''}${seg(R)}</div>
    <div class="pfoot"><span>${pctEs(p[L])}</span><span class="mut">${esc(p.src)}${p.draw ? ' · empate ' + pctEs(p.draw) : ''}${extra}</span><span>${pctEs(p[R])}</span></div>`;
}
function viewHoy() {
  if (!S.analysis.length) return `<div class="card empty">No hay partidos programados en los próximos días para esta liga.</div>`;
  let html = '', lastDay = '';
  for (const a of S.analysis) {
    const ev = a.ev, day = fmtDay(ev.commence_time);
    if (day !== lastDay) { html += `${lastDay ? '</div>' : ''}<div class="day">${day}</div><div class="grid">`; lastDay = day; }
    html += `<div class="card mcard ${ev.state === 'post' ? 'done' : ''}" data-open="${esc(ev.id)}">
      <div class="mrow">${ord(ev, teamBlock(ev.away_logo, ev.away_abbr || ev.away_team, ev.away_rec), teamBlock(ev.home_logo, ev.home_abbr || ev.home_team, ev.home_rec)).join(centerBlock(ev))}</div>
      ${probBar(probsOf(a), ev)}
    </div>`;
  }
  return html + '</div>';
}
// Picks: solo los que pasan las reglas de cada modelo (10 pp, umbrales, cuota mínima)
const SIDE_LABEL = (ev, m, side, lines) => {
  if (m === 'h2h') return side === 'home' ? ev.home_team : side === 'away' ? ev.away_team : 'Empate';
  if (m === 'spreads') { const l = side === 'home' ? lines.spreadHome : -lines.spreadHome; return (side === 'home' ? ev.home_abbr : ev.away_abbr) + ' ' + signed(l); }
  if (m === 'totals') return (side === 'Over' ? 'Más de ' : 'Menos de ') + String(lines.total).replace('.', ',');
  return side;
};
function allPicks() {
  const out = [];
  for (const [ai, a] of S.analysis.entries()) {
    const ev = a.ev, pr = ev.pred; if (!pr || ev.state !== 'pre') continue;
    for (const pk of pr.picks || []) {
      const mi = a.markets.findIndex((m) => m.market === pk.market);
      const m = a.markets[mi];
      const name = pk.market === 'h2h' ? (pk.side === 'home' ? ev.home_team : pk.side === 'away' ? ev.away_team : 'Draw') : pk.market === 'spreads' ? (pk.side === 'home' ? ev.home_team : ev.away_team) : pk.side;
      const o = m?.outcomes.find((x) => x.name === name);
      const price = pk.price ?? o?.best.price;
      out.push({ ai, a, mi, o, pk, price, ev_: price ? pk.p * price - 1 : null, label: SIDE_LABEL(ev, pk.market, pk.side, ev.lines) });
    }
  }
  return out.sort((x, y) => (y.ev_ ?? 0) - (x.ev_ ?? 0));
}
function viewValor() {
  const picks = allPicks();
  const isSoccer = S.liga === 'fc';
  const rules = S.liga === 'nba' ? 'NBA v2.5: sin pick si el modelo se separa >10 pp del mercado; ventaja solo si el hándicap difiere ≥3 pts o el total ≥8 pts de la línea de la casa.'
    : S.liga === 'nfl' ? 'NFL: sin pick si se separa >10 pp del mercado; solo es apostable una cuota de la casa que supere la cuota justa del modelo.'
    : 'Fútbol v4: sin pick si se separa >10 pp de la casa; solo si la casa paga la cuota mínima (justa × 1,10). Máximo 1% del banco, sin combinadas, sin favoritos obvios.';
  const head = `<h2>Picks del modelo</h2><p class="mut tiny" style="margin-bottom:12px">${rules} La probabilidad mostrada es siempre la del modelo.</p>`;
  const rev = S.analysis.filter((a) => a.ev.pred?.verdict === 'Revisar' && a.ev.state === 'pre');
  const revHtml = rev.length ? `<div class="card" style="margin-top:12px"><h4>REVISAR (&gt;10 pp con la casa)</h4>${rev.map((a) => `<div class="row-link" data-open="${esc(a.ev.id)}"><b>${esc(matchName(a.ev))}</b> <span class="mut tiny">${esc(a.ev.pred.verdictWhy)}</span></div>`).join('')}</div>` : '';
  if (S.modelStatus) return head + `<div class="card empty">${esc(S.modelStatus)}</div>`;
  if (!picks.length) return head + `<div class="card empty">Ahora mismo ningún partido cumple las reglas del modelo. Lo normal es que la mayoría salgan “No apostar”.</div>` + revHtml;
  return head + picks.map(({ ai, a, mi, o, pk, price, ev_, label }) => {
    const stakePct = isSoccer ? Math.min(0.01, kelly(pk.p, price) / 4) : kelly(pk.p, price) / 4;
    const added = o && inSlip(a, a.markets[mi], o);
    return `<div class="card vb">
      <div><div class="pick">${esc(label)} <span class="mut" style="font-weight:600">@ ${price ? fmtOdd(price) : '—'}</span></div>
        <div class="meta"><a class="lnk" data-open="${esc(a.ev.id)}">${esc(matchName(a.ev, true))}</a> · ${MKT[pk.market]} · ${fmtDay(a.ev.commence_time)} ${fmtTime(a.ev.commence_time)}</div></div>
      <div class="ev"><span class="mut tiny">Prob. modelo</span>${pct1(pk.p)}</div>
      <div class="nums"><span>Cuota justa <b>${fmtOdd(1 / pk.p)}</b></span>${isSoccer ? `<span>Cuota mínima <b>${fmtOdd(1.1 / pk.p)}</b></span>` : ''}<span>Valor esperado <b class="${ev_ > 0 ? 'good' : 'bad'}">${ev_ != null ? signed((ev_ * 100).toFixed(1)) + ' %' : 'N/D'}</b></span><span>Stake ${isSoccer ? '(máx. 1%)' : '¼ Kelly'} <b>${pct(stakePct)}</b> (${money(bankroll() * stakePct)})</span>${pk.why ? `<span>${esc(pk.why)}</span>` : ''}${pk.caution ? `<span class="warn">⚠ ${esc(pk.caution)}</span>` : ''}</div>
      ${o ? `<button class="add ${added ? 'in' : ''}" data-add="${ai}|${mi}|${a.markets[mi].outcomes.indexOf(o)}">${added ? '✓ En boleto' : '+ Boleto'}</button>` : ''}
    </div>`;
  }).join('') + revHtml + `<p class="mut tiny" style="margin-top:10px">Análisis probabilístico, no garantía. Apuesta solo lo que puedas perder.</p>`;
}
function viewBoleto() {
  const s = getSlip();
  if (!s.length) return `<h2>Mi boleto</h2><div class="card empty">Tu boleto está vacío. Agrega picks desde “Picks” o desde la página de un partido.</div>`;
  const stake = s.reduce((t, x) => t + (+x.stake || 0), 0);
  const ret = s.reduce((t, x) => t + (+x.stake || 0) * x.price, 0);
  return `<h2>Mi boleto</h2>
    <div class="summary"><div class="card"><span class="mut tiny">Apostado</span><b>${money(stake)}</b></div><div class="card"><span class="mut tiny">Si aciertan todas</span><b>${money(ret)}</b></div><div class="card"><span class="mut tiny">Selecciones</span><b>${s.length}</b></div></div>
    ${s.map((x, i) => `<div class="card slip-item"><div><b>${esc(x.pick)}</b> @ ${fmtOdd(x.price)}<div class="mut tiny">${esc(x.game)} · ${esc(x.market)} · ${esc(x.book)}${x.pModel != null ? ' · prob. modelo ' + pct1(x.pModel) : ''}</div></div>
      <div style="display:flex;gap:6px;align-items:center"><input type="number" min="0" value="${x.stake}" data-stake="${i}"><button class="x" data-del="${i}">×</button></div></div>`).join('')}
    <p class="mut tiny" style="margin-top:10px">Apuestas sueltas. Las combinadas multiplican también el margen de la casa (el modelo de fútbol no las recomienda).</p>
    <button class="btn ghost sm" data-act="clear" style="margin-top:12px">Vaciar boleto</button>`;
}
function viewPerfil() {
  if (isGuest()) return `<h2>Perfil</h2>` + lockCard('Tu perfil, tu bankroll y el registro de predicciones del modelo');
  const u = S.user, r = registryStats();
  const f3 = (x) => x.toFixed(3).replace('.', ',');
  return `<h2>Perfil</h2>
    <div class="card profile">${u.photo ? `<img src="${esc(u.photo)}" alt="">` : ''}<div><b>${esc(u.name || 'Invitado')}</b><div class="mut tiny">${esc(u.email || 'Invitado (sin cuenta de Google)')}</div></div></div>
    <div class="card" style="margin-top:10px"><label>Bankroll<br><input id="bankIn" type="number" min="0" value="${bankroll()}" style="margin-top:8px;font:inherit;background:var(--surf2);color:var(--ink);border:1px solid var(--edge);border-radius:8px;padding:8px;width:160px"></label></div>
    <div class="card" style="margin-top:10px"><h4>REGISTRO DE PREDICCIONES</h4>
      <p class="mut tiny">Se guarda cada predicción antes del partido (en este navegador) y se compara con el resultado.</p>
      <div class="summary"><div class="card"><span class="mut tiny">Guardadas</span><b>${r.n}</b></div><div class="card"><span class="mut tiny">Con resultado</span><b>${r.settled}</b></div><div class="card"><span class="mut tiny">Con cuota</span><b>${r.mkt.n}</b></div></div>
      ${r.settled ? `<table><tr><th></th><th>Log-loss</th><th>Brier</th></tr><tr><td>Modelo</td><td>${f3(r.model.ll)}</td><td>${f3(r.model.br)}</td></tr>${r.mkt.n ? `<tr><td>Mercado</td><td>${f3(r.mkt.ll)}</td><td>${f3(r.mkt.br)}</td></tr>` : ''}</table><p class="mut tiny">Menos es mejor. Con pocos partidos no prueba nada.</p>` : '<p class="mut tiny">Aún no hay partidos terminados en el registro.</p>'}
    </div>
    <button class="btn ghost" data-act="logout" style="margin-top:14px;width:100%">Cerrar sesión</button>`;
}
// ---------- Página del partido ----------
// Datos extra de ESPN (se piden al abrir el partido y se guardan en caché)
const D = { sum: {}, sched: {}, roster: {}, glog: {}, stand: {} };
const espnBase = (p) => `https://site.api.espn.com/apis/site/v2/sports/${p}`;
const getJ = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
async function cached(bucket, key, url, maxAge = 6e5) {
  const c = D[bucket][key];
  if (c && (c.v instanceof Promise || Date.now() - c.t < maxAge)) return c.v;
  const p = getJ(url);
  D[bucket][key] = { t: Date.now(), v: p };
  const v = await p; D[bucket][key] = { t: Date.now(), v }; return v;
}
const peek = (bucket, key) => { const c = D[bucket][key]; return c && !(c.v instanceof Promise) ? c.v : undefined; };
const rerenderDetail = () => { if (S.detail) render(); };
function need(bucket, key, url) { if (peek(bucket, key) === undefined && !(D[bucket][key]?.v instanceof Promise)) cached(bucket, key, url).then(rerenderDetail); return peek(bucket, key); }

const isNBA = (ev) => ev.path === 'basketball/nba';
const scoreVal = (s) => (s && typeof s === 'object' ? +s.value : +s);

// Partidos ya jugados de un equipo, del más antiguo al más reciente
function teamGames(path, teamId) {
  const j = need('sched', path + teamId, `${espnBase(path)}/teams/${teamId}/schedule`);
  if (!j) return j;
  return (j.events || []).filter((e) => e.competitions?.[0]?.status?.type?.completed).map((e) => {
    const c = e.competitions[0];
    const me = c.competitors.find((x) => x.id === String(teamId) || x.team?.id === String(teamId));
    const op = c.competitors.find((x) => x !== me);
    const pf = scoreVal(me?.score), pa = scoreVal(op?.score);
    return { id: e.id, date: e.date, home: me?.homeAway === 'home', opp: op?.team?.abbreviation || op?.team?.shortDisplayName || '?', oppId: op?.team?.id || op?.id, pf, pa, diff: pf - pa, win: pf > pa };
  }).filter((g) => isFinite(g.diff)).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function detailHeader(ev) {
  const sub = (r, side) => `${esc(r?.total || '')}${r?.[side] ? ` · ${side === 'home' ? 'casa' : 'fuera'} ${esc(r[side])}` : ''}`;
  const center = ev.state === 'pre'
    ? `<b class="time">${fmtTime(ev.commence_time)}</b><span class="mut">${new Date(ev.commence_time).toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ })} · hora Lima</span>`
    : `${ev.state === 'in' ? '<span class="tag live">EN VIVO</span>' : ''}<b class="score">${scoreTxt(ev)}</b><span class="mut">${esc(ev.detail)}</span>`;
  const awayB = `<div class="tb big">${ev.away_logo ? `<img src="${esc(ev.away_logo)}" alt="">` : ''}<b>${esc(ev.away_abbr)}</b><span class="mut">${sub(ev.away_rec, 'road')}</span></div>`;
  const homeB = `<div class="tb big">${ev.home_logo ? `<img src="${esc(ev.home_logo)}" alt="">` : ''}<b>${esc(ev.home_abbr)}</b><span class="mut">${sub(ev.home_rec, 'home')}</span></div>`;
  const tabBtn = (side) => `<button data-dtab="${side}" class="${S.detail.tab === side ? 'on' : ''}">Jugadores ${esc(side === 'home' ? ev.home_abbr : ev.away_abbr)}</button>`;
  return `<div class="dtop"><button class="icon-btn" data-act="back">‹</button><b>${esc(matchName(ev))}</b></div>
  <div class="hero">${ord(ev, awayB, homeB).join(`<div class="cb">${center}</div>`)}</div>
  <div class="seg wide">
    <button data-dtab="partido" class="${S.detail.tab === 'partido' ? 'on' : ''}">Partido</button>
    ${ord(ev, tabBtn('away'), tabBtn('home')).join('')}
  </div>`;
}

function viewDetail() {
  const ai = S.analysis.findIndex((x) => String(x.ev.id) === String(S.detail.id));
  if (ai < 0) return `<div class="dtop"><button class="icon-btn" data-act="back">‹</button></div><div class="card empty">Este partido ya no está en la lista.</div>`;
  const a = S.analysis[ai], ev = a.ev;
  if (!ev.path) return detailHeader(ev) + `<div class="card empty">El detalle completo usa datos de ESPN.</div>`;
  const body = S.detail.tab === 'partido' ? partidoTab(a, ai) : playersTab(a, S.detail.tab);
  return detailHeader(ev) + body;
}

// ----- Pestaña Partido -----
function partidoTab(a, ai) {
  const ev = a.ev;
  const sum = need('sum', ev.id, `${espnBase(ev.path)}/summary?event=${ev.id}`);
  if (isGuest()) return ganadorSection(a, ai) + lockCard('El porqué del %, todas las salidas del modelo, historial, bajas, detalles y otros mercados');
  return ganadorSection(a, ai) + historySection(ev) + injuriesSection(ev, sum) + detailsSection(ev) + marketsSection(a, ai);
}

// Ganador: probabilidad del MODELO frente a lo que dice la cuota de la casa
function ganadorSection(a, ai) {
  const ev = a.ev, pr = ev.pred, mi = a.markets.findIndex((m) => m.market === 'h2h'), h2h = a.markets[mi];
  const hasDraw = pr ? pr.pDraw != null : h2h?.outcomes.some((o) => o.name === 'Draw');
  const [first, last] = ord(ev, ['away', ev.away_team], ['home', ev.home_team]);
  const order = [first, ...(hasDraw ? [['draw', 'Draw']] : []), last];
  const pm = (side) => (pr ? (side === 'home' ? pr.pHome : side === 'away' ? pr.pAway : pr.pDraw) : null);
  const mk = (side) => (pr ? (side === 'home' ? pr.mktHome : side === 'away' ? pr.mktAway : pr.mktDraw) : null);
  const favSide = pr ? order.map(([s]) => s).sort((x, y) => (pm(y) ?? 0) - (pm(x) ?? 0))[0] : null;
  const cards = order.map(([side, name]) => {
    const o = h2h?.outcomes.find((x) => x.name === name);
    const logo = side === 'draw' ? '' : side === 'home' ? ev.home_logo : ev.away_logo;
    const abbr = side === 'draw' ? 'Empate' : side === 'home' ? ev.home_abbr : ev.away_abbr;
    const p = pm(side), implied = o ? 1 / o.best.price : null;
    const novig = mk(side) ?? (o ? o.fair : null);
    const pp = p != null && novig != null ? (p - novig) * 100 : null;
    const ev_ = p != null && o ? p * o.best.price - 1 : null;
    const fairOdd = p ? 1 / p : null;
    const minOdd = pr?.minOdds ? pr.minOdds[side] : null;
    const added = o && inSlip(a, h2h, o);
    return `<div class="card gcard ${side === favSide ? 'fav' : ''}">
      ${side === favSide ? '<span class="badge">Favorito del modelo</span>' : ''}
      <div class="ghead">${logo ? `<img src="${esc(logo)}" alt="">` : ''}<b>${esc(abbr)}</b><span class="odd-big">${o ? fmtOdd(o.best.price) : '—'}</span></div>
      <div class="cmp">
        <div><span class="mut">Modelo</span><b class="${side === favSide ? 'acc' : ''}">${pct1(p)}</b></div>
        <div><span class="mut">Cuota justa</span><b>${fairOdd ? fmtOdd(fairOdd) : 'N/D'}</b></div>
        <div><span class="mut">Casa (1/cuota)</span><b>${pct1(implied)}</b></div>
        <div><span class="mut">Casa sin margen</span><b>${pct1(novig)}</b></div>
        <div><span class="mut">Diferencia</span><b class="${pp == null ? '' : Math.abs(pp) > 10 ? 'warn' : ''}">${pp == null ? 'N/D' : signed(pp.toFixed(1)) + ' pp'}</b></div>
        <div><span class="mut">Valor esperado</span><b class="${ev_ == null ? '' : ev_ > 0 ? 'good' : 'bad'}">${ev_ == null ? 'N/D' : signed((ev_ * 100).toFixed(1)) + ' %'}</b></div>
        ${minOdd ? `<div><span class="mut">Cuota mínima</span><b>${fmtOdd(minOdd)}</b></div>` : ''}
      </div>
      ${o ? `<div class="gfoot"><span class="tiny mut">${esc(ev.provider || 'Casa')}</span><button class="add ${added ? 'in' : ''}" data-add="${ai}|${mi}|${h2h.outcomes.indexOf(o)}">${added ? '✓ Boleto' : '+ Boleto'}</button></div>` : ''}
    </div>`;
  }).join('');
  const head = pr ? `${esc(pr.model)}${pr.margin != null ? ` · ${esc(pr.margin >= 0 ? ev.home_abbr : ev.away_abbr)} por ${num1(Math.abs(pr.margin))} · ${num1(pr.homePts)}-${num1(pr.awayPts)}` : ''}${pr.xgHome != null ? ` · xG ${num1(pr.xgHome)}-${num1(pr.xgAway)}` : ''}`
    : (S.modelStatus || 'Modelo N/D');
  return `<div class="sec"><h4>GANADOR</h4><span class="mut tiny">${head}</span></div>
    ${verdictBox(ev)}
    <div class="gcards n${order.length}">${cards}</div>
    <p class="mut tiny" style="margin:6px 2px 0">La probabilidad es siempre la del modelo (no se acerca a la cuota). “Casa sin margen” quita la comisión: 1/cuota normalizado. Diferencia = modelo − casa sin margen. Valor esperado = prob. modelo × cuota − 1. Una probabilidad baja sigue siendo baja aunque tenga valor.</p>
    ${isGuest() ? '' : whyBox(a) + modelBox(a)}`;
}
// "¿Por qué este %?": explica de dónde sale la probabilidad con los números del modelo
function whyBox(a) {
  const ev = a.ev, pr = ev.pred, w = pr?.why; if (!w) return '';
  const H = ev.home_abbr, A = ev.away_abbr;
  const n1 = (x) => num1(Math.abs(x));
  const sg = (x) => (x >= 0 ? '+' : '−') + n1(x);
  // Barras de contribución: cada factor empuja hacia un equipo
  const bars = (rows, unit) => {
    const max = Math.max(0.01, ...rows.map((r) => Math.abs(r.v)));
    return `<div class="contrib">${rows.map((r) => {
      const toHome = r.v >= 0, team = toHome ? H : A, pctW = (Math.abs(r.v) / max) * 50;
      return `<div class="crow"><span class="clab">${esc(r.label)}</span>
        <div class="cbar"><i class="${toHome !== homeFirst(ev) ? 'r' : 'l'}" style="width:${pctW}%"></i></div>
        <span class="cval">${Math.abs(r.v) < 0.05 ? '≈ 0' : `${n1(r.v)} ${unit} a favor de <b>${esc(team)}</b>`}</span></div>`;
    }).join('')}<div class="caxis">${ord(ev, `<span>← ${esc(A)}</span>`, `<span>← ${esc(H)}</span>`).map((s, i) => (i ? s.replace('← ', '').replace('</span>', ' →</span>') : s)).join('')}</div></div>`;
  };
  const fav = pr.pHome >= pr.pAway ? H : A, pFav = Math.max(pr.pHome, pr.pAway);
  let summary = '', rows = [], steps = [];

  if (w.kind === 'nba' || w.kind === 'nfl') {
    const ratingDiff = w.netHome - w.netAway;
    const home = w.kind === 'nba' ? w.hca : w.hfa;
    const inj = w.penA - w.penH; // + favorece al local
    rows = [
      { label: 'Nivel de los equipos', v: ratingDiff },
      { label: 'Localía', v: home },
      { label: 'Bajas', v: inj },
      ...(w.kind === 'nba' && w.b2b ? [{ label: 'Back-to-back visitante', v: 0 }] : []),
    ];
    const names = { 'Nivel de los equipos': 'su mejor nivel en la temporada', Localía: 'la ventaja de jugar en casa', Bajas: 'las bajas del rival' };
    const against = { 'Nivel de los equipos': 'el mejor nivel del rival', Localía: 'la localía del rival', Bajas: 'sus propias bajas' };
    const favHome = pr.pHome >= pr.pAway;
    const pro = rows.filter((r) => (favHome ? r.v : -r.v) > 0.05).sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
    const con = rows.filter((r) => (favHome ? r.v : -r.v) < -0.05).sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
    summary = `<b>${esc(fav)}</b> sale con <b>${pct1(pFav)}</b> sobre todo por ${pro.length ? names[pro[0].label] : '}${con.length ? `, aunque le resta ${against[con[0].label]}` : '}: el modelo espera que gane por <b>${n1(pr.margin)} pts</b>.`;
    const unit = 'pts';
    if (w.kind === 'nba') {
      steps.push(`<b>Nivel (ratings).</b> Con todos los partidos de la temporada, dando más peso a lo reciente (vida media 10 días) y recortando palizas a ±20, ${H} vale <b>${sg(w.netHome)}</b> pts por partido frente a la media y ${A} <b>${sg(w.netAway)}</b>. Ataque: ${H} ${sg(w.attHome)} / ${A} ${sg(w.attAway)} pts anotados; defensa: ${H} ${sg(w.defHome)} / ${A} ${sg(w.defAway)} pts que evita. Diferencia: <b>${sg(ratingDiff)}</b> para ${H}.`);
      steps.push(`<b>Localía.</b> ${H} juega en casa: <b>${sg(w.hca)}</b> pts (estimada con la temporada, partiendo de 2,5).`);
      steps.push(`<b>Bajas.</b> ${H} pierde <b>${n1(w.penH)}</b> pts y ${A} <b>${n1(w.penA)}</b> pts${w.b2b ? ` (incluye ${n1(w.b2b)} pts por back-to-back del visitante)` : ''}. Cada jugador vale según su “tier” × probabilidad de no jugar, y cuenta menos si ya lleva tiempo fuera (el rating ya lo refleja). Dudas y b2b tienen un tope de 4 pts.${[...w.injNotesH.map((x) => H + ': ' + x), ...w.injNotesA.map((x) => A + ': ' + x)].map((x) => `<br><span class="mut tiny">· ${esc(x.replace(/(\d)\.(\d)/g, '$1,$2'))}</span>`).join('')}`);
      steps.push(`<b>De margen a probabilidad.</b> Sumando todo, ${fav} gana por <b>${n1(pr.margin)} pts</b> de media. Los partidos NBA se desvían de lo esperado unos <b>15,08 pts</b>, así que en 50.000 simulaciones ${fav} gana el <b>${pct1(pFav)}</b> (tope 94 %).`);
      steps.push(`<b>Total.</b> Los ratings dan ${num1(w.modelTotal)} pts; la media de la liga de los últimos 10 días es ${num1(w.leagueTot10)}. Mitad y mitad: <b>${num1(pr.total)}</b>.`);
    } else {
      steps.push(`<b>Nivel (ratings).</b> Regresión sobre los puntos de toda la temporada (sin peso extra a lo reciente): ${H} vale <b>${sg(w.netHome)}</b> pts frente a la media y ${A} <b>${sg(w.netAway)}</b>. Diferencia: <b>${sg(ratingDiff)}</b> para ${H}.`);
      steps.push(`<b>Localía.</b> ${w.hfa ? `<b>+${num1(w.hfa)}</b> pts para ${H}.` : 'Sede neutral: 0.'}`);
      steps.push(`<b>Bajas.</b> ${H} −${n1(w.penH)} pts, ${A} −${n1(w.penA)} pts. Solo cuentan Out y Doubtful (al 50 %) de QB titular, WR1, RB1 o TE1.${[...w.injNotesH.map((x) => H + ': ' + x), ...w.injNotesA.map((x) => A + ': ' + x)].map((x) => `<br><span class="mut tiny">· ${esc(x.replace(/(\d)\.(\d)/g, '$1,$2'))}</span>`).join('')}`);
      steps.push(`<b>De margen a probabilidad.</b> Sumando todo, ${fav} gana por <b>${n1(pr.margin)} pts</b> de media. Con ${num1(w.avgGp)} partidos jugados de media, la incertidumbre es σ = √(13,5² + 1000/${num1(w.avgGp)}) = <b>${num1(w.sigma)}</b> pts. En 50.000 partidos simulados drive a drive, ${fav} gana el <b>${pct1(pFav)}</b> (tope 92 %).`);
    }
    if (pr.mktHome != null) {
      const pp = (pr.pHome - pr.mktHome) * 100;
      steps.push(`<b>Frente a la casa.</b> ${esc(ev.provider || 'La casa')} da a ${H} un ${pct1(pr.mktHome)} sin margen: diferencia de <b>${signed(pp.toFixed(1))} pp</b>.${Math.abs(pp) > 10 ? ` Es más de 10 pp, por eso sale “Revisar”. El modelo solo mira puntos: no ve talento de plantilla, rotaciones ni noticias que el mercado sí ve (récord ${H} ${esc(ev.home_rec?.total || '–')}, ${A} ${esc(ev.away_rec?.total || '–')}).` : ''}`);
    }
    return `<div class="card why"><h4>¿POR QUÉ ESTE %?</h4><p class="wsum">${summary}</p>${bars(rows, unit)}<ol class="steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol></div>`;
  }

  // Fútbol: goles esperados = media de la liga × 1,04 × ataque propio × defensa rival
  const { rh, ra } = w;
  const n2 = (x) => x.toFixed(2).replace('.', ',');
  const ln = Math.log;
  rows = [
    { label: 'Localía (liga)', v: ln(w.homeAvg / w.awayAvg) },
    { label: 'Ataque', v: ln(rh.att / ra.att) },
    { label: 'Defensa', v: ln(ra.def / rh.def) },
  ];
  const favSide = pr.pHome >= pr.pAway ? 'home' : 'away';
  const favName = favSide === 'home' ? H : A, rivName = favSide === 'home' ? A : H;
  const sgn = favSide === 'home' ? 1 : -1;
  const proS = rows.filter((r) => sgn * r.v > 0.01).sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
  const conS = rows.filter((r) => sgn * r.v < -0.01).sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
  const forFav = { 'Localía (liga)': 'jugar en casa', Ataque: 'su mejor ataque', Defensa: 'su defensa más sólida' };
  const forRiv = { 'Localía (liga)': 'jugar de visita', Ataque: `el mejor ataque de ${rivName}`, Defensa: `la mejor defensa de ${rivName}` };
  const reason = (proS.length ? forFav[proS[0].label] : 'muy poco margen') + (conS.length ? `, aunque le resta ${forRiv[conS[0].label]}` : '');
  summary = `<b>${esc(favName)}</b> sale con <b>${pct1(favSide === 'home' ? pr.pHome : pr.pAway)}</b> (empate ${pct1(pr.pDraw)}), sobre todo por ${reason}. Goles esperados: ${H} <b>${num1(pr.xgHome)}</b> – ${A} <b>${num1(pr.xgAway)}</b>.`;
  const rel = (x, what) => `${x.toFixed(2).replace('.', ',')} (${x >= 1 ? '+' : '−'}${Math.round(Math.abs(x - 1) * 100)} % ${what})`;
  steps.push(`<b>Fuerza de cada equipo.</b> Ataque y defensa relativos a la media de la liga, con la temporada actual mezclada con 15 partidos “ficticios” a su nivel de la temporada pasada (cuanto más se juega, más pesa lo actual). ${H} (${rh.gp} PJ): ataque ${rel(rh.att, 'que la media')}, defensa ${rel(rh.def, 'goles que la media')}${rh.promoted ? ' · sin temporada anterior: tratado como ascendido' : ''}. ${A} (${ra.gp} PJ): ataque ${rel(ra.att, 'que la media')}, defensa ${rel(ra.def, 'goles que la media')}${ra.promoted ? ' · sin temporada anterior: tratado como ascendido' : ''}. En defensa, menos de 1 es mejor.`);
  steps.push(`<b>Goles esperados.</b> ${H}: ${n2(w.homeAvg)} (media de goles del local en la liga) × 1,04 × ataque ${n2(rh.att)} × defensa rival ${n2(ra.def)} = <b>${n2(pr.xgHome)}</b>. ${A}: ${n2(w.awayAvg)} × 1,04 × ${n2(ra.att)} × ${n2(rh.def)} = <b>${n2(pr.xgAway)}</b>.`);
  steps.push(`<b>De goles a probabilidad.</b> Se juegan 50.000 partidos: los goles de cada equipo salen de una Poisson con una pequeña variación de forma (gamma, ±10 %). ${H} gana el <b>${pct1(pr.pHome)}</b>, empate <b>${pct1(pr.pDraw)}</b>, ${A} <b>${pct1(pr.pAway)}</b>. El empate sube cuando los goles esperados son bajos y parecidos. Tope de favorito: 85 %.${w.live ? ' Partido en juego: solo se simula el tiempo que queda, partiendo del marcador actual.' : ''}`);
  if (pr.mktHome != null) steps.push(`<b>Frente a la casa.</b> Sin margen, la casa da ${H} ${pct1(pr.mktHome)} · X ${pct1(pr.mktDraw)} · ${A} ${pct1(pr.mktAway)}. Mayor diferencia: <b>${num1(pr.maxPP)} pp</b>${pr.maxPP > 10 ? ' (más de 10 pp → “Revisar”: el modelo no ve bajas, alineaciones ni motivación)' : ''}.`);
  return `<div class="card why"><h4>¿POR QUÉ ESTE %?</h4><p class="wsum">${summary}</p>${bars(rows.map((r) => ({ ...r, v: r.v * 100 })), '% más goles')}<ol class="steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol></div>`;
}

function verdictBox(ev) {
  const pr = ev.pred; if (!pr) return '';
  if (ev.state !== 'pre') return `<div class="verdict nd"><b>Partido ${ev.state === 'in' ? 'en juego' : 'terminado'}</b>${pr.live ? ' · probabilidades re-simuladas con el marcador y el tiempo restante' : ''}</div>`;
  const cls = { Ventaja: 'ok', Revisar: 'rev', 'No apostar': 'no', 'N/D': 'nd' }[pr.verdict] || 'nd';
  const picks = (pr.picks || []).map((pk) => `${SIDE_LABEL(ev, pk.market, pk.side, ev.lines)} (${pct1(pk.p)})`).join(' · ');
  return `<div class="verdict ${cls}"><b>${pr.verdict === 'Revisar' ? 'Revisar (>10 pp)' : esc(pr.verdict)}</b>${picks ? ' · ' + esc(picks) : ''}${pr.verdictWhy ? `<div class="tiny">${esc(pr.verdictWhy)}</div>` : ''}</div>`;
}
// Salidas completas del modelo
function modelBox(a) {
  const ev = a.ev, pr = ev.pred, L = ev.lines || {};
  if (!pr) return '';
  const row = (k, v, extra = '') => `<tr><td>${k}</td><td>${v}</td><td class="mut">${extra}</td></tr>`;
  let rows = '';
  if (pr.xgHome != null) { // fútbol
    const f = pr.fair, mo = pr.minOdds;
    rows += row('1X2', `${ev.home_abbr} ${pct1(pr.pHome)} · X ${pct1(pr.pDraw)} · ${ev.away_abbr} ${pct1(pr.pAway)}`, `justa ${fmtOdd(f.home)} / ${fmtOdd(f.draw)} / ${fmtOdd(f.away)} · mín. ${fmtOdd(mo.home)} / ${fmtOdd(mo.draw)} / ${fmtOdd(mo.away)}`);
    rows += row('Goles esperados', `${ev.home_abbr} ${num1(pr.xgHome)} · ${ev.away_abbr} ${num1(pr.xgAway)}`);
    rows += row('Más / Menos de 2,5', `${pct1(pr.pOver25)} / ${pct1(1 - pr.pOver25)}`, `justa ${fmtOdd(f.over)} / ${fmtOdd(f.under)}${L.total === 2.5 ? ` · casa ${fmtOdd(L.overPrice)} / ${fmtOdd(L.underPrice)}` : ''}`);
    rows += row('Ambos marcan', `Sí ${pct1(pr.pBTTS)} · No ${pct1(1 - pr.pBTTS)}`, `justa ${fmtOdd(f.btts)} / ${fmtOdd(f.noBtts)}`);
    rows += row('Marcadores más probables', pr.top.map(([s, p]) => `${s} (${pct1(p)})`).join(' · '), 'local-visitante');
    rows += row('Hándicap asiático equilibrado', `${ev.home_abbr} ${signed(pr.ah.line)}`, `${pct1(pr.ah.p)} de cubrir`);
    rows += row('Córners', 'N/D', 'sin promedios reales por equipo en ESPN');
  } else {
    rows += row('Prob. victoria', `${ev.home_abbr} ${pct1(pr.pHome)} · ${ev.away_abbr} ${pct1(pr.pAway)}`, `justa ${fmtOdd(1 / pr.pHome)} / ${fmtOdd(1 / pr.pAway)}${pr.mktHome != null ? ` · casa sin margen ${pct1(pr.mktHome)} / ${pct1(pr.mktAway)}` : ''}`);
    rows += row('Margen esperado (local)', signed(num1(pr.margin)), `σ ${num1(pr.sd)}`);
    rows += row('Hándicap equilibrado', `${ev.home_abbr} ${signed(pr.fairSpread)}`, L.spreadHome != null ? `casa ${ev.home_abbr} ${signed(L.spreadHome)} · P(cubre local) ${pct1(pr.pCoverHome)}` : 'casa N/D');
    rows += row('Total esperado', num1(pr.total), `línea equilibrada ${String(pr.fairTotal).replace('.', ',')}${L.total != null ? ` · casa ${String(L.total).replace('.', ',')} · P(Más) ${pct1(pr.pOver)} · P(Menos) ${pct1(pr.pOver != null ? 1 - pr.pOver : null)}` : ' · casa N/D'}`);
    rows += row('Diferencia con el mercado', pr.ppHome != null ? signed(pr.ppHome.toFixed(1)) + ' pp (local)' : 'N/D', pr.ppHome == null ? 'la casa no publica ganador' : '');
  }
  const ctx = (pr.context || []).length ? `<ul class="dots">${pr.context.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '<p class="mut tiny">Sin bajas que ajustar.</p>';
  return `<div class="card"><h4>MODELO · ${esc(pr.model)}</h4><div class="scroll"><table class="mtable">${rows}</table></div>
    <h4 style="margin-top:12px">CONTEXTO Y AJUSTES</h4>${ctx}
    <p class="mut tiny">${pr.nGames} partidos de la temporada usados · 50.000 simulaciones · hora de Lima. Análisis probabilístico, no garantía.</p></div>`;
}

function historySection(ev) {
  const h = (S.detail.hist ||= { team: 'home', n: 10, side: 'all' });
  const teamId = h.team === 'home' ? ev.home_id : ev.away_id;
  const abbr = h.team === 'home' ? ev.home_abbr : ev.away_abbr;
  const oppId = h.team === 'home' ? ev.away_id : ev.home_id;
  const all = teamGames(ev.path, teamId);
  const head = `<div class="card hist"><div class="hhead"><div><h3>Historial de ${esc(abbr)}</h3>`;
  if (all === undefined) return head + `<p class="mut">Cargando…</p></div></div></div>`;
  if (!all) return head + `<p class="mut">No disponible.</p></div></div></div>`;
  let g = all.filter((x) => (h.side === 'all' ? true : h.side === 'home' ? x.home : !x.home));
  if (h.n === 'h2h') g = g.filter((x) => String(x.oppId) === String(oppId));
  else if (h.n !== 'season') g = g.slice(-h.n);
  const w = g.filter((x) => x.win).length;
  const avg = g.length ? g.reduce((s, x) => s + x.diff, 0) / g.length : 0;
  const max = Math.max(1, ...g.map((x) => Math.abs(x.diff)));
  const btn = (k, v, label) => `<button data-hist="${k}:${v}" class="${String(h[k]) === String(v) ? 'on' : ''}">${label}</button>`;
  const bars = g.map((x) => {
    const hgt = (Math.abs(x.diff) / max) * 100;
    const d = new Date(x.date);
    return `<div class="bcol" title="${esc(x.home ? 'vs ' : '@ ')}${esc(x.opp)} · ${x.pf}-${x.pa}">
      <div class="up">${x.diff > 0 ? `<span>+${x.diff}</span><i class="win" style="height:${hgt}%"></i>` : ''}</div>
      <div class="dn">${x.diff <= 0 ? `<i class="loss" style="height:${hgt}%"></i><span>${x.diff}</span>` : ''}</div>
      <small>${d.getDate()}/${d.getMonth() + 1}<br><b>${x.home ? '' : '@'}${esc(x.opp)}</b></small></div>`;
  }).join('');
  const dr = g.filter((x) => x.diff === 0).length;
  return head + `<span class="mut">${w}-${dr ? dr + '-' : ''}${g.length - w - dr} en este tramo · ${avg > 0 ? '+' : ''}${avg.toFixed(1).replace('.', ',')} de diferencia media</span></div>
      <div class="seg">${ord(ev, btn('team', 'away', ev.away_abbr), btn('team', 'home', ev.home_abbr)).join('')}</div></div>
    <div class="filters"><div class="seg">${btn('n', 5, 'L5')}${btn('n', 10, 'L10')}${btn('n', 20, 'L20')}${btn('n', 'h2h', 'H2H')}${btn('n', 'season', 'Temporada')}</div>
      <div class="seg">${btn('side', 'all', 'Todos')}${btn('side', 'home', 'Casa')}${btn('side', 'away', 'Fuera')}</div></div>
    ${g.length ? `<div class="chart">${bars}</div>` : '<p class="mut" style="padding:20px 0">Sin partidos en este filtro.</p>'}
    <p class="mut tiny">Diferencia de ${isNBA(ev) || ev.path.includes('nfl') ? 'puntos' : 'goles'} de ${esc(abbr)} en cada partido. Por encima de 0 = ganó. Pasa el ratón por una barra para ver el marcador.</p></div>`;
}

const INJ_ES = { Out: 'Baja', 'Day-To-Day': 'Duda', Questionable: 'Duda', Doubtful: 'Duda', Probable: 'Probable', Suspension: 'Sanción' };
function injuriesSection(ev, sum) {
  if (sum === undefined) return `<div class="card"><h4>BAJAS</h4><p class="mut">Cargando…</p></div>`;
  const teams = sum?.injuries || [];
  if (!teams.length || teams.every((t) => !t.injuries?.length)) return `<div class="card"><h4>BAJAS</h4><p class="mut">ESPN no reporta bajas para este partido.</p></div>`;
  const col = (abbr, list) => {
    let lost = 0;
    const rows = list.map((x) => {
      const st = INJ_ES[x.status] || x.status || '';
      const ppg = isNBA(ev) ? playerAvg(ev.path, x.athlete?.id, 'PTS') : null;
      if (ppg != null) lost += st === 'Baja' ? ppg : st === 'Duda' ? ppg / 2 : 0;
      const d = x.details || {};
      const why = [d.type, d.location && d.location !== d.type ? `(${d.location})` : '', d.returnDate ? `· vuelta aprox. ${new Date(d.returnDate).toLocaleDateString('es', { day: 'numeric', month: 'short' })}` : ''].filter(Boolean).join(' ');
      return `<div class="inj"><b>${esc(x.athlete?.displayName)}</b> <span class="chip ${st === 'Baja' ? 'bad' : 'warn'}">${esc(st)}</span>${ppg != null ? ` <span class="mut">${ppg.toFixed(1).replace('.', ',')} pts/p</span>` : ''}<div class="mut tiny">${esc(why || x.shortComment || '')}</div></div>`;
    }).join('');
    return `<div><div class="ihead"><b>${esc(abbr)}</b>${lost ? `<span class="mut">−${lost.toFixed(1).replace('.', ',')} pts</span>` : ''}</div>${rows}</div>`;
  };
  const by = (id, abbr) => teams.find((t) => String(t.team?.id) === String(id) || t.team?.abbreviation === abbr)?.injuries || [];
  // En NBA, pedimos el promedio de cada lesionado para estimar cuánto pierde cada equipo
  if (isNBA(ev)) for (const t of teams) for (const x of t.injuries || []) if (x.athlete?.id) need('glog', x.athlete.id, glogUrl(ev.path, x.athlete.id));
  return `<div class="card"><div class="ihead"><h4>BAJAS</h4></div><div class="icols">${ord(ev, col(ev.away_abbr, by(ev.away_id, ev.away_abbr)), col(ev.home_abbr, by(ev.home_id, ev.home_abbr))).join('')}</div>
    ${isNBA(ev) ? '<p class="mut tiny">“−pts” = suma de los puntos por partido de las bajas (las dudas cuentan a medias). El modelo de ESPN puede o no tenerlas ya en cuenta.</p>' : ''}</div>`;
}

function detailsSection(ev) {
  const H = teamGames(ev.path, ev.home_id), A = teamGames(ev.path, ev.away_id);
  if (!H || !A) return '';
  const start = new Date(ev.commence_time);
  const rest = (g) => { const l = g[g.length - 1]; if (!l) return null; return Math.max(0, Math.floor((new Date(start).setHours(0, 0, 0, 0) - new Date(l.date).setHours(0, 0, 0, 0)) / 864e5) - 1); };
  const streak = (g) => { let n = 0; const last = g[g.length - 1]; if (!last) return null; for (let i = g.length - 1; i >= 0 && g[i].win === last.win; i--) n++; return { n, win: last.win }; };
  const l10 = (g) => { const s = g.slice(-10); return { w: s.filter((x) => x.win).length, n: s.length, diff: s.reduce((t, x) => t + x.diff, 0) / (s.length || 1), pf: s.reduce((t, x) => t + x.pf, 0) / (s.length || 1), pa: s.reduce((t, x) => t + x.pa, 0) / (s.length || 1) }; };
  const unit = isNBA(ev) || ev.path.includes('nfl') ? 'puntos' : 'goles';
  const items = [];
  const rH = rest(H), rA = rest(A);
  if (rH != null && rA != null) items.push([rH > rA ? 'good' : rH < rA ? 'bad' : '', `${ev.home_abbr}: ${rH === 0 ? 'juega dos días seguidos' : rH + ' día' + (rH > 1 ? 's' : '') + ' de descanso'} · ${ev.away_abbr}: ${rA === 0 ? 'juega dos días seguidos' : rA + ' día' + (rA > 1 ? 's' : '')}`]);
  for (const [g, abbr] of [[H, ev.home_abbr], [A, ev.away_abbr]]) {
    const s = streak(g); if (s && s.n >= 3) items.push([s.win ? 'good' : 'bad', `${abbr}: racha de ${s.n} ${s.win ? 'victorias' : 'derrotas'} seguidas`]);
  }
  if (ev.home_rec?.home) items.push(['', `${ev.home_abbr} en casa esta temporada: ${ev.home_rec.home}`]);
  if (ev.away_rec?.road) items.push(['', `${ev.away_abbr} fuera esta temporada: ${ev.away_rec.road}`]);
  for (const [g, abbr] of [[H, ev.home_abbr], [A, ev.away_abbr]]) {
    const t = l10(g); if (t.n) items.push([t.diff > 0 ? 'good' : 'bad', `${abbr} últimos ${t.n}: ${t.w}-${t.n - t.w}, ${t.diff > 0 ? '+' : ''}${t.diff.toFixed(1).replace('.', ',')} de diferencia media, ${t.pf.toFixed(0)} ${unit} a favor y ${t.pa.toFixed(0)} en contra`]);
  }
  const h2h = H.filter((x) => String(x.oppId) === String(ev.away_id));
  if (h2h.length) { const w = h2h.filter((x) => x.win).length; items.push([w > h2h.length - w ? 'good' : w < h2h.length - w ? 'bad' : '', `${ev.home_abbr} contra ${ev.away_abbr} esta temporada: ${w}-${h2h.length - w}`]); }
  return `<div class="card"><h4>DETALLES QUE PUEDEN CAMBIARLO TODO</h4><ul class="dots">${items.map(([c, t]) => `<li class="${c}">${esc(t)}</li>`).join('')}</ul></div>`;
}

function marketsSection(a, ai) {
  const ev = a.ev;
  const sp = a.markets.findIndex((m) => m.market === 'spreads'), to = a.markets.findIndex((m) => m.market === 'totals');
  if (sp < 0 && to < 0) return '';
  const cell = (mi, o, title) => {
    const added = inSlip(a, a.markets[mi], o);
    return `<div class="card mk"><span class="mut">${esc(title)}</span><b>${o.point != null ? (o.point > 0 && a.markets[mi].market === 'spreads' ? '+' : '') + String(o.point).replace('.', ',') : ''}</b>
      <div class="mkf"><span>${fmtOdd(o.best.price)} · ${pctEs(1 / o.best.price)}</span><button class="add ${added ? 'in' : ''}" data-add="${ai}|${mi}|${a.markets[mi].outcomes.indexOf(o)}">${added ? '✓' : '+'}</button></div></div>`;
  };
  const cells = [];
  if (sp >= 0) for (const o of a.markets[sp].outcomes) cells.push(cell(sp, o, 'Hándicap · ' + (o.name === ev.home_team ? ev.home_abbr : ev.away_abbr)));
  if (to >= 0) for (const o of a.markets[to].outcomes) cells.push(cell(to, o, o.name === 'Over' ? 'Total · Más de' : 'Total · Menos de'));
  // Puntos esperados por equipo a partir del total y el hándicap de la casa
  let tt = '';
  const hs = sp >= 0 ? a.markets[sp].outcomes.find((o) => o.name === ev.home_team)?.point : null;
  const tot = to >= 0 ? a.markets[to].outcomes[0].point : null;
  if (hs != null && tot != null) {
    const home = (tot - hs) / 2, away = (tot + hs) / 2;
    tt = `<div class="card mk"><span class="mut">Puntos esperados · ${esc(ev.away_abbr)}</span><b>${away.toFixed(1).replace('.', ',')}</b></div><div class="card mk"><span class="mut">Puntos esperados · ${esc(ev.home_abbr)}</span><b>${home.toFixed(1).replace('.', ',')}</b></div>`;
  }
  return `<div class="sec"><h4>OTROS MERCADOS</h4><span class="mut tiny">${esc(ev.provider || '')}</span></div><div class="mks">${cells.join('')}${tt}</div>`;
}

// ----- Pestañas de jugadores (NBA) -----
const glogUrl = (path, id) => `https://site.web.api.espn.com/apis/common/v3/sports/${path}/athletes/${id}/gamelog`;
const STATS = {
  PTS: { label: 'Puntos', f: (s) => s.points },
  REB: { label: 'Rebotes', f: (s) => s.totalRebounds },
  AST: { label: 'Asistencias', f: (s) => s.assists },
  '3PM': { label: 'Triples', f: (s) => s.threes },
  PRA: { label: 'Pts+Reb+Ast', f: (s) => s.points + s.totalRebounds + s.assists },
};
// Partidos de temporada regular de un jugador: [{date, oppId, home, min, points, ...}]
function playerGames(path, id) {
  const j = peek('glog', id); if (!j) return j;
  const names = j.names || [];
  const st = (j.seasonTypes || []).find((s) => /regular/i.test(s.displayName)) || (j.seasonTypes || [])[0];
  if (!st) return [];
  const out = [];
  for (const c of st.categories || []) if (c.type === 'event') for (const e of c.events || []) {
    const meta = j.events?.[e.eventId]; if (!meta) continue;
    const v = {}; names.forEach((n, i) => (v[n] = e.stats[i]));
    out.push({ date: meta.gameDate, oppId: meta.opponent?.id, home: meta.atVs !== '@', min: +v.minutes || 0, points: +v.points || 0, totalRebounds: +v.totalRebounds || 0, assists: +v.assists || 0, threes: parseInt(v['threePointFieldGoalsMade-threePointFieldGoalsAttempted']) || 0 });
  }
  return out.filter((g) => g.min > 0).sort((a, b) => new Date(a.date) - new Date(b.date));
}
function playerAvg(path, id, stat) {
  const g = playerGames(path, id); if (!g || !g.length) return null;
  return g.reduce((t, x) => t + STATS[stat].f(x), 0) / g.length;
}
function defRanks(path) {
  const j = need('stand', path, `https://site.api.espn.com/apis/v2/sports/${path}/standings`);
  if (!j) return null;
  const rows = [];
  for (const ch of j.children || []) for (const e of ch.standings?.entries || []) {
    const pa = e.stats?.find((s) => s.name === 'avgPointsAgainst')?.value; if (pa != null) rows.push([e.team.id, pa]);
  }
  rows.sort((a, b) => b[1] - a[1]); // 1.º = la que más puntos permite (mejor para el "Más")
  return Object.fromEntries(rows.map(([id], i) => [String(id), i + 1]));
}
function playersTab(a, side) {
  const ev = a.ev;
  if (isGuest()) return lockCard('Estadísticas de jugadores: % sobre la línea en temporada, H2H, L5, L10, L20 y defensa rival');
  if (!isNBA(ev)) return `<div class="card empty">Las estadísticas de jugadores por ahora están disponibles para la NBA.</div>`;
  const teamId = side === 'home' ? ev.home_id : ev.away_id, oppId = side === 'home' ? ev.away_id : ev.home_id;
  const abbr = side === 'home' ? ev.home_abbr : ev.away_abbr, logo = side === 'home' ? ev.home_logo : ev.away_logo;
  const roster = need('roster', teamId, `${espnBase(ev.path)}/teams/${teamId}/roster`);
  const stat = (S.detail.stat ||= 'PTS');
  const tabs = `<div class="seg wrap" style="margin:14px 0">${Object.entries(STATS).map(([k, v]) => `<button data-stat="${k}" class="${k === stat ? 'on' : ''}">${v.label}</button>`).join('')}</div>`;
  if (!roster) return tabs + `<div class="card empty">${roster === null ? 'Plantilla no disponible.' : 'Cargando plantilla…'}</div>`;
  const athletes = roster.athletes || [];
  athletes.forEach((p) => need('glog', p.id, glogUrl(ev.path, p.id)));
  const ranks = defRanks(ev.path);
  const sum = peek('sum', ev.id);
  const injured = new Map((sum?.injuries || []).flatMap((t) => (t.injuries || []).map((x) => [String(x.athlete?.id), INJ_ES[x.status] || x.status])));
  const loading = athletes.filter((p) => peek('glog', p.id) === undefined).length;
  const rows = athletes.map((p) => {
    const g = playerGames(ev.path, p.id); if (!g || g.length < 3) return null;
    const avgMin = g.reduce((t, x) => t + x.min, 0) / g.length; if (avgMin < 12) return null;
    const vals = g.map((x) => STATS[stat].f(x));
    const avg = vals.reduce((t, x) => t + x, 0) / vals.length;
    const line = Math.max(0.5, Math.round(avg) - 0.5);
    const rate = (arr) => (arr.length ? arr.filter((v) => v > line).length / arr.length : null);
    const h2h = g.filter((x) => String(x.oppId) === String(oppId)).map((x) => STATS[stat].f(x));
    return { p, avg, line, n: g.length, last: vals.slice(-10), season: rate(vals), h2h: rate(h2h), l5: rate(vals.slice(-5)), l10: rate(vals.slice(-10)), l20: rate(vals.slice(-20)), inj: injured.get(String(p.id)) };
  }).filter(Boolean).sort((x, y) => y.avg - x.avg);
  const cls = (r) => (r == null ? '' : r >= 0.6 ? 'good' : r <= 0.4 ? 'bad' : 'warn');
  const rk = ranks?.[String(oppId)];
  const cards = rows.map((r) => `<div class="card pcard">
    <div class="phead"><div class="ph"><img src="https://a.espncdn.com/i/headshots/nba/players/full/${esc(r.p.id)}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">${logo ? `<img class="tl" src="${esc(logo)}" alt="">` : ''}</div>
      <div><b>${esc(r.p.displayName)}</b> <span class="mut tiny">${esc(abbr)} · ${esc(r.p.position?.abbreviation || '')}</span>${r.inj ? ` <span class="chip ${r.inj === 'Baja' ? 'bad' : 'warn'}">${esc(r.inj)}</span>` : ''}
        <div><span class="acc">Más</span> ${String(r.line).replace('.', ',')} ${STATS[stat].label} <span class="mut tiny">· media ${r.avg.toFixed(1).replace('.', ',')} en ${r.n} partidos</span></div></div>
      <div class="pq"><span class="mut tiny">CUOTA</span><b>–</b></div><div class="pq"><span class="mut tiny">VALOR</span><b>–</b></div></div>
    <div class="rates">
      <div><span>Temporada</span><b class="${cls(r.season)}">${pctEs(r.season)}</b></div>
      <div><span>H2H</span><b class="${cls(r.h2h)}">${pctEs(r.h2h)}</b></div>
      <div><span>Def. rival</span><b class="${rk == null ? '' : rk <= 10 ? 'good' : rk >= 21 ? 'bad' : 'warn'}">${rk ? rk + '.º' : '–'}</b></div>
      <div><span>L5</span><b class="${cls(r.l5)}">${pctEs(r.l5)}</b></div>
      <div class="sel"><span>L10</span><b class="${cls(r.l10)}">${pctEs(r.l10)}</b></div>
      <div><span>L20</span><b class="${cls(r.l20)}">${pctEs(r.l20)}</b></div>
    </div>
    <div class="spark">${r.last.map((v) => `<i class="${v > r.line ? 'win' : 'loss'}" style="height:${Math.max(6, (v / Math.max(...r.last, r.line * 1.3)) * 100)}%" title="${v}"></i>`).join('')}<em style="bottom:${(r.line / Math.max(...r.last, r.line * 1.3)) * 100}%"></em></div>
  </div>`).join('');
  return tabs + `<p class="mut tiny" style="margin-bottom:10px">% = partidos en los que superó la línea. La línea es la media del jugador (ESPN no publica cuotas de jugadores; con The Odds API se podrían añadir). “Def. rival”: puesto del rival en puntos permitidos (1.º = la peor defensa).${loading ? ` Cargando ${loading} jugadores…` : ''}</p>` + (cards || `<div class="card empty">${loading ? 'Cargando jugadores…' : 'Sin datos de jugadores.'}</div>`);
}

// ---------- Eventos ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button,[data-open]');
  if (!t) return;
  if (t.id === 'googleBtn') return googleLogin();
  if (t.dataset.auth) return setAuthMode(t.dataset.auth);
  if (t.dataset.act === 'account') return isGuest() ? showLogin('signup') : (S.detail && (location.hash = ''), document.querySelector('[data-tab=perfil]').click());
  if (t.dataset.act === 'signup' || t.dataset.act === 'login') return showLogin(t.dataset.act);
  if (t.dataset.act === 'guest') return hideLogin();
  if (t.dataset.act === 'reset') return resetPassword();
  if (t.id === 'themeBtn') { const th = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = th; return store.set('theme', th); }
  if (t.dataset.liga) {
    S.liga = t.dataset.liga; store.set('liga', S.liga);
    document.querySelectorAll('#leagues button').forEach((b) => b.classList.toggle('on', b === t));
    if (S.user) load(); return;
  }
  if (t.dataset.tab) {
    S.tab = t.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b === t));
    window.scrollTo(0, 0); return render();
  }
  if (t.dataset.add) {
    e.stopPropagation();
    const [ai, mi, oi] = t.dataset.add.split('|').map(Number);
    const a = S.analysis[ai]; toggleSlip(a, a.markets[mi], a.markets[mi].outcomes[oi]);
    return;
  }
  if (t.dataset.del != null) { const s = getSlip(); s.splice(+t.dataset.del, 1); setSlip(s); return render(); }
  if (t.dataset.open != null) { location.hash = '#p/' + t.dataset.open; return; }
  if (t.dataset.dtab) { S.detail.tab = t.dataset.dtab; return render(); }
  if (t.dataset.hist) { const [k, v] = t.dataset.hist.split(':'); S.detail.hist[k] = isNaN(+v) ? v : +v; return render(); }
  if (t.dataset.stat) { S.detail.stat = t.dataset.stat; return render(); }
  const act = t.dataset.act;
  if (act === 'back') { if (history.length > 1 && location.hash) history.back(); else location.hash = ''; return; }
  if (act === 'reload') load();
  if (act === 'logout') logout();
  if (act === 'clear') { setSlip([]); render(); }
});
$('#authForm').addEventListener('submit', submitAuth);
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'liveChk') { S.live = t.checked; store.set('live', S.live); schedule(); renderStatus(); }
  if (t.id === 'fmtSel') { S.fmt = t.value; store.set('fmt', S.fmt); render(); }
  if (t.id === 'fcSel') { S.fc = t.value; store.set('fc', S.fc); load(); }
  if (t.id === 'bankIn') store.set('bank:' + S.user.uid, +t.value || 0);
  if (t.dataset.stake != null) { const s = getSlip(); s[+t.dataset.stake].stake = +t.value || 0; setSlip(s); render(); }
});

// ---------- Partidos reales vía ESPN (sin API key) ----------
// Partidos de hoy y próximos días, marcadores en vivo y cuotas de DraftKings (solo para comparar).
const amToDec = (s) => {
  if (s == null) return null;
  const t = String(s).trim().toUpperCase();
  if (t === 'EVEN' || t === 'EV') return 2;
  const a = parseFloat(t); if (!isFinite(a) || a === 0) return null;
  return Math.round((a > 0 ? 1 + a / 100 : 1 + 100 / -a) * 100) / 100;
};
const recs = (c) => {
  const r = {}; for (const x of c.records || []) r[x.type] = x.summary; return r; // total, home, road
};
async function fetchEspn() {
  const sk = sportKey(), path = ESPN[sk];
  const days = sk.startsWith('soccer') || sk.includes('nfl') ? 7 : 3;
  const dates = Array.from({ length: days }, (_, i) => limaDay(Date.now() + i * 864e5).replace(/-/g, ''));
  const base = `https://site.api.espn.com/apis/site/v2/sports/${path}`;
  const pages = await Promise.all(dates.map((d) => fetch(`${base}/scoreboard?dates=${d}`).then((r) => (r.ok ? r.json() : { events: [] })).catch(() => ({ events: [] }))));
  const seen = new Set(), raw = [];
  for (const p of pages) for (const e of p.events || []) if (!seen.has(e.id)) { seen.add(e.id); raw.push(e); }
  if (!raw.length && pages.every((p) => !p.events)) throw new Error('No se pudo conectar con ESPN');

  return raw.map((e) => {
    const c = e.competitions[0];
    const home = c.competitors.find((x) => x.homeAway === 'home'), away = c.competitors.find((x) => x.homeAway === 'away');
    const H = home.team.displayName, A = away.team.displayName;
    const o = (c.odds || [])[0];
    const cur = (x) => x?.close?.odds ?? x?.current?.odds ?? x?.open?.odds;
    const markets = [], lines = {};
    if (o) {
      const mh = amToDec(cur(o.moneyline?.home)), ma = amToDec(cur(o.moneyline?.away)), md = amToDec(o.drawOdds?.moneyLine);
      if (mh && ma) { markets.push({ key: 'h2h', outcomes: [{ name: H, price: mh }, { name: A, price: ma }, ...(md ? [{ name: 'Draw', price: md }] : [])] }); Object.assign(lines, { mlHome: mh, mlAway: ma, mlDraw: md }); }
      const ov = o.total?.over?.close || o.total?.over?.open, un = o.total?.under?.close || o.total?.under?.open;
      const line = parseFloat(String(ov?.line ?? o.overUnder ?? '').replace(/^[ou]/i, ''));
      if (ov && un && isFinite(line) && amToDec(ov.odds) && amToDec(un.odds)) { markets.push({ key: 'totals', outcomes: [{ name: 'Over', point: line, price: amToDec(ov.odds) }, { name: 'Under', point: line, price: amToDec(un.odds) }] }); Object.assign(lines, { total: line, overPrice: amToDec(ov.odds), underPrice: amToDec(un.odds) }); }
      else if (isFinite(+o.overUnder)) lines.total = +o.overUnder;
      const sh = o.pointSpread?.home?.close || o.pointSpread?.home?.open, sa = o.pointSpread?.away?.close || o.pointSpread?.away?.open;
      if (sh && sa && amToDec(sh.odds) && amToDec(sa.odds)) { markets.push({ key: 'spreads', outcomes: [{ name: H, point: parseFloat(sh.line), price: amToDec(sh.odds) }, { name: A, point: parseFloat(sa.line), price: amToDec(sa.odds) }] }); Object.assign(lines, { spreadHome: parseFloat(sh.line), spreadHomePrice: amToDec(sh.odds), spreadAwayPrice: amToDec(sa.odds) }); }
    }
    return {
      id: e.id, sport_key: sk, commence_time: e.date, home_team: H, away_team: A,
      home_logo: home.team.logo, away_logo: away.team.logo,
      path, home_id: String(home.team.id), away_id: String(away.team.id), neutral: !!c.neutralSite,
      home_abbr: home.team.abbreviation || H.slice(0, 3).toUpperCase(), away_abbr: away.team.abbreviation || A.slice(0, 3).toUpperCase(),
      home_rec: recs(home), away_rec: recs(away),
      total: lines.total ?? null, lines,
      state: e.status.type.state, detail: e.status.type.shortDetail, clock: e.status.displayClock,
      score: e.status.type.state === 'pre' ? null : [away.score, home.score],
      pred: S.events.find((x) => x.id === e.id)?.pred, // se mantiene mientras se recalcula
      provider: o?.provider?.name || 'DraftKings',
      bookmakers: markets.length ? [{ key: 'draftkings', title: o?.provider?.name || 'DraftKings', markets }] : [],
    };
  }).sort((a, b) => (a.state === 'post') - (b.state === 'post') || new Date(a.commence_time) - new Date(b.commence_time));
}

// Navegación: #p/<id> abre la página del partido; el botón atrás del navegador vuelve
function route() {
  const m = location.hash.match(/^#p\/(.+)$/);
  S.detail = m ? { id: decodeURIComponent(m[1]), tab: 'partido', hist: { team: 'home', n: 10, side: 'all' } } : null;
  window.scrollTo(0, 0);
  if (S.user) render();
}
window.addEventListener('hashchange', route);

// ---------- Inicio ----------
route();
document.querySelectorAll('#leagues button').forEach((b) => b.classList.toggle('on', b.dataset.liga === S.liga));
initAuth();
