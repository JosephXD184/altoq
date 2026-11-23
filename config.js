// ===== ALTOQ · configuración =====
// Rellena estos datos para activar el login con Google y las cuotas reales.
// Si los dejas vacíos, la app usa partidos y cuotas reales de ESPN y se entra como invitado.

window.RUSHTOP_CONFIG = {
  // 1) Firebase (cuentas: correo/contraseña y Google) · proyecto "altoq-befde"
  //    Esta configuración es pública por diseño (Firebase la protege con los dominios autorizados).
  firebase: {
    apiKey: "AIzaSyBl6Eq5uYTT47QchAtNiCUls4ET3c33cFw",
    authDomain: "altoq-befde.firebaseapp.com",
    projectId: "altoq-befde",
    appId: "1:482912647251:web:c02cfa8a261e64e14d6ea6",
    messagingSenderId: "482912647251",
    storageBucket: "altoq-befde.firebasestorage.app"
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
