// Testes da rota até um destino escolhido pelo usuário (js/rota-destino.js).
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
// Resposta real do OSRM do chalé até a portaria do parque: serve como rota de
// exemplo para um destino qualquer (a portaria).
const OSRM_EXEMPLO = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'osrm_chale_parque.json'), 'utf8');

function criarLeaflet() {
    const criadas = [];
    function camada(tipo, latLngs) {
        const c = {
            tipo: tipo,
            latLngs: latLngs,
            tooltips: [],
            addTo(mapa) { mapa.addLayer(this); return this; },
            setLatLngs(novas) { this.latLngs = novas; return this; },
            setLatLng(nova) { this.latLngs = nova; return this; },
            getBounds() { return { limites: this.latLngs }; },
            bindTooltip(conteudo) { this.tooltips.push(conteudo); return this; },
            unbindTooltip() { return this; }
        };
        criadas.push(c);
        return c;
    }
    return {
        criadas: criadas,
        polyline: latLngs => camada('polyline', latLngs),
        circleMarker: latLng => camada('circleMarker', latLng)
    };
}

function criarMapa() {
    const camadas = new Set();
    return {
        camadas: camadas,
        enquadramentos: 0,
        addLayer(c) { camadas.add(c); return this; },
        removeLayer(c) { camadas.delete(c); return this; },
        hasLayer(c) { return camadas.has(c); },
        fitBounds() { this.enquadramentos++; return this; }
    };
}

function criarArmazenamento() {
    const itens = new Map();
    return {
        itens: itens,
        getItem: chave => itens.has(chave) ? itens.get(chave) : null,
        setItem: (chave, valor) => { itens.set(chave, String(valor)); },
        removeItem: chave => { itens.delete(chave); }
    };
}

function respostaJson(corpo, status) {
    return Promise.resolve(new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' }
    }));
}

const AGORA = Date.parse('2026-11-07T13:00:00Z');
const POSICAO_CHALE = { latitude: -21.716948, longitude: -43.928103, precisao: 12 };
const PORTARIA = { latitude: -21.7118892, longitude: -43.9030178, nome: 'Portaria do parque' };

function criarAmbiente(opcoes) {
    opcoes = Object.assign({ rede: () => respostaJson(OSRM_EXEMPLO) }, opcoes);
    const contexto = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
        AbortController: AbortController, navigator: {} };
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(STATIC, 'js', 'instrucoes.js'), 'utf8'), contexto);
    vm.runInContext(fs.readFileSync(path.join(STATIC, 'js', 'rota-destino.js'), 'utf8'), contexto);

    const L = criarLeaflet();
    const mapa = criarMapa();
    // Camada de outra rota (principal), que nunca pode ser alterada.
    const principal = { tipo: 'principal', latLngs: [[-21.75, -43.34], [-21.71, -43.92]] };
    mapa.addLayer(principal);
    const copiaPrincipal = JSON.stringify(principal.latLngs);

    const chamadas = [];
    const estados = [];
    const amb = {
        L: L,
        mapa: mapa,
        principalIntacta: () => mapa.hasLayer(principal) &&
            JSON.stringify(principal.latLngs) === copiaPrincipal,
        chamadas: chamadas,
        estados: estados,
        armazenamento: opcoes.armazenamento || criarArmazenamento(),
        posicao: 'posicao' in opcoes ? opcoes.posicao
            : Object.assign({ timestamp: AGORA - 2000 }, POSICAO_CHALE),
        online: opcoes.online !== false,
        RotaDestino: contexto.RotaDestino,
        camadasDestino: () => [...mapa.camadas].filter(c => c !== principal)
    };
    amb.destino = contexto.RotaDestino.criar({
        mapa: mapa,
        L: L,
        fetch: (url, init) => { chamadas.push(url); return opcoes.rede(url, init); },
        armazenamento: amb.armazenamento,
        estaOnline: () => amb.online,
        agora: () => AGORA,
        obterPosicao: () => amb.posicao,
        aoMudar: e => estados.push(e)
    });
    return amb;
}

// Arrays criados dentro do vm são de outro "realm": compara pelo conteúdo.
const valor = v => JSON.parse(JSON.stringify(v));

// ---- Escolha do destino ----

test('padrão: sem destino, sem camadas nem requisições', () => {
    const amb = criarAmbiente();
    assert.equal(amb.destino.destinoAtual(), null);
    assert.equal(amb.camadasDestino().length, 0);
    assert.equal(amb.chamadas.length, 0);
});

