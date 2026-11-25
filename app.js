// ALTOQ · login con Google (Firebase), cuotas en tiempo real (The Odds API) y detector de valor (EV+).
import { modelFor, pendingReason, summaryFor, logPrediction, settleResults, registryStats } from './model.js?v=9';
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
  soccer_argentina_primera_division: 'Liga Argentina', soccer_peru_liga1: 'Liga 1 Perú', soccer_uefa_champs_league: 'Champions League', soccer_uefa_europa_league: 'Europa League',
  soccer_uefa_europa_conference_league: 'Conference League',
};
// Ruta equivalente en ESPN (partidos reales, marcadores y cuotas DraftKings sin API key)
const ESPN = {
  basketball_nba: 'basketball/nba', americanfootball_nfl: 'football/nfl',
  soccer_epl: 'soccer/eng.1', soccer_spain_la_liga: 'soccer/esp.1', soccer_italy_serie_a: 'soccer/ita.1',
  soccer_germany_bundesliga: 'soccer/ger.1', soccer_france_ligue_one: 'soccer/fra.1', soccer_brazil_campeonato: 'soccer/bra.1',
  soccer_argentina_primera_division: 'soccer/arg.1', soccer_peru_liga1: 'soccer/per.1', soccer_uefa_champs_league: 'soccer/uefa.champions', soccer_uefa_europa_league: 'soccer/uefa.europa',
  soccer_uefa_europa_conference_league: 'soccer/uefa.europa.conf',
};
const HAS_FIREBASE = !!(CFG.firebase && CFG.firebase.apiKey);
const HAS_ODDS = !!CFG.oddsApiKey;

