// ===== ALTOQ · configuración =====
// Rellena estos datos para activar el login con Google y las cuotas reales.
// Si los dejas vacíos, la app usa partidos y cuotas reales de ESPN y se entra como invitado.

window.RUSHTOP_CONFIG = {
  // 1) Firebase (login con Google) → https://console.firebase.google.com
  //    Proyecto > Configuración > Tus apps > Web. Activa "Google" en Authentication > Sign-in method
  //    y agrega tu dominio (ej. tuusuario.github.io) en Authentication > Settings > Authorized domains.
  firebase: {
    apiKey: "",
    authDomain: "",
    projectId: "",
    appId: ""
  },

  // 2) The Odds API (cuotas en tiempo real) → https://the-odds-api.com  (plan gratis: 500 peticiones/mes)
  oddsApiKey: "",

  // Regiones de casas de apuestas: us, us2, uk, eu, au (cada región cuenta como una petición extra)
  regions: "eu,us",

  // Mercados: h2h (ganador), spreads (hándicap), totals (más/menos). Cada mercado suma coste.
  markets: "h2h,totals",

  // Cada cuántos segundos refrescar las cuotas con "En vivo" activado
  refreshSeconds: 120,

  // Valor esperado mínimo para mostrar una apuesta como "con valor" (0.02 = +2%)
  minEV: 0.02,

  // Mínimo de casas para calcular la probabilidad justa de consenso
  minBooks: 3,

  // Casas "sharp" que pesan más en el consenso
  sharpBooks: { pinnacle: 3, betfair_ex_eu: 2.5, betfair_ex_uk: 2.5, matchbook: 2 }
};
