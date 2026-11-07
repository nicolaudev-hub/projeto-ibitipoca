// Testes do download do mapa offline (js/download-mapa.js).
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const CODIGO = fs.readFileSync(path.join(STATIC, 'js', 'download-mapa.js'), 'utf8');
const MANIFESTO = JSON.parse(fs.readFileSync(path.join(STATIC, 'tiles', 'manifesto.json'), 'utf8'));
const TOTAL = MANIFESTO.tiles.length;
const PAGINA = 'https://ibitipoca.test/index.html';

function carregarModulo() {
    const contexto = {
        console: console,
        Response: Response,
        AbortController: AbortController,
        setTimeout: (...a) => setTimeout(...a)
    };
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(CODIGO, contexto);
    return contexto.DownloadMapa;
}

const DownloadMapa = carregarModulo();

function criarAmbiente(ajustes) {
    const amb = Object.assign({
        tilesOffline: false,
        manifesto: () => new Response(JSON.stringify(MANIFESTO), { status: 200 }),
        falhaPersistente: new Set(),
        falhaUmaVez: new Set(),
        conteudoInvalido: new Set(),
        travarTiles: false,
        limiteGravacoes: Infinity,
        estimativa: null,
        persistiu: 0
    }, ajustes);
    amb.tentativas = new Map();
    amb.chamadasTiles = 0;
    amb.removidos = [];
    amb.armazenamento = new Map();

    const absoluta = url => new URL(url, PAGINA).href;

    class CacheFalso {
        constructor() { this.itens = new Map(); }
        async match(url) {
            const conteudo = this.itens.get(absoluta(url));
            return conteudo ? new Response(conteudo.slice(0), { status: 200 }) : undefined;
        }
        async put(url, resposta) {
            if (amb.limiteGravacoes <= 0) {
                throw new DOMException('Quota exceeded', 'QuotaExceededError');
            }
            amb.limiteGravacoes--;
            this.itens.set(absoluta(url), await resposta.arrayBuffer());
        }
        async delete(url) {
            amb.removidos.push(absoluta(url));
            return this.itens.delete(absoluta(url));
        }
    }

    amb.caches = {
        async open(nome) {
            if (!amb.armazenamento.has(nome)) amb.armazenamento.set(nome, new CacheFalso());
            return amb.armazenamento.get(nome);
        }
    };

    // O manifesto é servido sempre (no navegador, o sw.js o entrega do cache);
    // as opções acima afetam apenas os tiles.
    amb.fetch = (url, opcoes) => {
        const caminho = new URL(url, PAGINA).pathname;
        if (caminho === '/tiles/manifesto.json') return Promise.resolve(amb.manifesto());

        const tile = caminho.replace('/tiles/', '');
        amb.chamadasTiles++;
        amb.tentativas.set(tile, (amb.tentativas.get(tile) || 0) + 1);
        const sinal = opcoes && opcoes.signal;

        if (amb.travarTiles) {
            return new Promise((_ok, falha) => {
                sinal.addEventListener('abort', () =>
                    falha(new DOMException('Aborted', 'AbortError')));
            });
        }
        if (amb.tilesOffline || amb.falhaPersistente.has(tile)) {
            return Promise.reject(new TypeError('Failed to fetch'));
        }
        if (amb.falhaUmaVez.has(tile)) {
            amb.falhaUmaVez.delete(tile);
            return Promise.reject(new TypeError('Failed to fetch'));
        }
        if (amb.conteudoInvalido.has(tile)) {
            return Promise.resolve(new Response('<html>erro</html>', { status: 200 }));
        }
        const arquivo = path.join(STATIC, 'tiles', tile);
        if (!fs.existsSync(arquivo)) return Promise.resolve(new Response('', { status: 404 }));
        return Promise.resolve(new Response(fs.readFileSync(arquivo), { status: 200 }));
    };

    amb.storage = {
        estimate: async () => amb.estimativa || {},
        persist: async () => { amb.persistiu++; return true; }
    };

    amb.cacheTiles = () => amb.armazenamento.get('ibitipoca-tiles-' + MANIFESTO.versao);

    amb.criar = (extras) => {
        amb.progresso = [];
        return DownloadMapa.criar(Object.assign({
            caches: amb.caches,
            fetch: amb.fetch,
            armazenamento: amb.storage,
            subtle: globalThis.crypto.subtle,
            esperar: () => Promise.resolve(),
            aoProgresso: dados => amb.progresso.push(dados)
        }, extras));
    };
    return amb;
}