const S = {
  liga: store.get('liga', 'nba'),
  fc: FC_LEAGUES[store.get('fc', 'all')] ? store.get('fc', 'all') : 'all', // 'all' = todas las ligas y copas
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
const sportKey = () => ({ nba: 'basketball_nba', nfl: 'americanfootball_nfl', fc: 'soccer' }[S.liga]);
// En fútbol se cargan todas las ligas y copas a la vez; las fichas de arriba solo filtran
const leagueKeys = () => (S.liga === 'fc' ? Object.keys(FC_LEAGUES) : [sportKey()]);
const FC_SHORT = { soccer_epl: 'Premier', soccer_spain_la_liga: 'LaLiga', soccer_italy_serie_a: 'Serie A', soccer_germany_bundesliga: 'Bundesliga', soccer_france_ligue_one: 'Ligue 1', soccer_brazil_campeonato: 'Brasileirão', soccer_argentina_primera_division: 'Argentina', soccer_peru_liga1: 'Liga 1', soccer_uefa_champs_league: 'Champions', soccer_uefa_europa_league: 'Europa League', soccer_uefa_europa_conference_league: 'Conference' };
const fcVisible = (a) => S.liga !== 'fc' || S.fc === 'all' || a.ev.sport_key === S.fc;

// ---------- Formato ----------
const fmtOdd = (d) => {
  if (d == null || !isFinite(d)) return 'N/D';
  return d.toFixed(2).replace('.', ','); // siempre decimal: 1,20 · 1,85 · 3,40
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
  const paths = [...new Set(S.analysis.map((a) => a.ev.path).filter(Boolean))];
  const want = S.liga === 'fc' && S.fc !== 'all' ? ESPN[S.fc] : null;
  paths.sort((x, y) => (y === want) - (x === want)); // primero la liga que estás viendo
  const known = paths.filter((p) => modelFor(p));
  if (!known.length) { S.modelStatus = paths.length === 1 ? pendingReason(paths[0]) : null; render(); return; }
  const errs = [];
  for (const [i, path] of known.entries()) {
    const mdl = modelFor(path);
    S.modelStatus = `Calculando el modelo ${mdl.name}${known.length > 1 ? ` (${i + 1}/${known.length})` : ''}…`; render();
    try {
      const M = await mdl.fit();
      if (token !== S.loadToken) return;
      if (M.games) settleResults(M.games);
      // Primero el día que estás viendo; se repinta cada pocos partidos para no esperar a toda la semana
      const order = S.analysis.filter((a) => a.ev.path === path).sort((x, y) => (nightKey(x.ev.commence_time) === S.calDay ? 0 : 1) - (nightKey(y.ev.commence_time) === S.calDay ? 0 : 1));
      let done = 0;
      for (const a of order) {
        if (++done % 6 === 0) render();
        const ev = a.ev;
        const sum = path.startsWith('soccer') ? null : await summaryFor(ev.path, ev.id); // en fútbol el modelo no usa el resumen
        const injuries = (teamId) => (sum?.injuries || []).find((t) => String(t.team?.id) === String(teamId))?.injuries || [];
        const leaders = (teamId) => {
          const t = (sum?.leaders || []).find((x) => String(x.team?.id) === String(teamId));
          const id = (n) => String(t?.leaders?.find((l) => l.name === n)?.leaders?.[0]?.athlete?.id || '');
          return { pass: id('passingYards'), rush: id('rushingYards'), rec: id('receivingYards') };
        };
        try { ev.pred = await mdl.predict(M, ev, { injuries, leaders, lines: ev.lines || {} }); } catch { ev.pred = null; }
        if (token !== S.loadToken) return;
        if (ev.pred) logPrediction(ev, ev.pred);
      }
    } catch (e) { errs.push(mdl.name + ': ' + e.message); }
  }
  S.modelStatus = errs.length ? 'No se pudo calcular el modelo: ' + errs.join(' · ') : null;
  if (token === S.loadToken) render();
}async function fetchOdds() {
  const all = await Promise.all(leagueKeys().map(fetchOddsKey));
  return all.flat().sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
}
async function fetchOddsKey(key) {
  const u = new URL(`https://api.the-odds-api.com/v4/sports/${key}/odds`);
  u.search = new URLSearchParams({ apiKey: CFG.oddsApiKey, regions: CFG.regions || 'eu', markets: CFG.markets || 'h2h', oddsFormat: 'decimal' });
  const r = await fetch(u);
  S.remaining = r.headers.get('x-requests-remaining');
  if (!r.ok) throw new Error(r.status === 401 ? 'API key inválida o sin créditos' : 'Error ' + r.status + ' al pedir cuotas');
  const data = await r.json();
  return data.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
}
function schedule() {
  clearInterval(S.timer); clearInterval(S.fastTimer);
  if (!S.live) return;
  // Recarga completa (partidos de la semana y modelo) cada 2 min; sin pestaña visible no se pide nada
  S.timer = setInterval(() => { if (!document.hidden) load(); }, Math.max(30, CFG.refreshSeconds || 120) * 1000);
  // Directo: cada 10 s solo el marcador de las ligas que tienen partidos en juego
  S.fastTimer = setInterval(() => { if (!document.hidden) fastLive(); }, LIVE_MS);
}
const LIVE_MS = 10000;
const bust = (u) => u + (u.includes('?') ? '&' : '?') + '_=' + Date.now(); // evita respuestas guardadas por el navegador
// Partidos que están (o deberían estar) en juego ahora
const liveNow = () => S.events.filter((e) => e.path && (e.state === 'in' || (e.state === 'pre' && new Date(e.commence_time) <= new Date())));
async function fastLive() {
  if (S.fastBusy) return;
  const live = liveNow(); if (!live.length) return;
  S.fastBusy = true;
  try {
    const paths = [...new Set(live.map((e) => e.path))];
    const dates = [...new Set([limaDay(Date.now()), nightKey(Date.now())])].map((d) => d.replace(/-/g, ''));
    const pages = await Promise.all(paths.flatMap((p) => dates.map((d) => getJ(bust(`https://site.api.espn.com/apis/site/v2/sports/${p}/scoreboard?dates=${d}`)))));
    let changed = false;
    for (const pg of pages) for (const e of pg?.events || []) {
      const ev = S.events.find((x) => x.id === e.id); if (!ev) continue;
      const c = e.competitions?.[0], home = c?.competitors?.find((x) => x.homeAway === 'home'), away = c?.competitors?.find((x) => x.homeAway === 'away');
      const st = e.status?.type?.state, score = st === 'pre' ? null : [away?.score, home?.score];
      if (st !== ev.state || e.status?.displayClock !== ev.clock || JSON.stringify(score) !== JSON.stringify(ev.score)) {
        Object.assign(ev, { state: st, detail: e.status?.type?.shortDetail, clock: e.status?.displayClock, score }); changed = true;
      }
    }
    if (changed && !document.activeElement?.matches?.('input, select')) render();
  } finally { S.fastBusy = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user) fastLive(); });

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
    void soccer;
    // Sin importe por defecto: lo pones tú al registrar la apuesta
    s.push({ id, game: matchName(a.ev, true), time: a.ev.commence_time, market: MKT[m.market], pick: o.label, price: o.best.price, book: o.best.book, pModel,
      path: a.ev.path, eventId: a.ev.id, mk: m.market, oname: o.name, point: o.point, homeName: a.ev.home_team });
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
  v.innerHTML = { hoy: viewHoy, props: viewProps, valor: viewValor, boleto: viewBoleto, perfil: viewPerfil }[S.tab]();
}
function renderStatus() {
  const fc = '';
  $('#status').innerHTML = `
    <div class="toolbar">
      <span class="pill">Datos ESPN · cuotas ${HAS_ODDS ? 'The Odds API' : 'DraftKings'}</span>
      <label class="pill switch ${S.live ? 'live' : ''}"><input type="checkbox" id="liveChk" ${S.live ? 'checked' : ''} hidden><span class="dot"></span>${S.live ? 'En vivo' : 'Pausado'}</label>
      ${fc}
    </div>
    <div class="toolbar">
      <span>${S.updated ? 'Actualizado ' + S.updated.toLocaleTimeString('es-PE', { timeZone: TZ }) + ' (Lima)' : 'Cargando…'}${S.remaining != null ? ' · ' + S.remaining + ' peticiones' : ''}</span>
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
// Calendario por "noche": un partido de madrugada (antes de las 6:00 Lima) cuenta en la noche del día anterior
const nightKey = (t) => limaDay(new Date(t).getTime() - 6 * 36e5);
const keyDate = (k) => new Date(k + 'T12:00:00-05:00');
const wd = (k, f) => keyDate(k).toLocaleDateString('es-PE', { weekday: f, timeZone: TZ }).replace('.', '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dnum = (k) => +k.slice(8);
const monthOf = (k) => keyDate(k).toLocaleDateString('es-PE', { month: 'long', timeZone: TZ }).toLowerCase();
function calDays() {
  const today = nightKey(Date.now());
  return Array.from({ length: 7 }, (_, i) => limaDay(keyDate(today).getTime() + i * 864e5));
}
// Fútbol: próximos 7 días de todas nuestras ligas y copas, con fichas para filtrar
function viewFutbol() {
  const leagues = Object.keys(FC_LEAGUES).filter((k) => S.analysis.some((a) => a.ev.sport_key === k));
  if (S.fc !== 'all' && !leagues.includes(S.fc) && S.analysis.length) S.fc = 'all';
  const chip = (k, lab) => `<button class="lchip ${S.fc === k ? 'on' : ''}" data-fcf="${k}">${esc(lab)}</button>`;
  const list = S.analysis.filter(fcVisible);
  const upcoming = list.filter((a) => a.ev.state !== 'post');
  const first = upcoming.map((a) => a.ev.commence_time).sort()[0];
  const firstTxt = first ? new Date(first).toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }).replace(/\./g, '') + ' ' + fmtTime(first) : '–';
  const nVal = allPicks().length;
  let html = `<div class="calhead"><span class="calsub">Próximos 7 días</span><h2>Próximos partidos</h2></div>
    <div class="lchips">${chip('all', 'Todas')}${leagues.map((k) => chip(k, FC_SHORT[k] || FC_LEAGUES[k])).join('')}</div>
    <div class="calk"><div class="card"><b>${upcoming.length}</b><span>partido${upcoming.length === 1 ? '' : 's'}</span></div>
    <div class="card"><b>${firstTxt}</b><span>primer partido</span></div>
    <div class="card"><b class="acc">${S.modelStatus && !S.modelStatus.startsWith('No se') ? '…' : nVal}</b><span>apuestas con valor</span></div></div>`;
  if (!list.length) return html + `<div class="card empty">${S.updated ? 'No hay partidos en los próximos 7 días.' : 'Cargando partidos…'}</div>`;
  let lastDay = '';
  for (const a of list) {
    const ev = a.ev, day = fmtDay(ev.commence_time);
    if (day !== lastDay) { html += `${lastDay ? '</div>' : ''}<div class="day">${day}</div><div class="grid">`; lastDay = day; }
    html += matchCard(a, S.fc === 'all' ? FC_SHORT[ev.sport_key] : '');
  }
  return html + '</div>';
}
function matchCard(a, tag) {
  const ev = a.ev;
  return `<div class="card mcard ${ev.state === 'post' ? 'done' : ''}" data-open="${esc(ev.id)}">${tag ? `<span class="ltag">${esc(tag)}</span>` : ''}
      <div class="mrow">${ord(ev, teamBlock(ev.away_logo, ev.away_abbr || ev.away_team, ev.away_rec), teamBlock(ev.home_logo, ev.home_abbr || ev.home_team, ev.home_rec)).join(centerBlock(ev))}</div>
      ${probBar(probsOf(a), ev)}
    </div>`;
}
function viewHoy() {
  if (S.liga === 'fc') return viewFutbol();
  const days = calDays(), today = days[0];
  const byDay = (k) => S.analysis.filter((a) => nightKey(a.ev.commence_time) === k);
  if (S.calLiga !== sportKey()) { S.calLiga = sportKey(); S.calDay = null; }
  if (!days.includes(S.calDay)) S.calDay = days.find((k) => byDay(k).some((a) => a.ev.state !== 'post')) || today;
  const k = S.calDay, list = byDay(k);
  const next = limaDay(keyDate(k).getTime() + 864e5);
  const crosses = list.some((a) => limaDay(a.ev.commence_time) !== k);
  const title = crosses ? `Noche del ${wd(k, 'long')} ${dnum(k)}${monthOf(k) !== monthOf(next) ? ' de ' + monthOf(k) : ''} al ${wd(next, 'long')} ${dnum(next)} de ${monthOf(next)}`
    : `${cap(wd(k, 'long'))} ${dnum(k)} de ${monthOf(k)}`;
  const chips = days.map((d) => { const n = byDay(d).length; return `<button class="calday ${d === k ? 'on' : ''} ${n ? '' : 'none'}" data-calday="${d}"><span>${d === today ? 'Hoy' : cap(wd(d, 'short'))}</span><b>${dnum(d)}</b></button>`; }).join('');
  const first = list.map((a) => a.ev.commence_time).sort()[0];
  const withOdds = list.filter((a) => a.ev.lines?.mlHome || a.markets?.length).length;
  const startLab = S.liga === 'nba' ? 'primer salto' : S.liga === 'nfl' ? 'primer kickoff' : 'primer partido';
  const kpis = `<div class="calk"><div class="card"><b>${list.length}</b><span>partido${list.length === 1 ? '' : 's'}</span></div>
    <div class="card"><b>${first ? fmtTime(first) : '–'}</b><span>${startLab}</span></div>
    <div class="card"><b>${withOdds ? withOdds : '–'}</b><span>${withOdds ? 'con cuotas de la casa' : 'cuotas y props: el mismo día'}</span></div></div>`;
  let html = `<div class="calhead"><span class="calsub">${esc(cap(title))}</span><h2>Calendario</h2></div><div class="caldays">${chips}</div>${kpis}`;
  if (!list.length) return html + `<div class="card empty">No hay partidos ${k === today ? 'hoy' : 'este día'} en esta liga.</div>`;
  html += '<div class="grid">';
  for (const a of list) {
    const ev = a.ev;
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
    const ev = a.ev, pr = ev.pred; if (!pr || ev.state !== 'pre' || !fcVisible(a)) continue;
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
// ---------- Boleto: combinada o sencillas, y apuestas registradas ----------
const betsKey = () => 'bets:' + (S.user?.uid || 'anon');
const getBets = () => store.get(betsKey(), []);
const setBets = (b) => store.set(betsKey(), b);
const parseOdd = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) && n > 1 ? n : null; };
const prod = (arr) => arr.reduce((t, x) => t * x, 1);
function viewBoleto() {
  const s = getSlip(), mode = (S.slipMode ||= 'combo');
  const legs = s.map((x, i) => `<div class="leg">
      <div><b>${esc(x.pick)}</b><div class="mut tiny">${esc(x.game)} · ${esc(x.market)}</div>
        <div class="mut tiny">${x.pModel != null ? `modelo ${pctEs(x.pModel)}` : 'sin prob. del modelo'} · ${x.price ? `cuota ${fmtOdd(x.price)}${x.book ? ' (' + esc(x.book) + ')' : ''}` : 'sin cuota'}</div></div>
      <label class="legodd"><span class="mut tiny">Cuota</span><input inputmode="decimal" placeholder="—" value="${x.price ? String(x.price).replace('.', ',') : ''}" data-legodd="${i}"></label>
      ${mode === 'single' ? `<label class="legodd"><span class="mut tiny">Importe</span><input inputmode="decimal" placeholder="0" value="${x.stake || ''}" data-legstake="${i}"></label>` : ''}
      <button class="x" data-del="${i}" aria-label="Quitar">×</button></div>`).join('');
  let slipHtml;
  if (!s.length) slipHtml = `<div class="card empty">Tu boleto está vacío. Agrega selecciones desde “Props”, “Picks” o la página de un partido.</div>`;
  else {
    const ps = s.map((x) => x.pModel), allP = ps.every((p) => p != null), p = allP ? prod(ps) : null;
    const odds = s.map((x) => x.price), allO = odds.every((o) => o), combo = allO ? prod(odds) : null;
    const sameGame = new Set(s.map((x) => x.eventId || x.game)).size < s.length;
    const evv = p != null && combo ? p * combo - 1 : null;
    const comboBox = mode === 'combo' && s.length > 1 ? `
      <div class="kpis">
        <div class="card"><span>Probabilidad estimada</span><b>${p != null ? pctEs(p) : '—'}</b></div>
        <div class="card"><span>Cuota justa</span><b>${p ? fmtOdd(1 / p) : '—'}</b></div>
        <div class="card"><span>Cuota combinada</span><b>${combo ? fmtOdd(combo) : '—'}</b></div>
        <div class="card"><span>Valor</span><b class="${evv == null ? 'mut' : evv > 0 ? 'good' : 'bad'}">${evv == null ? (allO ? 'Falta alguna probabilidad' : 'Falta alguna cuota') : signed((evv * 100).toFixed(1)) + ' %'}</b></div>
      </div>
      <p class="mut tiny">Multiplica las probabilidades como si fueran independientes.${sameGame ? ' <b class="warn">Ojo: hay selecciones del mismo partido; suelen estar relacionadas y la probabilidad real puede ser distinta.</b>' : ''}</p>` : '';
    const reg = mode === 'combo' && s.length > 1 ? `
      <div class="card regbox"><h4>¿LA HAS JUGADO? REGÍSTRALA</h4>
        <div class="regrow"><label>Importe<input id="regStake" inputmode="decimal" placeholder="0" value="${S.regStake || ''}"></label>
          <label>Cuota que te dieron<input id="regOdds" inputmode="decimal" placeholder="${combo ? String(combo.toFixed(2)).replace('.', ',') : '—'}" value="${S.regOdds || ''}"></label></div>
        <div class="regfoot"><span class="mut">Cobras <b class="acc">${(() => { const st = parseOdd(S.regStake) || +String(S.regStake || '').replace(',', '.') || 0, od = parseOdd(S.regOdds) || combo; return st && od ? money(st * od) : '–'; })()}</b></span>
          <button class="btn google" data-act="regcombo">Registrar combinada</button></div>
        <p class="mut tiny">Se guarda en «Mis apuestas» y la sigues en directo durante el partido.</p></div>`
      : `<div class="card regbox"><h4>¿LAS HAS JUGADO? REGÍSTRALAS</h4><p class="mut tiny">Pon el importe en cada selección (y la cuota que te dieron) y regístralas como apuestas sencillas.</p>
        <div class="regfoot"><span class="mut">Total apostado <b class="acc">${money(s.reduce((t, x) => t + (+String(x.stake || 0).replace(',', '.') || 0), 0))}</b></span><button class="btn google" data-act="regsingles">Registrar sencillas</button></div></div>`;
    slipHtml = `<div class="card legs">${legs}</div>${comboBox}${reg}
      <div class="slipacts"><button class="linkbtn" data-act="clear">Vaciar boleto</button></div>`;
  }
  const modeSeg = s.length > 1 ? `<div class="seg"><button data-slipmode="combo" class="${mode === 'combo' ? 'on' : ''}">Combinada</button><button data-slipmode="single" class="${mode === 'single' ? 'on' : ''}">Sencillas</button></div>` : '';
  return `<div class="bhead"><div><h2 style="margin:0">Boleto</h2><span class="mut">${s.length} selecci${s.length === 1 ? 'ón' : 'ones'}${s.length > 1 ? ' · ' + (mode === 'combo' ? 'combinada' : 'sencillas') : ''}</span></div>${modeSeg}</div>
    ${slipHtml}${viewBets()}`;
}
function registerBet(type) {
  const s = getSlip(); if (!s.length) return;
  const bets = getBets();
  if (type === 'combo') {
    const stake = +String(S.regStake || '').replace(',', '.') || 0;
    const odds = parseOdd(S.regOdds) || (s.every((x) => x.price) ? Math.round(prod(s.map((x) => x.price)) * 100) / 100 : null);
    if (!stake) { alert('Pon el importe que apostaste.'); return; }
    bets.unshift({ id: 'b' + Date.now(), date: Date.now(), type: 'combo', legs: s, stake, odds });
  } else {
    const legs = s.filter((x) => +String(x.stake || '').replace(',', '.') > 0);
    if (!legs.length) { alert('Pon el importe en al menos una selección.'); return; }
    for (const x of legs) bets.unshift({ id: 'b' + Date.now() + Math.random().toString(36).slice(2, 6), date: Date.now(), type: 'single', legs: [x], stake: +String(x.stake).replace(',', '.'), odds: x.price || null });
  }
  setBets(bets); setSlip([]); S.regStake = S.regOdds = ''; render();
}

// Estado en vivo de una selección de partido (ganador, hándicap, total, ambos marcan, 1.er tiempo o estadística)
function gameLegLive(it) {
  if (!it.eventId || !it.path) return null;
  const sum = liveSum(it);
  if (!sum) return sum;
  const comp = sum.header?.competitions?.[0]; const st = comp?.status || {}; let state = st.type?.state || 'pre';
  const cs = comp?.competitors || [];
  const H = cs.find((c) => c.homeAway === 'home'), A = cs.find((c) => c.homeAway === 'away');
  const hs = +H?.score || 0, as = +A?.score || 0;
  const sel = it.sel || (it.oname === 'Draw' ? 'draw' : it.oname === it.homeName ? 'home' : it.mk === 'totals' ? (it.oname === 'Over' ? 'over' : 'under') : 'away');
  const ou = (v) => (sel === 'over' ? v > it.point : v < it.point);
  let ok = null, extra = '';
  if (it.mk === 'h2h') ok = sel === 'draw' ? hs === as : sel === 'home' ? hs > as : as > hs;
  else if (it.mk === 'totals') ok = ou(hs + as);
  else if (it.mk === 'spreads') ok = sel === 'home' ? hs + it.point > as : as + it.point > hs;
  else if (it.mk === 'btts') ok = (hs > 0 && as > 0) === (sel === 'yes');
  else if (it.mk === 'ht1x2' || it.mk === 'httotals') {
    const h1 = +H?.linescores?.[0]?.displayValue || 0, a1 = +A?.linescores?.[0]?.displayValue || 0;
    ok = it.mk === 'httotals' ? ou(h1 + a1) : sel === 'draw' ? h1 === a1 : sel === 'home' ? h1 > a1 : a1 > h1;
    if (state === 'in' && (st.period || 0) >= 2) state = 'post'; // el 1.er tiempo ya terminó
    extra = `1.er tiempo ${h1}-${a1}`;
  } else if (it.mk === 'stat') {
    const t = sum.boxscore?.teams || [];
    const val = (c) => +((t.find((x) => String(x.team?.id) === String(c?.team?.id || c?.id))?.statistics || []).find((s) => s.name === it.sname)?.displayValue) || 0;
    const v = it.team === 'home' ? val(H) : it.team === 'away' ? val(A) : val(H) + val(A);
    ok = ou(v); extra = `${v} ${TSTAT[it.sname]?.short || ''}`;
  }
  const soccer = it.path.startsWith('soccer');
  const score = soccer ? `${H?.team?.abbreviation || ''} ${hs} – ${as} ${A?.team?.abbreviation || ''}` : `${A?.team?.abbreviation || ''} ${as} – ${hs} ${H?.team?.abbreviation || ''}`;
  return { state, detail: st.type?.shortDetail || '', score: extra ? `${extra} · ${score}` : score, ok, p: state === 'post' ? (ok ? 1 : 0) : state === 'pre' ? it.pModel : null };
}
// Probabilidad en vivo de una apuesta de jugador (misma lógica que el seguimiento)
function propLiveP(it) {
  const L = liveStat(it); if (!L) return { state: L === undefined ? 'loading' : 'na', p: null };
  if (L.state === 'pre') return { state: 'pre', p: it.pModel };
  if (!L.found) return { state: L.state, p: null };
  const cur = L.cur ?? 0;
  let remFrac = L.state === 'post' ? 0 : 1 - L.elapsed;
  if (!it.path.startsWith('soccer') && it.avgMin && L.min != null && L.state !== 'post') remFrac = Math.max(0, Math.min(remFrac * 1.15, (it.avgMin - L.min) / it.avgMin));
  if (it.path.startsWith('soccer') && L.subbedOut) remFrac = 0;
  const lam = Math.max(it.proj * remFrac, 1e-6);
  const k = it.side === 'under' ? Math.ceil(it.line) - 1 - cur : Math.floor(it.line) - cur;
  const cdf = (x) => (x < 0 ? 0 : poissonCdf(x, lam));
  const p = L.state === 'post' ? (it.side === 'under' ? (cur < it.line ? 1 : 0) : (cur > it.line ? 1 : 0)) : it.side === 'under' ? cdf(k) : 1 - cdf(k);
  return { state: L.state, p };
}
function legLiveHtml(it) {
  if (it.pid) return trackBox(it);
  const g = gameLegLive(it);
  if (g === undefined) return `<div class="track mut tiny">Cargando…</div>`;
  if (!g) return '';
  if (g.state === 'pre') return `<div class="track"><span class="mut tiny">Aún no empieza${it.pModel != null ? ` · modelo ${pctEs(it.pModel)}` : ''}</span></div>`;
  const cls = g.state === 'post' ? (g.ok ? 'ok' : 'bad') : g.ok ? 'ok' : 'warn';
  const txt = g.state === 'post' ? (g.ok ? 'Ganada' : 'Perdida') : g.ok ? 'Va ganando' : 'Va perdiendo';
  return `<div class="track ${cls}"><div class="trow"><span class="chip ${cls === 'ok' ? 'okc' : cls}">${txt}</span><span><b>${esc(g.score)}</b> · ${esc(g.detail)}</span></div></div>`;
}
// Estado de una apuesta registrada. Cuando se decide (ganada/perdida) se guarda en el registro para el perfil.
function betState(b) {
  if (b.result) return { live: b.legs.map(() => ({ state: 'post', p: b.result === 'won' ? 1 : 0 })), lost: b.result === 'lost', won: b.result === 'won', pNow: null };
  const live = b.legs.map((it) => (it.pid ? propLiveP(it) : (gameLegLive(it) || { state: 'loading', p: null })));
  const lost = live.some((l) => l.state === 'post' && l.p === 0), won = live.every((l) => l.state === 'post' && l.p === 1);
  const allP = live.every((l) => l.p != null), pNow = allP ? prod(live.map((l) => l.p)) : null;
  if (lost || won) {
    const all = getBets(), x = all.find((y) => y.id === b.id);
    if (x && !x.result) { x.result = won ? 'won' : 'lost'; x.settled = Date.now(); setBets(all); }
  }
  return { live, lost, won, pNow };
}
function betStats() {
  const bets = getBets(); let staked = 0, ret = 0, won = 0, lost = 0, pend = 0, pendStake = 0;
  for (const b of bets) {
    const s = betState(b);
    if (s.won) { won++; staked += b.stake; ret += b.odds ? b.stake * b.odds : b.stake; }
    else if (s.lost) { lost++; staked += b.stake; }
    else { pend++; pendStake += b.stake; }
  }
  return { n: bets.length, won, lost, pend, pendStake, staked, net: ret - staked, roi: staked ? (ret - staked) / staked : null, noOdds: bets.filter((b) => b.result === 'won' && !b.odds).length };
}
function viewBets() {  const bets = getBets(); if (!bets.length) return '';
  const rows = bets.map((b) => {
    const { live, lost, won, pNow } = betState(b);
    const status = lost ? ['bad', 'Perdida'] : won ? ['ok', 'Ganada'] : live.some((l) => l.state === 'in') ? ['warn', 'En juego'] : ['', 'Pendiente'];
    const payout = b.odds ? b.stake * b.odds : null;
    const fair = payout && pNow != null && !lost && !won ? payout * pNow : null;
    const advice = fair != null && live.some((l) => l.state === 'in') ? `<div class="tiny">Cash out justo ≈ <b>${money(fair)}</b> (prob. de cobrar ahora ${pct1(pNow)}). Si tu casa ofrece más, conviene cobrar; si ofrece menos, mantener.</div>` : '';
    const amount = lost ? ' −' + money(b.stake) : won && payout ? ' +' + money(payout - b.stake) : '';
    const open = S.betOpen === b.id;
    return `<div class="card bet ${status[0]}">
      <div class="bettop"><div><b>${b.type === 'combo' ? `Combinada · ${b.legs.length}` : esc(b.legs[0].pick)}</b>
        <div class="mut tiny">${new Date(b.date).toLocaleDateString('es-PE', { day: 'numeric', month: 'short', timeZone: TZ })} · ${money(b.stake)}${b.odds ? ` a ${fmtOdd(b.odds)} · cobra ${money(payout)}` : ''}</div></div>
        <span class="chip ${status[0] === 'ok' ? 'okc' : status[0] || ''}">${status[1]}${amount}</span><button class="x" data-delbet="${esc(b.id)}" aria-label="Borrar">×</button></div>
      <div class="blegs">${b.legs.map((it) => { const n = legNow(it); return `<div class="bl"><i class="dot ${n.cls}"></i><span>${esc(it.pick)}${b.type === 'combo' ? ` <span class="mut tiny">· ${esc(it.game)}</span>` : ''}</span><b class="${n.cls}">${esc(n.val)}</b></div>`; }).join('')}</div>
      ${advice}
      <button class="linkbtn acc open-live" data-betopen="${esc(b.id)}">${open ? 'Ocultar el directo ▲' : 'Ver el directo ▼'}</button>
      ${open ? betLiveDetail(b) : ''}
    </div>`;
  }).join('');
  return `<h2 style="margin-top:26px">Mis apuestas</h2><p class="mut tiny">Se actualizan en vivo cada 30 s mientras estás aquí.</p>${rows}`;
}

function viewPerfil() {
  if (isGuest()) return `<h2>Perfil</h2>` + lockCard('Tu perfil, tu bankroll y el registro de predicciones del modelo');
  const u = S.user, r = registryStats(), bs = betStats();
  const f3 = (x) => x.toFixed(3).replace('.', ',');
  return `<h2>Perfil</h2>
    <div class="card profile">${u.photo ? `<img src="${esc(u.photo)}" alt="">` : ''}<div><b>${esc(u.name || 'Invitado')}</b><div class="mut tiny">${esc(u.email || 'Invitado (sin cuenta de Google)')}</div></div></div>
    <div class="card" style="margin-top:10px"><label>Bankroll<br><input id="bankIn" type="number" min="0" value="${bankroll()}" style="margin-top:8px;font:inherit;background:var(--surf2);color:var(--ink);border:1px solid var(--edge);border-radius:8px;padding:8px;width:160px"></label></div>
    <div class="card" style="margin-top:10px"><h4>MIS RESULTADOS</h4>
      ${bs.n ? `<div class="pnl"><div class="card"><span class="mut tiny">Ganancia neta</span><b class="${bs.net > 0 ? 'good' : bs.net < 0 ? 'bad' : ''}">${bs.net >= 0 ? '+' : '−'}${money(Math.abs(bs.net))}</b></div><div class="card"><span class="mut tiny">ROI</span><b class="${bs.roi > 0 ? 'good' : bs.roi < 0 ? 'bad' : ''}">${bs.roi == null ? '–' : signed((bs.roi * 100).toFixed(1)) + ' %'}</b></div><div class="card"><span class="mut tiny">Ganadas / perdidas</span><b>${bs.won} / ${bs.lost}</b></div><div class="card"><span class="mut tiny">Pendientes</span><b>${bs.pend}</b></div></div>
      <p class="mut tiny">Apostado en apuestas cerradas: ${money(bs.staked)} · en juego o pendiente: ${money(bs.pendStake)}. Bankroll actual: <b>${money(bankroll() + bs.net)}</b> (inicial ${money(bankroll())} ${bs.net >= 0 ? '+' : '−'} ${money(Math.abs(bs.net))}).${bs.noOdds ? ` ${bs.noOdds} ganada(s) sin cuota registrada: cuentan sin ganancia.` : ''}</p>` : '<p class="mut tiny">Aún no registraste apuestas. Regístralas desde el Boleto y aquí verás tus ganancias y pérdidas.</p>'}
    </div>
    <div class="card" style="margin-top:10px"><h4>REGISTRO DE PREDICCIONES DEL MODELO</h4>
      <p class="mut tiny">Se guarda cada predicción antes del partido (en este navegador) y se compara con el resultado.</p>
      <div class="summary"><div class="card"><span class="mut tiny">Guardadas</span><b>${r.n}</b></div><div class="card"><span class="mut tiny">Con resultado</span><b>${r.settled}</b></div><div class="card"><span class="mut tiny">Con cuota</span><b>${r.mkt.n}</b></div></div>
      ${r.settled ? `<table><tr><th></th><th>Log-loss</th><th>Brier</th></tr><tr><td>Modelo</td><td>${f3(r.model.ll)}</td><td>${f3(r.model.br)}</td></tr>${r.mkt.n ? `<tr><td>Mercado</td><td>${f3(r.mkt.ll)}</td><td>${f3(r.mkt.br)}</td></tr>` : ''}</table><p class="mut tiny">Menos es mejor. Con pocos partidos no prueba nada.</p>` : '<p class="mut tiny">Aún no hay partidos terminados en el registro.</p>'}
    </div>
    <button class="btn ghost" data-act="logout" style="margin-top:14px;width:100%">Cerrar sesión</button>`;
}
// ---------- Página del partido ----------
// Datos extra de ESPN (se piden al abrir el partido y se guardan en caché)
const D = { sum: {}, sched: {}, roster: {}, glog: {}, stand: {}, live: {} };
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
// Cuando llegan datos nuevos se vuelve a pintar, agrupando las llegadas (props carga cientos de jugadores)
let rrTimer = null;
const rerenderDetail = () => {
  if (!(S.detail || S.tab === 'boleto' || S.tab === 'props' || S.tab === 'perfil')) return;
  if (document.activeElement?.matches?.('input, select')) return; // no interrumpir mientras escribes
  clearTimeout(rrTimer); rrTimer = setTimeout(render, 350);
};
// En el boleto, refresca el seguimiento en vivo cada 30 s
setInterval(() => { if (S.user && (S.detail ? liveNow().some((e) => String(e.id) === String(S.detail.id)) : (S.tab === 'boleto' || S.tab === 'perfil') && (getBets().length || getSlip().some((x) => x.pid))) && !document.activeElement?.matches?.('input') && !document.hidden) render(); }, LIVE_MS);
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
  return `<div class="dtop"><button class="icon-btn" data-act="back">‹</button><b>${esc(matchName(ev))}</b></div>
  <div class="hero">${ord(ev, awayB, homeB).join(`<div class="cb">${center}</div>`)}</div>
  <div class="seg wide">
    <button data-dtab="partido" class="${S.detail.tab === 'partido' ? 'on' : ''}">Partido</button>
    ${isSoccerEv(ev) ? `<button data-dtab="stats" class="${S.detail.tab === 'stats' ? 'on' : ''}">Estadísticas</button>` : ''}
    <button data-dtab="players" class="${S.detail.tab === 'players' ? 'on' : ''}">Jugadores</button>
  </div>`;
}

function viewDetail() {
  const ai = S.analysis.findIndex((x) => String(x.ev.id) === String(S.detail.id));
  if (ai < 0) return `<div class="dtop"><button class="icon-btn" data-act="back">‹</button></div><div class="card empty">Este partido ya no está en la lista.</div>`;
  const a = S.analysis[ai], ev = a.ev;
  if (!ev.path) return detailHeader(ev) + `<div class="card empty">El detalle completo usa datos de ESPN.</div>`;
  if (S.detail.player) return isGuest() ? detailHeader(ev) + lockCard('Perfil completo del jugador, línea ajustable y boleto') : playerProfile();
  const body = S.detail.tab === 'partido' ? partidoTab(a, ai) : S.detail.tab === 'stats' ? statsTab(a) : playersSub(a);
  return detailHeader(ev) + body;
}

// ----- Pestaña Jugadores: sub-selección del equipo -----
function playersSub(a) {
  const ev = a.ev;
  if (S.detail.team !== 'home' && S.detail.team !== 'away') S.detail.team = ord(ev, 'away', 'home')[0];
  const b = (side) => { const logo = side === 'home' ? ev.home_logo : ev.away_logo; return `<button data-dteam="${side}" class="${S.detail.team === side ? 'on' : ''}">${logo ? `<img src="${esc(logo)}" alt="">` : ''}Jugadores ${esc(side === 'home' ? ev.home_team : ev.away_team)}</button>`; };
  return `<div class="teamseg">${ord(ev, b('away'), b('home')).join('')}</div>` + playersTab(a, S.detail.team);
}

// ----- Pestaña Partido -----
function partidoTab(a, ai) {
  const ev = a.ev;
  const sum = need('sum', ev.id, `${espnBase(ev.path)}/summary?event=${ev.id}`);
  if (isGuest()) return ganadorSection(a, ai) + lockCard('El porqué del %, todas las salidas del modelo, historial, bajas, detalles y otros mercados');
  if (ev.path.startsWith('soccer')) return ganadorSection(a, ai) + historySection(ev) + detailsSection(ev) + soccerBajasSection(ev, sum) + soccerMarketsSection(a);
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
  if (w.cup) {
    const c = w.cup, L = (x) => x.slug.toUpperCase();
    steps.push(`<b>Liga de origen.</b> En copa no hay una sola tabla, así que cada equipo trae su rating de su propia liga: ${H} de <b>${L(c.h)}</b> (ataque ${n2(c.h.raw.att)}, defensa ${n2(c.h.raw.def)} frente a su liga) y ${A} de <b>${L(c.a)}</b> (ataque ${n2(c.a.raw.att)}, defensa ${n2(c.a.raw.def)}).`);
    steps.push(`<b>Fuerza de cada liga.</b> Ser bueno en una liga débil vale menos: se recorta un poco el rating (^0,85, porque dominar tu liga exagera tu nivel) y se multiplica el ataque y se divide la defensa por la fuerza de la liga (Premier = 1, calibrada con el coeficiente UEFA): ${L(c.h)} ${n2(c.h.S)}, ${L(c.a)} ${n2(c.a.S)}. Queda ${H} ataque ${n2(rh.att)} / defensa ${n2(rh.def)} y ${A} ${n2(ra.att)} / ${n2(ra.def)}.`);
    steps.push(`<b>Goles esperados.</b> Media de goles de las dos ligas ${n2(c.media)} × localía (${n2(c.hf)} local, ${n2(c.af)} visita) × ataque × defensa rival: ${H} <b>${n2(pr.xgHome)}</b>, ${A} <b>${n2(pr.xgAway)}</b>.`);
  } else {
  steps.push(`<b>Fuerza de cada equipo.</b> Ataque y defensa relativos a la media de la liga, con la temporada actual mezclada con 15 partidos “ficticios” a su nivel de la temporada pasada (cuanto más se juega, más pesa lo actual). ${H} (${rh.gp} PJ): ataque ${rel(rh.att, 'que la media')}, defensa ${rel(rh.def, 'goles que la media')}${rh.promoted ? ' · sin temporada anterior: tratado como ascendido' : ''}. ${A} (${ra.gp} PJ): ataque ${rel(ra.att, 'que la media')}, defensa ${rel(ra.def, 'goles que la media')}${ra.promoted ? ' · sin temporada anterior: tratado como ascendido' : ''}. En defensa, menos de 1 es mejor.`);
  steps.push(`<b>Goles esperados.</b> ${H}: ${n2(w.homeAvg)} (media de goles del local en la liga) × 1,04 × ataque ${n2(rh.att)} × defensa rival ${n2(ra.def)} = <b>${n2(pr.xgHome)}</b>. ${A}: ${n2(w.awayAvg)} × 1,04 × ${n2(ra.att)} × ${n2(rh.def)} = <b>${n2(pr.xgAway)}</b>.`);
  }
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
    { const sm = statModel(ev), c = sm ? statLambda(sm, 'wonCorners', 'all') : null; rows += row('Córners esperados', c != null ? num1(c) : 'cargando…', 'pestaña Estadísticas'); }
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

// ----- Jugadores (NBA): mercados, proyección del partido y línea ajustable -----
const glogUrl = (path, id) => `https://site.web.api.espn.com/apis/common/v3/sports/${path}/athletes/${id}/gamelog`;
const STATS = {
  PTS: { label: 'Puntos', short: 'PTS', f: (s) => s.points },
  REB: { label: 'Rebotes', short: 'REB', f: (s) => s.reb },
  AST: { label: 'Asistencias', short: 'AST', f: (s) => s.ast },
  '3PM': { label: 'Triples anotados', short: '3PM', f: (s) => s.tpm },
  '3PA': { label: 'Triples intentados', short: '3PA', f: (s) => s.tpa },
  PRA: { label: 'Pts+Reb+Ast', short: 'PRA', f: (s) => s.points + s.reb + s.ast },
  PR: { label: 'Pts+Reb', short: 'PR', f: (s) => s.points + s.reb },
  PA: { label: 'Pts+Ast', short: 'PA', f: (s) => s.points + s.ast },
  RA: { label: 'Reb+Ast', short: 'RA', f: (s) => s.reb + s.ast },
  STL: { label: 'Robos', short: 'ROB', f: (s) => s.stl },
  BLK: { label: 'Tapones', short: 'TAP', f: (s) => s.blk },
  TO: { label: 'Pérdidas', short: 'PER', f: (s) => s.to },
};
const mean = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : null);
function playerAvg(path, id, stat) {
  const g = playerGames(path, id); if (!g || !g.length) return null;
  return mean(g.map((x) => STATS[stat].f(x)));
}
function defTable(path) {
  const j = need('stand', path, `https://site.api.espn.com/apis/v2/sports/${path}/standings`);
  if (!j) return null;
  const rows = [], pfRows = [];
  for (const ch of j.children || []) for (const e of ch.standings?.entries || []) {
    const st = Object.fromEntries((e.stats || []).map((s) => [s.name, s.value]));
    const gp = st.gamesPlayed || 0;
    // NBA trae la media; en fútbol se calcula goles recibidos / partidos
    const pa = st.avgPointsAgainst ?? (gp ? st.pointsAgainst / gp : null);
    const pf = st.avgPointsFor ?? (gp ? st.pointsFor / gp : null);
    if (pa != null) rows.push([String(e.team.id), pa]);
    if (pf != null) pfRows.push([String(e.team.id), pf]);
  }
  rows.sort((a, b) => b[1] - a[1]); // 1.º = la que más puntos/goles permite (mejor para el "Más")
  const league = mean(rows.map((r) => r[1])), leaguePf = mean(pfRows.map((r) => r[1]));
  return { rank: Object.fromEntries(rows.map(([id], i) => [id, i + 1])), pa: Object.fromEntries(rows), pf: Object.fromEntries(pfRows), league, leaguePf };
}
function defRanks(path) { return defTable(path)?.rank || null; }

