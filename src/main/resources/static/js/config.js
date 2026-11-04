/* ============================================================
   config.js — constantes e estado global compartilhado
   Define o namespace window.App usado pelos demais módulos.
   ============================================================ */

window.App = window.App || {};

App.CONFIG = {
    centro: [-21.764227, -43.350427],
    zoomInicial: 10,
    tiles: "http://localhost:8081/styles/basic-preview/{z}/{x}/{y}.png",
    arquivoRota: "./data/rota_navegacao_offline.json",
};

/* Estado compartilhado entre os módulos. */
App.estado = {
    mapa: null,
    pontos: [], // rota completa como [[lat,lng], ...]
    stepEls: [], // elementos <li> das instruções
};

/* Referências de DOM resolvidas uma vez no bootstrap. */
App.dom = {};