const baixando = amb => amb.progresso.filter(p => p.estado === 'baixando');

// ---- Conclusão ----

test('download completo: progresso, totais do manifesto e conteúdo guardado', async () => {
    const amb = criarAmbiente();
    const download = amb.criar();
    const resultado = await download.baixar();

    assert.equal(resultado.estado, 'completo');
    assert.equal(resultado.versao, MANIFESTO.versao);
    assert.equal(resultado.total, TOTAL);
    assert.equal(resultado.concluidos, TOTAL);
    assert.equal(resultado.percentual, 100);
    assert.equal(resultado.bytesTotais, MANIFESTO.totalBytes);
    assert.equal(resultado.bytesConcluidos, MANIFESTO.totalBytes);
    assert.equal(resultado.bytesTransferidos, MANIFESTO.totalBytes);
    assert.deepEqual([...resultado.falhas], []);
    assert.equal(resultado.persistente, true);
    assert.equal(amb.persistiu, 1);
    assert.equal(amb.chamadasTiles, TOTAL);

    const eventos = baixando(amb);
    assert.equal(eventos[0].concluidos, 0);
    assert.equal(eventos[0].percentual, 0);
    for (let i = 1; i < eventos.length; i++) {
        assert.ok(eventos[i].concluidos >= eventos[i - 1].concluidos, 'progresso não regride');
        assert.ok(eventos[i].bytesTransferidos >= eventos[i - 1].bytesTransferidos);
    }
    assert.equal(eventos.at(-1).percentual, 100);
    assert.equal(amb.progresso.at(-1).estado, 'completo', 'estado final informado');

    const cache = amb.cacheTiles();
    for (const tile of MANIFESTO.tiles) {
        const guardado = await cache.match('./tiles/' + tile.caminho);
        const esperado = fs.readFileSync(path.join(STATIC, 'tiles', tile.caminho));
        assert.ok(Buffer.from(await guardado.arrayBuffer()).equals(esperado), tile.caminho);
    }
});

test('verificar: informa incompleto antes e completo depois, sem baixar', async () => {
    const amb = criarAmbiente();
    const download = amb.criar();
    const antes = await download.verificar();
    assert.equal(antes.estado, 'incompleto');
    assert.equal(antes.concluidos, 0);
    assert.equal(antes.total, TOTAL);
    assert.equal(amb.chamadasTiles, 0);

    await download.baixar();
    amb.tilesOffline = true;
    const depois = await download.verificar();
    assert.equal(depois.estado, 'completo');
    assert.equal(depois.bytesConcluidos, MANIFESTO.totalBytes);
});

test('mapa já completo: novo download não acessa a rede', async () => {
    const amb = criarAmbiente();
    await amb.criar().baixar();
    amb.chamadasTiles = 0;
    const resultado = await amb.criar().baixar();
    assert.equal(resultado.estado, 'completo');
    assert.equal(amb.chamadasTiles, 0);
});

// ---- Cancelamento e retomada ----

test('cancelar no meio e retomar baixa apenas o que falta', async () => {
    const amb = criarAmbiente();
    const LIMITE = Math.floor(TOTAL / 3);
    let download;
    download = amb.criar({
        simultaneos: 1,
        aoProgresso: dados => {
            amb.progresso.push(dados);
            if (dados.estado === 'baixando' && dados.concluidos === LIMITE) download.cancelar();
        }
    });
    const cancelado = await download.baixar();
    assert.equal(cancelado.estado, 'cancelado');
    assert.equal(cancelado.concluidos, LIMITE);
    assert.ok(cancelado.concluidos < TOTAL);

    const conferido = await download.verificar();
    assert.equal(conferido.estado, 'incompleto');
    assert.equal(conferido.concluidos, LIMITE);

    amb.chamadasTiles = 0;
    const retomado = await amb.criar().baixar();
    assert.equal(retomado.estado, 'completo');
    assert.equal(amb.chamadasTiles, TOTAL - LIMITE, 'não repete tiles válidos');
    assert.equal(retomado.bytesTransferidos,
        MANIFESTO.totalBytes - cancelado.bytesConcluidos);
});