test('definir destino: marca o ponto no mapa sem consultar o serviço', () => {
    const amb = criarAmbiente();
    const e = amb.destino.definirDestino(PORTARIA);
    assert.equal(e.estado, 'destino-definido');
    assert.equal(e.destino.nome, 'Portaria do parque');
    assert.equal(amb.chamadas.length, 0);
    const marcadores = amb.camadasDestino().filter(c => c.tipo === 'circleMarker');
    assert.equal(marcadores.length, 1);
    assert.deepEqual(valor(marcadores[0].latLngs), [PORTARIA.latitude, PORTARIA.longitude]);
    assert.ok(amb.principalIntacta());
});

test('definir destino: aceita coordenadas em texto (como vêm da busca) e nome padrão', () => {
    const amb = criarAmbiente();
    const e = amb.destino.definirDestino({ latitude: '-21.7612', longitude: '-43.3496' });
    assert.equal(e.estado, 'destino-definido');
    assert.equal(e.destino.latitude, -21.7612);
    assert.equal(e.destino.nome, '-21.76120, -43.34960');
});

test('definir destino: recusa destino inválido ou fora do Sudeste', () => {
    const amb = criarAmbiente();
    assert.equal(amb.destino.definirDestino(null).estado, 'erro');
    assert.equal(amb.destino.definirDestino({ latitude: 'abc', longitude: 1 }).estado, 'erro');
    // Salvador (BA) fica fora da cobertura das rotas.
    const fora = amb.destino.definirDestino({ latitude: -12.97, longitude: -38.5, nome: 'Salvador' });
    assert.equal(fora.estado, 'fora-da-cobertura');
    assert.equal(amb.destino.destinoAtual(), null);
    assert.equal(amb.camadasDestino().length, 0);
});

test('nome vindo da busca entra no mapa como texto, não como HTML', () => {
    const amb = criarAmbiente();
    amb.destino.definirDestino(Object.assign({}, PORTARIA, { nome: '<img src=x onerror=alert(1)>' }));
    const marcador = amb.camadasDestino().find(c => c.tipo === 'circleMarker');
    // Sem document no ambiente de teste, cai no texto puro (String); com
    // document, vira um <span> preenchido por textContent.
    assert.equal(typeof marcador.tooltips[0], 'string');
});

// ---- Cálculo ----

test('calcular: origem é o GPS atual e o destino é o escolhido', async () => {
    const amb = criarAmbiente();
    amb.destino.definirDestino(PORTARIA);
    const e = await amb.destino.calcular();
    assert.equal(e.estado, 'pronta');
    assert.equal(e.recalculadaAgora, true);
    assert.equal(amb.chamadas.length, 1);
    assert.ok(amb.chamadas[0].startsWith('./osrm/route/v1/driving/'));
    const url = new URL(amb.chamadas[0], 'https://app.exemplo/');
    assert.equal(url.pathname,
        '/osrm/route/v1/driving/-43.928103,-21.716948;-43.903018,-21.711889');
    assert.equal(url.searchParams.get('steps'), 'true');
    assert.equal(url.searchParams.get('geometries'), 'geojson');
    assert.equal(e.rota.origem.latitude, POSICAO_CHALE.latitude);
    assert.equal(e.rota.destino.nome, 'Portaria do parque');
    assert.ok(e.rota.etapas.length > 2);
    assert.ok(amb.principalIntacta());
});

test('calcular: desenha a rota, enquadra o mapa e salva no aparelho', async () => {
    const amb = criarAmbiente();
    amb.destino.definirDestino(PORTARIA);
    await amb.destino.calcular();
    const linhas = amb.camadasDestino().filter(c => c.tipo === 'polyline');
    assert.equal(linhas.length, 1);
    assert.ok(linhas[0].latLngs.length > 100);
    assert.equal(amb.mapa.enquadramentos, 1);
    const salva = JSON.parse(amb.armazenamento.getItem(amb.RotaDestino.CHAVE_ARMAZENAMENTO));
    assert.equal(salva.formato, 1);
    assert.equal(salva.destino.nome, 'Portaria do parque');
});

test('calcular sem destino: pede para escolher e não consulta o serviço', async () => {
    const amb = criarAmbiente();
    const e = await amb.destino.calcular();
    assert.equal(e.estado, 'sem-destino');
    assert.equal(amb.chamadas.length, 0);
});

