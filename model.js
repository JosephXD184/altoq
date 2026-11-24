// ALTOQ · modelos propios (NBA v2.5, NFL, Fútbol v4). Todo se calcula en el navegador con datos de ESPN.
// Las cuotas NUNCA entran al ajuste: solo se usan después para comparar.

const BASE = (p) => `https://site.api.espn.com/apis/site/v2/sports/${p}`;
const STAND = (p, season) => `https://site.api.espn.com/apis/v2/sports/${p}/standings${season ? '?season=' + season : ''}`;
const getJ = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const cache = new Map();
function memo(key, ms, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ms) return c.p;
  const p = fn(); cache.set(key, { t: Date.now(), p }); p.catch(() => cache.delete(key)); return p;
}
const N = 50000;
const DAY = 864e5;

// ---------- utilidades numéricas ----------
function randn() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function gamma(k) { // Marsaglia–Tsang, escala 1
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = randn(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = Math.random(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
function poisson(l) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; }
function solve(A, b) { // Gauss con pivoteo parcial
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let m = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
    [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
    const piv = A[i][i] || 1e-12;
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / piv; if (!f) continue; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / (A[i][i] || 1e-12); }
  return x;
}
// Ridge ponderada. obs: [{y, w, x: {idx: val}}]; prior: {idx: [lambda, valorPrevio]}
function ridge(nParams, obs, prior) {
  const A = Array.from({ length: nParams }, () => new Array(nParams).fill(0)), b = new Array(nParams).fill(0);
  for (const o of obs) {
    const ks = Object.keys(o.x).map(Number);
    for (const i of ks) { b[i] += o.w * o.x[i] * o.y; for (const j of ks) A[i][j] += o.w * o.x[i] * o.x[j]; }
  }
  for (const [i, [lam, v0]] of Object.entries(prior)) { A[i][i] += lam; b[i] += lam * v0; }
  return solve(A, b);
}
const capP = (p, hi) => Math.min(hi, Math.max(1 - hi, p));
const noVig = (prices) => { const inv = prices.map((p) => (p ? 1 / p : 0)); const s = inv.reduce((a, b) => a + b, 0); return s ? inv.map((x) => x / s) : prices.map(() => null); };
const half = (x) => Math.floor(x) + 0.5;

// ---------- datos de la liga ----------
async function leagueTeams(path, season) {
  const j = await getJ(STAND(path, season));
  const out = [];
  for (const ch of j?.children || []) for (const e of ch.standings?.entries || []) {
    const st = Object.fromEntries((e.stats || []).map((s) => [s.name, s.value]));
    out.push({ id: String(e.team.id), abbr: e.team.abbreviation, gp: st.gamesPlayed ?? ((st.wins || 0) + (st.losses || 0) + (st.ties || 0)), gf: st.pointsFor, ga: st.pointsAgainst });
  }
  return out;
}
const scoreVal = (s) => (s && typeof s === 'object' ? +s.value : +s);
// Todos los partidos jugados de la temporada (sin duplicados), a partir del calendario de cada equipo
async function leagueGames(path, teams) {
  const scheds = await Promise.all(teams.map((t) => getJ(`${BASE(path)}/teams/${t.id}/schedule`)));
  const seen = new Map();
  for (const j of scheds) for (const e of j?.events || []) {
    const c = e.competitions?.[0]; if (!c?.status?.type?.completed || seen.has(e.id)) continue;
    if (e.seasonType && e.seasonType.type && e.seasonType.type !== 2 && !path.startsWith('soccer')) continue; // solo temporada regular
    const h = c.competitors.find((x) => x.homeAway === 'home'), a = c.competitors.find((x) => x.homeAway === 'away');
    const hp = scoreVal(h?.score), ap = scoreVal(a?.score);
    if (!isFinite(hp) || !isFinite(ap)) continue;
    seen.set(e.id, { id: e.id, date: new Date(e.date).getTime(), home: String(h.team?.id || h.id), away: String(a.team?.id || a.id), hp, ap, neutral: !!c.neutralSite });
  }
  return [...seen.values()].sort((x, y) => x.date - y.date);
}

// ---------- NBA v2.5 ----------
async function fitNBA(path) {
  const teams = await leagueTeams(path); const games = await leagueGames(path, teams);
  const idx = Object.fromEntries(teams.map((t, i) => [t.id, i])), n = teams.length;
  const now = Date.now(), P = 2 * n + 3, HCA = 2 * n + 1, B2B = 2 * n + 2;
  const lastPlayed = {}; const obs = [];
  for (const g of games) {
    if (idx[g.home] == null || idx[g.away] == null) continue;
    const awayB2B = lastPlayed[g.away] != null && g.date - lastPlayed[g.away] < 30 * 36e5;
    lastPlayed[g.home] = g.date; lastPlayed[g.away] = g.date;
    const w = Math.pow(0.5, (now - g.date) / DAY / 10);
    let hp = g.hp, ap = g.ap; const m = hp - ap, t = hp + ap;
    if (Math.abs(m) > 20) { const mm = Math.sign(m) * 20; hp = (t + mm) / 2; ap = (t - mm) / 2; }
    const h = idx[g.home], a = idx[g.away];
    obs.push({ y: hp, w, x: { 0: 1, [1 + h]: 1, [1 + n + a]: -1, [HCA]: 1 } });
    obs.push({ y: ap, w, x: { 0: 1, [1 + a]: 1, [1 + n + h]: -1, ...(awayB2B ? { [B2B]: -1 } : {}) } });
  }
  const prior = { [HCA]: [1, 2.5], [B2B]: [1, 1.5] };
  for (let i = 1; i <= 2 * n; i++) prior[i] = [1, 0];
  const beta = ridge(P, obs, prior);
  // DE del total: residuo real de los totales con el modelo ajustado (la guía no fija este valor)
  let se = 0, k = 0;
  for (const g of games) { const h = idx[g.home], a = idx[g.away]; if (h == null || a == null) continue; const pt = 2 * beta[0] + beta[1 + h] - beta[1 + n + a] + beta[1 + a] - beta[1 + n + h] + beta[HCA]; se += (g.hp + g.ap - pt) ** 2; k++; }
  const recent = games.filter((g) => now - g.date < 10 * DAY);
  const leagueTot10 = recent.length ? recent.reduce((s, g) => s + g.hp + g.ap, 0) / recent.length : null;
  return { kind: 'nba', teams, games, idx, n, beta, HCA, B2B, totalSD: k > 5 ? Math.sqrt(se / k) : 15, leagueTot10, lastPlayed, nGames: games.length };
}
const NBA_PNOPLAY = { Out: 1, Suspension: 1, Doubtful: 0.75, Questionable: 0.5, 'Day-To-Day': 0.5, Probable: 0.1 };
async function nbaInjuryPenalty(path, M, teamId, injuries) {
  let hard = 0, soft = 0; const notes = [];
  const teamGames = M.games.filter((g) => g.home === teamId || g.away === teamId);
  const wsum = teamGames.reduce((s, g) => s + Math.pow(0.5, (Date.now() - g.date) / DAY / 10), 0) || 1;
  for (const x of injuries) {
    const pNo = NBA_PNOPLAY[x.status]; const id = x.athlete?.id; if (pNo == null || !id) continue;
    const gl = await memo('glog' + id, 6e5, () => getJ(`https://site.web.api.espn.com/apis/common/v3/sports/${path}/athletes/${id}/gamelog`));
    const st = (gl?.seasonTypes || []).find((s) => /regular/i.test(s.displayName));
    const pi = (gl?.names || []).indexOf('points'), mi = (gl?.names || []).indexOf('minutes');
    const played = [];
    for (const c of st?.categories || []) if (c.type === 'event') for (const e of c.events || []) if (+e.stats[mi] > 0) played.push({ pts: +e.stats[pi] || 0, date: new Date(gl.events?.[e.eventId]?.gameDate).getTime() });
    const ppg = played.length ? played.reduce((s, g) => s + g.pts, 0) / played.length : 0;
    const tier = Math.max(0, Math.min(6, 0.2 * ppg - 1));
    const missedW = teamGames.filter((g) => !played.some((p) => Math.abs(p.date - g.date) < DAY)).reduce((s, g) => s + Math.pow(0.5, (Date.now() - g.date) / DAY / 10), 0);
    const frac = Math.min(1, missedW / wsum);
    const pen = tier * pNo * (1 - frac);
    if (x.status === 'Out' || x.status === 'Suspension') hard += pen; else soft += pen;
    if (pen > 0.05) notes.push(`${x.athlete.displayName} (${x.status}) −${pen.toFixed(1)} · tier ${tier.toFixed(1)}, ya fuera ${Math.round(frac * 100)}% de la ventana`);
  }
  return { hard, soft, notes };
}
function simNormal(mean, sd, fn) { let c = 0; for (let i = 0; i < N; i++) if (fn(mean + sd * randn())) c++; return c / N; }
async function predictNBA(M, ev, ctx) {
  const h = M.idx[ev.home_id], a = M.idx[ev.away_id]; if (h == null || a == null) return null;
  const n = M.n, b = M.beta;
  let homePts = b[0] + b[1 + h] - b[1 + n + a] + b[M.HCA];
  let awayPts = b[0] + b[1 + a] - b[1 + n + h];
  const start = new Date(ev.commence_time).getTime();
  const awayB2B = M.lastPlayed[ev.away_id] != null && start - M.lastPlayed[ev.away_id] < 30 * 36e5 && start > M.lastPlayed[ev.away_id];
  const injH = await nbaInjuryPenalty(ev.path, M, ev.home_id, ctx.injuries(ev.home_id));
  const injA = await nbaInjuryPenalty(ev.path, M, ev.away_id, ctx.injuries(ev.away_id));
  const b2bPen = awayB2B ? b[M.B2B] : 0;
  const penH = injH.hard + Math.min(4, injH.soft), penA = injA.hard + Math.min(4, injA.soft + b2bPen);
  homePts -= penH; awayPts -= penA;
  const margin = homePts - awayPts;
  const modelTotal = homePts + awayPts;
  const total = M.leagueTot10 ? 0.5 * modelTotal + 0.5 * M.leagueTot10 : modelTotal;
  const SD = 15.08;
  const pHome = capP(simNormal(margin, SD, (x) => x > 0), 0.94);
  const lines = ctx.lines;
  const out = {
    model: 'NBA v2.5', pHome, pAway: 1 - pHome, pDraw: null, margin, total, homePts, awayPts,
    sd: SD, totalSD: M.totalSD,
    context: [...(awayB2B ? [`Visitante en back-to-back (−${b2bPen.toFixed(1)} pts, cuenta en el tope de 4)`] : []), ...injH.notes.map((s) => ev.home_abbr + ': ' + s), ...injA.notes.map((s) => ev.away_abbr + ': ' + s)],
    nGames: M.nGames,
  };
  out.fairSpread = -balancedLine(margin, SD);
  // Desglose para explicar el porcentaje
  const tg = (id) => M.games.filter((g) => g.home === id || g.away === id);
  out.why = {
    kind: 'nba', netHome: b[1 + h] + b[1 + n + h], netAway: b[1 + a] + b[1 + n + a], hca: b[M.HCA],
    attHome: b[1 + h], defHome: b[1 + n + h], attAway: b[1 + a], defAway: b[1 + n + a],
    penH, penA, b2b: awayB2B ? b2bPen : 0, injNotesH: injH.notes, injNotesA: injA.notes,
    modelTotal, leagueTot10: M.leagueTot10, sd: SD, gpHome: tg(ev.home_id).length, gpAway: tg(ev.away_id).length,
  };
  if (lines.spreadHome != null) out.pCoverHome = simNormal(margin, SD, (x) => x + lines.spreadHome > 0);
  if (lines.total != null) out.pOver = simNormal(total, M.totalSD, (x) => x > lines.total);
  out.fairTotal = balancedLine(total, M.totalSD);
  return finishUS(out, lines, 'nba');
}
// Línea de medio punto donde cada lado está más cerca de 50% (Normal)
function balancedLine(mean, sd) {
  const c = [half(mean - 1), half(mean), half(mean) - 1].sort((x, y) => Math.abs(x - mean) - Math.abs(y - mean));
  return c[0];
}

// ---------- NFL ----------
async function fitNFL(path) {
  const teams = await leagueTeams(path); const games = await leagueGames(path, teams);
  const idx = Object.fromEntries(teams.map((t, i) => [t.id, i])), n = teams.length, P = 2 * n + 1;
  const now = Date.now(), HFA = 1.5;
  const mk = (weightFn) => {
    const obs = [];
    for (const g of games) {
      const h = idx[g.home], a = idx[g.away]; if (h == null || a == null) continue;
      const hf = g.neutral ? 0 : HFA / 2, w = weightFn(g);
      obs.push({ y: g.hp - hf, w, x: { 0: 1, [1 + h]: 1, [1 + n + a]: -1 } });
      obs.push({ y: g.ap + hf, w, x: { 0: 1, [1 + a]: 1, [1 + n + h]: -1 } });
    }
    return obs;
  };
  const pr = (lam) => { const p = {}; for (let i = 1; i <= 2 * n; i++) p[i] = [lam, 0]; return p; };
  const betaM = ridge(P, mk(() => 1), pr(1));
  const betaT = ridge(P, mk((g) => Math.pow(0.9, (now - g.date) / (7 * DAY))), pr(16));
  const gp = {}; for (const g of games) { gp[g.home] = (gp[g.home] || 0) + 1; gp[g.away] = (gp[g.away] || 0) + 1; }
  return { kind: 'nfl', teams, games, idx, n, betaM, betaT, HFA, gp, nGames: games.length };
}
function nflInjuryPenalty(injuries, leaders) {
  let pen = 0; const notes = [];
  for (const x of injuries) {
    const mult = x.status === 'Out' ? 1 : x.status === 'Doubtful' ? 0.5 : 0; if (!mult) continue;
    const id = String(x.athlete?.id), pos = x.athlete?.position?.abbreviation;
    let v = 0, why = '';
    if (pos === 'QB' && leaders.pass === id) { v = 2.0; why = 'QB titular (tier "bueno" por defecto; élite/medio N/D)'; }
    else if ((pos === 'WR' || pos === 'TE') && leaders.rec === id) { v = 0.75; why = pos + '1'; }
    else if (pos === 'RB' && leaders.rush === id) { v = 0.75; why = 'RB1'; }
    if (v) { pen += v * mult; notes.push(`${x.athlete.displayName} (${x.status}) −${(v * mult).toFixed(2)} · ${why}${mult < 1 ? ' · DUDOSA 50%' : ''}`); }
  }
  return { pen, notes };
}
async function predictNFL(M, ev, ctx) {
  const h = M.idx[ev.home_id], a = M.idx[ev.away_id]; if (h == null || a == null) return null;
  const n = M.n, hf = ev.neutral ? 0 : M.HFA / 2;
  const pts = (b) => [b[0] + b[1 + h] - b[1 + n + a] + hf, b[0] + b[1 + a] - b[1 + n + h] - hf];
  const [mh, ma] = pts(M.betaM), [th, ta] = pts(M.betaT);
  const injH = nflInjuryPenalty(ctx.injuries(ev.home_id), ctx.leaders(ev.home_id));
  const injA = nflInjuryPenalty(ctx.injuries(ev.away_id), ctx.leaders(ev.away_id));
  const margin = mh - ma - injH.pen + injA.pen;
  const total = th + ta - injH.pen - injA.pen;
  const avgGp = ((M.gp[ev.home_id] || 0) + (M.gp[ev.away_id] || 0)) / 2 || 1;
  const sigma = Math.sqrt(13.5 ** 2 + 1000 / avgGp);
  const sim = simDrives((total + margin) / 2, (total - margin) / 2, sigma);
  const lines = ctx.lines;
  const pHome = capP(sim.pHome, 0.92);
  const out = { model: 'NFL ridge', pHome, pAway: 1 - pHome, pDraw: null, margin, total, homePts: (total + margin) / 2, awayPts: (total - margin) / 2, sd: sigma, nGames: M.nGames,
    context: [...injH.notes.map((s) => ev.home_abbr + ': ' + s), ...injA.notes.map((s) => ev.away_abbr + ': ' + s)] };
  out.fairSpread = -sim.line(sim.margins, margin); out.fairTotal = sim.line(sim.totals, total);
  const bm = M.betaM;
  out.why = {
    kind: 'nfl', netHome: bm[1 + h] + bm[1 + n + h], netAway: bm[1 + a] + bm[1 + n + a], hfa: ev.neutral ? 0 : M.HFA,
    penH: injH.pen, penA: injA.pen, injNotesH: injH.notes, injNotesA: injA.notes, sigma, avgGp,
    gpHome: M.gp[ev.home_id] || 0, gpAway: M.gp[ev.away_id] || 0, totalModel: total,
  };
  if (lines.spreadHome != null) out.pCoverHome = sim.margins.filter((m) => m + lines.spreadHome > 0).length / N;
  if (lines.total != null) out.pOver = sim.totals.filter((t) => t > lines.total).length / N;
  return finishUS(out, lines, 'nfl');
}
// Simulación por drives: ~10,6 por equipo; TD 6/7/8, FG 3; prórroga; ruido de rating hasta la σ calibrada
function simDrives(eh, ea, sigma) {
  const TDV = 0.05 * 6 + 0.89 * 7 + 0.06 * 8, FGR = 0.68, D = 10.6;
  const rates = (e) => { const pt = Math.max(0.02, Math.min(0.6, e / (D * (TDV + 3 * FGR)))); return [pt, pt * FGR]; };
  const varTeam = (e) => { const [pt, pf] = rates(e); const m = pt * TDV + pf * 3, m2 = pt * (0.05 * 36 + 0.89 * 49 + 0.06 * 64) + pf * 9; return D * (m2 - m * m); };
  const sr = Math.sqrt(Math.max(0, sigma ** 2 - varTeam(eh) - varTeam(ea)));
  const margins = new Float32Array(N), totals = new Float32Array(N); let wins = 0;
  const td = () => { const u = Math.random(); return u < 0.05 ? 6 : u < 0.94 ? 7 : 8; };
  const play = (e) => { const [pt, pf] = rates(e); const nd = Math.random() < 0.6 ? 11 : 10; let s = 0; for (let d = 0; d < nd; d++) { const u = Math.random(); if (u < pt) s += td(); else if (u < pt + pf) s += 3; } return s; };
  for (let i = 0; i < N; i++) {
    const z = sr * randn();
    let hs = play(Math.max(1, eh + z / 2)), as = play(Math.max(1, ea - z / 2));
    if (hs === as) { const [ph] = rates(eh), [pa] = rates(ea); if (Math.random() < ph / (ph + pa)) hs += 3; else as += 3; }
    margins[i] = hs - as; totals[i] = hs + as; if (hs > as) wins++;
  }
  const line = (arr, mean) => { const cands = [half(mean - 1), half(mean), half(mean + 1) - 1, half(mean) - 1]; let best = cands[0], bd = 9; for (const c of cands) { let k = 0; for (let i = 0; i < N; i += 5) if (arr[i] > c) k++; const d = Math.abs(k / (N / 5) - 0.5); if (d < bd) { bd = d; best = c; } } return best; };
  return { pHome: wins / N, margins: Array.from(margins), totals: Array.from(totals), line };
}

// Comparación con el mercado y veredicto (NBA/NFL)
function finishUS(out, lines, kind) {
  const fair = (p) => (p ? 1 / p : null);
  out.fairHome = fair(out.pHome); out.fairAway = fair(out.pAway);
  if (lines.mlHome && lines.mlAway) {
    const [mh, ma] = noVig([lines.mlHome, lines.mlAway]);
    out.mktHome = mh; out.mktAway = ma; out.ppHome = (out.pHome - mh) * 100;
    out.evHome = out.pHome * lines.mlHome - 1; out.evAway = out.pAway * lines.mlAway - 1;
  }
  const picks = [];
  if (out.ppHome == null && lines.spreadHome == null && lines.total == null) { out.verdict = 'N/D'; out.verdictWhy = 'La casa no publica líneas para este partido'; out.picks = []; return out; }
  if (out.ppHome != null && Math.abs(out.ppHome) > 10) { out.verdict = 'Revisar'; out.verdictWhy = `El modelo se separa ${Math.abs(out.ppHome).toFixed(1)} pp del mercado (>10 pp): no hay pick`; out.picks = []; return out; }
  if (kind === 'nba') {
    if (lines.spreadHome != null && Math.abs(out.margin - -lines.spreadHome) >= 3) {
      const homeSide = out.margin > -lines.spreadHome;
      picks.push({ market: 'spreads', side: homeSide ? 'home' : 'away', p: homeSide ? out.pCoverHome : 1 - out.pCoverHome, why: `margen modelo ${out.margin.toFixed(1)} vs línea ${-lines.spreadHome}` });
    }
    if (lines.total != null && Math.abs(out.total - lines.total) >= 8) {
      const over = out.total > lines.total;
      picks.push({ market: 'totals', side: over ? 'Over' : 'Under', p: over ? out.pOver : 1 - out.pOver, why: `total modelo ${out.total.toFixed(1)} vs ${lines.total}` });
    }
  } else { // NFL: solo es apostable una cuota que supere la cuota justa
    if (lines.mlHome && out.pHome * lines.mlHome > 1) picks.push({ market: 'h2h', side: 'home', p: out.pHome, price: lines.mlHome });
    if (lines.mlAway && out.pAway * lines.mlAway > 1) picks.push({ market: 'h2h', side: 'away', p: out.pAway, price: lines.mlAway });
    if (out.pCoverHome != null) {
      if (lines.spreadHomePrice && out.pCoverHome * lines.spreadHomePrice > 1) picks.push({ market: 'spreads', side: 'home', p: out.pCoverHome, price: lines.spreadHomePrice });
      if (lines.spreadAwayPrice && (1 - out.pCoverHome) * lines.spreadAwayPrice > 1) picks.push({ market: 'spreads', side: 'away', p: 1 - out.pCoverHome, price: lines.spreadAwayPrice });
    }
    if (out.pOver != null) {
      if (lines.overPrice && out.pOver * lines.overPrice > 1) picks.push({ market: 'totals', side: 'Over', p: out.pOver, price: lines.overPrice });
      if (lines.underPrice && (1 - out.pOver) * lines.underPrice > 1) picks.push({ market: 'totals', side: 'Under', p: 1 - out.pOver, price: lines.underPrice });
    }
  }
  out.picks = picks;
  out.verdict = picks.length ? 'Ventaja' : 'No apostar';
  out.verdictWhy = picks.length ? '' : kind === 'nba' ? 'Sin ventaja: hándicap a <3 pts y total a <8 pts de la casa' : 'Ninguna cuota de la casa supera la cuota justa del modelo';
  return out;
}

// ---------- Fútbol v4 ----------
const SOCCER_OK = ['soccer/eng.1', 'soccer/esp.1', 'soccer/ita.1', 'soccer/ger.1', 'soccer/fra.1', 'soccer/bra.1'];
async function fitSoccer(path) {
  const teams = await leagueTeams(path);
  const games = await leagueGames(path, teams);
  // Temporada anterior: nivel final de cada equipo (para el rating previo)
  const season = (await getJ(`${BASE(path)}/scoreboard`))?.leagues?.[0]?.season?.year;
  const prev = season ? await leagueTeams(path, season - 1) : [];
  const prevAvg = prev.reduce((s, t) => s + (t.gf || 0), 0) / Math.max(1, prev.reduce((s, t) => s + (t.gp || 0), 0));
  const prevMap = Object.fromEntries(prev.map((t) => [t.id, t]));
  const gpTot = teams.reduce((s, t) => s + (t.gp || 0), 0);
  const media = teams.reduce((s, t) => s + (t.gf || 0), 0) / Math.max(1, gpTot);
  const homeAvg = games.length ? games.reduce((s, g) => s + g.hp, 0) / games.length : media * 1.1;
  const awayAvg = games.length ? games.reduce((s, g) => s + g.ap, 0) / games.length : media * 0.9;
  const K = 15, Pp = 0.8;
  const R = {};
  for (const t of teams) {
    const p = prevMap[t.id];
    let attPrev, defPrev, promoted = false;
    if (p && p.gp && prevAvg) { attPrev = 1 + Pp * ((p.gf / p.gp) / prevAvg - 1); defPrev = 1 + Pp * ((p.ga / p.gp) / prevAvg - 1); }
    else { attPrev = 0.88; defPrev = 1.12; promoted = true; }
    const gp = t.gp || 0;
    R[t.id] = { att: ((t.gf || 0) + K * media * attPrev) / (gp + K) / media, def: ((t.ga || 0) + K * media * defPrev) / (gp + K) / media, promoted, gp };
  }
  return { kind: 'soccer', R, media, homeAvg, awayAvg, nGames: games.length, hasPrev: prev.length > 0, games, teams };
}
function simSoccer(lh, la, minute, scoreH, scoreA) {
  const rem = minute != null ? Math.max(0, (90 - minute) / 90) : 1;
  let H = 0, D = 0, A = 0, O25 = 0, BTTS = 0; const scores = {}; const diffs = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    const gh = (scoreH || 0) + poisson(lh * rem * gamma(100) / 100), ga = (scoreA || 0) + poisson(la * rem * gamma(100) / 100);
    if (gh > ga) H++; else if (gh === ga) D++; else A++;
    if (gh + ga > 2.5) O25++; if (gh > 0 && ga > 0) BTTS++;
    const k = gh + '-' + ga; scores[k] = (scores[k] || 0) + 1; diffs[i] = gh - ga;
  }
  let pH = H / N, pD = D / N, pA = A / N;
  // Tope de favorito 85%: el exceso se reparte entre empate y rival en proporción
  const cap = (fav, o1, o2) => { if (fav <= 0.85) return [fav, o1, o2]; const ex = fav - 0.85, s = o1 + o2 || 1; return [0.85, o1 + ex * o1 / s, o2 + ex * o2 / s]; };
  if (pH > 0.85) [pH, pD, pA] = cap(pH, pD, pA); else if (pA > 0.85) [pA, pD, pH] = cap(pA, pD, pH);
  const top = Object.entries(scores).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([s, c]) => [s, c / N]);
  // Hándicap asiático equilibrado de medio gol (local)
  let best = null;
  for (let l = -3.5; l <= 3.5; l += 1) { let c = 0; for (let i = 0; i < N; i++) if (diffs[i] + l > 0) c++; const p = c / N; if (!best || Math.abs(p - 0.5) < Math.abs(best.p - 0.5)) best = { line: l, p }; }
  // Distribución completa de marcadores: permite calcular cualquier línea de hándicap o goles
  const dist = Object.fromEntries(Object.entries(scores).map(([s, c]) => [s, c / N]));
  return { pHome: pH, pDraw: pD, pAway: pA, pOver25: O25 / N, pBTTS: BTTS / N, top, ah: best, dist };
}
async function predictSoccer(M, ev, ctx) {
  const rh = M.R[ev.home_id], ra = M.R[ev.away_id]; if (!rh || !ra) return null;
  // goles medios del local/visitante en la liga × 1,04 × ataque propio × defensa rival
  const lhAdj = M.homeAvg * 1.04 * rh.att * ra.def;
  const la = M.awayAvg * 1.04 * ra.att * rh.def;
  const live = ev.state === 'in' ? { minute: parseInt(ev.clock) || null, sh: +ev.score?.[1] || 0, sa: +ev.score?.[0] || 0 } : null;
  const s = simSoccer(lhAdj, la, live?.minute ?? null, live?.sh, live?.sa);
  const why = { kind: 'soccer', homeAvg: M.homeAvg, awayAvg: M.awayAvg, media: M.media, rh, ra, live };
  const out = { model: 'Fútbol v4', why, ...s, xgHome: lhAdj, xgAway: la, nGames: M.nGames, live: !!live,
    context: [...(rh.promoted ? [ev.home_abbr + ': sin temporada anterior en ESPN → tratado como ascendido (0,88/1,12)'] : []), ...(ra.promoted ? [ev.away_abbr + ': sin temporada anterior en ESPN → tratado como ascendido (0,88/1,12)'] : []), 'Bajas: N/D (ESPN no publica bajas confirmadas de fútbol de forma fiable)', 'Córners/tiros: N/D'] };
  const lines = ctx.lines; const fair = (p) => (p ? 1 / p : null);
  out.fair = { home: fair(s.pHome), draw: fair(s.pDraw), away: fair(s.pAway), over: fair(s.pOver25), under: fair(1 - s.pOver25), btts: fair(s.pBTTS), noBtts: fair(1 - s.pBTTS) };
  out.minOdds = Object.fromEntries(Object.entries(out.fair).map(([k, v]) => [k, v ? v * 1.1 : null]));
  const picks = [];
  if (lines.mlHome && lines.mlAway && lines.mlDraw) {
    const [mh, md, ma] = noVig([lines.mlHome, lines.mlDraw, lines.mlAway]);
    out.mktHome = mh; out.mktDraw = md; out.mktAway = ma; out.ppHome = (s.pHome - mh) * 100;
    const maxPP = Math.max(Math.abs(s.pHome - mh), Math.abs(s.pDraw - md), Math.abs(s.pAway - ma)) * 100;
    out.maxPP = maxPP;
    if (maxPP > 10) { out.verdict = 'Revisar'; out.verdictWhy = `El modelo se separa ${maxPP.toFixed(1)} pp de la casa (>10 pp) sin baja o contexto verificado: no se apuesta`; out.picks = []; return out; }
    for (const [side, p, price, mo] of [['home', s.pHome, lines.mlHome, out.minOdds.home], ['draw', s.pDraw, lines.mlDraw, out.minOdds.draw], ['away', s.pAway, lines.mlAway, out.minOdds.away]])
      if (price >= mo) picks.push({ market: 'h2h', side, p, price, obvious: p > 0.7 });
  }
  if (lines.total === 2.5 && lines.overPrice && lines.underPrice) {
    if (lines.overPrice >= out.minOdds.over) picks.push({ market: 'totals', side: 'Over', p: s.pOver25, price: lines.overPrice });
    if (lines.underPrice >= out.minOdds.under) picks.push({ market: 'totals', side: 'Under', p: 1 - s.pOver25, price: lines.underPrice, caution: 'Menos de 2,5: tratar con cautela (sesgo conocido)' });
  }
  out.picks = picks.filter((p) => !p.obvious);
  if (!lines.mlHome) { out.verdict = 'N/D'; out.verdictWhy = 'Sin cuota real verificada de la casa'; }
  else { out.verdict = out.picks.length ? 'Ventaja' : 'No apostar'; out.verdictWhy = out.picks.length ? '' : 'La casa no paga la cuota mínima (justa × 1,10) en ningún mercado'; }
  return out;
}

