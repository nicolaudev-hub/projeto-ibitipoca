/**
 * Projeto Ibitipoca — Service Worker
 *
 * Estratégias:
 * - Navegação (página): rede primeiro, com limite de tempo; sem rede,
 *   usa a cópia guardada do index.html.
 * - Demais recursos do app (Leaflet, JS, rota, manifesto): cache primeiro.
 * - Tiles (./tiles/{z}/{x}/{y}.png): cache primeiro, em cache separado.
 *   Tile ausente sem conexão responde 504; o Leaflet trata como falha
 *   daquele tile e continua desenhando os demais.
 *
 * Ao alterar qualquer arquivo de RECURSOS_APP, incremente VERSAO_APP.
 * Ao gerar novos tiles, copie a versão de tiles/manifesto.json para
 * VERSAO_TILES (o teste automatizado confere).
 */
'use strict';

const VERSAO_APP = '2';
const VERSAO_TILES = '5ca315088105b9b6';
const PREFIXO_CACHE = 'ibitipoca-';
const CACHE_APP = PREFIXO_CACHE + 'app-v' + VERSAO_APP + '-' + VERSAO_TILES;
const CACHE_TILES = PREFIXO_CACHE + 'tiles-' + VERSAO_TILES;
const TEMPO_LIMITE_REDE_MS = 4000;

const RECURSOS_APP = [
    './index.html',
    './leaflet/leaflet.css',
    './leaflet/leaflet.js',
    './leaflet/images/marker-icon.png',
    './leaflet/images/marker-shadow.png',
    './js/navegacao.js',
    './js/registro-sw.js',
    './js/download-mapa.js',
    './data/rota_navegacao_offline.json',
    './tiles/manifesto.json'
];

const BASE = new URL('./', self.location).pathname;
const URL_PAGINA = new URL('./index.html', self.location).href;

self.addEventListener('install', evento => {
    evento.waitUntil(
        caches.open(CACHE_APP)
            // 'reload' evita copiar versões antigas do cache HTTP.
            .then(cache => cache.addAll(RECURSOS_APP.map(
                recurso => new Request(recurso, { cache: 'reload' })
            )))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', evento => {
    const atuais = [CACHE_APP, CACHE_TILES];
    evento.waitUntil(
        caches.keys()
            // Só apaga caches deste aplicativo; os de outros sites/apps ficam.
            .then(nomes => Promise.all(nomes
                .filter(nome => nome.startsWith(PREFIXO_CACHE) && !atuais.includes(nome))
                .map(nome => caches.delete(nome))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', evento => {
    const requisicao = evento.request;
    if (requisicao.method !== 'GET') return;

    const url = new URL(requisicao.url);
    if (url.origin !== self.location.origin) return;

    if (requisicao.mode === 'navigate') {
        evento.respondWith(redePrimeiro(evento, url));
    } else if (url.pathname.startsWith(BASE + 'tiles/') && url.pathname.endsWith('.png')) {
        evento.respondWith(tile(evento));
    } else {
        evento.respondWith(cachePrimeiro(evento, CACHE_APP));
    }
});

function guardar(evento, nomeCache, chave, resposta) {
    evento.waitUntil(
        caches.open(nomeCache)
            .then(cache => cache.put(chave, resposta))
            .catch(erro => console.warn('Não foi possível guardar no cache:', erro))
    );
}

function paginaGuardada() {
    return caches.open(CACHE_APP).then(cache => cache.match(URL_PAGINA));
}

function redePrimeiro(evento, url) {
    const ehPagina = url.pathname === BASE || url.pathname === BASE + 'index.html';

    const daRede = fetch(evento.request).then(resposta => {
        if (resposta.ok && ehPagina) {
            guardar(evento, CACHE_APP, URL_PAGINA, resposta.clone());
        }
        return resposta;
    });

    let temporizador;
    const limite = new Promise(resolver => {
        temporizador = setTimeout(resolver, TEMPO_LIMITE_REDE_MS, null);
    });

    return Promise.race([
        daRede.then(resposta => resposta.ok ? resposta : null, () => null),
        limite
    ]).then(resposta => {
        clearTimeout(temporizador);
        if (resposta) return resposta;
        // Sem rede, rede lenta ou erro do servidor: tenta a cópia guardada.
        return paginaGuardada().then(guardada => guardada || daRede);
    });
}

function cachePrimeiro(evento, nomeCache) {
    return caches.open(nomeCache)
        .then(cache => cache.match(evento.request))
        .then(guardada => guardada || fetch(evento.request).then(resposta => {
            if (resposta.ok) guardar(evento, nomeCache, evento.request, resposta.clone());
            return resposta;
        }));
}

function tile(evento) {
    return cachePrimeiro(evento, CACHE_TILES).catch(() => new Response(
        'Tile indisponível offline.',
        {
            status: 504,
            statusText: 'Tile indisponivel offline',
            headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
        }
    ));
}