test('cancelar aborta requisições pendentes', async () => {
    const amb = criarAmbiente({ travarTiles: true });
    const download = amb.criar();
    const promessa = download.baixar();
    while (amb.chamadasTiles === 0) await new Promise(r => setImmediate(r));
    assert.equal(download.emAndamento(), true);
    assert.equal(download.cancelar(), true);
    const resultado = await promessa;
    assert.equal(resultado.estado, 'cancelado');
    assert.equal(resultado.concluidos, 0);
    assert.deepEqual([...resultado.falhas], [], 'cancelamento não conta como falha');
    assert.equal(download.emAndamento(), false);
    assert.equal(download.cancelar(), false, 'nada para cancelar');
});

test('chamadas simultâneas a baixar() compartilham o mesmo download', async () => {
    const amb = criarAmbiente();
    const download = amb.criar();
    const [a, b] = await Promise.all([download.baixar(), download.baixar()]);
    assert.equal(a, b);
    assert.equal(amb.chamadasTiles, TOTAL);
});

// ---- Falhas ----

const ALGUNS = [MANIFESTO.tiles[3].caminho, MANIFESTO.tiles[TOTAL - 2].caminho];

test('falha transitória é refeita e o download conclui', async () => {
    const amb = criarAmbiente({ falhaUmaVez: new Set([ALGUNS[0]]) });
    const resultado = await amb.criar().baixar();
    assert.equal(resultado.estado, 'completo');
    assert.equal(amb.tentativas.get(ALGUNS[0]), 2);
});

test('falha persistente: estado parcial, sem declarar completo; retomada conclui', async () => {
    const amb = criarAmbiente({ falhaPersistente: new Set(ALGUNS) });
    const parcial = await amb.criar().baixar();
    assert.equal(parcial.estado, 'parcial');
    assert.equal(parcial.concluidos, TOTAL - ALGUNS.length);
    assert.ok(parcial.percentual < 100);
    assert.deepEqual([...parcial.falhas].map(f => f.caminho).sort(), [...ALGUNS].sort());
    assert.match(parcial.mensagem, new RegExp(ALGUNS.length + ' tile'));
    for (const tile of ALGUNS) assert.equal(amb.tentativas.get(tile), 3, 'três tentativas');
    assert.ok(!amb.progresso.some(p => p.estado === 'completo'));

    amb.falhaPersistente.clear();
    amb.chamadasTiles = 0;
    const retomado = await amb.criar().baixar();
    assert.equal(retomado.estado, 'completo');
    assert.equal(amb.chamadasTiles, ALGUNS.length);
});

test('conteúdo inválido não é guardado', async () => {
    const amb = criarAmbiente({ conteudoInvalido: new Set([ALGUNS[0]]) });
    const resultado = await amb.criar().baixar();
    assert.equal(resultado.estado, 'parcial');
    assert.equal(resultado.falhas[0].caminho, ALGUNS[0]);
    assert.match(resultado.falhas[0].motivo, /inválido/);
    assert.equal(await amb.cacheTiles().match('./tiles/' + ALGUNS[0]), undefined);
});

test('tile corrompido no cache é detectado, removido e baixado de novo', async () => {
    const amb = criarAmbiente();
    await amb.criar().baixar();
    const url = './tiles/' + ALGUNS[0];
    amb.cacheTiles().itens.set(new URL(url, PAGINA).href, new ArrayBuffer(10));

    const conferido = await amb.criar().verificar();
    assert.equal(conferido.estado, 'incompleto');
    assert.equal(conferido.concluidos, TOTAL - 1);

    amb.chamadasTiles = 0;
    const resultado = await amb.criar().baixar();
    assert.equal(resultado.estado, 'completo');
    assert.equal(amb.chamadasTiles, 1);
    assert.ok(amb.removidos.includes(new URL(url, PAGINA).href));
});