test('sem GPS, GPS antigo ou impreciso: não consulta o serviço', async () => {
    for (const posicao of [null,
        Object.assign({ timestamp: AGORA - 60000 }, POSICAO_CHALE),
        Object.assign({ timestamp: AGORA }, POSICAO_CHALE, { precisao: 500 })]) {
        const amb = criarAmbiente({ posicao: posicao });
        amb.destino.definirDestino(PORTARIA);
        const e = await amb.destino.calcular();
        assert.equal(e.estado, 'aguardando-gps');
        assert.equal(amb.chamadas.length, 0);
    }
});

test('posição fora do Sudeste: explica e não consulta o serviço', async () => {
    const amb = criarAmbiente({
        posicao: { latitude: -12.97, longitude: -38.5, precisao: 10, timestamp: AGORA }
    });
    amb.destino.definirDestino(PORTARIA);
    const e = await amb.destino.calcular();
    assert.equal(e.estado, 'fora-da-cobertura');
    assert.equal(amb.chamadas.length, 0);
});

test('sem internet: não consulta o serviço', async () => {
    const amb = criarAmbiente({ online: false });
    amb.destino.definirDestino(PORTARIA);
    const e = await amb.destino.calcular();
    assert.equal(e.estado, 'sem-rede');
    assert.equal(amb.chamadas.length, 0);
});

test('pedidos simultâneos geram uma única requisição', async () => {
    const amb = criarAmbiente();
    amb.destino.definirDestino(PORTARIA);
    const [a, b] = await Promise.all([amb.destino.calcular(), amb.destino.calcular()]);
    assert.equal(amb.chamadas.length, 1);
    assert.equal(a, b);
});

test('trocar de destino descarta a rota anterior', async () => {
    const amb = criarAmbiente();
    amb.destino.definirDestino(PORTARIA);
    await amb.destino.calcular();
    const e = amb.destino.definirDestino({ latitude: -21.7612, longitude: -43.3496, nome: 'Juiz de Fora' });
    assert.equal(e.rota, null);
    assert.equal(amb.camadasDestino().filter(c => c.tipo === 'polyline').length, 0);
    // Um único marcador, movido para o novo destino.
    const marcadores = amb.camadasDestino().filter(c => c.tipo === 'circleMarker');
    assert.equal(marcadores.length, 1);
    assert.deepEqual(valor(marcadores[0].latLngs), [-21.7612, -43.3496]);
});

test('resultado que chega depois de trocar o destino não é desenhado', async () => {
    let liberar;
    const amb = criarAmbiente({
        rede: () => new Promise(ok => { liberar = () => ok(respostaJson(OSRM_EXEMPLO)); })
    });
    amb.destino.definirDestino(PORTARIA);
    const pedido = amb.destino.calcular();
    amb.destino.definirDestino({ latitude: -21.7612, longitude: -43.3496, nome: 'Juiz de Fora' });
    liberar();
    const e = await pedido;
    assert.equal(e.estado, 'destino-definido');
    assert.equal(amb.destino.rotaAtual(), null);
    assert.equal(amb.camadasDestino().filter(c => c.tipo === 'polyline').length, 0);
});

test('destino longe de qualquer via: mensagem clara, nada desenhado', async () => {
    const dados = JSON.parse(OSRM_EXEMPLO);
    dados.waypoints[1].distance = 5000;
    const amb = criarAmbiente({ rede: () => respostaJson(dados) });
    amb.destino.definirDestino(PORTARIA);
    const e = await amb.destino.calcular();
    assert.equal(e.estado, 'erro');
    assert.match(e.mensagem, /longe de qualquer via/);
    assert.equal(amb.camadasDestino().filter(c => c.tipo === 'polyline').length, 0);
});

test('destino a algumas centenas de metros da via: calcula e avisa', async () => {
    const dados = JSON.parse(OSRM_EXEMPLO);
    dados.waypoints[1].distance = 420;
    const amb = criarAmbiente({ rede: () => respostaJson(dados) });
    amb.destino.definirDestino(PORTARIA);
    const e = await amb.destino.calcular();
    assert.equal(e.estado, 'pronta');
    assert.match(e.mensagem, /a 420 m do ponto escolhido/);
});

