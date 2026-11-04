// Testes do Service Worker (sw.js) e do registro (js/registro-sw.js).
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const CODIGO_SW = fs.readFileSync(path.join(STATIC, 'sw.js'), 'utf8');
const CODIGO_REGISTRO = fs.readFileSync(path.join(STATIC, 'js', 'registro-sw.js'), 'utf8');
const MANIFESTO = JSON.parse(fs.readFileSync(path.join(STATIC, 'tiles', 'manifesto.json'), 'utf8'));
const ORIGEM = 'https://ibitipoca.test';
const LOCAL_SW = ORIGEM + '/sw.js';

// ---- Ambiente simulado de Service Worker ----

function criarAmbiente(opcoesIniciais) {
    const opcoes = Object.assign({ rede: 'online', respostas: {} }, opcoesIniciais);
    const chamadasRede = [];
    const ouvintes = {};
    const armazenamento = new Map();
    const estado = { skipWaiting: 0, claim: 0 };

    // Rede: serve arquivos de static/; 'offline' falha; 'lenta' nunca responde.
    function fetchFalso(requisicao) {
        const url = new URL(requisicao.url);
        chamadasRede.push(url.pathname);
        if (opcoes.rede === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
        if (opcoes.rede === 'lenta') return new Promise(() => {});
        const personalizada = opcoes.respostas[url.pathname];
        if (personalizada) return Promise.resolve(personalizada());
        const arquivo = path.join(STATIC, url.pathname === '/' ? 'index.html' : url.pathname);
        if (!fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) {
            return Promise.resolve(new Response('Recurso nao encontrado.', { status: 404 }));
        }
        return Promise.resolve(new Response(fs.readFileSync(arquivo), { status: 200 }));
    }

    const chave = r => typeof r === 'string' ? new URL(r, LOCAL_SW).href : r.url;

    class CacheFalso {
        constructor() { this.itens = new Map(); }
        async match(r) {
            const item = this.itens.get(chave(r));
            return item ? item.clone() : undefined;
        }
        async put(r, resposta) { this.itens.set(chave(r), resposta); }
        // Atômico, como no navegador: falha inteira se algum recurso falhar.
        async addAll(requisicoes) {
            const respostas = await Promise.all(requisicoes.map(async r => {
                const resposta = await fetchFalso(r);
                if (!resposta.ok) throw new TypeError('addAll: ' + r.url + ' ' + resposta.status);
                return [r, resposta];
            }));
            for (const [r, resposta] of respostas) await this.put(r, resposta);
        }
    }

    const caches = {
        async open(nome) {
            if (!armazenamento.has(nome)) armazenamento.set(nome, new CacheFalso());
            return armazenamento.get(nome);
        },
        async keys() { return [...armazenamento.keys()]; },
        async delete(nome) { return armazenamento.delete(nome); }
    };

    // O Request do Node exige URL absoluta; no SW ela é relativa ao sw.js.
    class RequestSW extends Request {
        constructor(entrada, init) {
            super(typeof entrada === 'string' ? new URL(entrada, LOCAL_SW).href : entrada, init);
        }
    }

    const contexto = {
        console: console,
        URL: URL,
        Response: Response,
        Request: RequestSW,
        Promise: Promise,
        setTimeout: (...a) => setTimeout(...a),
        clearTimeout: (...a) => clearTimeout(...a),
        location: new URL(LOCAL_SW),
        caches: caches,
        fetch: fetchFalso,
        skipWaiting: () => { estado.skipWaiting++; return Promise.resolve(); },
        clients: { claim: () => { estado.claim++; return Promise.resolve(); } },
        addEventListener: (tipo, fn) => { ouvintes[tipo] = fn; }
    };
    contexto.self = contexto;
    vm.createContext(contexto);
    vm.runInContext(CODIGO_SW, contexto);

    function disparar(tipo, dados) {
        const esperas = [];
        let resposta;
        ouvintes[tipo](Object.assign({
            waitUntil(p) { esperas.push(Promise.resolve(p)); },
            respondWith(p) { resposta = Promise.resolve(p); }
        }, dados));
        return {
            resposta,
            // Aguarda inclusive waitUntil() chamados depois (gravações no cache).
            async concluir() {
                let quantidade;
                do {
                    quantidade = esperas.length;
                    await Promise.all(esperas);
                } while (quantidade !== esperas.length);
            }
        };
    }

    function requisitar(caminho, init) {
        const evento = disparar('fetch', {
            request: Object.assign({
                method: 'GET',
                mode: 'cors',
                url: new URL(caminho, ORIGEM).href
            }, init)
        });
        return evento;
    }

    async function buscar(caminho, init) {
        const evento = requisitar(caminho, init);
        assert.ok(evento.resposta, 'o SW deveria responder ' + caminho);
        const resposta = await evento.resposta;
        await evento.concluir();
        return resposta;
    }

    async function instalarEAtivar() {
        const instalacao = disparar('install', {});
        await instalacao.concluir();
        const ativacao = disparar('activate', {});
        await ativacao.concluir();
    }

    return {
        opcoes, chamadasRede, armazenamento, estado, disparar, requisitar,
        buscar, instalarEAtivar,
        // Copia arrays do contexto vm para o realm dos testes (deepStrictEqual compara protótipos).
        constante: nome => {
            const valor = vm.runInContext(nome, contexto);
            return Array.isArray(valor) ? [...valor] : valor;
        }
    };
}

const ler = arquivo => fs.readFileSync(path.join(STATIC, arquivo));

// ---- Configuração e recursos ----

test('config: versão dos tiles do SW igual à do manifesto', () => {
    const amb = criarAmbiente();
    assert.equal(amb.constante('VERSAO_TILES'), MANIFESTO.versao);
    assert.match(amb.constante('CACHE_APP'), /^ibitipoca-app-/);
    assert.match(amb.constante('CACHE_TILES'), /^ibitipoca-tiles-/);
    assert.notEqual(amb.constante('CACHE_APP'), amb.constante('CACHE_TILES'));
});

test('recursos: todos os arquivos pré-armazenados existem em static/', () => {
    const recursos = criarAmbiente().constante('RECURSOS_APP');
    const ausentes = recursos.filter(r => !fs.existsSync(path.join(STATIC, r)));
    assert.deepEqual(ausentes, []);
});

test('recursos: tudo que o index.html carrega localmente está no pré-cache', () => {
    const recursos = criarAmbiente().constante('RECURSOS_APP');
    const html = ler('index.html').toString('utf8');
    const usados = new Set();
    for (const m of html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) usados.add(m[1]);
    for (const m of html.matchAll(/'(\.\/[^'{}]+\.(?:png|json|js|css))'/g)) usados.add(m[1]);
    assert.ok(usados.size >= 6, 'deveria encontrar os recursos do index.html');
    const faltando = [...usados].filter(u => !recursos.includes(u));
    assert.deepEqual(faltando, []);
});

// ---- Instalação ----

test('instalação: guarda todos os recursos e ativa imediatamente', async () => {
    const amb = criarAmbiente();
    const instalacao = amb.disparar('install', {});
    await instalacao.concluir();
    const cache = amb.armazenamento.get(amb.constante('CACHE_APP'));
    for (const recurso of amb.constante('RECURSOS_APP')) {
        const guardada = await cache.match(new URL(recurso, LOCAL_SW).href);
        assert.ok(guardada, recurso);
        assert.ok(Buffer.from(await guardada.arrayBuffer()).equals(ler(recurso)), recurso);
    }
    assert.equal(amb.estado.skipWaiting, 1);
    // Tiles não são baixados na instalação (etapa do download com progresso).
    assert.equal(amb.armazenamento.has(amb.constante('CACHE_TILES')), false);
});

test('instalação: recurso ausente faz a instalação falhar sem cache parcial', async () => {
    const amb = criarAmbiente({
        respostas: { '/js/navegacao.js': () => new Response('x', { status: 404 }) }
    });
    const instalacao = amb.disparar('install', {});
    await assert.rejects(instalacao.concluir(), /navegacao\.js/);
    const cache = amb.armazenamento.get(amb.constante('CACHE_APP'));
    assert.equal(cache.itens.size, 0);
    assert.equal(amb.estado.skipWaiting, 0);
});

// ---- Limpeza de versões ----

test('ativação: remove só caches antigos deste aplicativo', async () => {
    const amb = criarAmbiente();
    for (const nome of ['ibitipoca-app-v0-antigo', 'ibitipoca-tiles-antigo',
        'outro-site-cache', 'workbox-precache']) {
        amb.armazenamento.set(nome, {});
    }
    await amb.instalarEAtivar();
    assert.deepEqual([...amb.armazenamento.keys()].sort(), [
        amb.constante('CACHE_APP'),
        'outro-site-cache',
        'workbox-precache'
    ].sort());
    assert.equal(amb.estado.claim, 1);
});

test('ativação: preserva o cache de tiles da versão atual', async () => {
    const amb = criarAmbiente();
    amb.armazenamento.set(amb.constante('CACHE_TILES'), {});
    await amb.instalarEAtivar();
    assert.ok(amb.armazenamento.has(amb.constante('CACHE_TILES')));
});

// ---- Navegação: rede primeiro ----

test('navegação online: usa a rede e atualiza a cópia da página', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    amb.opcoes.respostas['/'] = () => new Response('<p>versao nova</p>', { status: 200 });
    const online = await amb.buscar('/', { mode: 'navigate' });
    assert.equal(await online.text(), '<p>versao nova</p>');

    amb.opcoes.rede = 'offline';
    const offline = await amb.buscar('/', { mode: 'navigate' });
    assert.equal(await offline.text(), '<p>versao nova</p>');
});

