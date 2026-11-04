// Testes da rota opcional até o parque (js/rota-parque.js).
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const OSRM_PARQUE = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'osrm_chale_parque.json'), 'utf8');

// ---- Leaflet e mapa simulados ----

function criarLeaflet() {
    const criadas = [];
    function camada(tipo, latLngs) {
        const c = {
            tipo: tipo,
            latLngs: latLngs,
            addTo(mapa) { mapa.addLayer(this); return this; },
            setLatLngs(novas) { this.latLngs = novas; return this; },
            bindPopup() { return this; }
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
        addLayer(c) { camadas.add(c); return this; },
        removeLayer(c) { camadas.delete(c); return this; },
        hasLayer(c) { return camadas.has(c); }
    };
}

function criarArmazenamento() {
    const itens = new Map();
    return {
        itens: itens,
        getItem: chave => itens.has(chave) ? itens.get(chave) : null,
        setItem: (chave, valor) => { itens.set(chave, String(valor)); }
    };
}

function respostaJson(corpo, status) {
    return Promise.resolve(new Response(corpo, {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' }
    }));
}

const AGORA = Date.parse('2026-10-30T20:00:00Z');
const POSICAO_CHALE = { latitude: -21.716948, longitude: -43.928103, precisao: 12 };

function criarAmbiente(opcoes) {
    opcoes = Object.assign({ rede: () => respostaJson(OSRM_PARQUE) }, opcoes);
    const contexto = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
        AbortController: AbortController, navigator: {} };
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(STATIC, 'js', 'instrucoes.js'), 'utf8'), contexto);
    vm.runInContext(fs.readFileSync(path.join(STATIC, 'js', 'rota-parque.js'), 'utf8'), contexto);

    const L = criarLeaflet();
    const mapa = criarMapa();
    // Camada da rota principal, que nunca pode ser alterada.
    const principal = { tipo: 'principal', latLngs: [[-21.75, -43.34], [-21.71, -43.92]] };
    mapa.addLayer(principal);
    const copiaPrincipal = JSON.stringify(principal.latLngs);

    const chamadas = [];
    const estados = [];
    const amb = {
        L: L,
        mapa: mapa,
        principal: principal,
        principalIntacta: () => mapa.hasLayer(principal) &&
            JSON.stringify(principal.latLngs) === copiaPrincipal,
        chamadas: chamadas,
        estados: estados,
        armazenamento: opcoes.armazenamento || criarArmazenamento(),
        posicao: 'posicao' in opcoes ? opcoes.posicao
            : Object.assign({ timestamp: AGORA - 2000 }, POSICAO_CHALE),
        online: opcoes.online !== false,
        RotaParque: contexto.RotaParque,
        camadasParque: () => [...mapa.camadas].filter(c => c !== principal)
    };
    amb.parque = contexto.RotaParque.criar({
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

// ---- Padrão e destino ----

test('padrão: rota do parque desativada, sem camadas nem requisições', () => {
    const amb = criarAmbiente();
    assert.equal(amb.parque.estaAtiva(), false);
    assert.equal(amb.camadasParque().length, 0);
    assert.equal(amb.chamadas.length, 0);
    const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
    assert.match(html, /name="rota-parque" value="nao" checked/);
    assert.doesNotMatch(html, /value="sim" checked/);
});

test('destino: portaria de visitantes validada no OpenStreetMap', () => {
    const { DESTINO } = criarAmbiente().RotaParque;
    // Cancela com cobrança (node 2074946673) no fim da LMG-871.
    assert.equal(DESTINO.latitude, -21.7118892);
    assert.equal(DESTINO.longitude, -43.9030178);
});

// ---- Cálculo ----

test('ativar: origem é o GPS atual e o destino é a portaria', async () => {
    const amb = criarAmbiente();
    const e = await amb.parque.ativar();
    assert.equal(e.estado, 'pronta');
    assert.equal(e.recalculadaAgora, true);
    assert.equal(amb.chamadas.length, 1);
    const url = new URL(amb.chamadas[0]);
    assert.equal(url.origin, 'https://router.project-osrm.org');
    assert.equal(url.pathname,
        '/route/v1/driving/-43.928103,-21.716948;-43.9030178,-21.7118892');
    assert.equal(url.searchParams.get('steps'), 'true');
    assert.equal(e.rota.origem.latitude, POSICAO_CHALE.latitude);
    assert.ok(e.rota.etapas.length > 2);
});

test('ativar não modifica a rota principal; desativar remove só a do parque', async () => {
    const amb = criarAmbiente();
    await amb.parque.ativar();
    assert.ok(amb.principalIntacta());
    assert.deepEqual(amb.camadasParque().map(c => c.tipo).sort(), ['circleMarker', 'polyline']);
    amb.parque.desativar();
    assert.equal(amb.camadasParque().length, 0);
    assert.ok(amb.principalIntacta());
});

test('alternar várias vezes não duplica camadas nem requisições', async () => {
    const amb = criarAmbiente();
    for (let i = 0; i < 10; i++) {
        await amb.parque.ativar();
        await amb.parque.ativar();
        amb.parque.desativar();
    }
    await amb.parque.ativar();
    assert.equal(amb.chamadas.length, 1);
    assert.equal(amb.L.criadas.length, 2);
    assert.equal(amb.camadasParque().length, 2);
    assert.ok(amb.principalIntacta());
});

test('pedidos simultâneos geram uma única requisição', async () => {
    const amb = criarAmbiente();
    const pedidos = [amb.parque.ativar(), amb.parque.calcular(), amb.parque.calcular()];
    await Promise.all(pedidos);
    assert.equal(amb.chamadas.length, 1);
});

test('recalcular troca a geometria na mesma camada', async () => {
    const amb = criarAmbiente();
    await amb.parque.ativar();
    const linha = amb.camadasParque().find(c => c.tipo === 'polyline');
    amb.posicao = Object.assign({}, amb.posicao, { latitude: -21.7200 });
    await amb.parque.calcular();
    assert.equal(amb.chamadas.length, 2);
    assert.match(amb.chamadas[1], /-21\.720000/);
    assert.equal(amb.camadasParque().length, 2);
    assert.ok(amb.mapa.hasLayer(linha));
});

// ---- Falhas ----

const FALHAS = {
    'rede indisponível': () => Promise.reject(new TypeError('Failed to fetch')),
    'HTTP 503': () => respostaJson('{}', 503),
    'sem rota (NoRoute)': () => respostaJson('{"code":"NoRoute","routes":[]}', 400),
    'JSON inválido': () => respostaJson('<html>erro</html>'),
    'origem longe de vias': () => {
        const d = JSON.parse(OSRM_PARQUE);
        d.waypoints[0].distance = 2500;
        return respostaJson(JSON.stringify(d));
    },
    'destino fora da cobertura': () => {
        const d = JSON.parse(OSRM_PARQUE);
        d.waypoints[1].distance = 900;
        return respostaJson(JSON.stringify(d));
    }
};

for (const [nome, rede] of Object.entries(FALHAS)) {
    test('falha (' + nome + '): mensagem clara, nada desenhado, mapa principal intacto', async () => {
        const amb = criarAmbiente({ rede: rede });
        const e = await amb.parque.ativar();
        assert.equal(e.estado, 'erro');
        assert.match(e.mensagem, /chalé não foi afetada/);
        assert.doesNotMatch(e.mensagem, /Unexpected token|Failed to fetch/);
        assert.equal(amb.camadasParque().length, 0);
        assert.ok(amb.principalIntacta());
        assert.equal(amb.armazenamento.itens.size, 0);
    });
}

test('serviço lento: desiste após o tempo limite', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const amb = criarAmbiente({
        rede: (url, init) => new Promise((resolver, rejeitar) => {
            init.signal.addEventListener('abort', () =>
                rejeitar(Object.assign(new Error('abortado'), { name: 'AbortError' })));
        })
    });
    const pedido = amb.parque.ativar();
    t.mock.timers.tick(20000);
    const e = await pedido;
    assert.equal(e.estado, 'erro');
    assert.match(e.mensagem, /demorou demais/);
});

test('sem GPS: explica o que habilitar e não consulta o serviço', async () => {
    const amb = criarAmbiente({ posicao: null });
    const e = await amb.parque.ativar();
    assert.equal(e.estado, 'aguardando-gps');
    assert.match(e.mensagem, /localização/);
    assert.equal(amb.chamadas.length, 0);
});

test('GPS antigo ou impreciso não é usado como posição atual', async () => {
    for (const posicao of [
        Object.assign({}, POSICAO_CHALE, { timestamp: AGORA - 60000 }),
        Object.assign({}, POSICAO_CHALE, { timestamp: AGORA, precisao: 800 })
    ]) {
        const amb = criarAmbiente({ posicao: posicao });
        assert.equal((await amb.parque.ativar()).estado, 'aguardando-gps');
        assert.equal(amb.chamadas.length, 0);
    }
});

test('sem internet e sem rota salva: não consulta nem simula rota', async () => {
    const amb = criarAmbiente({ online: false });
    const e = await amb.parque.ativar();
    assert.equal(e.estado, 'sem-rede');
    assert.equal(amb.chamadas.length, 0);
    assert.equal(amb.camadasParque().length, 0);
});

test('falha ao salvar (cota cheia) ainda exibe a rota e avisa', async () => {
    const armazenamento = criarArmazenamento();
    armazenamento.setItem = () => { throw new Error('QuotaExceededError'); };
    const amb = criarAmbiente({ armazenamento: armazenamento });
    const e = await amb.parque.ativar();
    assert.equal(e.estado, 'pronta');
    assert.match(e.mensagem, /não pôde ser salva/);
    assert.equal(amb.camadasParque().length, 2);
});

// ---- Offline ----

test('rota salva é recuperada sem internet e identificada como não recalculada', async () => {
    const online = criarAmbiente();
    await online.parque.ativar();

    const offline = criarAmbiente({
        armazenamento: online.armazenamento,
        online: false,
        rede: () => { throw new Error('não deveria acessar a rede'); }
    });
    const e = await offline.parque.ativar();
    assert.equal(e.estado, 'pronta');
    assert.equal(e.recalculadaAgora, false);
    assert.match(e.mensagem, /não foi recalculada/);
    assert.equal(offline.chamadas.length, 0);
    assert.equal(offline.camadasParque().length, 2);

    // Pedir recálculo offline mantém a rota salva e não gera loop de requisições.
    const r = await offline.parque.calcular();
    assert.equal(r.estado, 'sem-rede');
    assert.equal(offline.chamadas.length, 0);
    assert.equal(offline.camadasParque().length, 2);
});

test('instruções da rota salva funcionam sem internet', async () => {
    const online = criarAmbiente();
    await online.parque.ativar();
    const salva = JSON.parse(online.armazenamento.getItem(online.RotaParque.CHAVE_ARMAZENAMENTO));

    const contexto = { console: console };
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(STATIC, 'js', 'instrucoes.js'), 'utf8'), contexto);
    const I = contexto.InstrucoesNavegacao;
    const coordenadas = salva.coordenadas.map(([lon, lat]) => [lat, lon]);
    const preparo = I.preparar(salva.etapas, coordenadas);
    assert.ok(preparo.valido, preparo.motivo);
    const r = I.criarAcompanhador(preparo).atualizar({
        latitude: coordenadas[0][0], longitude: coordenadas[0][1], precisao: 10, timestamp: 1
    });
    assert.equal(r.estado, 'navegando');
    assert.ok(r.instrucao);
});

test('dado salvo corrompido ou de outro destino é ignorado', async () => {
    const armazenamento = criarArmazenamento();
    const chave = criarAmbiente().RotaParque.CHAVE_ARMAZENAMENTO;
    for (const valor of ['{quebrado', JSON.stringify({ formato: 1, destino: { latitude: 0 } })]) {
        armazenamento.setItem(chave, valor);
        const amb = criarAmbiente({ armazenamento: armazenamento, online: false });
        assert.equal((await amb.parque.ativar()).estado, 'sem-rede');
        assert.equal(amb.camadasParque().length, 0);
    }
});

test('resultado que chega após desativar não é desenhado', async () => {
    let liberar;
    const amb = criarAmbiente({
        rede: () => new Promise(resolver => { liberar = () => resolver(respostaJson(OSRM_PARQUE)); })
    });
    const pedido = amb.parque.ativar();
    amb.parque.desativar();
    liberar();
    await pedido;
    assert.equal(amb.camadasParque().length, 0);
    // Fica salva para quando o usuário escolher "Sim".
    assert.equal((await amb.parque.ativar()).recalculadaAgora, false);
    assert.equal(amb.chamadas.length, 1);
});
