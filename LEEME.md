# ALTOQ

Página estática (HTML/CSS/JS, sin compilar). Se puede publicar en GitHub Pages igual que la de referencia.

## Archivos
- `index.html` · estructura
- `styles.css` · estilo oscuro/claro
- `app.js` · login, cuotas, análisis de valor, boleto
- `config.js` · **tus claves** (lo único que tienes que editar)
- `logo.svg` / `logo-dark.svg` · logo para fondo oscuro / claro
- `icon.svg` · ícono (favicon, app, redes, pecho del polo)
- `marca.html` · hoja de marca con logos, ícono y colores

## Cuentas y acceso
- **Invitado** (sin cuenta): ve la lista de partidos con las probabilidades y, dentro del partido, solo “Ganador”.
- **Registrado** (gratis, correo + contraseña o Google): todo — ¿por qué este %?, salidas del modelo, historial,
  bajas, detalles, mercados, jugadores, Picks, Boleto y Perfil con el registro de predicciones.
- Sin Firebase configurado, el registro funciona en “modo de prueba”: la cuenta solo existe en ese navegador.
- Ojo: el bloqueo es de la página (front-end). Sirve para animar a registrarse, pero alguien con conocimientos
  técnicos podría saltárselo. Para contenido de pago haría falta un servidor.

## Publicar y sacar el link
1. **Firebase (cuentas reales):** crea el proyecto, agrega una app Web y copia la configuración en `config.js`.
   En *Authentication → Sign-in method* activa **Correo/contraseña** y **Google**.
2. **Hosting (el link):** la forma más simple es https://app.netlify.com/drop → arrastra la carpeta del proyecto →
   te da un link `https://<nombre>.netlify.app` (crea una cuenta gratis para que no caduque y cámbiale el nombre a `altoq`).
   Alternativas: GitHub Pages o Firebase Hosting.
3. Vuelve a Firebase → *Authentication → Settings → Authorized domains* y agrega el dominio del link (y luego `altoq.pe`).

## Activar lo real
1. **Login con Google** – crea un proyecto en https://console.firebase.google.com, agrega una app Web,
   copia `apiKey`, `authDomain`, `projectId`, `appId` en `config.js`.
   En *Authentication → Sign-in method* activa **Google** y en *Settings → Authorized domains* agrega tu dominio.
2. **Cuotas en tiempo real** – saca una API key en https://the-odds-api.com y ponla en `oddsApiKey`.
   Plan gratis = 500 peticiones/mes. Cada refresco cuesta (nº regiones × nº mercados);
   con `regions: "eu,us"` y `markets: "h2h,totals"` son 4 por refresco, así que sube `refreshSeconds` o pausa "En vivo".

Sin clave de cuotas usa **partidos reales de ESPN** (horarios, marcadores en vivo, cuotas de DraftKings).
En NBA/NFL el valor se calcula con 50% modelo Matchup Predictor de ESPN + 50% mercado sin margen.
En fútbol, sin The Odds API se ven partidos y cuotas pero no se calcula valor (hace falta comparar varias casas).
Sin Firebase se entra como invitado.

## Modelos propios (model.js)
- **NBA v2.5**: ridge ponderada (vida media 10 días, λ=1, márgenes ±20, localía prior 2,5, b2b visitante prior 1,5),
  bajas con tier estimado (0,2 × pts/p − 1) × P(no juega) × (1 − fracción ya perdida), tope blando 4,
  total 50/50 con la media de la liga de 10 días, margen ~ Normal(DE 15,08), 50.000 simulaciones, tope 94%.
  Veredicto: >10 pp → Revisar; hándicap ≥3 pts o total ≥8 pts → Ventaja; si no, No apostar.
- **NFL**: ridge de margen (λ=1, localía 1,5) y de total (λ=16, decaimiento 0,90/semana), σ = √(13,5² + 1000/partidos),
  50.000 simulaciones por drives, tope 92%. Bajas: QB titular −2 (tier "bueno" por defecto), WR1/RB1/TE1 −0,75, Doubtful 50%.
  Solo es apostable una cuota que supere la cuota justa; >10 pp → Revisar.
- **Fútbol v4** (Premier, LaLiga, Serie A, Bundesliga, Ligue 1, Brasileirão): ataque/defensa con K=15 y prior 80% de la
  temporada anterior, ascendidos 0,88/1,12, ×1,04, gamma(100) + Poisson, 50.000 partidos, tope 85%. Cuota mínima = justa × 1,10.
  Copas europeas y Liga 1 Perú: N/D por ahora. Bajas, córners y tiros: N/D.
- Registro de predicciones en el navegador (Perfil): log-loss y Brier del modelo y del mercado.

## Cómo detecta el valor (modo The Odds API)
1. A cada casa se le quita el margen (normaliza 1/cuota).
2. Promedia la probabilidad justa entre casas (Pinnacle/Betfair pesan más).
3. EV = probabilidad justa × mejor cuota − 1. Se muestran las de EV ≥ `minEV`.
4. Stake sugerido: ¼ de Kelly sobre tu bankroll (en Perfil).

> Nota: la API key de cuotas queda visible en el navegador. Para uso público, conviene pasarla por un
> backend pequeño (p. ej. una Cloudflare Worker) más adelante.