test('navegação offline: devolve a página guardada', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    amb.opcoes.rede = 'offline';
    for (const caminho of ['/', '/index.html']) {
        const resposta = await amb.buscar(caminho, { mode: 'navigate' });
        assert.equal(resposta.status, 200);
        assert.ok(Buffer.from(await resposta.arrayBuffer()).equals(ler('index.html')));
    }
});

test('navegação com rede lenta: após o limite usa a página guardada', async (t) => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    amb.opcoes.rede = 'lenta';
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const evento = amb.requisitar('/', { mode: 'navigate' });
    // Deixa o SW abrir o cache e armar o temporizador antes de avançar o relógio.
    await new Promise(resolver => setImmediate(resolver));
    t.mock.timers.tick(amb.constante('TEMPO_LIMITE_REDE_MS'));
    const resposta = await evento.resposta;
    assert.ok(Buffer.from(await resposta.arrayBuffer()).equals(ler('index.html')));
});

test('navegação com erro do servidor: prefere a página guardada', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    amb.opcoes.respostas['/'] = () => new Response('erro', { status: 500 });
    const resposta = await amb.buscar('/', { mode: 'navigate' });
    assert.equal(resposta.status, 200);
    assert.ok(Buffer.from(await resposta.arrayBuffer()).equals(ler('index.html')));
});

