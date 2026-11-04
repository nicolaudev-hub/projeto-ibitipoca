// Gera static/data/etapas_rota_principal.json com as manobras do OSRM
// para a rota principal (static/data/rota_navegacao_offline.json).
//
// Uso (na raiz do projeto, com internet):
//   node scripts/gerar-etapas-rota.mjs
//
// O arquivo da rota principal é apenas lido, nunca alterado. As etapas só
// são gravadas se a geometria devolvida pelo OSRM for a mesma da rota local
// e se todas as manobras caírem sobre vértices dessa rota.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DADOS = path.join(RAIZ, 'src', 'main', 'resources', 'static', 'data');
const ARQUIVO_ROTA = path.join(DADOS, 'rota_navegacao_offline.json');
const ARQUIVO_ETAPAS = path.join(DADOS, 'etapas_rota_principal.json');
const SERVIDOR_OSRM = 'https://router.project-osrm.org';

const chave = ponto => ponto.join(',');

const rota = JSON.parse((await readFile(ARQUIVO_ROTA, 'utf8')).replace(/^﻿/, ''));
const local = rota.routes[0];
const pontos = rota.waypoints.map(w => w.location.join(',')).join(';');
const url = SERVIDOR_OSRM + '/route/v1/driving/' + pontos +
    '?overview=full&geometries=geojson&steps=true';

const resposta = await fetch(url);
if (!resposta.ok) throw new Error('OSRM respondeu HTTP ' + resposta.status);
const osrm = await resposta.json();
if (osrm.code !== 'Ok' || !osrm.routes?.length) throw new Error('OSRM: ' + osrm.code);
const nova = osrm.routes[0];

// A geometria local pode repetir o último ponto; fora isso deve ser igual.
const verticesLocais = local.geometry.coordinates.map(chave)
    .filter((p, i, todos) => i === 0 || p !== todos[i - 1]);
const verticesNovos = nova.geometry.coordinates.map(chave);
if (verticesLocais.join(';') !== verticesNovos.join(';')) {
    throw new Error('A geometria do OSRM mudou; as etapas não seriam confiáveis.');
}
if (Math.abs(nova.distance - local.distance) > 1) {
    throw new Error('Distância diferente: ' + nova.distance + ' x ' + local.distance);
}

const conjuntoLocal = new Set(verticesLocais);
const etapas = nova.legs.map((trecho, indiceTrecho) => trecho.steps.map(etapa => {
    if (!conjuntoLocal.has(chave(etapa.maneuver.location))) {
        throw new Error('Manobra fora da rota local: ' + chave(etapa.maneuver.location));
    }
    const manobra = {
        tipo: etapa.maneuver.type,
        localizacao: etapa.maneuver.location,
        rumoAntes: etapa.maneuver.bearing_before,
        rumoDepois: etapa.maneuver.bearing_after
    };
    if (etapa.maneuver.modifier) manobra.modificador = etapa.maneuver.modifier;
    if (etapa.maneuver.exit) manobra.saida = etapa.maneuver.exit;
    return {
        trecho: indiceTrecho,
        nome: etapa.name || '',
        ref: etapa.ref || '',
        distancia: etapa.distance,
        duracao: etapa.duration,
        manobra: manobra
    };
})).flat();

const saida = {
    formato: 'ibitipoca-etapas-v1',
    fonte: {
        servico: 'OSRM (' + SERVIDOR_OSRM + ', perfil driving)',
        consulta: url,
        geradoEm: new Date().toISOString(),
        dadosMapa: '© colaboradores do OpenStreetMap'
    },
    rota: {
        arquivo: 'rota_navegacao_offline.json',
        distancia: local.distance,
        duracao: local.duration,
        waypoints: rota.waypoints.map(w => w.location)
    },
    etapas: etapas
};

await writeFile(ARQUIVO_ETAPAS, JSON.stringify(saida, null, 1) + '\n', 'utf8');
console.log('Gravado ' + ARQUIVO_ETAPAS + ': ' + etapas.length + ' etapas.');