test('sem conexão: todos falham e o mapa não é declarado completo', async () => {
    const amb = criarAmbiente({ tilesOffline: true });
    const resultado = await amb.criar().baixar();
    assert.equal(resultado.estado, 'parcial');
    assert.equal(resultado.concluidos, 0);
    assert.equal(resultado.falhas.length, TOTAL);
});

test('espaço insuficiente estimado: não inicia o download', async () => {
    const amb = criarAmbiente({
        estimativa: { quota: MANIFESTO.totalBytes, usage: MANIFESTO.totalBytes / 2 }
    });
    const resultado = await amb.criar().baixar();
    assert.equal(resultado.estado, 'espaco');
    assert.match(resultado.mensagem, /insuficiente/);
    assert.equal(amb.chamadasTiles, 0);
});

test('armazenamento cheio durante a gravação: para e informa espaço', async () => {
    const amb = criarAmbiente({ limiteGravacoes: 10 });
    const resultado = await amb.criar().baixar();
    assert.equal(resultado.estado, 'espaco');
    assert.equal(resultado.concluidos, 10);
    assert.ok(amb.chamadasTiles < TOTAL, 'interrompe os demais downloads');
});

test('manifesto indisponível ou inválido: estado de erro', async () => {
    const semManifesto = criarAmbiente({
        manifesto: () => new Response('', { status: 404 })
    });
    const r1 = await semManifesto.criar().baixar();
    assert.equal(r1.estado, 'erro');
    assert.match(r1.mensagem, /manifesto/);
    assert.equal((await semManifesto.criar().verificar()).estado, 'erro');

    const invalido = criarAmbiente({
        manifesto: () => new Response('{"versao":"x","tiles":[]}', { status: 200 })
    });
    assert.equal((await invalido.criar().baixar()).estado, 'erro');
    assert.equal(semManifesto.chamadasTiles + invalido.chamadasTiles, 0);
});

test('sem Cache Storage (fora de HTTPS): indisponível', async () => {
    const amb = criarAmbiente();
    const download = amb.criar({ caches: undefined });
    assert.equal((await download.baixar()).estado, 'indisponivel');
    assert.equal((await download.verificar()).estado, 'indisponivel');
});

test('sem crypto.subtle: valida por tamanho e assinatura PNG', async () => {
    const amb = criarAmbiente({ conteudoInvalido: new Set([ALGUNS[0]]) });
    const resultado = await amb.criar({ subtle: undefined }).baixar();
    assert.equal(resultado.estado, 'parcial');
    assert.equal(resultado.concluidos, TOTAL - 1);
});

test('callback com erro não interrompe o download', async () => {
    const amb = criarAmbiente();
    const erros = console.error;
    console.error = () => {};
    try {
        const resultado = await amb.criar({
            aoProgresso: () => { throw new Error('falha na interface'); }
        }).baixar();
        assert.equal(resultado.estado, 'completo');
    } finally {
        console.error = erros;
    }
});

// ---- Integração com sw.js e index.html ----

test('integração: grava no mesmo cache de tiles que o sw.js usa', () => {
    const contexto = {
        URL: URL,
        location: new URL('https://ibitipoca.test/sw.js'),
        addEventListener() {}
    };
    contexto.self = contexto;
    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(STATIC, 'sw.js'), 'utf8'), contexto);
    assert.equal(vm.runInContext('CACHE_TILES', contexto),
        DownloadMapa.nomeCacheTiles(MANIFESTO.versao));
});

test('index.html: carrega o módulo e tem os controles do download', () => {
    const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(STATIC, 'js', 'novo-app.js'), 'utf8');
    const modulo = html.indexOf('<script src="./js/download-mapa.js"></script>');
    assert.ok(modulo > 0 && modulo < html.indexOf('<script src="./js/novo-app.js"></script>'));
    for (const id of ['offline-estado', 'offline-progresso', 'offline-detalhe',
        'offline-baixar', 'offline-cancelar']) {
        assert.match(html, new RegExp('id="' + id + '"'), id);
    }
    assert.match(app, /DownloadMapa\.criar\(/);
});