test('navegação offline sem cópia guardada: falha como erro de rede', async () => {
    const amb = criarAmbiente({ rede: 'offline' });
    await assert.rejects(amb.buscar('/', { mode: 'navigate' }), TypeError);
});

test('navegação para outro caminho não substitui a cópia da página', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    await amb.buscar('/tiles/manifesto.json', { mode: 'navigate' });
    amb.opcoes.rede = 'offline';
    const pagina = await amb.buscar('/', { mode: 'navigate' });
    assert.ok(Buffer.from(await pagina.arrayBuffer()).equals(ler('index.html')));
});

// ---- Página de testes novo.html ----

test('novo.html: tudo que a página carrega localmente está no pré-cache', () => {
    const recursos = criarAmbiente().constante('RECURSOS_APP');
    const html = ler('novo.html').toString('utf8');
    const usados = new Set();
    for (const m of html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) usados.add(m[1]);
    assert.ok(usados.size >= 15, 'deveria encontrar os recursos do novo.html');
    const faltando = [...usados].filter(u => !recursos.includes(u));
    assert.deepEqual(faltando, []);
    assert.ok(recursos.includes('./novo.html'));
});

test('novo.html offline: devolve a própria cópia, não a do index.html', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    amb.opcoes.rede = 'offline';
    const nova = await amb.buscar('/novo.html', { mode: 'navigate' });
    assert.ok(Buffer.from(await nova.arrayBuffer()).equals(ler('novo.html')));
    const principal = await amb.buscar('/', { mode: 'navigate' });
    assert.ok(Buffer.from(await principal.arrayBuffer()).equals(ler('index.html')));
});

