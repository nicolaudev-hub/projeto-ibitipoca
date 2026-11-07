// Testes das instruções passo a passo (js/instrucoes.js).
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');

function carregar(arquivo) {
    const contexto = { console: console };
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(STATIC, 'js', arquivo), 'utf8'), contexto);
    return contexto;
}

const I = carregar('instrucoes.js').InstrucoesNavegacao;
const { NavegacaoGPS } = carregar('navegacao.js');

const lerJson = arquivo => JSON.parse(
    fs.readFileSync(arquivo, 'utf8').replace(/^﻿/, ''));

// Rota real Juiz de Fora → chalé (usada na viagem), guardada como exemplo de teste.
const ROTA = lerJson(path.join(__dirname, 'fixtures', 'rota_jf_chale.json')).routes[0];
const COORDENADAS = ROTA.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
const ETAPAS = lerJson(path.join(__dirname, 'fixtures', 'etapas_jf_chale.json'));
const PREPARO = I.preparar(ETAPAS.etapas, COORDENADAS);

// Ponto a s metros do início, ao longo da rota preparada.
function pontoEm(preparo, s) {
    const ac = preparo.acumulado;
    let i = 0;
    while (i < ac.length - 2 && ac[i + 1] < s) i++;
    const f = ac[i + 1] === ac[i] ? 0 : (s - ac[i]) / (ac[i + 1] - ac[i]);
    const a = preparo.coordenadas[i];
    const b = preparo.coordenadas[i + 1];
    return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
}

function deslocar(ponto, norte, leste) {
    return [
        ponto[0] + norte / 111195,
        ponto[1] + leste / (111195 * Math.cos(ponto[0] * Math.PI / 180))
    ];
}

function leitura(ponto, timestamp, precisao) {
    return {
        latitude: ponto[0],
        longitude: ponto[1],
        precisao: precisao === undefined ? 10 : precisao,
        timestamp: timestamp
    };
}

// Percorre a rota de sIni a sFim em passos, uma leitura a cada 2 s.
function percorrer(acompanhador, preparo, sIni, sFim, passo, t0) {
    const resultados = [];
    let t = t0 || 0;
    for (let s = sIni; s <= sFim; s += passo) {
        t += 2000;
        resultados.push(acompanhador.atualizar(leitura(pontoEm(preparo, s), t)));
    }
    return { resultados: resultados, t: t };
}

// Manobra "de verdade" (não partida nem chegada) longe das vizinhas.
const ALVO = PREPARO.manobras.findIndex((m, i) => i > 0 &&
    m.etapa.manobra.tipo === 'turn' &&
    m.posicao - PREPARO.manobras[i - 1].posicao > 800 &&
    PREPARO.manobras[i + 1].posicao - m.posicao > 300);

// ---- Dados ----

test('dados: as etapas de exemplo foram geradas para a rota de exemplo', () => {
    assert.equal(ETAPAS.formato, 'ibitipoca-etapas-v1');
    assert.ok(Math.abs(ETAPAS.rota.distancia - ROTA.distance) <= 1);
    assert.match(ETAPAS.fonte.servico, /OSRM/);
    assert.ok(PREPARO.valido, PREPARO.motivo);
});

test('dados: toda manobra cai sobre a geometria da rota de exemplo', () => {
    for (const etapa of ETAPAS.etapas) {
        const ponto = [etapa.manobra.localizacao[1], etapa.manobra.localizacao[0]];
        const d = NavegacaoGPS.menorDistanciaRota(ponto, COORDENADAS);
        assert.ok(d < 1, etapa.manobra.tipo + ' a ' + d + ' m');
    }
});

test('dados: chegada/partida no ponto intermediário não viram manobras', () => {
    const tipos = PREPARO.manobras.map(m => m.etapa.manobra.tipo);
    assert.equal(tipos.filter(t => t === 'depart').length, 1);
    assert.equal(tipos.filter(t => t === 'arrive').length, 1);
    assert.equal(tipos[tipos.length - 1], 'arrive');
    // Manobras em ordem ao longo da rota.
    for (let i = 1; i < PREPARO.manobras.length; i++) {
        assert.ok(PREPARO.manobras[i].posicao >= PREPARO.manobras[i - 1].posicao);
    }
});

