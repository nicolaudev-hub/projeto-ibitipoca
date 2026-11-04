// Testes do Circuito das Águas (js/circuito-aguas.js e data/circuito_aguas.json).
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const TEXTO_CIRCUITO = fs.readFileSync(path.join(STATIC, 'data', 'circuito_aguas.json'), 'utf8');
const CIRCUITO = JSON.parse(TEXTO_CIRCUITO);
// Cancela da portaria de visitantes (a mesma de rota-parque.js).
const PORTARIA = [-43.9030178, -21.7118892];

function distanciaMetros([lon1, lat1], [lon2, lat2]) {
    const rad = Math.PI / 180;
    const h = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
        Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

// ---- Leaflet e mapa simulados ----

function criarLeaflet() {
    function camada(tipo, latLngs, estilo) {
        return {
            tipo: tipo,
            latLngs: latLngs,
            estilo: estilo,
            popup: null,
            addTo(mapa) { mapa.addLayer(this); return this; },
            bindPopup(html) { this.popup = html; return this; },
            getBounds() { return { de: this.latLngs }; }
        };
    }
    return {
        polyline: (latLngs, estilo) => camada('polyline', latLngs, estilo),
        circleMarker: (latLng, estilo) => camada('circleMarker', latLng, estilo)
    };
}

function criarMapa() {
    const camadas = new Set();
    return {
        camadas: camadas,
        enquadramentos: [],
        addLayer(c) { camadas.add(c); return this; },
        removeLayer(c) { camadas.delete(c); return this; },
        hasLayer(c) { return camadas.has(c); },
        fitBounds(limites) { this.enquadramentos.push(limites); return this; }
    };
}

function respostaJson(corpo, status) {
    return Promise.resolve(new Response(corpo, {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' }
    }));
}

function criarAmbiente(opcoes) {
    opcoes = Object.assign({ rede: () => respostaJson(TEXTO_CIRCUITO) }, opcoes);
    const contexto = { console: console };
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(STATIC, 'js', 'circuito-aguas.js'), 'utf8'), contexto);

    const mapa = criarMapa();
    // Camada da rota principal, que nunca pode ser alterada.
    const principal = { tipo: 'principal' };
    mapa.addLayer(principal);

    const chamadas = [];
    const estados = [];
    const amb = {
        mapa: mapa,
        principal: principal,
        chamadas: chamadas,
        estados: estados,
        CircuitoAguas: contexto.CircuitoAguas,
        camadasCircuito: () => [...mapa.camadas].filter(c => c !== principal)
    };
    amb.circuito = contexto.CircuitoAguas.criar({
        mapa: mapa,
        L: criarLeaflet(),
        fetch: url => { chamadas.push(url); return opcoes.rede(url); },
        aoMudar: e => estados.push(e)
    });
    return amb;
}

// ---- Dados ----

test('dados: arquivo válido, gerado a partir do OpenStreetMap', () => {
    const amb = criarAmbiente();
    assert.doesNotThrow(() => amb.CircuitoAguas.validar(CIRCUITO));
    assert.equal(CIRCUITO.nome, 'Circuito das Águas');
    assert.match(CIRCUITO.fonte.dadosMapa, /OpenStreetMap/);
    assert.ok(CIRCUITO.vias.length > 0 && CIRCUITO.vias.every(v => /^way\/\d+$/.test(v)));
});

test('dados: volta que começa e termina na portaria do parque', () => {
    const coordenadas = CIRCUITO.coordenadas;
    assert.deepEqual(coordenadas[0], PORTARIA);
    assert.deepEqual(coordenadas[coordenadas.length - 1], PORTARIA);
    assert.deepEqual(CIRCUITO.portaria.localizacao, PORTARIA);
});

test('dados: sem saltos em linha reta entre pontos consecutivos', () => {
    // Pontos vêm de nós das vias do OSM; um salto grande indicaria trecho inventado.
    const coordenadas = CIRCUITO.coordenadas;
    let total = 0;
    for (let i = 1; i < coordenadas.length; i++) {
        const d = distanciaMetros(coordenadas[i - 1], coordenadas[i]);
        assert.ok(d < 150, 'salto de ' + d.toFixed(0) + ' m no ponto ' + i);
        total += d;
    }
    assert.ok(Math.abs(total - CIRCUITO.distancia) < 1);
});

test('dados: cada atração fica perto do traçado, na ordem do percurso', () => {
    let anterior = 0;
    for (const atracao of CIRCUITO.atracoes) {
        const maisPerto = Math.min(...CIRCUITO.coordenadas.map(p => distanciaMetros(p, atracao.localizacao)));
        assert.ok(maisPerto <= 30, atracao.nome + ' a ' + maisPerto.toFixed(1) + ' m');
        assert.match(atracao.osm, /^node\/\d+$/);
        assert.ok(atracao.posicao >= anterior && atracao.posicao <= CIRCUITO.distancia, atracao.nome);
        anterior = atracao.posicao;
    }
    const nomes = CIRCUITO.atracoes.map(a => a.nome);
    for (const nome of ['Ducha', 'Lago das Miragens', 'Ponte de Pedra', 'Poço Dourado']) {
        assert.ok(nomes.includes(nome), nome);
    }
});