test('novo.html online: atualiza só a própria cópia', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    amb.opcoes.respostas['/novo.html'] = () => new Response('<p>novo atualizado</p>', { status: 200 });
    await amb.buscar('/novo.html', { mode: 'navigate' });
    amb.opcoes.rede = 'offline';
    assert.equal(await (await amb.buscar('/novo.html', { mode: 'navigate' })).text(),
        '<p>novo atualizado</p>');
    const principal = await amb.buscar('/', { mode: 'navigate' });
    assert.ok(Buffer.from(await principal.arrayBuffer()).equals(ler('index.html')));
});

test('novo.html offline sem cópia própria: usa a do index.html', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    const cache = amb.armazenamento.get(amb.constante('CACHE_APP'));
    cache.itens.delete(amb.constante('URL_PAGINA_NOVA'));
    amb.opcoes.rede = 'offline';
    const resposta = await amb.buscar('/novo.html', { mode: 'navigate' });
    assert.ok(Buffer.from(await resposta.arrayBuffer()).equals(ler('index.html')));
});

// ---- Recursos do app: cache primeiro ----

test('recursos do app: vêm do cache sem acessar a rede', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    amb.opcoes.rede = 'offline';
    amb.chamadasRede.length = 0;
    for (const recurso of ['/js/navegacao.js', '/leaflet/leaflet.js', '/leaflet/leaflet.css',
        '/data/rota_navegacao_offline.json', '/tiles/manifesto.json']) {
        const resposta = await amb.buscar(recurso);
        assert.equal(resposta.status, 200, recurso);
        assert.ok(Buffer.from(await resposta.arrayBuffer()).equals(ler(recurso)), recurso);
    }
    assert.deepEqual(amb.chamadasRede, []);
});

test('recurso fora do pré-cache: online busca e guarda; offline falha', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    amb.opcoes.respostas['/extra.js'] = () => new Response('// extra', { status: 200 });
    assert.equal(await (await amb.buscar('/extra.js')).text(), '// extra');
    amb.opcoes.rede = 'offline';
    assert.equal(await (await amb.buscar('/extra.js')).text(), '// extra');
    await assert.rejects(amb.buscar('/nao-guardado.js'), TypeError);
});

test('recurso inexistente (404) não é guardado', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    assert.equal((await amb.buscar('/nao-existe.js')).status, 404);
    const cache = amb.armazenamento.get(amb.constante('CACHE_APP'));
    assert.equal(await cache.match(ORIGEM + '/nao-existe.js'), undefined);
});

// ---- Tiles ----

const TILE = '/tiles/' + MANIFESTO.tiles[MANIFESTO.tiles.length - 1].caminho;

test('tiles: busca online, guarda no cache de tiles e serve offline', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    const online = await amb.buscar(TILE);
    assert.equal(online.status, 200);

    const cacheTiles = amb.armazenamento.get(amb.constante('CACHE_TILES'));
    assert.ok(await cacheTiles.match(ORIGEM + TILE), 'tile no cache de tiles');
    const cacheApp = amb.armazenamento.get(amb.constante('CACHE_APP'));
    assert.equal(await cacheApp.match(ORIGEM + TILE), undefined, 'tile fora do cache do app');

    amb.opcoes.rede = 'offline';
    amb.chamadasRede.length = 0;
    const offline = await amb.buscar(TILE);
    assert.ok(Buffer.from(await offline.arrayBuffer()).equals(ler(TILE)));
    assert.deepEqual(amb.chamadasRede, []);
});