// Proyección para ESTE partido:
//  base = 40 % últimos 5 + 35 % últimos 10 + 25 % temporada
//  × rival: puntos que permite el rival frente a la media de la liga (efecto a la mitad)
//  × casa/fuera: su rendimiento como local o visitante frente a su media (efecto a la mitad, si hay ≥3 partidos)
function projectPlayer(g, stat, oppId, isHome, dt) {
  const vals = g.map((x) => STATS[stat].f(x));
  const season = mean(vals), l5 = mean(vals.slice(-5)), l10 = mean(vals.slice(-10));
  const base = 0.4 * l5 + 0.35 * l10 + 0.25 * season;
  let fOpp = 1, fHA = 1;
  // Atajadas: dependen de lo que ataca el rival. Faltas y offsides: sin ajuste por rival. Resto: de lo que concede el rival.
  if (stat === 'SV') { if (dt?.pf?.[String(oppId)] && dt.leaguePf) fOpp = 1 + 0.5 * (dt.pf[String(oppId)] / dt.leaguePf - 1); }
  else if (!['YC', 'FC', 'FS', 'OFF'].includes(stat) && dt && dt.pa[String(oppId)] && dt.league) fOpp = 1 + 0.5 * (dt.pa[String(oppId)] / dt.league - 1);
  const side = g.filter((x) => x.home === isHome).map((x) => STATS[stat].f(x));
  if (side.length >= 3 && season > 0) fHA = 1 + 0.5 * (mean(side) / season - 1);
  const proj = Math.max(0, base * fOpp * fHA);
  const sd = Math.sqrt(mean(vals.map((v) => (v - season) ** 2)) || 0);
  return { proj, base, l5, l10, season, fOpp, fHA, sd, n: vals.length, vals };
}
const suggestLine = (proj) => Math.max(0.5, Math.floor(proj) + 0.5);
// Probabilidad de superar la línea: Poisson para estadísticas pequeñas, Normal para el resto
function poissonCdf(k, l) { let p = Math.exp(-l), s = p; for (let i = 1; i <= k; i++) { p *= l / i; s += p; } return s; }
function normCdf(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function probOver(pr, line) {
  const { proj, sd } = pr;
  if (proj < 8) { // conteo pequeño: Poisson
    const k = Math.floor(line);
    const pAtMost = poissonCdf(k, proj);
    const pPush = Number.isInteger(line) ? poissonCdf(k, proj) - (k > 0 ? poissonCdf(k - 1, proj) : 0) : 0;
    return { over: 1 - pAtMost, under: pAtMost - pPush, push: pPush };
  }
  const s = Math.max(sd, Math.sqrt(proj), 1);
  const over = 1 - normCdf((line + (Number.isInteger(line) ? 0.5 : 0) - proj) / s);
  const under = normCdf((line - (Number.isInteger(line) ? 0.5 : 0) - proj) / s);
  return { over, under, push: Math.max(0, 1 - over - under) };
}
const fmtL = (x) => String(x).replace('.', ',');
const rateAt = (arr, line, side) => (arr.length ? arr.filter((v) => (side === 'under' ? v < line : v > line)).length / arr.length : null);
const rateCls = (r) => (r == null ? '' : r >= 0.6 ? 'good' : r <= 0.4 ? 'bad' : 'warn');

function playersTab(a, side) {
  const ev = a.ev;
  if (isGuest()) return lockCard('Estadísticas de jugadores: proyección del partido, línea ajustable y % de acierto');
  if (ev.path.startsWith('soccer')) return soccerPlayersTab(a, side);
  if (!isNBA(ev)) return `<div class="card empty">Las estadísticas de jugadores están disponibles para NBA y fútbol.</div>`;
  const teamId = side === 'home' ? ev.home_id : ev.away_id, oppId = side === 'home' ? ev.away_id : ev.home_id;
  const abbr = side === 'home' ? ev.home_abbr : ev.away_abbr, logo = side === 'home' ? ev.home_logo : ev.away_logo;
  const roster = need('roster', teamId, `${espnBase(ev.path)}/teams/${teamId}/roster`);
  if (S.detail.stat && STATS[S.detail.stat]?.soccer) S.detail.stat = 'PTS';
  const stat = (S.detail.stat ||= 'PTS');
  const tabs = statTabs(stat);
  if (!roster) return tabs + `<div class="card empty">${roster === null ? 'Plantilla no disponible.' : 'Cargando plantilla…'}</div>`;
  const athletes = roster.athletes || [];
  athletes.forEach((p) => need('glog', p.id, glogUrl(ev.path, p.id)));
  const dt = defTable(ev.path);
  const sum = peek('sum', ev.id);
  const injured = new Map((sum?.injuries || []).flatMap((t) => (t.injuries || []).map((x) => [String(x.athlete?.id), INJ_ES[x.status] || x.status])));
  const loading = athletes.filter((p) => peek('glog', p.id) === undefined).length;
  const rows = athletes.map((p) => {
    const g = playerGames(ev.path, p.id); if (!g || g.length < 3) return null;
    if (mean(g.map((x) => x.min)) < 12) return null;
    const pr = projectPlayer(g, stat, oppId, side === 'home', dt);
    const line = S.detail.lines?.[p.id + '|' + stat] ?? suggestLine(pr.proj);
    const h2h = g.filter((x) => String(x.oppId) === String(oppId)).map((x) => STATS[stat].f(x));
    const vals = pr.vals;
    return { p, pr, line, prob: probOver(pr, line), last: vals.slice(-10), season: rateAt(vals, line), h2h: rateAt(h2h, line), l5: rateAt(vals.slice(-5), line), l10: rateAt(vals.slice(-10), line), l20: rateAt(vals.slice(-20), line), inj: injured.get(String(p.id)) };
  }).filter(Boolean).sort((x, y) => y.pr.proj - x.pr.proj);
  const rk = dt?.rank?.[String(oppId)];
  const cards = rows.map((r) => {
    const mx = Math.max(...r.last, r.line * 1.3);
    return `<div class="card pcard click" data-pl="${esc(side)}/${esc(r.p.id)}">
    <div class="phead"><div class="ph">${face(ev.path, r.p, r.p.id)}${logo ? `<img class="tl" src="${esc(logo)}" alt="">` : ''}</div>
      <div><b>${esc(r.p.displayName)}</b> <span class="mut tiny">${esc(abbr)} · ${esc(posEs(r.p))}</span>${r.inj ? ` <span class="chip ${r.inj === 'Baja' ? 'bad' : 'warn'}">${esc(r.inj)}</span>` : ''}
        <div><span class="acc">Más</span> ${fmtL(r.line)} ${STATS[stat].label} <span class="mut tiny">· proyección ${num1(r.pr.proj)}</span></div></div>
      <div class="pq"><span class="mut tiny">PROB. MÁS</span><b class="${rateCls(r.prob.over)}">${pctEs(r.prob.over)}</b></div><div class="pq"><span class="mut tiny">CUOTA JUSTA</span><b>${fmtOdd(1 / r.prob.over)}</b></div></div>
    <div class="rates">
      <div><span>Temporada</span><b class="${rateCls(r.season)}">${pctEs(r.season)}</b></div>
      <div><span>H2H</span><b class="${rateCls(r.h2h)}">${pctEs(r.h2h)}</b></div>
      <div><span>Def. rival</span><b class="${rk == null ? '' : rk <= 10 ? 'good' : rk >= 21 ? 'bad' : 'warn'}">${rk ? rk + '.º' : '–'}</b></div>
      <div><span>L5</span><b class="${rateCls(r.l5)}">${pctEs(r.l5)}</b></div>
      <div class="sel"><span>L10</span><b class="${rateCls(r.l10)}">${pctEs(r.l10)}</b></div>
      <div><span>L20</span><b class="${rateCls(r.l20)}">${pctEs(r.l20)}</b></div>
    </div>
    <div class="spark">${r.last.map((v) => `<i class="${v > r.line ? 'win' : 'loss'}" style="height:${Math.max(6, (v / mx) * 100)}%" title="${v}"></i>`).join('')}<em style="bottom:${(r.line / mx) * 100}%"></em></div>
    <div class="pmore">Ver perfil, ajustar línea y agregar al boleto ›</div>
  </div>`;
  }).join('');
  return tabs + `<p class="mut tiny" style="margin-bottom:10px">La línea es la <b>proyección ALTOQ para este partido</b> redondeada a medio punto. Toca un jugador para ver su perfil completo, mover la línea y agregarla a tu boleto. % = partidos en los que superó la línea. “Def. rival”: puesto del rival en puntos permitidos (1.º = la peor defensa).${loading ? ` Cargando ${loading} jugadores…` : ''}</p>` + (cards || `<div class="card empty">${loading ? 'Cargando jugadores…' : 'Sin datos de jugadores.'}</div>`);
}

// ----- Perfil del jugador (estilo ficha completa) -----
const STAT_EXTRA = {
  FGM: { label: 'Tiros de campo anotados', short: 'TC', f: (s) => s.fgm },
  FGA: { label: 'Tiros de campo intentados', short: 'TCI', f: (s) => s.fga },
  FTM: { label: 'Tiros libres anotados', short: 'TL', f: (s) => s.ftm },
  FTA: { label: 'Tiros libres intentados', short: 'TLI', f: (s) => s.fta },
};
Object.assign(STATS, STAT_EXTRA);
// Fútbol: jugador de campo = tiros a puerta, tiros, asistencias, faltas y offsides · arquero = atajadas
Object.assign(STATS, {
  SOT: { label: 'Tiros a puerta', short: 'A puerta', f: (s) => s.sot, soccer: true },
  SH: { label: 'Tiros', short: 'Tiros', f: (s) => s.sh, soccer: true },
  SV: { label: 'Atajadas', short: 'Atajadas', f: (s) => s.sv, soccer: true },
  SG: { label: 'Goles', short: 'Goles', f: (s) => s.goals, soccer: true },
  SAST: { label: 'Asistencias', short: 'Asist.', f: (s) => s.assists, soccer: true },
  SGA: { label: 'Gol o asistencia', short: 'G+A', f: (s) => (s.goals || 0) + (s.assists || 0), soccer: true },
  FC: { label: 'Faltas cometidas', short: 'Faltas com.', f: (s) => s.fouls, soccer: true },
  FS: { label: 'Faltas recibidas', short: 'Faltas rec.', f: (s) => s.fs, soccer: true },
  OFF: { label: 'Fueras de juego', short: 'Offsides', f: (s) => s.off, soccer: true },
});
const STAT_ORDER = ['PTS', 'REB', 'AST', '3PM', '3PA', 'PRA', 'PR', 'PA', 'RA', 'FGM', 'FGA', 'FTM', 'FTA', 'STL', 'BLK', 'TO'];
// Las amarillas NO son mercado: solo un indicador (últimas 5) de lo faltero que es el jugador
const SOC_FIELD = ['SOT', 'SH', 'SG', 'SAST', 'SGA', 'FC', 'FS', 'OFF'], SOC_GK = ['SV'], SOC_ALL = [...SOC_FIELD, 'SV'];
const CHIP = { PRA: 'P+R+A', PR: 'P+R', PA: 'P+A', RA: 'R+A' };
const isGK = (p) => /^(G|GK)$/i.test(p?.position?.abbreviation || '') || /goalkeeper/i.test(p?.position?.name || '');
function statTabs(stat, keys = STAT_ORDER) {
  return `<div class="chips">${keys.map((k) => `<button data-stat="${k}" class="${k === stat ? 'on' : ''}" title="${esc(STATS[k].label)}">${esc(CHIP[k] || STATS[k].short)}</button>`).join('')}</div>`;
}
// Constancia con las amarillas: % de partidos con tarjeta, partidos desde la última y racha
function cardStreak(g) {
  const n = g.length, withY = g.filter((x) => x.yc > 0).length;
  let since = 0; for (let i = n - 1; i >= 0 && !(g[i].yc > 0); i--) since++;
  const lastIdx = g.map((x) => x.yc > 0).lastIndexOf(true);
  return { n, withY, rate: n ? withY / n : null, since: lastIdx < 0 ? null : since, total: g.reduce((t, x) => t + x.yc, 0), red: g.reduce((t, x) => t + (x.rc || 0), 0), last5: g.slice(-5).map((x) => x.yc > 0) };
}
// Gamelog → partidos (con descanso y back-to-back)
function parseGlog(j, soccer) {
  if (!j) return j;
  const names = j.names || [];
  const st = (j.seasonTypes || []).find((s) => /regular/i.test(s.displayName)) || (j.seasonTypes || [])[0];
  if (!st) return [];
  const pair = (v) => String(v || '0-0').split('-').map((x) => parseInt(x) || 0);
  const out = [];
  for (const c of st.categories || []) if (c.type === 'event') for (const e of c.events || []) {
    const meta = j.events?.[e.eventId]; if (!meta) continue;
    const v = {}; names.forEach((n, i) => (v[n] = e.stats[i]));
    const [tpm, tpa] = pair(v['threePointFieldGoalsMade-threePointFieldGoalsAttempted']);
    const [fgm, fga] = pair(v['fieldGoalsMade-fieldGoalsAttempted']);
    const [ftm, fta] = pair(v['freeThrowsMade-freeThrowsAttempted']);
    const base = { date: meta.gameDate, oppId: meta.opponent?.id, opp: meta.opponent?.abbreviation || '', home: meta.atVs !== '@', result: meta.gameResult, score: meta.score };
    if (soccer) out.push({ ...base, soccer: true, min: null, sh: +v.totalShots || 0, sot: +v.shotsOnTarget || 0, goals: +v.totalGoals || 0, assists: +v.goalAssists || 0,
      yc: +v.yellowCards || 0, rc: +v.redCards || 0, sv: +v.saves || 0, gc: +v.goalsConceded || 0, cs: +v.cleanSheet || 0, fouls: +v.foulsCommitted || 0, fs: +v.foulsSuffered || 0, off: +v.offsides || 0,
      // ESPN lista todos los partidos del equipo: se cuenta como jugado si tuvo alguna acción registrada
      played: ['totalShots', 'shotsOnTarget', 'totalGoals', 'goalAssists', 'yellowCards', 'redCards', 'saves', 'goalsConceded', 'cleanSheet', 'foulsCommitted', 'foulsSuffered', 'offsides'].some((k) => +v[k] > 0) });
    else out.push({ ...base, min: +v.minutes || 0, points: +v.points || 0, reb: +v.totalRebounds || 0, ast: +v.assists || 0, tpm, tpa, fgm, fga, ftm, fta,
      stl: +v.steals || 0, blk: +v.blocks || 0, to: +v.turnovers || 0 });
  }
  const g = out.filter((x) => (soccer ? x.played : x.min > 0)).sort((a, b) => new Date(a.date) - new Date(b.date));
  g.forEach((x, i) => { const prev = g[i - 1]; x.rest = prev ? Math.max(0, Math.round((new Date(x.date) - new Date(prev.date)) / 864e5) - 1) : null; x.b2b = x.rest === 0; });
  return g;
}
function playerGames(path, id) { return parseGlog(peek('glog', id), path.startsWith('soccer')); }
const POS_ES = { Forward: 'Delantero', Midfielder: 'Mediocampista', Defender: 'Defensa', Goalkeeper: 'Arquero', Guard: 'Base/escolta', 'Point Guard': 'Base', 'Shooting Guard': 'Escolta', 'Small Forward': 'Alero', 'Power Forward': 'Ala-pívot', Center: 'Pívot', 'Guard-Forward': 'Escolta-alero', 'Forward-Center': 'Ala-pívot', Attacker: 'Delantero' };
const POS_NBA_ES = { G: 'Base/escolta', PG: 'Base', SG: 'Escolta', F: 'Alero', SF: 'Alero', PF: 'Ala-pívot', C: 'Pívot', 'G-F': 'Escolta-alero', 'F-G': 'Alero-escolta', 'F-C': 'Ala-pívot', 'C-F': 'Pívot-ala' };
// En la NBA "Forward" es alero; en fútbol es delantero
const posEs = (p) => {
  const ab = (p?.position?.abbreviation || '').toUpperCase();
  const soccer = S.liga === 'fc'; // todas las vistas pintan la liga elegida
  if (!soccer && POS_NBA_ES[ab]) return POS_NBA_ES[ab];
  return POS_ES[p?.position?.displayName] || POS_ES[p?.position?.name] || p?.position?.displayName || ab || '';
};
const seasonLabel = (j) => { const d = ((j?.seasonTypes || []).find((s) => /regular/i.test(s.displayName)) || (j?.seasonTypes || [])[0])?.displayName || ''; const m = d.match(/(\d{4})-(\d{2})/); return m ? { label: m[1].slice(2) + '-' + m[2], end: 2000 + +m[2] } : null; };
function prevSeasonGames(path, id) {
  const cur = seasonLabel(peek('glog', id)); if (!cur) return { games: undefined };
  const prevEnd = cur.end - 1, key = id + '|' + prevEnd;
  const j = need('glog', key, glogUrl(path, id) + '?season=' + prevEnd);
  return { games: parseGlog(j, path.startsWith('soccer')), label: String(prevEnd - 1).slice(2) + '-' + String(prevEnd).slice(2), curLabel: cur.label };
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Perfil de juego a partir de sus números
function archetype(g) {
  const m = (f) => mean(g.map(f)) || 0;
  const t = [];
  if (m((x) => x.tpa) >= 6) t.push('Tirador de triples');
  if (m((x) => x.ast) >= 6.5) t.push('Organizador');
  if (m((x) => x.reb) >= 9) t.push('Reboteador');
  if (m((x) => x.points) >= 22) t.push('Anotador');
  if (m((x) => x.blk) >= 1.5) t.push('Protector del aro');
  if (m((x) => x.fta) >= 6) t.push('Va mucho a la línea');
  return t.slice(0, 2);
}
// Nota del pick según la probabilidad del modelo
const grade = (p) => (p >= 0.75 ? 'A+' : p >= 0.68 ? 'A' : p >= 0.62 ? 'B+' : p >= 0.56 ? 'B' : p >= 0.5 ? 'C' : 'D');

function playerCtx() {
  const ai = S.analysis.findIndex((x) => String(x.ev.id) === String(S.detail.id)); if (ai < 0) return null;
  const a = S.analysis[ai], ev = a.ev, side = S.detail.pside, pid = S.detail.player;
  const teamId = side === 'home' ? ev.home_id : ev.away_id, oppId = side === 'home' ? ev.away_id : ev.home_id;
  const roster = need('roster', teamId, `${espnBase(ev.path)}/teams/${teamId}/roster`);
  need('glog', pid, glogUrl(ev.path, pid));
  const p = roster?.athletes?.find((x) => String(x.id) === String(pid));
  const g = playerGames(ev.path, pid);
  const soccer = ev.path.startsWith('soccer');
  const keys = soccer ? (p ? (isGK(p) ? SOC_GK : SOC_FIELD) : SOC_ALL) : STAT_ORDER;
  if (!keys.includes(S.detail.stat)) S.detail.stat = keys[0];
  const stat = S.detail.stat;
  const dt = defTable(ev.path);
  const pr = g && g.length ? projectPlayer(g, stat, oppId, side === 'home', dt) : null;
  const key = pid + '|' + stat;
  const sugg = pr ? suggestLine(pr.proj) : null;
  const line = S.detail.lines?.[key] ?? sugg;
  const pick = S.detail.pick ||= 'over';
  return { a, ai, ev, side, pid, teamId, oppId, roster, p, g, stat, dt, pr, key, sugg, line, pick, soccer, keys };
}
function playerProfile() {
  const c = playerCtx(); if (!c) return `<div class="dtop"><button class="icon-btn" data-act="pback">‹</button></div><div class="card empty">Este partido ya no está en la lista.</div>`;
  const { ev, side, pid, oppId, p, g, stat, dt, pr, line, pick, sugg } = c;
  const abbr = side === 'home' ? ev.home_abbr : ev.away_abbr, logo = side === 'home' ? ev.home_logo : ev.away_logo;
  const oppAbbr = side === 'home' ? ev.away_abbr : ev.home_abbr;
  const sum = peek('sum', ev.id);
  const inj = (sum?.injuries || []).flatMap((t) => t.injuries || []).find((x) => String(x.athlete?.id) === String(pid));
  const name = p?.displayName || inj?.athlete?.displayName || 'Jugador';
  const top = `<div class="dtop"><button class="icon-btn" data-act="pback">‹</button><b>${esc(name)}</b></div>`;
  if (g === undefined) return top + `<div class="card empty">Cargando estadísticas…</div>`;
  if (!g || !g.length) return top + `<div class="card empty">Sin partidos esta temporada.</div>`;
  const pb = probOver(pr, line), pSel = pick === 'over' ? pb.over : pb.under;
  const soccer = c.soccer, cs = soccer ? cardStreak(g) : null;
  const tags = soccer ? [isGK(p) ? 'Arquero' : 'Jugador de campo', ...(mean(g.map((x) => x.sh)) >= 2.5 ? ['Rematador'] : []), ...(cs.rate >= 0.25 ? ['Suele ver amarilla'] : []), ...(isGK(p) && mean(g.map((x) => x.sv)) >= 3.5 ? ['Muy exigido'] : [])].slice(0, 3) : archetype(g);
  const f = STATS[stat].f, lab = STATS[stat].label.toLowerCase();
  const prev = prevSeasonGames(ev.path, pid);

  // Filtros del tramo
  const F = (S.detail.pf ||= { tramo: 'l10', side: 'all', minMin: 0, rest: 'all' });
  const pass = (x) => (F.side === 'all' || (F.side === 'home' ? x.home : !x.home)) && (x.min == null || x.min >= F.minMin) && (soccer || F.rest === 'all' || (F.rest === 'b2b' ? x.b2b : F.rest === '1' ? x.rest === 1 : x.rest >= 2));
  const gf = g.filter(pass), pf = (prev.games || []).filter(pass);
  const sets = {
    l5: gf.slice(-5), l10: gf.slice(-10), l20: gf.slice(-20),
    h2h: [...pf, ...gf].filter((x) => String(x.oppId) === String(oppId)),
    cur: gf, prev: pf,
  };
  const hit = (x) => (pick === 'under' ? f(x) < line : f(x) > line);
  const tile = (k, title) => { const s = sets[k], n = s.length, h = s.filter(hit).length, r = n ? h / n : null; return `<button class="tile ${rateCls(r)} ${F.tramo === k ? 'sel' : ''}" data-tramo="${k}"><span>${title}</span><b>${r == null ? '–' : Math.round(r * 100) + ' %'}</b><small>${h}/${n}</small></button>`; };
  const tramo = sets[F.tramo] || sets.l10;
  const tvals = tramo.map(f), hits = tramo.filter(hit).length;
  const maxV = Math.max(soccer ? 3 : 10, ...tvals, line) * 1.12;
  const H = 210;
  const rk = dt?.rank?.[String(oppId)];
  const price = S.detail.price?.[c.key];
  const evv = price ? pSel * price - 1 : null;
  const added = getSlip().some((x) => x.id === slipPropId(c));
  const prevLabel = prev.label || 'Temp. pasada';
  const curLabel = prev.curLabel || 'Temporada';

  const hero = `<div class="card phero">
    <div class="ph big">${face(ev.path, p, pid, name)}${logo ? `<img class="tl" src="${esc(logo)}" alt="">` : ''}</div>
    <div class="phinfo"><h3>${esc(name)}</h3>
      <div class="mut">${esc(abbr)} · ${esc(posEs(p))} · ${side === 'home' ? 'vs' : '@'} ${esc(oppAbbr)} · ${fmtTime(ev.commence_time)} <span class="tiny">(Lima)</span></div>
      ${tags.length ? `<div class="ptags">${tags.map((t) => `<span>● ${esc(t)}</span>`).join('')}</div>` : ''}
      ${inj ? `<div style="margin-top:6px"><span class="chip ${INJ_ES[inj.status] === 'Baja' ? 'bad' : 'warn'}">${esc(INJ_ES[inj.status] || inj.status)}</span> <span class="mut tiny">${esc([inj.details?.type, inj.details?.location].filter(Boolean).join(' · '))}</span></div>` : ''}</div>
    <div class="grade" title="Nota del pick según la probabilidad del modelo">${grade(pSel)}</div>
  </div>`;

  const controls = `<div class="card pctl">
    <div class="ctlrow">
      <div class="seg side"><button data-pick="over" class="${pick === 'over' ? 'on' : ''}">Más de</button><button data-pick="under" class="${pick === 'under' ? 'on' : ''}">Menos de</button></div>
      <div class="stepper"><button data-line="-0.5">−</button><input id="lineIn" type="number" step="0.5" min="0" value="${line}"><button data-line="0.5">+</button></div>
      <label class="oddin"><span class="mut">Cuota</span><input id="priceIn" type="number" step="0.01" min="1.01" placeholder="—" value="${price || ''}"></label>
    </div>
    <div class="pickrow">
      <div><h3 class="pickh">${pick === 'over' ? 'Más' : 'Menos'} de ${num1(line)} <small>${esc(lab)}</small></h3>
        <p class="mut">Proyección ALTOQ para hoy: <b style="color:var(--ink)">${num1(pr.proj)}</b>${line !== sugg ? ` · <button class="linkbtn" data-line="reset">Usar la línea sugerida (${fmtL(sugg)})</button>` : ' · línea sugerida'}</p></div>
      <button class="btn ${added ? 'ghost' : 'google'} addprop" data-act="propadd">${added ? '✓ En boleto · quitar' : '+ Boleto'}</button>
    </div>
    <div class="pnums">
      <div><span>Prob. del modelo</span><b class="${rateCls(pSel)}">${pct1(pSel)}</b></div>
      <div><span>Cuota justa</span><b>${fmtOdd(1 / pSel)}</b></div>
      <div><span>Mínima recomendada</span><b>${fmtOdd(1.1 / pSel)}</b></div>
      <div><span>Valor esperado</span><b class="${evv == null ? '' : evv > 0 ? 'good' : 'bad'}">${evv == null ? 'pon tu cuota' : signed((evv * 100).toFixed(1)) + ' %'}</b></div>
    </div>
    ${pb.push > 0.005 ? `<p class="mut tiny">Línea entera: ${pct1(pb.push)} de que quede exacto (se devuelve la apuesta).</p>` : ''}
    <div class="tiles">${tile('l5', 'L5')}${tile('l10', 'L10')}${tile('l20', 'L20')}${tile('h2h', 'H2H')}${tile('cur', curLabel)}${tile('prev', prevLabel)}</div>
    ${prev.games === undefined ? '<p class="mut tiny">Cargando la temporada pasada…</p>' : ''}
    <div class="bchart" style="height:${H + 60}px">
      <div class="yax"><span style="bottom:${H + 34}px">${Math.round(maxV / 1.12)}</span><span style="bottom:34px">0</span></div>
      <div class="bars">${tramo.map((x) => { const v = f(x), d = new Date(x.date); return `<div class="bc" title="${esc((x.home ? 'vs ' : '@ ') + x.opp)} · ${x.min} min${x.b2b ? ' · B2B' : ''}"><span style="bottom:${(v / maxV) * H + 36}px">${v}</span><i class="${hit(x) ? 'win' : 'loss'}" style="height:${(v / maxV) * H}px"></i><small>${d.getDate()}/${d.getMonth() + 1}<br><b>${x.home ? '' : '@'}${esc(x.opp)}</b></small></div>`; }).join('') || '<p class="mut" style="padding:40px">Sin partidos con estos filtros.</p>'}
        <div class="lline" style="bottom:${(line / maxV) * H + 34}px"><b>${num1(line)}</b></div></div>
    </div>
    <div class="legend"><span><i class="win"></i>${pick === 'over' ? 'Superó' : 'Quedó bajo'} ${num1(line)}</span><span><i class="loss"></i>No ${pick === 'over' ? 'llegó' : 'quedó bajo'}</span><span><i class="ln"></i>Línea</span></div>
    <p class="mut">${pick === 'over' ? 'Más' : 'Menos'} de ${num1(line)} se cumplió en <b class="acc">${hits} de ${tramo.length}</b> partidos de este tramo.</p>
  </div>`;

  const stats = `<div class="card pstats">
    <div><span>Media</span><b>${num1(mean(tvals))}</b></div><div><span>Mediana</span><b>${num1(median(tvals))}</b></div><div><span>Máx.</span><b>${tvals.length ? Math.max(...tvals) : '–'}</b></div>
    <div><span>Def. ${esc(oppAbbr)}</span><b>${rk ? rk + '.º' : '–'}</b></div>
    ${soccer ? `<p class="mut tiny" style="margin:0">Amarillas esta temporada: <b>${cs.total}</b> en ${cs.n} PJ (${pctEs(cs.rate)} de los partidos) · ${cs.since == null ? 'no ha visto ninguna' : cs.since === 0 ? 'vio amarilla en su último partido' : `última hace ${cs.since} PJ`}${cs.red ? ` · ${cs.red} roja(s)` : ''} · últimos 5: <span class="ycd">${ycDots(cs.last5)}</span></p>` : ''}
    <p class="mut tiny">${esc(oppAbbr)} es la ${rk ? rk + '.ª' : 'N/D'} defensa en ${soccer ? 'goles recibidos' : 'puntos permitidos'} (1.ª = la que más concede). ESPN no da la defensa por posición. La proyección ya ajusta por el rival (×${pr.fOpp.toFixed(2).replace('.', ',')}) y por jugar ${side === 'home' ? 'en casa' : 'fuera'} (×${pr.fHA.toFixed(2).replace('.', ',')}). Base: 40 % L5 ${num1(pr.l5)} · 35 % L10 ${num1(pr.l10)} · 25 % temporada ${num1(pr.season)}.</p>
  </div>`;

  const filters = `<div class="card pfil">
    <div class="seg"><button data-pfs="all" class="${F.side === 'all' ? 'on' : ''}">Todos</button><button data-pfs="home" class="${F.side === 'home' ? 'on' : ''}">Casa</button><button data-pfs="away" class="${F.side === 'away' ? 'on' : ''}">Fuera</button></div>
    ${soccer ? '' : `<label class="minf"><span class="mut">Mín. minutos</span><input id="minMin" type="range" min="0" max="40" step="1" value="${F.minMin}"><b>${F.minMin}</b></label>`}
    <label class="minf ${soccer ? 'hidden' : ''}"><span class="mut">Descanso</span><select id="restSel"><option value="all" ${F.rest === 'all' ? 'selected' : ''}>Todos</option><option value="b2b" ${F.rest === 'b2b' ? 'selected' : ''}>B2B (0 días)</option><option value="1" ${F.rest === '1' ? 'selected' : ''}>1 día</option><option value="2" ${F.rest === '2' ? 'selected' : ''}>2+ días</option></select></label>
  </div>`;

  const socRows = () => [...tramo].reverse().map((x) => { const d = new Date(x.date), v = f(x); return `<tr><td>${d.getDate()}/${d.getMonth() + 1}</td><td>${x.home ? 'vs' : '@'} ${esc(x.opp)}</td><td class="${x.result === 'W' ? 'good' : x.result === 'L' ? 'bad' : ''}">${esc(x.result || '')} ${esc(x.score || '')}</td>${isGK(p) ? `<td>${x.sv}</td><td>${x.gc}</td><td>${x.cs ? 'Sí' : 'No'}</td>` : `<td>${x.sh}</td><td>${x.sot}</td><td>${x.goals}</td>`}<td>${x.yc ? '🟨' : ''}${x.rc ? '🟥' : ''}</td><td class="${hit(x) ? 'acc' : ''}"><b>${v}</b></td></tr>`; }).join('');
  if (soccer) {
    const head = isGK(p) ? '<th>Atajadas</th><th>Goles rec.</th><th>Valla inv.</th>' : '<th>Tiros</th><th>A puerta</th><th>Goles</th>';
    const tableS = `<div class="card"><h4>PARTIDOS DEL TRAMO</h4><div class="scroll"><table class="glog"><tr><th>Fecha</th><th>Rival</th><th>Res.</th>${head}<th>Tarj.</th><th>${esc(STATS[stat].short)}</th></tr>${socRows()}</table></div></div>
      <p class="mut tiny" style="text-align:center">Estimaciones a partir de partidos pasados; no garantizan nada. +18 · Juega solo lo que puedas permitirte perder.</p>`;
    return top + hero + statTabs(stat, c.keys) + controls + stats + filters + tableS;
  }
  const rows = [...tramo].reverse().map((x) => { const d = new Date(x.date), v = f(x); return `<tr><td>${d.getDate()}/${d.getMonth() + 1}${x.b2b ? ' <span class="b2b">B2B</span>' : ''}</td><td>${x.home ? 'vs' : '@'} ${esc(x.opp)}</td><td>${x.min}</td><td>${x.points}</td><td>${x.reb}</td><td>${x.ast}</td><td>${x.tpm}-${x.tpa}</td><td>${x.fgm}-${x.fga}</td><td>${x.ftm}-${x.fta}</td><td>${x.stl}</td><td>${x.blk}</td><td class="${hit(x) ? 'acc' : ''}"><b>${v}</b></td></tr>`; }).join('');
  const table = `<div class="card"><h4>PARTIDOS DEL TRAMO</h4><div class="scroll"><table class="glog"><tr><th>Fecha</th><th>Rival</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>3PM-3PA</th><th>TC</th><th>TL</th><th>ROB</th><th>TAP</th><th>${esc(CHIP[stat] || STATS[stat].short)}</th></tr>${rows}</table></div></div>
    <p class="mut tiny" style="text-align:center">Estimaciones a partir de partidos pasados; no garantizan nada. +18 · Juega solo lo que puedas permitirte perder.</p>`;

  return top + hero + statTabs(stat) + controls + stats + filters + table;
}
const slipPropId = (c) => `${c.ev.id}|prop|${c.pid}|${c.stat}|${c.pick}|${c.line}`;
function togglePropSlip() {
  const c = playerCtx(); if (!c || !c.pr) return;
  const id = slipPropId(c);
  let s = getSlip();
  if (s.some((x) => x.id === id)) s = s.filter((x) => x.id !== id);
  else {
    const pb = probOver(c.pr, c.line), p = c.pick === 'over' ? pb.over : pb.under;
    const price = S.detail.price?.[c.key] || null;
    const name = c.p?.displayName || 'Jugador';
    s.push({ id, game: matchName(c.ev, true), time: c.ev.commence_time, market: 'Jugador · ' + STATS[c.stat].label,
      pick: `${name} ${c.pick === 'over' ? 'Más' : 'Menos'} de ${num1(c.line)} ${STATS[c.stat].label.toLowerCase()}`,
      price: price || Math.round((1 / p) * 100) / 100, book: price ? 'Tu casa' : 'Cuota justa (pon la de tu casa)', pModel: p,
      // Datos para el seguimiento en vivo y el aviso de cash out
      path: c.ev.path, eventId: c.ev.id, pid: c.pid, pname: name, stat: c.stat, line: c.line, side: c.pick, proj: c.pr.proj,
      avgMin: c.soccer ? null : mean(c.g.slice(-10).map((x) => x.min)) });
  }
  setSlip(s); render();
}
function setLine(v) {
  const c = playerCtx(); if (!c) return;
  (S.detail.lines ||= {});
  if (v === 'reset') delete S.detail.lines[c.key];
  else S.detail.lines[c.key] = Math.max(0, Math.round(v * 2) / 2);
}

// ----- Fútbol: jugadores disponibles de la plantilla -----
const headshot = (path, id) => `https://a.espncdn.com/i/headshots/${path.startsWith('soccer') ? 'soccer' : 'nba'}/players/full/${id}.png`;
// Foto del jugador; si ESPN no tiene foto (muy común en fútbol) se muestran sus iniciales
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
function face(path, p, id, name) {
  const src = p?.headshot?.href || (path.startsWith('soccer') ? null : headshot(path, id));
  const ini = `<span class="ini">${esc(initials(name || p?.displayName))}</span>`;
  return src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ini',textContent:'${esc(initials(name || p?.displayName))}'}))">` : ini;
}
const ycDots = (arr) => arr.map((y) => `<i class="${y ? 'y' : ''}"></i>`).join('');
function soccerPlayersTab(a, side) {
  const ev = a.ev;
  const teamId = side === 'home' ? ev.home_id : ev.away_id, oppId = side === 'home' ? ev.away_id : ev.home_id;
  const abbr = side === 'home' ? ev.home_abbr : ev.away_abbr, logo = side === 'home' ? ev.home_logo : ev.away_logo;
  if (!S.detail.stat || !STATS[S.detail.stat]?.soccer) S.detail.stat = 'SOT';
  const stat = S.detail.stat;
  const roster = need('roster', teamId, `${espnBase(ev.path)}/teams/${teamId}/roster`);
  const tabs = statTabs(stat, SOC_ALL);
  if (!roster) return tabs + `<div class="card empty">${roster === null ? 'Plantilla no disponible.' : 'Cargando plantilla…'}</div>`;
  const athletes = roster.athletes || [];
  athletes.forEach((p) => need('glog', p.id, glogUrl(ev.path, p.id)));
  const dt = defTable(ev.path);
  const loading = athletes.filter((p) => peek('glog', p.id) === undefined).length;
  const rows = athletes.map((p) => {
    const gk = isGK(p);
    if ((stat === 'SV') !== gk) return null;
    const g = playerGames(ev.path, p.id); if (!g || g.length < 2) return null;
    const pr = projectPlayer(g, stat, oppId, side === 'home', dt);
    const line = S.detail.lines?.[p.id + '|' + stat] ?? suggestLine(pr.proj);
    const vals = pr.vals, h2h = g.filter((x) => String(x.oppId) === String(oppId)).map((x) => STATS[stat].f(x));
    return { p, gk, g, pr, line, prob: probOver(pr, line), cs: cardStreak(g), avgSh: mean(g.map((x) => x.sh)), avgSot: mean(g.map((x) => x.sot)), avgSv: mean(g.map((x) => x.sv)),
      season: rateAt(vals, line), h2h: rateAt(h2h, line), l5: rateAt(vals.slice(-5), line), l10: rateAt(vals.slice(-10), line), last: vals.slice(-10) };
  }).filter(Boolean).sort((x, y) => y.pr.proj - x.pr.proj);
  const rk = dt?.rank?.[String(oppId)];
  const card = (r) => {
    const mx = Math.max(...r.last, r.line * 1.3, 1);
    const pos = r.gk ? 'Arquero' : (posEs(r.p) || 'Jugador de campo');
    const kpis = r.gk
      ? `<div><span>Atajadas/partido</span><b>${num1(r.avgSv)}</b></div><div><span>Goles recibidos/p</span><b>${num1(mean(r.g.map((x) => x.gc)))}</b></div>`
      : `<div><span>Tiros a puerta/p</span><b>${num1(r.avgSot)}</b></div><div><span>Tiros/p</span><b>${num1(r.avgSh)}</b></div>${['SOT', 'SH'].includes(stat) ? '' : `<div><span>${esc(STATS[stat].label)}/p</span><b>${num1(r.pr.season)}</b></div>`}`;
    return `<div class="card pcard click" data-pl="${esc(side)}/${esc(r.p.id)}">
    <div class="phead"><div class="ph">${face(ev.path, r.p, r.p.id)}${logo ? `<img class="tl" src="${esc(logo)}" alt="">` : ''}</div>
      <div><b>${esc(r.p.displayName)}</b> <span class="mut tiny">${esc(abbr)} · ${esc(pos)} · ${r.g.length} PJ</span>
        <div><span class="acc">Más</span> ${fmtL(r.line)} ${STATS[stat].label.toLowerCase()} <span class="mut tiny">· proyección ${num1(r.pr.proj)}</span></div></div>
      <div class="pq"><span class="mut tiny">PROB. MÁS</span><b class="${rateCls(r.prob.over)}">${pctEs(r.prob.over)}</b></div><div class="pq"><span class="mut tiny">CUOTA JUSTA</span><b>${fmtOdd(1 / r.prob.over)}</b></div></div>
    <div class="rates soc">${kpis}
      <div><span>L5 % sobre línea</span><b class="${rateCls(r.l5)}">${pctEs(r.l5)}</b></div>
      <div><span>Últ. 5 amarillas</span><b class="ycd">${ycDots(r.cs.last5)}</b></div>
    </div>
    <div class="spark">${r.last.map((v) => `<i class="${v > r.line ? 'win' : 'loss'}" style="height:${Math.max(6, (v / mx) * 100)}%" title="${v}"></i>`).join('')}<em style="bottom:${(r.line / mx) * 100}%"></em></div>
    <div class="pmore">Ver perfil, ajustar línea y agregar al boleto ›</div>
  </div>`;
  };
  const gks = rows.filter((r) => r.gk), field = rows.filter((r) => !r.gk);
  const section = (title, list) => (list.length ? `<h4 style="margin:14px 2px 8px">${title}</h4>` + list.map(card).join('') : '');
  return tabs + `<p class="mut tiny" style="margin-bottom:10px">Plantilla de ${esc(abbr)} con sus partidos de la temporada. Jugadores de campo: tiros a puerta, tiros, asistencias, faltas cometidas y recibidas, fueras de juego. Arqueros: atajadas. Las amarillas de los últimos 5 partidos son solo un indicador de lo faltero que es. La línea es la proyección ALTOQ para este partido (ajustada por ${stat === 'SV' ? 'lo que ataca' : 'lo que concede'} el rival${rk ? `, ${rk}.º en goles recibidos` : ''}). Toca un jugador para mover la línea y agregarla al boleto.${loading ? ` Cargando ${loading} jugadores…` : ''}</p>`
    + (section(stat === 'SV' ? '' : 'JUGADORES DE CAMPO', stat === 'SV' ? [] : field) + section('ARQUEROS', stat === 'SV' ? gks : [])
      || `<div class="card empty">${loading ? 'Cargando jugadores…' : 'Sin datos de jugadores.'}</div>`);
}

// ----- Fútbol: bajas y sanciones en la pestaña Partido -----
function soccerBajasSection(ev, sum) {
  const teamBlock = (side) => {
    const teamId = side === 'home' ? ev.home_id : ev.away_id, abbr = side === 'home' ? ev.home_abbr : ev.away_abbr;
    const roster = need('roster', teamId, `${espnBase(ev.path)}/teams/${teamId}/roster`);
    if (!roster) return `<div><div class="ihead"><b>${esc(abbr)}</b></div><p class="mut tiny">${roster === null ? 'Plantilla no disponible.' : 'Cargando…'}</p></div>`;
    const ath = roster.athletes || [];
    ath.forEach((p) => need('glog', p.id, glogUrl(ev.path, p.id)));
    const rows = [];
    for (const p of ath) {
      // Lesiones (si ESPN las publica para esta liga)
      for (const inj of p.injuries || []) {
        const d = inj.details || {}, ret = d.returnDate ? new Date(d.returnDate) : null;
        const days = ret ? Math.max(0, Math.round((ret - new Date()) / 864e5)) : null;
        rows.push(`<div class="inj"><b>${esc(p.displayName)}</b> <span class="chip bad">${esc(INJ_ES[inj.status] || inj.status || 'Baja')}</span><div class="mut tiny">${esc([d.type, d.location].filter(Boolean).join(' · ') || 'Lesión')}${ret ? ` · regreso aprox. ${ret.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })} (${days} días)` : ''}</div></div>`);
      }
      // Sanciones probables a partir de su historial de tarjetas
      const g = playerGames(ev.path, p.id); if (!g || !g.length) continue;
      const last = g[g.length - 1], cs = cardStreak(g);
      if (last.rc > 0) rows.push(`<div class="inj"><b>${esc(p.displayName)}</b> <span class="chip bad">Roja en su último partido</span><div class="mut tiny">Probable sanción (${new Date(last.date).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })} vs ${esc(last.opp)}).</div></div>`);
      else if (cs.total >= 4) rows.push(`<div class="inj"><b>${esc(p.displayName)}</b> <span class="chip warn">${cs.total} amarillas</span><div class="mut tiny">Cerca del ciclo de suspensión por acumulación (depende del reglamento de la liga).</div></div>`);
    }
    return `<div><div class="ihead"><b>${esc(abbr)}</b></div>${rows.join('') || '<p class="mut tiny">Sin bajas ni sancionados detectados.</p>'}</div>`;
  };
  return `<div class="card"><div class="ihead"><h4>BAJAS, LESIONES Y SANCIONES</h4></div><div class="icols">${ord(ev, teamBlock('away'), teamBlock('home')).join('')}</div>
    <p class="mut tiny">Las sanciones salen del historial de tarjetas de cada jugador. ESPN no publica lesiones de fútbol con fecha de regreso; cuando las publique para esta liga aparecerán aquí automáticamente.</p></div>`;
}