test('dados: o preparo não altera a geometria recebida', () => {
    const copia = JSON.stringify(COORDENADAS);
    I.preparar(ETAPAS.etapas, COORDENADAS);
    assert.equal(JSON.stringify(COORDENADAS), copia);
});

// ---- Textos ----

test('texto: frases vêm dos campos do OSRM', () => {
    const etapa = (tipo, modificador, nome, extras) => ({
        nome: nome || '', ref: '', manobra: Object.assign(
            { tipo: tipo, modificador: modificador }, extras)
    });
    assert.equal(I.descrever(etapa('turn', 'left', 'Rua A')), 'vire à esquerda na Rua A');
    assert.equal(I.descrever(etapa('turn', 'slight right')), 'vire levemente à direita');
    assert.equal(I.descrever(etapa('fork', 'slight right')), 'na bifurcação, mantenha-se à direita');
    assert.equal(I.descrever(etapa('end of road', 'left')), 'no fim da via, vire à esquerda');
    assert.equal(I.descrever(etapa('roundabout', 'right', '', { saida: 3 })),
        'na rotatória, pegue a 3ª saída');
    // Tipo desconhecido não vira uma conversão inventada.
    assert.equal(I.descrever(etapa('notification', 'left')), 'siga a rota');
});

test('texto: distâncias arredondadas', () => {
    assert.equal(I.formatarDistancia(487), '500 m');
    assert.equal(I.formatarDistancia(212), '200 m');
    assert.equal(I.formatarDistancia(43), '40 m');
    assert.equal(I.formatarDistancia(1260), '1,3 km');
    // Arredondamento para 1000 m vira "1 km", não "1000 m".
    assert.equal(I.formatarDistancia(995), '1 km');
    assert.equal(I.formatarDistancia(974), '950 m');
    assert.equal(I.formatarDistancia(28812), '28,8 km');
});

// ---- Acompanhamento ----

test('instrução corresponde à etapa atual', () => {
    const a = I.criarAcompanhador(PREPARO);
    const alvo = PREPARO.manobras[ALVO];
    const r = percorrer(a, PREPARO, alvo.posicao - 600, alvo.posicao - 400, 50).resultados.pop();
    assert.equal(r.estado, 'navegando');
    assert.equal(r.indiceManobra, ALVO);
    assert.equal(r.textoManobra, alvo.texto);
    assert.match(r.instrucao, /^Em \d+ m, vire /);
    assert.equal(r.viaAtual, PREPARO.manobras[ALVO - 1].via);
    assert.equal(r.seguinte.toLowerCase(), PREPARO.manobras[ALVO + 1].texto.toLowerCase());
});

test('distância até a manobra diminui de forma coerente', () => {
    const a = I.criarAcompanhador(PREPARO);
    const alvo = PREPARO.manobras[ALVO];
    const { resultados } = percorrer(a, PREPARO, alvo.posicao - 700, alvo.posicao - 40, 30);
    let anterior = Infinity;
    for (const r of resultados) {
        assert.equal(r.indiceManobra, ALVO);
        assert.ok(r.distanciaManobraMetros < anterior);
        anterior = r.distanciaManobraMetros;
    }
    assert.ok(Math.abs(anterior - 40) < 2, String(anterior));
});

test('avança para a etapa seguinte depois de passar pela manobra', () => {
    const a = I.criarAcompanhador(PREPARO);
    const alvo = PREPARO.manobras[ALVO];
    const antes = percorrer(a, PREPARO, alvo.posicao - 300, alvo.posicao - 10, 10);
    assert.match(antes.resultados.pop().instrucao, /^Agora, vire /);
    const depois = percorrer(a, PREPARO, alvo.posicao + 30, alvo.posicao + 60, 10, antes.t);
    assert.equal(depois.resultados.pop().indiceManobra, ALVO + 1);
});

