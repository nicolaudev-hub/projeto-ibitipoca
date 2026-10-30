// Testes do módulo de navegação GPS.
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const CODIGO = fs.readFileSync(path.join(STATIC, 'js', 'navegacao.js'), 'utf8');

function carregarModulo(extras) {
    const contexto = Object.assign({
        console: console,
        navigator: {},
        isSecureContext: true
    }, extras);
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(CODIGO, contexto);
    return { NavegacaoGPS: contexto.NavegacaoGPS, contexto: contexto };
}

function carregarRota() {
    const texto = fs.readFileSync(
        path.join(STATIC, 'data', 'rota_navegacao_offline.json'), 'utf8'
    ).replace(/^﻿/, '');
    return JSON.parse(texto).routes[0].geometry.coordinates
        .map(([lon, lat]) => [lat, lon]);
}

// Desloca um ponto em metros (norte, leste).
function deslocar(ponto, norte, leste) {
    const lat = ponto[0] + norte / 111195;
    const lon = ponto[1] + leste / (111195 * Math.cos(ponto[0] * Math.PI / 180));
    return [lat, lon];
}

// Gerador determinístico para ruído reproduzível.
function aleatorio(semente) {
    let s = semente >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

const { NavegacaoGPS } = carregarModulo();

test('distanciaMetros: 1 grau de latitude ~ 111,2 km', () => {
    const d = NavegacaoGPS.distanciaMetros([-21, -43], [-22, -43]);
    assert.ok(Math.abs(d - 111195) < 10, String(d));
});

test('menorDistanciaRota: ponto sobre e ao lado do segmento', () => {
    const a = [-21.7, -43.9];
    const b = deslocar(a, 0, 1000);
    const meio = deslocar(a, 0, 500);
    assert.ok(NavegacaoGPS.menorDistanciaRota(meio, [a, b]) < 0.5);
    const d = NavegacaoGPS.menorDistanciaRota(deslocar(meio, 100, 0), [a, b]);
    assert.ok(Math.abs(d - 100) < 0.5, String(d));
    // Além do fim do segmento, mede até a extremidade.
    const alem = NavegacaoGPS.menorDistanciaRota(deslocar(b, 0, 80), [a, b]);
    assert.ok(Math.abs(alem - 80) < 0.5, String(alem));
    assert.equal(NavegacaoGPS.menorDistanciaRota(a, [a]), null);
});

test('detector: leituras na rota nunca alertam', () => {
    const det = NavegacaoGPS.criarDetectorDesvio();
    for (let t = 0; t < 20; t++) {
        assert.equal(det.avaliar(30, 10, t * 1000).foraDaRota, false);
    }
});

test('detector: exige 3 leituras e pelo menos 5 s fora da rota', () => {
    const det = NavegacaoGPS.criarDetectorDesvio();
    // Rajada de 3 leituras em 1 s: ainda não confirma.
    assert.equal(det.avaliar(200, 10, 0).foraDaRota, false);
    assert.equal(det.avaliar(200, 10, 500).foraDaRota, false);
    assert.equal(det.avaliar(200, 10, 1000).foraDaRota, false);
    assert.equal(det.avaliar(200, 10, 4000).foraDaRota, false);
    assert.equal(det.avaliar(200, 10, 5000).foraDaRota, true);
});

test('detector: margem considera a precisão do GPS', () => {
    const det = NavegacaoGPS.criarDetectorDesvio();
    // 90 m com precisão de 40 m: pode estar na rota (90 < 60 + 40).
    for (let t = 0; t <= 10; t++) {
        assert.equal(det.avaliar(90, 40, t * 1000).foraDaRota, false);
    }
});

test('detector: precisão ruim não confirma nem zera o desvio', () => {
    const det = NavegacaoGPS.criarDetectorDesvio();
    det.avaliar(200, 10, 0);
    det.avaliar(200, 10, 3000);
    const ruim = det.avaliar(20, 500, 4000);
    assert.equal(ruim.leituraIgnorada, true);
    assert.equal(ruim.precisaoInsuficiente, true);
    assert.equal(det.avaliar(200, 10, 6000).foraDaRota, true);
});

test('detector: timestamp repetido é ignorado', () => {
    const det = NavegacaoGPS.criarDetectorDesvio();
    det.avaliar(200, 10, 0);
    det.avaliar(200, 10, 0);
    det.avaliar(200, 10, 0);
    assert.equal(det.avaliar(200, 10, 5000).foraDaRota, false);
});

test('detector: histerese ao voltar para a rota', () => {
    const det = NavegacaoGPS.criarDetectorDesvio();
    [0, 3000, 6000].forEach(t => det.avaliar(200, 10, t));
    assert.equal(det.avaliar(200, 10, 7000).foraDaRota, true);
    // Leitura ambígua (entre 60 e 60 + precisão) não muda o estado.
    assert.equal(det.avaliar(65, 10, 8000).foraDaRota, true);
    assert.equal(det.avaliar(20, 10, 9000).foraDaRota, true);
    assert.equal(det.avaliar(20, 10, 10000).foraDaRota, false);
});

test('rota real: percurso com ruído não gera falso positivo; afastamento gera alerta', () => {
    const rota = carregarRota();
    assert.ok(rota.length > 2000);
    const det = NavegacaoGPS.criarDetectorDesvio();
    const rnd = aleatorio(42);
    let t = 0;
    let alertas = 0;

    // Percorre a rota inteira com ruído de até ±15 m e precisão relatada de 10–25 m.
    for (let i = 0; i < rota.length; i += 2) {
        const ruido = deslocar(rota[i], (rnd() - 0.5) * 30, (rnd() - 0.5) * 30);
        const precisao = 10 + rnd() * 15;
        const d = NavegacaoGPS.menorDistanciaRota(ruido, rota);
        t += 1000;
        if (det.avaliar(d, precisao, t).foraDaRota) alertas++;
    }
    assert.equal(alertas, 0, 'falsos positivos ao longo da rota');

    // Sai 150 m para o lado e permanece: alerta em até ~6 leituras.
    const base = rota[1200];
    let confirmouEm = null;
    for (let k = 1; k <= 10; k++) {
        const p = deslocar(base, 150, 150);
        const d = NavegacaoGPS.menorDistanciaRota(p, rota);
        t += 1000;
        if (det.avaliar(d, 10, t).foraDaRota && confirmouEm === null) confirmouEm = k;
    }
    assert.ok(confirmouEm !== null && confirmouEm <= 6, 'confirmou em ' + confirmouEm);
});

// ---- iniciar(): integração com Leaflet e geolocalização simuladas ----

function criarAmbiente(opcoes) {
    const chamadas = { panTo: [], setView: [], removidos: 0, cleared: [] };
    const ouvintes = {};
    const mapa = {
        addLayer() {},
        removeLayer() { chamadas.removidos++; },
        on(evento, fn) { ouvintes[evento] = fn; },
        off(evento) { delete ouvintes[evento]; },
        panTo(p) { chamadas.panTo.push(p); },
        setView(p, z) { chamadas.setView.push([p, z]); },
        getZoom() { return 10; },
        getMaxZoom() { return 17; }
    };
    function camada() {
        return {
            pos: null,
            addTo() { return this; },
            bindPopup() { return this; },
            setLatLng(p) { this.pos = p; },
            setRadius() {}
        };
    }
    let controleClique = null;
    const L = {
        circleMarker: (p) => { const c = camada(); c.pos = p; chamadas.marcador = c; return c; },
        circle: () => camada(),
        Control: {
            extend(def) {
                return function () {
                    return {
                        addTo() { def.onAdd(); return this; },
                        remove() { chamadas.controleRemovido = true; }
                    };
                };
            }
        },
        DomUtil: { create: () => ({}) },
        DomEvent: {
            disableClickPropagation() {},
            on(_el, _ev, fn) { controleClique = fn; }
        }
    };
    let aoPosicao = null;
    let aoErro = null;
    const geolocation = {
        watchPosition(ok, erro) { aoPosicao = ok; aoErro = erro; return 7; },
        clearWatch(id) { chamadas.cleared.push(id); }
    };
    const { NavegacaoGPS: modulo } = carregarModulo(Object.assign({
        L: L,
        navigator: { geolocation: geolocation }
    }, opcoes));
    return {
        modulo, mapa, chamadas, ouvintes,
        enviar(lat, lon, precisao, timestamp) {
            aoPosicao({ coords: { latitude: lat, longitude: lon, accuracy: precisao }, timestamp });
        },
        erro(code) {
            aoErro({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
        },
        clicarCentralizar() { controleClique(); }
    };
}

const ROTA_CURTA = [[-21.70, -43.90], [-21.70, -43.89]];

test('iniciar: marcador acompanha a posição e o mapa segue', () => {
    const amb = criarAmbiente();
    const estados = [];
    amb.modulo.iniciar({ mapa: amb.mapa, coordenadas: ROTA_CURTA, aoAtualizar: d => estados.push(d) });
    assert.equal(estados[0].estado, 'aguardando');

    amb.enviar(-21.70, -43.899, 8, 1000);
    assert.equal(amb.chamadas.setView.length, 1, 'primeira posição centraliza');
    assert.equal(amb.chamadas.setView[0][1], 15, 'aproxima para o zoom de acompanhamento');

    amb.enviar(-21.70, -43.898, 8, 2000);
    assert.deepEqual([...amb.chamadas.marcador.pos], [-21.70, -43.898]);
    assert.equal(amb.chamadas.panTo.length, 1);
    assert.equal(estados.at(-1).estado, 'ativo');
    assert.equal(estados.at(-1).seguindo, true);
});

test('iniciar: arrastar o mapa pausa o acompanhamento; Centralizar retoma', () => {
    const amb = criarAmbiente();
    amb.modulo.iniciar({ mapa: amb.mapa, coordenadas: ROTA_CURTA });
    amb.enviar(-21.70, -43.899, 8, 1000);
    amb.ouvintes.dragstart();
    amb.enviar(-21.70, -43.898, 8, 2000);
    amb.enviar(-21.70, -43.897, 8, 3000);
    assert.equal(amb.chamadas.panTo.length, 0);

    amb.clicarCentralizar();
    assert.equal(amb.chamadas.setView.length, 2);
    amb.enviar(-21.70, -43.896, 8, 4000);
    assert.equal(amb.chamadas.panTo.length, 1);
});

test('iniciar: sem HTTPS informa o motivo e não chama o GPS', () => {
    const amb = criarAmbiente({ isSecureContext: false });
    const estados = [];
    amb.modulo.iniciar({ mapa: amb.mapa, coordenadas: ROTA_CURTA, aoAtualizar: d => estados.push(d) });
    assert.equal(estados.length, 1);
    assert.equal(estados[0].estado, 'indisponivel');
    assert.match(estados[0].mensagem, /HTTPS/);
});

test('iniciar: permissão negada encerra o watch; timeout mantém', () => {
    const amb = criarAmbiente();
    const estados = [];
    amb.modulo.iniciar({ mapa: amb.mapa, coordenadas: ROTA_CURTA, aoAtualizar: d => estados.push(d) });
    amb.erro(3);
    assert.deepEqual(amb.chamadas.cleared, []);
    assert.match(estados.at(-1).mensagem, /fraco/);
    amb.erro(1);
    assert.deepEqual(amb.chamadas.cleared, [7]);
});

test('iniciar: parar() remove camadas, controle e o watch', () => {
    const amb = criarAmbiente();
    const nav = amb.modulo.iniciar({ mapa: amb.mapa, coordenadas: ROTA_CURTA });
    amb.enviar(-21.70, -43.899, 8, 1000);
    nav.parar();
    assert.deepEqual(amb.chamadas.cleared, [7]);
    assert.equal(amb.chamadas.removidos, 2);
    assert.equal(amb.chamadas.controleRemovido, true);
    assert.equal(amb.ouvintes.dragstart, undefined);
});