// ---------- API pública ----------
export function modelFor(path) {
  if (path === 'basketball/nba') return { fit: () => memo('fit' + path, 6e5, () => fitNBA(path)), predict: predictNBA, name: 'NBA v2.5' };
  if (path === 'football/nfl') return { fit: () => memo('fit' + path, 6e5, () => fitNFL(path)), predict: predictNFL, name: 'NFL ridge' };
  if (SOCCER_OK.includes(path)) return { fit: () => memo('fit' + path, 6e5, () => fitSoccer(path)), predict: predictSoccer, name: 'Fútbol v4' };
  return null; // copas europeas, Liga 1 Perú, etc.: pendiente → N/D
}
export const pendingReason = (path) => (/uefa/.test(path) ? 'Copas europeas: capa del modelo pendiente (necesita los ratings de todas las ligas de origen) → N/D' : /per\.1/.test(path) ? 'Liga 1 Perú: modelo por diferencia de gol pendiente → N/D' : 'Modelo no disponible para esta competición → N/D');
export async function summaryFor(path, id) { return memo('sum' + id, 6e5, () => getJ(`${BASE(path)}/summary?event=${id}`)); }

// Registro de predicciones (log-loss y Brier contra el mercado)
const REG = 'rushtop:registro';
export function logPrediction(ev, pred) {
  try {
    const r = JSON.parse(localStorage.getItem(REG) || '{}');
    if (ev.state !== 'pre' || !pred) return;
    r[ev.id] = { v: pred.model, path: ev.path, date: ev.commence_time, game: ev.path?.startsWith('soccer') ? ev.home_abbr + ' vs ' + ev.away_abbr : ev.away_abbr + ' @ ' + ev.home_abbr, home: ev.home_id, away: ev.away_id, p: [pred.pHome, pred.pDraw, pred.pAway], mkt: [pred.mktHome ?? null, pred.mktDraw ?? null, pred.mktAway ?? null], margin: pred.margin ?? null, total: pred.total ?? null, saved: r[ev.id]?.saved || Date.now(), result: r[ev.id]?.result || null };
    localStorage.setItem(REG, JSON.stringify(r));
  } catch {}
}
export function settleResults(games) {
  try {
    const r = JSON.parse(localStorage.getItem(REG) || '{}'); let ch = false;
    for (const g of games) if (r[g.id] && !r[g.id].result) { r[g.id].result = [g.hp, g.ap]; ch = true; }
    if (ch) localStorage.setItem(REG, JSON.stringify(r));
  } catch {}
}
export function registryStats() {
  let r = {}; try { r = JSON.parse(localStorage.getItem(REG) || '{}'); } catch {}
  const rows = Object.values(r); const done = rows.filter((x) => x.result);
  const m = { n: rows.length, settled: done.length, model: { ll: 0, br: 0 }, mkt: { ll: 0, br: 0, n: 0 } };
  for (const x of done) {
    const [hp, ap] = x.result; const o = hp > ap ? 0 : hp === ap ? 1 : 2;
    const p = x.p.map((v) => v ?? 0); const s = p.reduce((a, b) => a + b, 0) || 1; const pn = p.map((v) => v / s);
    m.model.ll += -Math.log(Math.max(1e-6, pn[o])); m.model.br += pn.reduce((t, v, i) => t + (v - (i === o ? 1 : 0)) ** 2, 0);
    if (x.mkt[0] != null) { const q = x.mkt.map((v) => v ?? 0); m.mkt.ll += -Math.log(Math.max(1e-6, q[o])); m.mkt.br += q.reduce((t, v, i) => t + (v - (i === o ? 1 : 0)) ** 2, 0); m.mkt.n++; }
  }
  if (done.length) { m.model.ll /= done.length; m.model.br /= done.length; }
  if (m.mkt.n) { m.mkt.ll /= m.mkt.n; m.mkt.br /= m.mkt.n; }
  return { ...m, rows };
}