test('oscilação do GPS perto da manobra não alterna as instruções', () => {
    const a = I.criarAcompanhador(PREPARO);
    const alvo = PREPARO.manobras[ALVO];
    let { t } = percorrer(a, PREPARO, alvo.posicao - 400, alvo.posicao, 20);
    const sorteio = (() => { let s = 7; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); })();
    const indices = [];
    for (let i = 0; i < 60; i++) {
        t += 1000;
        // Para perto da manobra com ruído de ±25 m em todas as direções.
        const ponto = deslocar(pontoEm(PREPARO, alvo.posicao + (sorteio() - 0.5) * 50),
            (sorteio() - 0.5) * 30, (sorteio() - 0.5) * 30);
        indices.push(a.atualizar(leitura(ponto, t, 15)).indiceManobra);
    }
    // Pode avançar uma vez, mas nunca voltar.
    for (let i = 1; i < indices.length; i++) assert.ok(indices[i] >= indices[i - 1]);
    assert.ok(indices[indices.length - 1] <= ALVO + 1);
});

test('perda temporária do GPS mantém a última instrução', () => {
    const a = I.criarAcompanhador(PREPARO);
    const alvo = PREPARO.manobras[ALVO];
    const ultimo = percorrer(a, PREPARO, alvo.posicao - 500, alvo.posicao - 300, 50).resultados.pop();
    const semSinal = a.marcarSemSinal();
    assert.equal(semSinal.estado, 'sem-sinal');
    assert.equal(semSinal.textoManobra, ultimo.textoManobra);
    assert.equal(semSinal.distanciaManobraMetros, null);
    assert.equal(a.estadoAtual().textoManobra, ultimo.textoManobra);
});

test('precisão ruim mantém a instrução e omite as distâncias', () => {
    const a = I.criarAcompanhador(PREPARO);
    const alvo = PREPARO.manobras[ALVO];
    const { t } = percorrer(a, PREPARO, alvo.posicao - 500, alvo.posicao - 300, 50);
    const r = a.atualizar(leitura(pontoEm(PREPARO, alvo.posicao - 250), t + 2000, 500));
    assert.equal(r.estado, 'precisao-baixa');
    assert.equal(r.indiceManobra, ALVO);
    assert.equal(r.distanciaManobraMetros, null);
    assert.equal(r.restanteMetros, null);
});

test('salto do GPS não avança várias etapas de uma vez', () => {
    const a = I.criarAcompanhador(PREPARO);
    let { t } = percorrer(a, PREPARO, 1000, 1200, 50);
    const indiceAntes = a.estadoAtual().indiceManobra;
    // Uma leitura isolada 40 km à frente, sobre a rota.
    t += 2000;
    const salto = a.atualizar(leitura(pontoEm(PREPARO, 41000), t));
    assert.equal(salto.estado, 'confirmando');
    assert.equal(salto.indiceManobra, indiceAntes);
    // De volta à posição real: segue normalmente.
    t += 2000;
    assert.equal(a.atualizar(leitura(pontoEm(PREPARO, 1250), t)).indiceManobra, indiceAntes);
});

test('salto confirmado por leituras coerentes reposiciona a navegação', () => {
    const a = I.criarAcompanhador(PREPARO);
    let { t } = percorrer(a, PREPARO, 1000, 1200, 50);
    let r;
    for (let i = 0; i < 3; i++) {
        t += 2000;
        r = a.atualizar(leitura(pontoEm(PREPARO, 41000 + i * 40), t));
    }
    assert.equal(r.estado, 'navegando');
    assert.ok(Math.abs(PREPARO.total - 41080 - r.restanteMetros) < 5);
});