for (const [nome, rede, padrao] of [
    ['rede indisponível', () => Promise.reject(new TypeError('Failed to fetch')), /sem internet/],
    ['HTTP 502 do proxy', () => respostaJson({ code: 'ProxyError' }, 502), /HTTP 502/],
    ['sem rota (NoRoute)', () => respostaJson({ code: 'NoRoute', routes: [] }, 400), /não encontrou rota/],
    ['fora das vias (NoSegment)', () => respostaJson({ code: 'NoSegment' }, 400), /fora das vias/],
    ['JSON inválido', () => Promise.resolve(new Response('<html>', { status: 200 })), /formato inesperado/]
]) {
    test('falha (' + nome + '): mensagem clara e nada desenhado', async () => {
        const amb = criarAmbiente({ rede: rede });
        amb.destino.definirDestino(PORTARIA);
        const e = await amb.destino.calcular();
        assert.equal(e.estado, 'erro');
        assert.match(e.mensagem, padrao);
        assert.equal(amb.camadasDestino().filter(c => c.tipo === 'polyline').length, 0);
        assert.ok(amb.principalIntacta());
    });
}

// ---- Uso sem internet e limpeza ----

test('restaurar: rota salva aparece sem internet, identificada como não recalculada', async () => {
    const armazenamento = criarArmazenamento();
    const online = criarAmbiente({ armazenamento: armazenamento });
    online.destino.definirDestino(PORTARIA);
    await online.destino.calcular();

    const offline = criarAmbiente({ armazenamento: armazenamento, online: false, posicao: null });
    const e = offline.destino.restaurar();
    assert.equal(e.estado, 'pronta');
    assert.equal(e.recalculadaAgora, false);
    assert.equal(e.destino.nome, 'Portaria do parque');
    assert.equal(offline.chamadas.length, 0);
    assert.equal(offline.camadasDestino().filter(c => c.tipo === 'polyline').length, 1);
    assert.equal(offline.camadasDestino().filter(c => c.tipo === 'circleMarker').length, 1);
    // Ao abrir o app, não move o mapa por conta própria.
    assert.equal(offline.mapa.enquadramentos, 0);
});

test('restaurar: dado salvo corrompido ou de outro formato é ignorado', () => {
    for (const salvo of ['{quebrado', JSON.stringify({ formato: 2 }),
        JSON.stringify({ formato: 1, criadaEm: 1, origem: { latitude: 1 },
            destino: { latitude: 'x' }, coordenadas: [[0, 0], [1, 1]], etapas: [] })]) {
        const armazenamento = criarArmazenamento();
        armazenamento.setItem('offgrid-rota-destino-v1', salvo);
        const amb = criarAmbiente({ armazenamento: armazenamento });
        assert.equal(amb.destino.restaurar().estado, 'sem-destino');
        assert.equal(amb.camadasDestino().length, 0);
    }
});

test('limpar: remove destino, rota, camadas e a cópia salva', async () => {
    const amb = criarAmbiente();
    amb.destino.definirDestino(PORTARIA);
    await amb.destino.calcular();
    const e = amb.destino.limpar();
    assert.equal(e.estado, 'sem-destino');
    assert.equal(amb.destino.destinoAtual(), null);
    assert.equal(amb.destino.rotaAtual(), null);
    assert.equal(amb.camadasDestino().length, 0);
    assert.equal(amb.armazenamento.getItem(amb.RotaDestino.CHAVE_ARMAZENAMENTO), null);
    assert.ok(amb.principalIntacta());
});

test('falha ao salvar (cota cheia) ainda exibe a rota e avisa', async () => {
    const armazenamento = criarArmazenamento();
    armazenamento.setItem = () => { throw new Error('QuotaExceededError'); };
    const amb = criarAmbiente({ armazenamento: armazenamento });
    amb.destino.definirDestino(PORTARIA);
    const avisos = console.warn;
    console.warn = () => {};
    try {
        const e = await amb.destino.calcular();
        assert.equal(e.estado, 'pronta');
        assert.match(e.mensagem, /não pôde ser salva/);
    } finally {
        console.warn = avisos;
    }
});

test('cobertura: Sudeste dentro, outras regiões fora', () => {
    const { dentroDaCobertura } = criarAmbiente().RotaDestino;
    assert.ok(dentroDaCobertura(-23.5505, -46.6333), 'São Paulo');
    assert.ok(dentroDaCobertura(-22.9068, -43.1729), 'Rio de Janeiro');
    assert.ok(dentroDaCobertura(-19.9208, -43.9378), 'Belo Horizonte');
    assert.ok(dentroDaCobertura(-20.3155, -40.3377), 'Vitória');
    assert.ok(!dentroDaCobertura(-12.97, -38.5), 'Salvador');
    assert.ok(!dentroDaCobertura(-30.03, -51.23), 'Porto Alegre');
});