test('validar: recusa arquivos sem formato, traçado ou atrações válidos', () => {
    const { validar } = criarAmbiente().CircuitoAguas;
    const copia = () => JSON.parse(TEXTO_CIRCUITO);
    assert.throws(() => validar(null), /formato/);
    assert.throws(() => validar(Object.assign(copia(), { formato: 'outro' })), /formato/);
    assert.throws(() => validar(Object.assign(copia(), { coordenadas: [[1, 2]] })), /traçado/);
    assert.throws(() => validar(Object.assign(copia(), { atracoes: [{ nome: 'x' }] })), /atrações/);
    assert.throws(() => validar(Object.assign(copia(), { distancia: 0 })), /distância/);
});

// ---- Opcional ----

test('padrão: desativado, sem camadas nem requisições', () => {
    const amb = criarAmbiente();
    assert.equal(amb.circuito.estaAtivo(), false);
    assert.equal(amb.camadasCircuito().length, 0);
    assert.equal(amb.chamadas.length, 0);
    for (const pagina of ['index.html', 'novo.html']) {
        const html = fs.readFileSync(path.join(STATIC, pagina), 'utf8');
        assert.match(html, /name="circuito-aguas" value="nao" checked/, pagina);
        assert.doesNotMatch(html, /name="circuito-aguas" value="sim" checked/, pagina);
        assert.match(html, /<script src="\.\/js\/circuito-aguas\.js"><\/script>/, pagina);
    }
});

test('ativar: desenha o traçado, a portaria e as atrações e enquadra o mapa', async () => {
    const amb = criarAmbiente();
    const e = await amb.circuito.ativar();
    assert.equal(e.estado, 'pronto');
    assert.match(e.mensagem, /Circuito das Águas: \d+,\d km/);
    assert.deepEqual(amb.chamadas, ['./data/circuito_aguas.json']);

    const camadas = amb.camadasCircuito();
    const linhas = camadas.filter(c => c.tipo === 'polyline');
    assert.equal(linhas.length, 1);
    // Leaflet usa [latitude, longitude]; o arquivo, [longitude, latitude].
    // Arrays criados no contexto do vm têm outro protótipo; compara-se o conteúdo.
    assert.deepEqual([...linhas[0].latLngs[0]], [PORTARIA[1], PORTARIA[0]]);
    assert.equal(camadas.filter(c => c.tipo === 'circleMarker').length, CIRCUITO.atracoes.length + 1);
    assert.ok(camadas.some(c => /1\. /.test(c.popup || '')));
    assert.equal(amb.mapa.enquadramentos.length, 1);
    assert.ok(amb.mapa.hasLayer(amb.principal));
});

test('desativar e reativar: remove as camadas e reaproveita os dados', async () => {
    const amb = criarAmbiente();
    await amb.circuito.ativar();
    const camadas = amb.camadasCircuito();
    const e = amb.circuito.desativar();
    assert.equal(e.estado, 'desativado');
    assert.equal(amb.camadasCircuito().length, 0);
    assert.ok(amb.mapa.hasLayer(amb.principal));

    await amb.circuito.ativar();
    assert.equal(amb.chamadas.length, 1);
    assert.deepEqual(amb.camadasCircuito(), camadas);
});

test('desativar durante o carregamento: não desenha nada', async () => {
    const amb = criarAmbiente();
    const pendente = amb.circuito.ativar();
    amb.circuito.desativar();
    const e = await pendente;
    assert.equal(e.estado, 'desativado');
    assert.equal(amb.camadasCircuito().length, 0);
});

test('popups: nomes entram como texto, não como HTML', async () => {
    const dados = JSON.parse(TEXTO_CIRCUITO);
    dados.atracoes[0].nome = '<img src=x onerror=alert(1)>';
    const amb = criarAmbiente({ rede: () => respostaJson(JSON.stringify(dados)) });
    await amb.circuito.ativar();
    const popups = amb.camadasCircuito().map(c => c.popup || '').join('\n');
    assert.doesNotMatch(popups, /<img/);
    assert.match(popups, /&lt;img src=x/);
});

// ---- Falhas ----

test('falhas: sem rede, HTTP de erro ou arquivo inválido viram mensagem', async () => {
    const casos = [
        [() => Promise.reject(new TypeError('Failed to fetch')), /sem internet/],
        [() => respostaJson('{}', 404), /HTTP 404/],
        [() => respostaJson('não é json'), /formato inesperado/],
        [() => respostaJson('{"formato":"outro"}'), /formato desconhecido/]
    ];
    for (const [rede, esperado] of casos) {
        const amb = criarAmbiente({ rede: rede });
        const e = await amb.circuito.ativar();
        assert.equal(e.estado, 'erro');
        assert.match(e.mensagem, esperado);
        assert.match(e.mensagem, /navegação até o chalé não foi afetada/);
        assert.equal(amb.camadasCircuito().length, 0);
        assert.ok(amb.mapa.hasLayer(amb.principal));
    }
});