test('tiles: ausente e sem conexão responde 504 sem afetar outros tiles', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    await amb.buscar(TILE);
    amb.opcoes.rede = 'offline';
    const ausente = await amb.buscar('/tiles/' + MANIFESTO.tiles[0].caminho);
    assert.equal(ausente.status, 504);
    assert.match(await ausente.text(), /offline/);
    assert.equal((await amb.buscar(TILE)).status, 200);
});

test('tiles: tile inexistente no servidor responde 404 e não é guardado', async () => {
    const amb = criarAmbiente();
    await amb.instalarEAtivar();
    const resposta = await amb.buscar('/tiles/12/0/0.png');
    assert.equal(resposta.status, 404);
    const cacheTiles = amb.armazenamento.get(amb.constante('CACHE_TILES'));
    assert.equal(cacheTiles ? await cacheTiles.match(ORIGEM + '/tiles/12/0/0.png') : undefined,
        undefined);
});

// ---- Requisições ignoradas ----

test('não intercepta POST nem outras origens', () => {
    const amb = criarAmbiente();
    assert.equal(amb.requisitar('/config.json', { method: 'POST' }).resposta, undefined);
    assert.equal(amb.requisitar('https://outro.site/tile.png').resposta, undefined);
});

// ---- Registro na página ----

function carregarRegistro(janela) {
    const contexto = Object.assign({ console: console, Promise: Promise }, janela);
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(CODIGO_REGISTRO, contexto);
    return contexto.RegistroSW;
}

test('registro: navegador sem Service Worker informa indisponível', async () => {
    const informados = [];
    const registro = carregarRegistro({ navigator: {}, isSecureContext: true });
    const resultado = await registro.registrar(r => informados.push(r));
    assert.equal(resultado.estado, 'indisponivel');
    assert.equal(informados.length, 1);
});

test('registro: sem HTTPS não tenta registrar', async () => {
    let chamadas = 0;
    const registro = carregarRegistro({
        isSecureContext: false,
        navigator: { serviceWorker: { register() { chamadas++; return Promise.resolve(); } } }
    });
    assert.equal((await registro.registrar()).estado, 'indisponivel');
    assert.equal(chamadas, 0);
});

test('registro: falha no registro é informada sem lançar erro', async () => {
    const registro = carregarRegistro({
        isSecureContext: true,
        navigator: { serviceWorker: { register: () => Promise.reject(new Error('SecurityError')) } }
    });
    const avisos = console.warn;
    console.warn = () => {};
    try {
        const resultado = await registro.registrar();
        assert.equal(resultado.estado, 'erro');
    } finally {
        console.warn = avisos;
    }
});

test('registro: sucesso registra ./sw.js e aguarda ficar pronto', async () => {
    const registrados = [];
    const registro = carregarRegistro({
        isSecureContext: true,
        navigator: {
            serviceWorker: {
                register(url) { registrados.push(url); return Promise.resolve({}); },
                ready: Promise.resolve({})
            }
        }
    });
    const erros = console.error;
    console.error = () => {};
    let resultado;
    try {
        resultado = await registro.registrar(() => { throw new Error('callback com erro'); });
    } finally {
        console.error = erros;
    }
    assert.equal(resultado.estado, 'pronto');
    assert.deepEqual(registrados, ['./sw.js']);
});

test('index.html: carrega o registro antes do script principal', () => {
    const html = ler('index.html').toString('utf8');
    const registro = html.indexOf('<script src="./js/registro-sw.js"></script>');
    const principal = html.indexOf('<script>');
    assert.ok(registro > 0 && registro < principal);
    assert.match(html, /RegistroSW\.registrar\(/);
});