test('longe da rota: sinaliza, mantém a instrução e não inventa distância', () => {
    const a = I.criarAcompanhador(PREPARO);
    const { t } = percorrer(a, PREPARO, 2000, 2300, 50);
    const antes = a.estadoAtual();
    const r = a.atualizar(leitura(deslocar(pontoEm(PREPARO, 2350), 900, 0), t + 2000));
    assert.equal(r.estado, 'fora-da-rota');
    assert.equal(r.textoManobra, antes.textoManobra);
    assert.equal(r.distanciaManobraMetros, null);
    assert.equal(r.restanteMetros, null);
});

test('distância restante é pela estrada, não em linha reta', () => {
    const a = I.criarAcompanhador(PREPARO);
    const r = a.atualizar(leitura(COORDENADAS[0], 1000));
    const linhaReta = NavegacaoGPS.distanciaMetros(COORDENADAS[0], COORDENADAS[COORDENADAS.length - 1]);
    assert.ok(Math.abs(r.restanteMetros - ROTA.distance) < ROTA.distance * 0.005);
    assert.ok(r.restanteMetros > linhaReta * 1.3);
});

test('chegada ao destino é detectada e se mantém com oscilações', () => {
    const a = I.criarAcompanhador(PREPARO);
    let { t, resultados } = percorrer(a, PREPARO, PREPARO.total - 600, PREPARO.total, 25);
    assert.ok(resultados.some(r => r.instrucao === 'Você está chegando ao destino.'));
    assert.equal(resultados.pop().estado, 'chegou');
    const fim = COORDENADAS[COORDENADAS.length - 1];
    for (let i = 0; i < 20; i++) {
        t += 1000;
        const r = a.atualizar(leitura(deslocar(fim, (i % 3 - 1) * 15, (i % 2) * 15), t, 15));
        assert.equal(r.estado, 'chegou');
        assert.equal(r.instrucao, 'Você chegou ao destino.');
    }
});

test('leitura repetida (mesmo timestamp) é ignorada', () => {
    const a = I.criarAcompanhador(PREPARO);
    const primeira = a.atualizar(leitura(pontoEm(PREPARO, 3000), 5000));
    const repetida = a.atualizar(leitura(pontoEm(PREPARO, 9000), 5000));
    assert.equal(repetida, primeira);
});

// ---- Sem dados suficientes ----

test('sem etapas de navegação não há instruções falsas', () => {
    for (const etapas of [[], undefined, null]) {
        const preparo = I.preparar(etapas, COORDENADAS);
        assert.equal(preparo.valido, false);
        const r = I.criarAcompanhador(preparo).atualizar(leitura(COORDENADAS[10], 1));
        assert.equal(r.estado, 'sem-dados');
        assert.equal(r.instrucao, undefined);
        assert.equal(r.distanciaManobraMetros, undefined);
    }
});

test('etapas de outra rota são rejeitadas', () => {
    const outra = ETAPAS.etapas.map(e => Object.assign({}, e, {
        manobra: Object.assign({}, e.manobra, {
            localizacao: [e.manobra.localizacao[0] + 0.05, e.manobra.localizacao[1]]
        })
    }));
    const preparo = I.preparar(outra, COORDENADAS);
    assert.equal(preparo.valido, false);
    assert.match(preparo.motivo, /não correspondem/);
});

test('rota do parque (resposta real do OSRM) gera instruções válidas', () => {
    const osrm = lerJson(path.join(__dirname, 'fixtures', 'osrm_chale_parque.json')).routes[0];
    const coordenadas = osrm.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const preparo = I.preparar(I.etapasDeOsrm(osrm), coordenadas);
    assert.ok(preparo.valido, preparo.motivo);
    const a = I.criarAcompanhador(preparo);
    const r = a.atualizar(leitura(coordenadas[0], 1000));
    assert.equal(r.estado, 'navegando');
    assert.ok(r.instrucao.length > 0);
    const { resultados } = percorrer(a, preparo, 0, preparo.total, 40, 1000);
    assert.equal(resultados.pop().estado, 'chegou');
});
