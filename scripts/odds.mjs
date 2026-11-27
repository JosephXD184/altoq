// ALTOQ · cuotas de referencia (Betano y casas de Reino Unido) desde The Odds API.
// Se ejecuta en GitHub Actions una vez al día; la clave va en el secreto ODDSAPI_KEY.
// Plan gratis = 500 créditos/mes: solo mercado ganador (h2h) y región uk → 1 crédito por liga con partidos.
// Escribe <out>/latest.json → { at, remaining, events:[{ sk, t, home, away, books:[{ k, n, home, away, draw }] }] }
import { mkdirSync, writeFileSync } from 'node:fs';

const KEY = process.env.ODDSAPI_KEY;
const OUT = process.argv[2] || 'out';
const API = 'https://api.the-odds-api.com/v4';
// Ligas de ALTOQ (mismas claves que usa la página)
const SPORTS = ['soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a', 'soccer_germany_bundesliga', 'soccer_france_ligue_one',
  'soccer_uefa_champs_league', 'soccer_uefa_europa_league', 'soccer_uefa_europa_conference_league', 'soccer_conmebol_copa_libertadores',
  'soccer_brazil_campeonato', 'soccer_argentina_primera_division', 'basketball_nba', 'americanfootball_nfl'];
if (!KEY) { console.error('Falta el secreto ODDSAPI_KEY'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

// La lista de deportes activos no gasta créditos: así no se piden ligas en pausa
const list = await fetch(`${API}/sports?apiKey=${KEY}`).then((r) => r.json()).catch(() => null);
if (!Array.isArray(list)) { console.error('Clave inválida o API caída:', JSON.stringify(list)); process.exit(1); }
const active = new Set(list.filter((s) => s.active).map((s) => s.key));
const events = [];
let remaining = null;
for (const sk of SPORTS) {
  if (active.size && !active.has(sk)) continue;
  if (remaining != null && remaining < 2) { console.error('Sin créditos este mes'); break; }
  const r = await fetch(`${API}/sports/${sk}/odds?apiKey=${KEY}&regions=uk&markets=h2h&oddsFormat=decimal`);
  remaining = +r.headers.get('x-requests-remaining') || remaining;
  if (!r.ok) { console.error(sk, r.status, await r.text()); if (r.status === 401) process.exitCode = 1; continue; }
  const data = await r.json();
  for (const e of data) {
    const books = (e.bookmakers || []).map((b) => {
      const o = b.markets?.find((m) => m.key === 'h2h')?.outcomes || [], p = (n) => o.find((x) => x.name === n)?.price ?? null;
      return { k: b.key, n: b.title, home: p(e.home_team), away: p(e.away_team), draw: p('Draw') };
    }).filter((b) => b.home && b.away);
    if (books.length) events.push({ sk, t: e.commence_time, home: e.home_team, away: e.away_team, books });
  }
  console.log(sk, data.length, 'partidos · quedan', remaining);
}
writeFileSync(`${OUT}/latest.json`, JSON.stringify({ at: Date.now(), remaining, events }));