// ----- Boleto: seguimiento en vivo de apuestas de jugador -----
// Estado del partido y la estadística actual del jugador desde el resumen en vivo de ESPN
function liveStat(it) {
  const sum = liveSum(it);
  if (!sum) return sum;
  const st = sum.header?.competitions?.[0]?.status || {};
  const state = st.type?.state || 'pre';
  const out = { state, detail: st.type?.shortDetail || '', period: st.period || 0, clock: st.displayClock || '', cur: null, min: null, found: false };
  if (it.path.startsWith('soccer')) {
    for (const t of sum.rosters || []) for (const r of t.roster || []) if (String(r.athlete?.id) === String(it.pid)) {
      out.found = true; out.starter = r.starter; out.subbedOut = r.subbedOut;
      const v = Object.fromEntries((r.stats || []).map((s) => [s.name, +s.value || +s.displayValue || 0]));
      out.box = v;
      out.cur = { SOT: v.shotsOnTarget, SH: v.totalShots, SV: v.saves, YC: v.yellowCards, SG: v.totalGoals, SAST: v.goalAssists, SGA: (+v.totalGoals || 0) + (+v.goalAssists || 0), FC: v.foulsCommitted, FS: v.foulsSuffered, OFF: v.offsides }[it.stat] ?? 0;
    }
    const m = parseInt(out.clock) || (state === 'post' ? 90 : 0);
    out.elapsed = Math.min(1, m / 90);
  } else {
    for (const t of sum.boxscore?.players || []) for (const s of t.statistics || []) {
      const keys = s.keys || [];
      for (const a of s.athletes || []) if (String(a.athlete?.id) === String(it.pid)) {
        out.found = true;
        const v = {}; keys.forEach((k, i) => (v[k] = a.stats?.[i]));
        const pair = (x) => String(x || '0-0').split('-').map((n) => parseInt(n) || 0);
        const [fgm, fga] = pair(v['fieldGoalsMade-fieldGoalsAttempted']), [tpm, tpa] = pair(v['threePointFieldGoalsMade-threePointFieldGoalsAttempted']), [ftm, fta] = pair(v['freeThrowsMade-freeThrowsAttempted']);
        const x = { points: +v.points || 0, reb: +v.rebounds || 0, ast: +v.assists || 0, tpm, tpa, fgm, fga, ftm, fta, stl: +v.steals || 0, blk: +v.blocks || 0, to: +v.turnovers || 0 };
        out.cur = STATS[it.stat].f(x); out.min = parseInt(v.minutes) || 0; out.box = x;
      }
    }
    // Tiempo de juego transcurrido (48 min + prórrogas)
    const [mm, ss] = String(out.clock || '0:00').split(':').map((n) => parseFloat(n) || 0);
    const left = mm + ss / 60, p = out.period || 0;
    const played = state === 'post' ? 48 : p <= 4 ? (p - 1) * 12 + (12 - left) : 48 + (p - 5) * 5 + (5 - left);
    out.elapsed = Math.max(0, Math.min(1, played / 48));
  }
  return out;
}
function trackBox(it) {
  if (!it.pid || !it.path) return '';
  const L = liveStat(it);
  if (L === undefined) return `<div class="track mut tiny">Cargando seguimiento…</div>`;
  if (!L) return '';
  const want = it.side === 'under' ? 'menos de' : 'más de';
  if (L.state === 'pre') return `<div class="track"><span class="mut tiny">Aún no empieza · proyección ${num1(it.proj)} ${STATS[it.stat].label.toLowerCase()} · necesitas ${want} ${fmtL(it.line)}</span></div>`;
  if (!L.found) return `<div class="track"><span class="chip warn">No aparece en el partido</span> <span class="mut tiny">Puede no estar convocado o en el banquillo.</span></div>`;
  const cur = L.cur ?? 0;
  // Lo que le queda: proyección × fracción de partido (o de sus minutos) que falta
  let remFrac = 1 - L.elapsed;
  if (!it.path.startsWith('soccer') && it.avgMin && L.min != null) remFrac = Math.max(0, Math.min(remFrac * 1.15, (it.avgMin - L.min) / it.avgMin));
  if (it.path.startsWith('soccer') && L.subbedOut) remFrac = 0;
  if (L.state === 'post') remFrac = 0;
  const restMean = Math.max(0, it.proj * remFrac);
  const finalProj = cur + restMean;
  const need = it.side === 'under' ? null : Math.max(0, Math.floor(it.line) + 1 - cur);
  let p;
  if (L.state === 'post') p = it.side === 'under' ? (cur < it.line ? 1 : 0) : (cur > it.line ? 1 : 0);
  else {
    const k = it.side === 'under' ? Math.ceil(it.line) - 1 - cur : Math.floor(it.line) - cur; // máximo que puede sumar sin pasar / mínimo que necesita menos uno
    const cdf = (x) => (x < 0 ? 0 : poissonCdf(x, Math.max(restMean, 1e-6)));
    p = it.side === 'under' ? cdf(k) : 1 - cdf(k);
  }
  const done = L.state === 'post';
  const status = done ? (p === 1 ? ['ok', 'Ganada'] : ['bad', 'Perdida']) : p >= 0.65 ? ['ok', 'Va bien · mantén'] : p >= 0.35 ? ['warn', 'Ajustada'] : ['bad', 'En riesgo'];
  const fairCash = +it.stake ? +it.stake * (it.price || 0) * p : null;
  const advice = done ? '' : p >= 0.65 ? 'Mantén la apuesta salvo que el cash out supere el valor justo.' : fairCash == null ? '' : p >= 0.35 ? `Si tu casa ofrece cash out de más de ${money(fairCash)}, conviene tomarlo; si ofrece menos, mantén.` : `Riesgo alto. Un cash out por encima de ${money(fairCash)} te conviene.`;
  const pctDone = Math.min(100, (cur / Math.max(it.line, 0.5)) * 100);
  return `<div class="track ${status[0]}">
    <div class="trow"><span class="chip ${status[0] === 'ok' ? 'okc' : status[0]}">${status[1]}</span>
      <span><b>${cur}</b> ${STATS[it.stat].label.toLowerCase()} de ${fmtL(it.line)} · ${esc(L.detail)}${L.min != null ? ` · ${L.min} min` : ''}</span></div>
    <div class="tbar"><i style="width:${pctDone}%"></i><em style="left:${Math.min(100, (it.line / Math.max(it.line, finalProj, cur) ) * 100)}%"></em></div>
    <div class="mut tiny">${done ? 'Final.' : `Proyección final: <b>${num1(finalProj)}</b>${need != null && need > 0 ? ` · le faltan ${need}` : ''} · prob. de acertar ahora: <b>${pct1(p)}</b>${fairCash != null ? ` · cash out justo ≈ <b>${money(fairCash)}</b>` : ''}`}</div>
    ${advice ? `<div class="tiny" style="margin-top:4px">${advice}</div>` : ''}
  </div>`;
}

