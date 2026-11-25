// ALTOQ · bajas de fútbol desde API-Football (se ejecuta en GitHub Actions, la clave va en el secreto APIFOOTBALL_KEY)
// Escribe out/<fecha>.json → { date, fixtures:[{id,ts,lg,home,away,hid,aid}], items:[{fx,tid,name,type,reason}], at }
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';

const API = 'https://v3.football.api-sports.io';
const KEY = process.env.APIFOOTBALL_KEY;
const OUT = process.argv[2] || 'out';
// Ligas de ALTOQ (ids de API-Football): Premier, LaLiga, Serie A, Bundesliga, Ligue 1, Brasileirão, Argentina, Perú, Champions, Europa, Conference
const LEAGUES = new Set([39, 140, 135, 78, 61, 71, 128, 281, 2, 3, 848]);
if (!KEY) { console.error('Falta el secreto APIFOOTBALL_KEY'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

let remaining = Infinity;
async function api(path) {
  if (remaining < 6) throw new Error('budget');
  const r = await fetch(API + path, { headers: { 'x-apisports-key': KEY } });
  const rem = +r.headers.get('x-ratelimit-requests-remaining'); if (Number.isFinite(rem)) remaining = rem;
  const j = await r.json().catch(() => null);
  const errs = j?.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
  if (!r.ok || errs?.length) throw new Error('api:' + (errs?.join(' ') || r.status));
  return j.response || [];
}

async function day(date) {
  const fixtures = (await api(`/fixtures?date=${date}`)).filter((f) => LEAGUES.has(f.league?.id)).map((f) => ({
    id: f.fixture.id, ts: f.fixture.timestamp, lg: f.league.id,
    home: f.teams.home.name, away: f.teams.away.name, hid: f.teams.home.id, aid: f.teams.away.id,
  }));
  let raw = [];
  if (fixtures.length) {
    try { raw = await api(`/injuries?date=${date}`); }
    catch (e) {
      if (e.message === 'budget') throw e;
      for (let i = 0; i < fixtures.length; i += 20) raw.push(...(await api(`/injuries?ids=${fixtures.slice(i, i + 20).map((f) => f.id).join('-')}`)));
    }
  }
  const ids = new Set(fixtures.map((f) => f.id));
  const items = raw.filter((x) => ids.has(x.fixture?.id)).map((x) => ({
    fx: x.fixture.id, tid: x.team?.id, name: x.player?.name, type: x.player?.type, reason: x.player?.reason || '',
  }));
  return { date, fixtures, items, at: Date.now() };
}

const iso = (d) => d.toISOString().slice(0, 10);
const now = Date.now();
// hoy y mañana: cada ~2 h · pasado mañana y el siguiente: cada ~6 h
const plan = [0, 1, 2, 3].map((k) => ({ date: iso(new Date(now + k * 864e5)), maxAge: (k <= 1 ? 100 : 350) * 60e3 }));
for (const { date, maxAge } of plan) {
  const f = `${OUT}/${date}.json`;
  if (existsSync(f)) { try { const o = JSON.parse(readFileSync(f, 'utf8')); if (!o.error && now - o.at < maxAge) continue; } catch {} }
  try {
    const v = await day(date);
    writeFileSync(f, JSON.stringify(v));
    console.log(date, v.fixtures.length, 'partidos', v.items.length, 'bajas · quedan', remaining);
  } catch (e) {
    console.error(date, e.message);
    if (e.message === 'budget') break;
    if (!existsSync(f)) writeFileSync(f, JSON.stringify({ date, error: e.message, at: now }));
    if (/plan|season|key|token/i.test(e.message)) process.exitCode = 1;
  }
}
// limpia días viejos
for (const n of readdirSync(OUT)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n < iso(new Date(now - 2 * 864e5))) unlinkSync(`${OUT}/${n}`);