// ---------- Pestaña Props: todas las apuestas de jugador de hoy según el deporte ----------
const favKey = () => 'favs:' + (S.user?.uid || 'anon');
const getFavs = () => new Set(store.get(favKey(), []));
const PROP_STATS_NBA = ['PTS', 'REB', 'AST', '3PM', 'PRA', 'PA', 'PR', 'RA'];
const POS_NBA = [['all', 'Todas'], ['G', 'G'], ['F', 'F'], ['C', 'C']];
const POS_SOC = [['all', 'Todas'], ['GK', 'Arq'], ['D', 'Def'], ['M', 'Med'], ['F', 'Del']];
function posGroup(p, soccer) {
  const a = (p?.position?.abbreviation || '').toUpperCase(), n = (p?.position?.name || p?.position?.displayName || '').toLowerCase();
  if (soccer) return isGK(p) ? 'GK' : /defend|back/.test(n) || /^(D|CB|LB|RB)/.test(a) ? 'D' : /mid/.test(n) || /^(M|CM|DM|AM)/.test(a) ? 'M' : 'F';
  return a.includes('C') && !a.includes('G') ? 'C' : a.includes('G') ? 'G' : 'F';
}
// Línea "llamativa": la que deja la probabilidad a favor (55-72 %) con una cuota justa que valga la pena (≈1,40-1,80).
// Nada de 1,10-1,20: esas no sirven para combinadas.
const P_MIN = 0.53, P_MAX = 0.66, P_TARGET = 0.6;
// Líneas mínimas en NBA: nada de props de relleno (Menos de 7,5 P+R de un suplente)
const MIN_LINE = { PTS: 9.5, REB: 3.5, AST: 2.5, '3PM': 1.5, PRA: 14.5, PR: 11.5, PA: 11.5, RA: 5.5 };
function bestLine(pr, soccer, stat) {
  const sides = soccer ? ['over'] : ['over', 'under'];
  let best = null;
  const top = Math.ceil(Math.max(pr.proj * 2, 3)) + 2;
  for (let k = 0; k <= top; k++) {
    const line = k + 0.5;
    for (const side of sides) {
      if (!soccer && line < (MIN_LINE[stat] ?? 1.5)) continue;
      const p = probOver(pr, line)[side];
      if (p < P_MIN || p > P_MAX) continue;
      const d = Math.abs(p - P_TARGET);
      if (!best || d < best.d) best = { line, pick: side, p, d };
    }
  }
  return best;
}
function propsGames() {
  const live = S.analysis.filter((a) => a.ev.state !== 'post' && a.ev.path && fcVisible(a));
  const today = limaDay(Date.now());
  const todays = live.filter((a) => limaDay(a.ev.commence_time) === today);
  if (todays.length) return todays;
  const next = live.map((a) => limaDay(a.ev.commence_time)).sort()[0];
  return live.filter((a) => limaDay(a.ev.commence_time) === next);
}
function viewProps() {
  if (isGuest()) return `<h2>Props</h2>` + lockCard('Las mejores apuestas del día, ordenadas por probabilidad del modelo');
  const soccer = S.liga === 'fc';
  const P = (S.props ||= { view: 'players', tramo: 'l10', stat: 'ALL', game: 'all', pos: 'all', onlyValue: false, favs: false });
  if (S.liga === 'nfl' && P.view === 'players') P.view = 'games';
  const statList = soccer ? SOC_ALL : PROP_STATS_NBA;
  if (P.stat !== 'ALL' && !statList.includes(P.stat)) P.stat = 'ALL';
  const games = propsGames();
  const chip = (k, lab) => `<button data-pstat="${k}" class="${P.stat === k ? 'on' : ''}">${esc(lab)}</button>`;
  const viewSeg = `<div class="seg">${S.liga === 'nfl' ? '' : `<button data-pview="players" class="${P.view === 'players' ? 'on' : ''}">Jugadores</button>`}<button data-pview="games" class="${P.view === 'games' ? 'on' : ''}">Partidos</button></div>`;
  const gameSel = `<select id="pGame"><option value="all">Todos los partidos</option>${games.map((a) => `<option value="${esc(a.ev.id)}" ${P.game === String(a.ev.id) ? 'selected' : ''}>${esc(matchName(a.ev))} · ${fmtTime(a.ev.commence_time)}</option>`).join('')}</select>`;
  if (P.view === 'games') {
    const head = `<div class="phead2"><div><h2 style="margin:0">Props de ${soccer ? 'hoy' : 'esta noche'}</h2><span class="mut">Resultados del partido según el modelo</span></div></div>
      <div class="ptools">${viewSeg}${gameSel}</div>`;
    if (!games.length) return head + `<div class="card empty">No hay partidos próximos en esta liga.</div>`;
    return head + games.filter((a) => P.game === 'all' || String(a.ev.id) === P.game).map(gameMarketsCard).join('')
      + `<p class="mut tiny">Probabilidades del modelo. ★ = la opción con la probabilidad a favor y una cuota que vale la pena (justa ≥ 1,40). Cuota casa = DraftKings vía ESPN cuando existe.</p>`;
  }
  const favs = getFavs();
  const tramoN = { l5: 5, l10: 10, l20: 20, season: 999 }[P.tramo];
  let pending = 0, total = 0;
  const rows = [];
  for (const a of games) {
    const ev = a.ev;
    if (P.game !== 'all' && String(ev.id) !== P.game) continue;
    const dt = defTable(ev.path);
    for (const side of ['away', 'home']) {
      const teamId = side === 'home' ? ev.home_id : ev.away_id, oppId = side === 'home' ? ev.away_id : ev.home_id;
      const abbr = side === 'home' ? ev.home_abbr : ev.away_abbr, oppAbbr = side === 'home' ? ev.away_abbr : ev.home_abbr;
      const roster = need('roster', teamId, `${espnBase(ev.path)}/teams/${teamId}/roster`);
      if (!roster) { pending++; continue; }
      for (const p of roster.athletes || []) {
        total++;
        need('glog', p.id, glogUrl(ev.path, p.id));
        const g = playerGames(ev.path, p.id);
        if (g === undefined) { pending++; continue; }
        if (!g || g.length < (soccer ? 4 : 5)) continue;
        if (!soccer && mean(g.slice(-10).map((x) => x.min)) < 18) continue;
        const grp = posGroup(p, soccer);
        if (P.pos !== 'all' && grp !== P.pos) continue;
        if (P.favs && !favs.has(String(p.id))) continue;
        const stats = P.stat === 'ALL' ? statList : [P.stat];
        let bestRow = null;
        for (const stat of stats) {
          if (soccer && (stat === 'SV') !== (grp === 'GK')) continue;
          const pr = projectPlayer(g, stat, oppId, side === 'home', dt);
          const b = bestLine(pr, soccer, stat); if (!b) continue;
          const vals = pr.vals, seg = vals.slice(-tramoN);
          const hits = seg.filter((v) => (b.pick === 'over' ? v > b.line : v < b.line)).length;
          const hr = seg.length ? hits / seg.length : null;
          if (hr == null || hr < 0.5) continue; // el historial también tiene que acompañar
          const value = b.p >= 0.6 && hr >= 0.6;
          if (P.onlyValue && !value) continue;
          const r = { ev, side, p, abbr, oppAbbr, stat, line: b.line, pick: b.pick, pm: b.p, pr, hits, n: seg.length, hr, value, fav: favs.has(String(p.id)), score: b.p + 0.6 * hr };
          if (P.stat !== 'ALL') rows.push(r);
          else if (!bestRow || r.score > bestRow.score) bestRow = r;
        }
        if (bestRow) rows.push(bestRow);
      }
    }
  }
  rows.sort((x, y) => y.score - x.score);
  const head = `<div class="phead2"><div><h2 style="margin:0">Props de ${soccer ? 'hoy' : 'esta noche'}</h2><span class="mut">${P.stat === 'ALL' ? 'La mejor apuesta de cada jugador' : esc(STATS[P.stat].label)} · cuota justa entre 1,50 y 1,90 con la probabilidad a favor</span></div>
      <div class="seg">${[['l5', 'L5'], ['l10', 'L10'], ['l20', 'L20'], ['season', 'Temporada']].map(([k, l]) => `<button data-ptramo="${k}" class="${P.tramo === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="ptools">${viewSeg}
      <div class="chips inline">${chip('ALL', 'Mejor de cada uno')}${statList.map((k) => chip(k, CHIP[k] || STATS[k].short)).join('')}</div>
    </div>
    <div class="ptools">${gameSel}
      <div class="seg">${(soccer ? POS_SOC : POS_NBA).map(([k, l]) => `<button data-ppos="${k}" class="${P.pos === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="pill ${P.onlyValue ? 'onp' : ''}" data-ptoggle="onlyValue" title="Prob. del modelo ≥ 60 % y acierto en el tramo ≥ 60 %">Más fiables</button>
      <button class="pill ${P.favs ? 'onp' : ''}" data-ptoggle="favs">★ Favoritas</button>
    </div>`;
  if (!games.length) return head + `<div class="card empty">No hay partidos próximos en esta liga.</div>`;
  const status = pending ? `<p class="mut tiny">Cargando jugadores… (${total - pending}/${total || '…'})</p>` : '';
  if (!rows.length) return head + status + `<div class="card empty">${pending ? 'Cargando…' : P.favs ? 'Aún no tienes favoritas: toca ☆ en un jugador.' : 'Ninguna prop cumple estos filtros.'}</div>`;
  const row = (r) => {
    const lab = (CHIP[r.stat] || STATS[r.stat].short);
    return `<div class="prow ${r.value ? 'val' : ''}">
      <button class="star ${r.fav ? 'on' : ''}" data-fav="${esc(r.p.id)}" title="Favorita">${r.fav ? '★' : '☆'}</button>
      <div class="ph sm">${face(r.ev.path, r.p, r.p.id)}</div>
      <div class="pinfo" data-openpl="${esc(r.ev.id)}|${r.side}|${esc(r.p.id)}|${r.stat}"><b>${esc(r.p.displayName)}</b><div class="mut tiny">${esc(r.abbr)} · ${esc(posEs(r.p))} · ${r.side === 'home' ? 'vs' : '@'} ${esc(r.oppAbbr)} · ${fmtTime(r.ev.commence_time)}</div></div>
      <div class="pline"><span class="${r.pick === 'over' ? 'acc' : ''}">${r.pick === 'over' ? 'Más' : 'Menos'}</span> <b>${fmtL(r.line)}</b> <span class="mut">${esc(lab)}</span><div class="mut tiny">proy. ${num1(r.pr.proj)}</div></div>
      <div class="pmet"><span class="mut tiny">Modelo</span><b class="${rateCls(r.pm)}">${pctEs(r.pm)}</b></div>
      <div class="pmet"><span class="mut tiny">${{ l5: 'L5', l10: 'L10', l20: 'L20', season: 'Temp.' }[P.tramo]}</span><b class="${rateCls(r.hr)}">${r.hits}/${r.n}</b></div>
      <div class="pmet"><span class="mut tiny">Cuota justa</span><b class="acc">${fmtOdd(1 / r.pm)}</b></div>
      <button class="add ${propInSlip(r) ? 'in' : ''}" data-qadd="${esc(r.ev.id)}|${r.side}|${esc(r.p.id)}|${r.stat}|${r.line}|${r.pick}">${propInSlip(r) ? '✓' : '+'}</button>
    </div>`;
  };
  const body = `<div class="card plist">${rows.slice(0, 120).map(row).join('')}</div>`;
  return head + status + body + `<p class="mut tiny">Para cada jugador se busca la línea en la que el modelo le da entre 53 % y 66 % (cuota justa ≈ 1,50-1,90) y que además se haya cumplido en al menos la mitad del tramo. “Más fiables”: modelo ≥ 60 % y acierto ≥ 60 %. Si tu casa paga más que la cuota justa, hay valor. Toca un jugador para mover la línea.</p>`;
}
// Tarjeta de un partido con sus mercados de resultado (sin estadísticas de jugadores)
function gameMarketsCard(a) {
  const ev = a.ev, pr = ev.pred;
  const items = gameMarketList(a);
  const cands = items.filter((x) => x.p != null && x.p >= 0.5 && 1 / x.p >= 1.4);
  const star = cands.sort((x, y) => y.p - x.p)[0];
  const rows = items.map((x) => {
    const added = getSlip().some((s) => s.id === x.id);
    return `<div class="gmrow ${x === star ? 'star1' : ''}"><div><span class="mut tiny">${esc(x.market)}</span><b>${x === star ? '★ ' : ''}${esc(x.label)}</b></div>
      <div class="pmet"><span class="mut tiny">Modelo</span><b class="${rateCls(x.p)}">${pctEs(x.p)}</b></div>
      <div class="pmet"><span class="mut tiny">Cuota justa</span><b>${x.p ? fmtOdd(1 / x.p) : '–'}</b></div>
      <div class="pmet"><span class="mut tiny">Casa</span><b>${x.price ? fmtOdd(x.price) : '–'}</b></div>
      <button class="add ${added ? 'in' : ''}" data-gadd="${esc(x.spec)}">${added ? '✓' : '+'}</button></div>`;
  }).join('');
  return `<div class="card plist"><h4 class="click" data-open="${esc(ev.id)}">${esc(matchName(ev, true))} · ${fmtTime(ev.commence_time)} ›</h4>${pr ? rows : '<p class="mut tiny">Modelo calculándose…</p>'}</div>`;
}
const propId = (evId, pid, stat, pick, line) => `${evId}|prop|${pid}|${stat}|${pick}|${line}`;
const propInSlip = (r) => getSlip().some((x) => x.id === propId(r.ev.id, r.p.id, r.stat, r.pick, r.line));
function quickAddProp(spec) {
  const [evId, side, pid, stat, lineS, pick] = spec.split('|'), line = +lineS;
  const a = S.analysis.find((x) => String(x.ev.id) === evId); if (!a) return;
  const ev = a.ev, oppId = side === 'home' ? ev.away_id : ev.home_id, teamId = side === 'home' ? ev.home_id : ev.away_id;
  const g = playerGames(ev.path, pid); if (!g) return;
  const p = peek('roster', teamId)?.athletes?.find((x) => String(x.id) === pid);
  const pr = projectPlayer(g, stat, oppId, side === 'home', defTable(ev.path));
  const pb = probOver(pr, line), pm = pick === 'over' ? pb.over : pb.under;
  const id = propId(evId, pid, stat, pick, line);
  let s = getSlip();
  if (s.some((x) => x.id === id)) s = s.filter((x) => x.id !== id);
  else s.push({ id, game: matchName(ev, true), time: ev.commence_time, market: 'Jugador · ' + STATS[stat].label,
    pick: `${p?.displayName || 'Jugador'} ${pick === 'over' ? 'Más' : 'Menos'} de ${num1(line)} ${STATS[stat].label.toLowerCase()}`,
    price: null, book: '', pModel: pm, path: ev.path, eventId: ev.id, pid, pname: p?.displayName, stat, line, side: pick, proj: pr.proj,
    avgMin: ev.path.startsWith('soccer') ? null : mean(g.slice(-10).map((x) => x.min)) });
  setSlip(s); render();
}

// ---------- Mercados de partido con línea ajustable (hándicap, goles, córners, 1.er tiempo, estadísticas) ----------
const isSoccerEv = (ev) => !!ev.path?.startsWith('soccer');
// Reparte un hándicap/total asiático de cuarto (x,25 / x,75) en dos medias apuestas
const halves = (L) => (Math.abs(L * 4) % 2 === 1 ? [L - 0.25, L + 0.25] : [L]);
// f(h, a, L) > 0 gana, = 0 devuelve, < 0 pierde. Devuelve prob. de ganar, de devolución y la prob. "efectiva" (la que da la cuota justa)
function evalLine(dist, f, L) {
  const hs = halves(L); let W = 0, Lo = 0, Pu = 0;
  for (const l of hs) for (const [k, p] of Object.entries(dist)) {
    const [h, a] = k.split('-').map(Number), v = f(h, a, l);
    if (v > 1e-9) W += p / hs.length; else if (v < -1e-9) Lo += p / hs.length; else Pu += p / hs.length;
  }
  return { win: W, push: Pu, lose: Lo, p: W + Lo > 0 ? W / (W + Lo) : null };
}
function poisPmf(l, max = 10) { const out = []; let p = Math.exp(-l); for (let k = 0; k <= max; k++) { out.push(p); p *= l / (k + 1); } return out; }
function poisDist(lh, la, sh = 0, sa = 0) {
  const H = poisPmf(lh), A = poisPmf(la), d = {};
  H.forEach((ph, i) => A.forEach((pa, j) => { d[`${i + sh}-${j + sa}`] = ph * pa; }));
  return d;
}
const liveMinute = (ev) => (ev.state === 'in' ? parseInt(ev.clock) || 0 : 0);
// Primer tiempo: ≈45 % de los goles esperados se marcan antes del descanso
function htDist(ev) {
  const pr = ev.pred; if (!pr?.xgHome) return null;
  if (ev.state === 'post' || (ev.state === 'in' && liveMinute(ev) >= 45)) return null;
  const rem = ev.state === 'in' ? Math.max(0, (45 - liveMinute(ev)) / 45) : 1;
  const sh = ev.state === 'in' ? +ev.score?.[1] || 0 : 0, sa = ev.state === 'in' ? +ev.score?.[0] || 0 : 0;
  return poisDist(pr.xgHome * 0.45 * rem, pr.xgAway * 0.45 * rem, sh, sa);
}
// Estadísticas de equipo de ESPN (por partido) que se usan para apostar
const TSTAT = {
  wonCorners: { label: 'Córners', short: 'córners', market: true },
  yellowCards: { label: 'Tarjetas amarillas', short: 'amarillas', market: true },
  shotsOnTarget: { label: 'Tiros a puerta', short: 'tiros a puerta', market: true },
  totalShots: { label: 'Tiros', short: 'tiros', market: true },
  foulsCommitted: { label: 'Faltas', short: 'faltas', market: true },
  offsides: { label: 'Fueras de juego', short: 'offsides', market: true },
  saves: { label: 'Atajadas', short: 'atajadas' },
  possessionPct: { label: 'Posesión %', short: '% posesión' },
  totalPasses: { label: 'Pases', short: 'pases' },
  accuratePasses: { label: 'Pases precisos', short: 'pases precisos' },
  totalTackles: { label: 'Entradas (tackles)', short: 'entradas' },
  totalCrosses: { label: 'Centros', short: 'centros' },
  interceptions: { label: 'Intercepciones', short: 'intercepciones' },
};
const sumUrl = (path, id) => `${espnBase(path)}/summary?event=${id}`;
const teamStatsOf = (sum, teamId) => {
  const t = sum?.boxscore?.teams || [], me = t.find((x) => String(x.team?.id) === String(teamId)), op = t.find((x) => x !== me);
  const m = (x) => Object.fromEntries((x?.statistics || []).map((s) => [s.name, parseFloat(s.displayValue)]).filter(([, v]) => isFinite(v)));
  return me && op && (me.statistics || []).length ? { me: m(me), op: m(op) } : null;
};
// Promedios a favor y en contra en sus últimos N partidos de liga
function teamStatAvgs(path, teamId, n = 8) {
  const games = teamGames(path, teamId); if (!games) return games;
  const last = games.slice(-n); let loading = 0;
  const rows = [];
  for (const g of last) { const s = need('sum', g.id, sumUrl(path, g.id)); if (s === undefined) { loading++; continue; } const t = teamStatsOf(s, teamId); if (t) rows.push(t); }
  const avg = (k, w) => { const v = rows.map((r) => r[w][k]).filter((x) => x != null); return v.length ? mean(v) : null; };
  const fr = {}, ag = {};
  for (const k of Object.keys(TSTAT)) { fr[k] = avg(k, 'me'); ag[k] = avg(k, 'op'); }
  return { n: rows.length, total: last.length, loading, for: fr, against: ag };
}
// Esperado en ESTE partido: media entre lo que hace el equipo y lo que concede el rival
function statModel(ev) {
  const H = teamStatAvgs(ev.path, ev.home_id), A = teamStatAvgs(ev.path, ev.away_id);
  if (!H || !A) return H === null || A === null ? null : undefined;
  const ex = (k, side) => { const [m, o] = side === 'home' ? [H, A] : [A, H]; const x = [m.for[k], o.against[k]].filter((v) => v != null); return x.length ? mean(x) : null; };
  return { H, A, ex, loading: H.loading + A.loading };
}
function statLambda(sm, sname, team) {
  const h = sm.ex(sname, 'home'), a = sm.ex(sname, 'away');
  return team === 'home' ? h : team === 'away' ? a : h != null && a != null ? h + a : null;
}
// Probabilidad del modelo para cualquier selección de partido
function gameProb(ev, mk, sel, point, sname, team) {
  const pr = ev.pred; if (!pr) return null;
  if (mk === 'h2h') return sel === 'home' ? pr.pHome : sel === 'away' ? pr.pAway : pr.pDraw;
  if (isSoccerEv(ev)) {
    const dist = pr.dist;
    if (mk === 'spreads' && dist) return evalLine(dist, (h, a, l) => (sel === 'home' ? h - a : a - h) + l, point).p;
    if (mk === 'totals' && dist) return evalLine(dist, (h, a, l) => (sel === 'over' ? h + a - l : l - h - a), point).p;
    if (mk === 'btts') return sel === 'yes' ? pr.pBTTS : 1 - pr.pBTTS;
    if (mk === 'ht1x2' || mk === 'httotals') {
      const d = htDist(ev); if (!d) return null;
      if (mk === 'httotals') return evalLine(d, (h, a, l) => (sel === 'over' ? h + a - l : l - h - a), point).p;
      let s = 0; for (const [k, p] of Object.entries(d)) { const [h, a] = k.split('-').map(Number); if (sel === 'home' ? h > a : sel === 'away' ? a > h : h === a) s += p; } return s;
    }
    if (mk === 'stat') {
      const sm = statModel(ev); if (!sm) return null;
      const lam = statLambda(sm, sname, team); if (lam == null) return null;
      const k = Math.floor(point), pAtMost = poissonCdf(k, lam), pPush = Number.isInteger(point) ? poisPmf(lam, k)[k] : 0;
      const over = 1 - pAtMost, under = pAtMost - pPush;
      return (sel === 'over' ? over : under) / (over + under);
    }
    return null;
  }
  const sd = pr.sd || 13;
  if (mk === 'spreads' && pr.margin != null) return sel === 'home' ? 1 - normCdf((-point - pr.margin) / sd) : normCdf((point - pr.margin) / sd);
  if (mk === 'totals' && pr.pOver != null && point === ev.lines?.total) return sel === 'over' ? pr.pOver : 1 - pr.pOver;
  return null;
}
function bookPrice(ev, mk, sel, point) {
  const L = ev.lines || {};
  if (mk === 'h2h') return sel === 'home' ? L.mlHome : sel === 'away' ? L.mlAway : L.mlDraw;
  if (mk === 'spreads' && L.spreadHome != null) { if (sel === 'home' && point === L.spreadHome) return L.spreadHomePrice; if (sel === 'away' && point === -L.spreadHome) return L.spreadAwayPrice; }
  if (mk === 'totals' && point === L.total) return sel === 'over' ? L.overPrice : L.underPrice;
  return null;
}
function legLabel(ev, mk, sel, point, sname, team) {
  const soc = isSoccerEv(ev), ab = (s) => (s === 'home' ? ev.home_abbr : ev.away_abbr), tm = (s) => (s === 'home' ? ev.home_team : s === 'away' ? ev.away_team : 'Empate');
  const ou = sel === 'over' ? 'Más' : 'Menos';
  if (mk === 'h2h') return tm(sel);
  if (mk === 'spreads') return `${ab(sel)} ${signed(point)}`;
  if (mk === 'totals') return `${ou} de ${fmtL(point)} ${soc ? 'goles' : 'puntos'}`;
  if (mk === 'btts') return `Ambos marcan: ${sel === 'yes' ? 'Sí' : 'No'}`;
  if (mk === 'ht1x2') return `1.er tiempo: ${tm(sel)}`;
  if (mk === 'httotals') return `1.er tiempo: ${ou} de ${fmtL(point)} goles`;
  if (mk === 'stat') return `${ou} de ${fmtL(point)} ${TSTAT[sname].short}${team !== 'all' ? ' de ' + ab(team) : ' (total)'}`;
  return '';
}
const MK_NAME = { h2h: 'Ganador', spreads: 'Hándicap', totals: 'Total', btts: 'Ambos marcan', ht1x2: '1.er tiempo', httotals: 'Goles 1.er tiempo', stat: 'Estadísticas' };
const gSpec = (ev, mk, sel, point = '', sname = '', team = '') => [ev.id, mk, sel, point, sname, team].join('~');
const gId = (spec) => 'g|' + spec;
function specParts(spec) {
  const [evId, mk, sel, pointS, sname, team] = spec.split('~');
  return { evId, mk, sel, point: pointS === '' ? null : +pointS, sname, team };
}
function addGameLeg(spec) {
  const { evId, mk, sel, point, sname, team } = specParts(spec);
  const a = S.analysis.find((x) => String(x.ev.id) === evId); if (!a) return;
  const ev = a.ev, id = gId(spec);
  let s = getSlip();
  if (s.some((x) => x.id === id)) s = s.filter((x) => x.id !== id);
  else {
    const price = bookPrice(ev, mk, sel, point);
    s.push({ id, game: matchName(ev, true), time: ev.commence_time, market: mk === 'stat' ? TSTAT[sname].label : MK_NAME[mk], pick: legLabel(ev, mk, sel, point, sname, team),
      price: price || null, book: price ? ev.provider || 'Casa' : '', pModel: gameProb(ev, mk, sel, point, sname, team),
      path: ev.path, eventId: ev.id, mk, sel, point, sname, team, homeName: ev.home_team });
  }
  setSlip(s); render();
}
const inSlipSpec = (spec) => getSlip().some((x) => x.id === gId(spec));
function gItem(ev, mk, sel, point, sname, team) {
  const spec = gSpec(ev, mk, sel, point ?? '', sname || '', team || '');
  return { market: mk === 'stat' ? TSTAT[sname].label : MK_NAME[mk], label: legLabel(ev, mk, sel, point, sname, team), p: gameProb(ev, mk, sel, point, sname, team), price: bookPrice(ev, mk, sel, point), spec, id: gId(spec) };
}
// Lista de mercados de resultado para la vista "Partidos" de Props
function gameMarketList(a) {
  const ev = a.ev, pr = ev.pred, L = ev.lines || {}; if (!pr) return [];
  const it = [];
  const [s1, s2] = ord(ev, 'away', 'home');
  it.push(gItem(ev, 'h2h', s1)); if (isSoccerEv(ev)) it.push(gItem(ev, 'h2h', 'draw')); it.push(gItem(ev, 'h2h', s2));
  if (isSoccerEv(ev)) {
    const sp = L.spreadHome ?? pr.ah?.line ?? -0.5;
    it.push(gItem(ev, 'spreads', 'home', sp), gItem(ev, 'spreads', 'away', -sp));
    const t = L.total ?? 2.5;
    it.push(gItem(ev, 'totals', 'over', t), gItem(ev, 'totals', 'under', t));
    if (t !== 1.5) it.push(gItem(ev, 'totals', 'over', 1.5));
    if (t !== 3.5) it.push(gItem(ev, 'totals', 'under', 3.5));
    it.push(gItem(ev, 'btts', 'yes'), gItem(ev, 'btts', 'no'));
  } else {
    if (L.spreadHome != null) it.push(gItem(ev, 'spreads', s1, s1 === 'home' ? L.spreadHome : -L.spreadHome), gItem(ev, 'spreads', s2, s2 === 'home' ? L.spreadHome : -L.spreadHome));
    if (L.total != null) it.push(gItem(ev, 'totals', 'over', L.total), gItem(ev, 'totals', 'under', L.total));
  }
  return it;
}
// Fila de mercado: probabilidad del modelo, cuota justa, cuota de la casa y botón al boleto
function mrow(x, lab) {
  const added = inSlipSpec(x.spec);
  return `<div class="mrow"><span class="ml">${esc(lab || x.label)}</span><b class="${rateCls(x.p)}">${pctEs(x.p)}</b><span class="mut tiny">justa <b>${x.p ? fmtOdd(1 / x.p) : '–'}</b>${x.price ? ` · casa <b>${fmtOdd(x.price)}</b>` : ''}</span><button class="add ${added ? 'in' : ''}" data-gadd="${esc(x.spec)}">${added ? '✓' : '+'}</button></div>`;
}
const mstate = () => (S.detail.m ||= {});
const stepper = (key, val, txt, step) => `<div class="stepper sm"><button data-mstep="${key}|${-step}">−</button><b>${txt ?? fmtL(val)}</b><button data-mstep="${key}|${step}">+</button></div>`;

// Fútbol · Partido: hándicap y goles con línea ajustable, córners y acceso al 1.er tiempo
function soccerMarketsSection(a) {
  const ev = a.ev, pr = ev.pred, L = ev.lines || {}, M = mstate();
  if (!pr?.dist) return '';
  M.ahSide ||= 'home';
  M.ah ??= L.spreadHome ?? pr.ah?.line ?? -0.5;
  M.goals ??= L.total ?? 2.5;
  const ahLine = M.ahSide === 'home' ? M.ah : -M.ah;
  const ahE = evalLine(pr.dist, (h, a2, l) => (M.ahSide === 'home' ? h - a2 : a2 - h) + l, ahLine);
  const ahItem = gItem(ev, 'spreads', M.ahSide, ahLine);
  const sideBtn = (s) => `<button data-mset="ahSide|${s}" class="${M.ahSide === s ? 'on' : ''}">${esc(s === 'home' ? ev.home_abbr : ev.away_abbr)}</button>`;
  const hand = `<div class="card mk2"><div class="mkh"><span class="mut">Hándicap asiático</span><div class="seg sm">${ord(ev, sideBtn('away'), sideBtn('home')).join('')}</div></div>
    ${stepper('ah', M.ah, `${esc(M.ahSide === 'home' ? ev.home_abbr : ev.away_abbr)} ${signed(ahLine)}`, M.ahSide === 'home' ? 0.25 : -0.25)}
    <div class="mkn"><div><span>Gana</span><b class="${rateCls(ahE.win)}">${pctEs(ahE.win)}</b></div><div><span>Devuelve</span><b>${pctEs(ahE.push)}</b></div><div><span>Cuota justa</span><b class="acc">${ahE.p ? fmtOdd(1 / ahE.p) : '–'}</b></div><div><span>Casa</span><b>${ahItem.price ? fmtOdd(ahItem.price) : '–'}</b></div></div>
    <button class="btn ${inSlipSpec(ahItem.spec) ? 'ghost' : 'google'} sm" data-gadd="${esc(ahItem.spec)}">${inSlipSpec(ahItem.spec) ? '✓ En boleto' : '+ Boleto'}</button></div>`;
  // Ganador del 1.er tiempo (siempre visible, con su probabilidad y botón al boleto)
  const hd = htDist(ev);
  const order = ord(ev, 'away', 'home');
  const ht = `<div class="card mk2"><div class="mkh"><span class="mut">Ganador del 1.er tiempo</span><span class="mut tiny">xG 1T ${num1((pr.xgHome + pr.xgAway) * 0.45)}</span></div>
    ${hd ? [order[0], 'draw', order[1]].map((s) => mrow(gItem(ev, 'ht1x2', s), s === 'draw' ? 'Empate al descanso' : `Gana ${s === 'home' ? ev.home_abbr : ev.away_abbr} al descanso`)).join('') : '<p class="mut tiny">El primer tiempo ya terminó.</p>'}
    <button class="linkbtn" data-dtab="stats">Goles, córners y más estadísticas ›</button></div>`;
  return `<div class="sec"><h4>HÁNDICAP Y 1.ER TIEMPO</h4><span class="mut tiny">mueve la línea con − / +</span></div>
    <div class="mks2">${hand}${ht}</div>
    <p class="mut tiny">Salen de la distribución de marcadores del modelo (50.000 simulaciones). En líneas de cuarto (−0,25, −0,75…) la mitad va a cada línea. Al descanso se asume ≈45 % de los goles esperados. Cuota casa solo si coincide con la línea de ${esc(ev.provider || 'la casa')}.</p>`;
}

// Fútbol · Estadísticas: tarjeta de goles (total, ambos marcan y 1.er tiempo)
function goalsCard(ev) {
  const pr = ev.pred, L = ev.lines || {}, M = mstate();
  if (!pr?.dist) return `<div class="card"><h4>GOLES</h4><p class="mut tiny">${S.modelStatus && !S.modelStatus.includes('N/D') ? 'Calculando el modelo…' : 'Modelo no disponible para este partido.'}</p></div>`;
  M.goals ??= L.total ?? 2.5;
  M.htGoals ??= 0.5;
  const hd = htDist(ev);
  const order = ord(ev, 'away', 'home');
  return `<div class="card"><h4>GOLES</h4>
    <div class="cbig">${order.map((s) => `<div><span class="mut">${esc(s === 'home' ? ev.home_abbr : ev.away_abbr)}</span><b>${num1(s === 'home' ? pr.xgHome : pr.xgAway)}</b></div>`).join(`<div><span class="mut">Total</span><b class="acc">${num1(pr.xgHome + pr.xgAway)}</b></div>`)}</div>
    <div class="strow"><div class="sthead"><b>Partido</b><span class="mut tiny">goles esperados ${num1(pr.xgHome + pr.xgAway)}</span>${stepper('goals', M.goals, null, 0.5)}</div>
      ${mrow(gItem(ev, 'totals', 'over', M.goals), 'Más de ' + fmtL(M.goals))}${mrow(gItem(ev, 'totals', 'under', M.goals), 'Menos de ' + fmtL(M.goals))}</div>
    <div class="strow"><div class="sthead"><b>Ambos marcan</b></div>${mrow(gItem(ev, 'btts', 'yes'), 'Sí')}${mrow(gItem(ev, 'btts', 'no'), 'No')}</div>
    ${hd ? `<div class="strow"><div class="sthead"><b>1.er tiempo</b><span class="mut tiny">esperados ${num1((pr.xgHome + pr.xgAway) * 0.45)}</span>${stepper('htGoals', M.htGoals, null, 1)}</div>
      ${mrow(gItem(ev, 'httotals', 'over', M.htGoals), 'Más de ' + fmtL(M.htGoals))}${mrow(gItem(ev, 'httotals', 'under', M.htGoals), 'Menos de ' + fmtL(M.htGoals))}</div>` : ''}</div>`;
}
// Fútbol · pestaña Estadísticas: córners primero y luego el resto de mercados de estadísticas
function statsTab(a) {
  const ev = a.ev;
  if (isGuest()) return lockCard('Córners, tarjetas, tiros y más estadísticas del partido');
  const sm = statModel(ev);
  if (sm === undefined) return goalsCard(ev) + `<div class="card empty">Cargando estadísticas de los últimos partidos…</div>`;
  if (!sm) return goalsCard(ev) + `<div class="card empty">Estadísticas no disponibles para este partido.</div>`;
  const M = mstate();
  const rowsFor = (sname, team) => {
    const lam = statLambda(sm, sname, team); if (lam == null) return '';
    const key = `st:${sname}:${team}`;
    M[key] ??= Math.floor(lam) + 0.5;
    const t = team === 'all' ? 'Total' : team === 'home' ? ev.home_abbr : ev.away_abbr;
    return `<div class="strow"><div class="sthead"><b>${esc(t)}</b><span class="mut tiny">esperados ${num1(lam)}</span>${stepper(key, M[key], null, 1)}</div>
      ${mrow(gItem(ev, 'stat', 'over', M[key], sname, team), 'Más de ' + fmtL(M[key]))}${mrow(gItem(ev, 'stat', 'under', M[key], sname, team), 'Menos de ' + fmtL(M[key]))}</div>`;
  };
  const cH = statLambda(sm, 'wonCorners', 'home'), cA = statLambda(sm, 'wonCorners', 'away');
  const cornersCard = `<div class="card"><h4>CÓRNERS</h4>
    <div class="cbig">${ord(ev, `<div><span class="mut">${esc(ev.away_abbr)}</span><b>${num1(cA)}</b></div>`, `<div><span class="mut">${esc(ev.home_abbr)}</span><b>${num1(cH)}</b></div>`).join(`<div><span class="mut">Total</span><b class="acc">${num1(cH != null && cA != null ? cH + cA : null)}</b></div>`)}</div>
    ${rowsFor('wonCorners', 'all')}${ord(ev, rowsFor('wonCorners', 'away'), rowsFor('wonCorners', 'home')).join('')}</div>`;
  const others = ['yellowCards', 'shotsOnTarget', 'totalShots', 'foulsCommitted', 'offsides'].map((k) => `<div class="card"><h4>${esc(TSTAT[k].label.toUpperCase())}</h4>${rowsFor(k, 'all')}${ord(ev, rowsFor(k, 'away'), rowsFor(k, 'home')).join('')}</div>`).join('');
  const fmtS = (v, k) => (v == null ? '–' : k === 'possessionPct' ? Math.round(v) + ' %' : num1(v));
  const [T1, T2] = ord(ev, ['away', sm.A, ev.away_abbr], ['home', sm.H, ev.home_abbr]);
  const table = `<div class="card"><h4>PROMEDIOS POR PARTIDO</h4><div class="scroll"><table class="mtable st"><tr><th></th><th colspan="2">${esc(T1[2])}</th><th colspan="2">${esc(T2[2])}</th></tr>
    <tr class="mut tiny"><td></td><td>a favor</td><td>en contra</td><td>a favor</td><td>en contra</td></tr>
    ${Object.entries(TSTAT).map(([k, d]) => `<tr><td>${esc(d.label)}</td><td><b>${fmtS(T1[1].for[k], k)}</b></td><td>${fmtS(T1[1].against[k], k)}</td><td><b>${fmtS(T2[1].for[k], k)}</b></td><td>${fmtS(T2[1].against[k], k)}</td></tr>`).join('')}</table></div>
    <p class="mut tiny">Últimos ${sm.H.n} partidos de ${esc(ev.home_abbr)} y ${sm.A.n} de ${esc(ev.away_abbr)} en esta competición (ESPN).</p></div>`;
  return `${sm.loading ? `<p class="mut tiny">Cargando ${sm.loading} partidos…</p>` : ''}${goalsCard(ev)}${cornersCard}${others}${table}
    <p class="mut tiny">Esperado = media entre lo que hace cada equipo y lo que le hacen a su rival. Probabilidad con Poisson; la línea se mueve con − / +. Antes del partido; en directo no se recalcula.</p>`;
}

// ---------- Directo de la apuesta: marcador por periodos y gráfica de la estadística vs lo esperado ----------
// Resumen en vivo: se vuelve a pedir cada 10 s, pero mientras llega se sigue mostrando el último (sin parpadeo)
function liveSum(it) {
  const k = String(it.eventId), c = D.live[k];
  const done = c?.v?.header?.competitions?.[0]?.status?.type?.state === 'post';
  if (!c || (!c.busy && Date.now() - c.t > (done ? 6e5 : LIVE_MS))) {
    const prev = c?.v;
    D.live[k] = { t: c?.t || 0, v: prev, busy: true };
    getJ(bust(`${espnBase(it.path)}/summary?event=${it.eventId}`)).then((v) => { D.live[k] = { t: Date.now(), v: v ?? prev }; rerenderDetail(); });
  }
  return D.live[k].v;
}
const ZERO = { points: 0, reb: 0, ast: 0, tpm: 0, tpa: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, stl: 0, blk: 0, to: 0, sh: 0, sot: 0, sv: 0, yc: 0, goals: 0, assists: 0, fouls: 0, fs: 0, off: 0 };
const nbaT = (period, clock) => {
  const s = String(clock || '0'); const left = s.includes(':') ? +s.split(':')[0] + (+s.split(':')[1] || 0) / 60 : (parseFloat(s) || 0) / 60;
  return period <= 4 ? (period - 1) * 12 + (12 - left) : 48 + (period - 5) * 5 + (5 - left);
};
const pName = (it) => it.pname || String(it.pick || '').split(/ (Más|Menos) de /)[0];
// Serie acumulada de la estadística del jugador a lo largo del partido
function statSeries(sum, it) {
  const soccer = it.path.startsWith('soccer'), pid = String(it.pid), f = STATS[it.stat].f;
  const st = sum.header?.competitions?.[0]?.status || {}, state = st.type?.state;
  const pts = [];
  let tNow;
  if (!soccer) {
    for (const p of sum.plays || []) {
      const ids = (p.participants || []).map((x) => String(x.athlete?.id || ''));
      const type = p.type?.text || '', text = p.text || '', ft = /free throw/i.test(type + ' ' + text);
      const inc = { ...ZERO };
      if (ids[0] === pid) {
        if (p.scoringPlay) { inc.points = +p.scoreValue || 0; if (+p.scoreValue === 3) inc.tpm = 1; if (ft) inc.ftm = 1; else inc.fgm = 1; }
        if (p.shootingPlay) { if (ft) inc.fta = 1; else { inc.fga = 1; if (/three point|3-pt/i.test(text) || +p.scoreValue === 3) inc.tpa = 1; } }
        if (/rebound/i.test(type)) inc.reb = 1;
        if (/turnover/i.test(type)) inc.to = 1;
      }
      if (ids[1] === pid) {
        if (p.scoringPlay && !ft) inc.ast = 1;
        if (/steal/i.test(text)) inc.stl = 1;
        if (/block/i.test(text)) inc.blk = 1;
      }
      const v = f(inc); if (v) pts.push([nbaT(p.period?.number || 1, p.clock?.displayValue), v]);
    }
    tNow = state === 'post' ? Math.max(48, ...pts.map((x) => x[0])) : nbaT(st.period || 1, st.displayClock);
    if (state === 'post') { const per = st.period || 4; tNow = per <= 4 ? 48 : 48 + (per - 4) * 5; }
  } else {
    let name = null;
    for (const t of sum.rosters || []) for (const r of t.roster || []) if (String(r.athlete?.id) === pid) name = r.athlete.displayName;
    name ||= pName(it);
    const isGoal = (ty) => /^goal|penalty---scored/.test(ty);
    for (const c of sum.commentary || []) {
      const p = c.play; if (!p) continue;
      const ty = p.type?.type || '', text = p.text || c.text || '', parts = (p.participants || []).map((x) => x.athlete?.displayName);
      const inc = { ...ZERO }, me = parts[0] === name;
      if (me && (/^shot-/.test(ty) || isGoal(ty)) && !/own goal/i.test(text)) { inc.sh = 1; if (ty === 'shot-on-target' || isGoal(ty)) inc.sot = 1; if (isGoal(ty)) inc.goals = 1; }
      if (isGoal(ty) && parts[1] === name) inc.assists = 1;
      if (ty === 'foul' && me) { if (/^Foul by/i.test(text)) inc.fouls = 1; else if (/wins a free kick/i.test(text)) inc.fs = 1; }
      if (ty === 'offside' && text.includes(name + ' is caught offside')) inc.off = 1;
      if (ty === 'shot-on-target' && new RegExp('saved .* by ' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(').test(text)) inc.sv = 1;
      if (ty === 'yellow-card' && me) inc.yc = 1;
      const v = f(inc); if (v) pts.push([(+p.clock?.value || +c.time?.value || 0) / 60, v]);
    }
    tNow = state === 'post' ? Math.max(90, ...pts.map((x) => x[0])) : (parseInt(st.displayClock) || 0);
  }
  pts.sort((x, y) => x[0] - y[0]);
  return { pts, tNow, soccer, periods: st.period || 0 };
}
// Gráfica SVG: escalones naranjas (lo que lleva), línea discontinua (la línea de la apuesta), punteada (ritmo esperado)
function liveChart(series, line, proj, cur) {
  const W = 640, Hh = 200, padL = 44, padR = 54, padT = 16, padB = 26;
  const reg = series.soccer ? 90 : 48;
  const tMax = Math.max(reg, series.tNow);
  const yMax = Math.max(line, proj || 0, cur, 1) * 1.15;
  const x = (t) => padL + (t / tMax) * (W - padL - padR), y = (v) => padT + (1 - v / yMax) * (Hh - padT - padB);
  let d = `M${x(0)},${y(0)}`, acc = 0;
  for (const [t, v] of series.pts) { if (t > series.tNow + 0.01) break; d += ` H${x(t).toFixed(1)}`; acc += v; d += ` V${y(acc).toFixed(1)}`; }
  if (acc !== cur && series.tNow > 0) { d += ` H${x(series.tNow).toFixed(1)} V${y(cur).toFixed(1)}`; acc = cur; }
  d += ` H${x(series.tNow).toFixed(1)}`;
  // Marcas de periodo
  const marks = [];
  if (series.soccer) { marks.push([0, 45, '1T'], [45, 90, '2T']); if (tMax > 90) marks.push([90, tMax, '+']); }
  else { for (let i = 0; i < 4; i++) marks.push([i * 12, (i + 1) * 12, 'C' + (i + 1)]); for (let t = 48, k = 1; t < tMax; t += 5, k++) marks.push([t, t + 5, 'P' + k]); }
  const grid = marks.map(([a, b, l]) => `<line x1="${x(b)}" x2="${x(b)}" y1="${padT}" y2="${Hh - padB}" class="cg"/><text x="${(x(a) + x(b)) / 2}" y="${Hh - 6}" class="cl">${l}</text>`).join('');
  const projLine = proj != null ? `<line x1="${x(0)}" y1="${y(0)}" x2="${x(reg)}" y2="${y(proj)}" class="cp"/><text x="${x(reg) - 4}" y="${y(proj) - 6}" class="cl" text-anchor="end">${fmtL(num1(proj))}</text>` : '';
  return `<svg class="lchart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Evolución en el partido">
    ${grid}<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" class="ca"/>
    <text x="${padL - 6}" y="${y(0) + 4}" class="cl" text-anchor="end">0</text>
    <line x1="${padL}" x2="${W - padR}" y1="${y(line)}" y2="${y(line)}" class="cline"/><text x="${padL - 6}" y="${y(line) + 4}" class="cl b" text-anchor="end">${fmtL(line)}</text>
    ${projLine}<path d="${d}" class="cs"/><circle cx="${x(series.tNow)}" cy="${y(acc)}" r="4.5" class="cdot"/>
    <text x="${x(series.tNow) + 8}" y="${y(acc) + 4}" class="cl b">${cur}</text></svg>`;
}
// Marcador con los parciales por periodo
function scoreBoard(sum, path) {
  const comp = sum?.header?.competitions?.[0]; if (!comp) return '';
  const cs = comp.competitors || [], st = comp.status?.type || {};
  const soccer = path.startsWith('soccer');
  const H = cs.find((c) => c.homeAway === 'home'), A = cs.find((c) => c.homeAway === 'away');
  const [L, R] = soccer ? [H, A] : [A, H];
  const n = Math.max(...cs.map((c) => (c.linescores || []).length), 0);
  const lab = (i) => (soccer ? (i === 0 ? '1T' : i === 1 ? '2T' : 'Pr' + (i - 1)) : i < 4 ? i + 1 + '.º' : 'P' + (i - 3));
  const row = (c) => `<tr><td><b>${esc(c?.team?.abbreviation)}</b></td>${Array.from({ length: n }, (_, i) => `<td>${esc(c?.linescores?.[i]?.displayValue ?? '–')}</td>`).join('')}<td><b>${esc(c?.score ?? '–')}</b></td></tr>`;
  const logo = (c) => c?.team?.logos?.[0]?.href || c?.team?.logo || '';
  return `<div class="sboard"><div class="sbt">${logo(L) ? `<img src="${esc(logo(L))}" alt="">` : ''}<b>${esc(L?.team?.abbreviation)}</b></div>
    <div class="sbc"><b class="sbs">${esc(L?.score ?? 0)} – ${esc(R?.score ?? 0)}</b><span class="mut">${esc(st.state === 'pre' ? 'Aún no empieza' : st.shortDetail || '')}</span>
      ${n ? `<table class="sbl"><tr><td></td>${Array.from({ length: n }, (_, i) => `<th>${lab(i)}</th>`).join('')}<th>T</th></tr>${row(L)}${row(R)}</table>` : ''}</div>
    <div class="sbt r"><b>${esc(R?.team?.abbreviation)}</b>${logo(R) ? `<img src="${esc(logo(R))}" alt="">` : ''}</div></div>`;
}
// Tarjeta de un jugador dentro del directo
function liveLegCard(it, sum) {
  const L = liveStat(it), soccer = it.path.startsWith('soccer');
  const name = pName(it);
  const cur = L?.cur ?? 0, done = L?.state === 'post';
  const lp = propLiveP(it).p;
  const st = !L || L.state === 'pre' ? ['', 'Aún no empieza'] : done ? (lp === 1 ? ['ok', 'Acertada'] : ['bad', 'Fallada']) : lp >= 0.65 ? ['ok', 'Va bien'] : lp >= 0.35 ? ['warn', 'Ajustada'] : ['bad', 'En riesgo'];
  const ser = sum && L && L.state !== 'pre' ? statSeries(sum, it) : null;
  const box = L?.box || {};
  const tiles = soccer
    ? [['Goles', box.totalGoals], ['Tiros', box.totalShots], ['A puerta', box.shotsOnTarget], ['Asist.', box.goalAssists], ['Faltas', box.foulsCommitted], ['F. recib.', box.foulsSuffered], ['Offsides', box.offsides], ...(it.stat === 'SV' ? [['Atajadas', box.saves]] : [])]
    : [['MIN', L?.min], ['PTS', box.points], ['REB', box.reb], ['AST', box.ast], ['3PM', box.tpm], ['TC', box.fga != null ? `${box.fgm}-${box.fga}` : null]];
  const want = it.side === 'under' ? 'Menos' : 'Más';
  return `<div class="lcard lc-${st[0]}">
    <div class="lch"><div class="ph">${face(it.path, null, it.pid, name)}</div><div><b>${esc(name)}</b><div class="mut">${want} de ${fmtL(it.line)} ${esc(STATS[it.stat].label)}</div></div>
      <div class="lcv"><b class="${st[0]}">${cur}</b><span class="mut"> / ${fmtL(it.line)}</span></div></div>
    <div class="tbar big ${st[0]}"><i style="width:${Math.min(100, (cur / Math.max(it.line * 1.07, cur, 0.5)) * 100)}%"></i><em style="left:${(it.line / Math.max(it.line * 1.07, cur, 0.5)) * 100}%"></em></div>
    <div class="${st[0]} tiny" style="margin:6px 0">${st[1]}${L && !done && L.state === 'in' && lp != null ? ` · prob. de acertar ahora ${pct1(lp)}` : ''}</div>
    ${ser ? liveChart(ser, it.line, it.proj, cur) : ''}
    ${L && L.state !== 'pre' ? `<div class="ltiles">${tiles.map(([k, v]) => `<div><span>${k}</span><b>${v ?? '–'}</b></div>`).join('')}</div>` : ''}
    ${ser ? `<p class="mut tiny">Naranja: lo que lleva · discontinua: tu línea · punteada: ritmo esperado según la proyección (${fmtL(num1(it.proj))}). Si va por encima de la punteada, va mejor de lo esperado.</p>` : ''}
  </div>`;
}
// Directo completo de una apuesta registrada (agrupado por partido)
function betLiveDetail(b) {
  const byEv = new Map();
  for (const it of b.legs) { if (!it.eventId || !it.path) continue; if (!byEv.has(it.eventId)) byEv.set(it.eventId, []); byEv.get(it.eventId).push(it); }
  return [...byEv.values()].map((legs) => {
    const sum = liveSum(legs[0]);
    if (sum === undefined) return `<div class="lbox"><p class="mut tiny">Cargando el directo…</p></div>`;
    if (!sum) return '';
    return `<div class="lbox">${scoreBoard(sum, legs[0].path)}${legs.map((it) => (it.pid ? liveLegCard(it, sum) : `<div class="lcard"><b>${esc(it.pick)}</b>${legLiveHtml(it)}</div>`)).join('')}</div>`;
  }).join('');
}
// Valor actual y estado de cada selección para la lista resumida
function legNow(it) {
  if (it.pid) {
    const L = liveStat(it), lp = propLiveP(it).p;
    const cls = !L || L.state === 'pre' ? 'pend' : L.state === 'post' ? (lp === 1 ? 'ok' : 'bad') : lp >= 0.5 ? 'ok' : 'warn';
    return { cls, val: L && L.state !== 'pre' ? `${L.cur ?? 0} / ${fmtL(it.line)}` : '' };
  }
  const g = gameLegLive(it);
  if (!g || g.state === 'pre') return { cls: 'pend', val: '' };
  return { cls: g.state === 'post' ? (g.ok ? 'ok' : 'bad') : g.ok ? 'ok' : 'warn', val: g.score };
}

// ---------- Eventos ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button,[data-open],[data-pl],[data-openpl]');
  if (!t) return;
  if (t.dataset.calday) { S.calDay = t.dataset.calday; return render(); }
  if (t.dataset.fcf) { S.fc = t.dataset.fcf; store.set('fc', S.fc); return render(); }
  if (t.dataset.dteam) { S.detail.team = t.dataset.dteam; return render(); }
  // Props
  const P = S.props;
  if (t.dataset.pstat) { P.stat = t.dataset.pstat; return render(); }
  if (t.dataset.ptramo) { P.tramo = t.dataset.ptramo; return render(); }
  if (t.dataset.pview) { P.view = t.dataset.pview; return render(); }
  if (t.dataset.ppos) { P.pos = t.dataset.ppos; return render(); }
  if (t.dataset.ptoggle) { P[t.dataset.ptoggle] = !P[t.dataset.ptoggle]; return render(); }
  if (t.dataset.fav) { const f = getFavs(); f.has(t.dataset.fav) ? f.delete(t.dataset.fav) : f.add(t.dataset.fav); store.set(favKey(), [...f]); return render(); }
  if (t.dataset.qadd) return quickAddProp(t.dataset.qadd);
  // Mercados de partido con línea ajustable
  if (t.dataset.gadd) { e.stopPropagation(); return addGameLeg(t.dataset.gadd); }
  if (t.dataset.mstep) {
    const [k, d] = t.dataset.mstep.split('|'), M = mstate(), q = k === 'ah' ? 4 : 2;
    const min = k === 'ah' ? -10 : 0.5;
    M[k] = Math.max(min, Math.round(((M[k] ?? 0) + parseFloat(d)) * q) / q);
    return render();
  }
  if (t.dataset.mset) { const [k, v] = t.dataset.mset.split('|'); mstate()[k] = v; return render(); }
  if (t.dataset.betopen) { S.betOpen = S.betOpen === t.dataset.betopen ? null : t.dataset.betopen; return render(); }
  if (t.dataset.openpl) { const [evId, side, pid, stat] = t.dataset.openpl.split('|'); S.pendingStat = stat; location.hash = `#p/${evId}/j/${side}/${pid}`; return; }
  // Perfil del jugador
  if (t.dataset.pl) { location.hash = `#p/${encodeURIComponent(S.detail.id)}/j/${t.dataset.pl}`; return; }
  if (t.dataset.act === 'pback') { if (history.length > 1) history.back(); else location.hash = '#p/' + S.detail.id; return; }
  if (t.dataset.pick) { S.detail.pick = t.dataset.pick; return render(); }
  if (t.dataset.line) { const c = playerCtx(); if (c) setLine(t.dataset.line === 'reset' ? 'reset' : c.line + parseFloat(t.dataset.line)); return render(); }
  if (t.dataset.tramo) { S.detail.pf.tramo = t.dataset.tramo; return render(); }
  if (t.dataset.pfs) { S.detail.pf.side = t.dataset.pfs; return render(); }
  if (t.dataset.act === 'propadd') return togglePropSlip();
  // Boleto
  if (t.dataset.slipmode) { S.slipMode = t.dataset.slipmode; return render(); }
  if (t.dataset.act === 'regcombo') return registerBet('combo');
  if (t.dataset.act === 'regsingles') return registerBet('single');
  if (t.dataset.delbet) { if (confirm('¿Borrar esta apuesta de tu registro?')) { setBets(getBets().filter((b) => b.id !== t.dataset.delbet)); render(); } return; }
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
  if (t.id === 'fcSel') { S.fc = t.value; store.set('fc', S.fc); load(); }
  if (t.id === 'bankIn') store.set('bank:' + S.user.uid, +t.value || 0);
  if (t.dataset.stake != null) { const s = getSlip(); s[+t.dataset.stake].stake = +t.value || 0; setSlip(s); render(); }
  if (t.dataset.legodd != null) { const s = getSlip(); s[+t.dataset.legodd].price = parseOdd(t.value); s[+t.dataset.legodd].book = parseOdd(t.value) ? 'tu casa' : ''; setSlip(s); render(); }
  if (t.dataset.legstake != null) { const s = getSlip(); s[+t.dataset.legstake].stake = t.value; setSlip(s); render(); }
  if (t.id === 'pGame') { S.props.game = t.value; render(); }
  if (t.id === 'regStake') { S.regStake = t.value; render(); }
  if (t.id === 'regOdds') { S.regOdds = t.value; render(); }
  if (t.id === 'lineIn') { if (t.value !== '') setLine(+t.value); render(); }
  if (t.id === 'priceIn') { const c = playerCtx(); if (c) { (S.detail.price ||= {})[c.key] = +t.value > 1 ? +t.value : undefined; } render(); }
  if (t.id === 'minMin') { S.detail.pf.minMin = +t.value; render(); }
  if (t.id === 'restSel') { S.detail.pf.rest = t.value; render(); }
});
// Mientras se arrastra el filtro de minutos, solo actualiza el número
document.addEventListener('input', (e) => { if (e.target.id === 'minMin') e.target.nextElementSibling.textContent = e.target.value; });

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
  // 7 noches desde hoy (+1 día para los partidos de madrugada de la última). En fútbol, todas las ligas y copas.
  const dates = Array.from({ length: 8 }, (_, i) => limaDay(Date.now() - 6 * 36e5 + i * 864e5).replace(/-/g, ''));
  const jobs = leagueKeys().flatMap((sk) => dates.map((d) => ({ sk, path: ESPN[sk], d })));
  const pages = await Promise.all(jobs.map((j) => fetch(`https://site.api.espn.com/apis/site/v2/sports/${j.path}/scoreboard?dates=${j.d}`).then((r) => (r.ok ? r.json() : { events: [] })).catch(() => ({ events: [] }))));
  const seen = new Set(), raw = [];
  pages.forEach((p, i) => { for (const e of p.events || []) if (!seen.has(e.id)) { seen.add(e.id); raw.push([e, jobs[i].sk, jobs[i].path]); } });
  if (!raw.length && pages.every((p) => !p.events)) throw new Error('No se pudo conectar con ESPN');

  return raw.map(([e, sk, path]) => {
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
  // #p/<partido>  ·  #p/<partido>/j/<home|away>/<jugador>
  const m = location.hash.match(/^#p\/([^/]+)(?:\/j\/(home|away)\/(.+))?$/);
  if (!m) { S.detail = null; }
  else {
    const id = decodeURIComponent(m[1]), prev = S.detail && S.detail.id === id ? S.detail : null;
    // Al entrar y salir del perfil se conservan mercado, líneas, filtros y pestaña
    const tab0 = m[2] || prev?.tab || 'partido';
    S.detail = { id, tab: tab0 === 'home' || tab0 === 'away' ? 'players' : tab0, team: m[2] || prev?.team || null, hist: prev?.hist || { team: 'home', n: 10, side: 'all' },
      stat: prev?.stat, lines: prev?.lines || {}, m: prev?.m, price: prev?.price || {}, pick: prev?.pick || 'over',
      pf: prev?.pf || { tramo: 'l10', side: 'all', minMin: 0, rest: 'all' }, pside: m[2] || null, player: m[3] || null };
    if (m[3] && prev?.player !== m[3]) S.detail.pf = { tramo: 'l10', side: 'all', minMin: 0, rest: 'all' };
    if (S.pendingStat) { S.detail.stat = S.pendingStat; S.pendingStat = null; } // al abrir un jugador desde Props
  }
  window.scrollTo(0, 0);
  if (S.user) render();
}
window.addEventListener('hashchange', route);

// ---------- Inicio ----------
route();
document.querySelectorAll('#leagues button').forEach((b) => b.classList.toggle('on', b.dataset.liga === S.liga));
initAuth();
