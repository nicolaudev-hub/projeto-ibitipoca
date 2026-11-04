// Gera static/data/circuito_aguas.json com o traçado do Circuito das Águas
// do Parque Estadual do Ibitipoca, montado sobre as trilhas do OpenStreetMap.
//
// Uso (na raiz do projeto, com internet):
//   node scripts/gerar-circuito-aguas.mjs
//
// O OSM não tem uma via chamada "Circuito das Águas"; tem as trilhas e as
// atrações do circuito. O percurso é a volta mais curta, pelas trilhas e
// vias internas mapeadas, que sai da portaria, passa por todas as atrações
// de ATRACOES e retorna à portaria. Nenhum trecho é ligado em linha reta:
// o arquivo só é gravado se todas as atrações estiverem perto de uma via
// da mesma rede conectada.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARQUIVO = path.join(RAIZ, 'src', 'main', 'resources', 'static', 'data', 'circuito_aguas.json');
const SERVIDOR_OVERPASS = 'https://overpass-api.de/api/interpreter';

// Cancela da portaria de visitantes (a mesma de js/rota-parque.js). No OSM
// ela é só barrier=lift_gate, sem nome; usa-se o nome de rota-parque.js.
const PORTARIA = 2074946673;
const NOME_PORTARIA = 'Portaria do Parque Estadual do Ibitipoca';
// Nós do OSM das atrações; nome e posição vêm do próprio OSM.
const ATRACOES = [
    8888064917, // Ducha
    8887812217, // Mirante da Prainha
    8887689017, // Gruta dos Gnomos
    4363423295, // Lago das Miragens
    8887686618, // Raia das Ninfas
    8887689018, // Poço Dourado
    4363596284, // Ponte de Pedra
    4293139093, // Mirante do Gavião
    8887726317  // Cachoeira dos macacos (a queda; o nó tourism=attraction fica a 34 m da trilha)
];
// Atração mais longe que isso da via mais próxima não é ligada ao percurso.
const AFASTAMENTO_MAXIMO_METROS = 30;
// Área das trilhas entre a portaria e a Cachoeira dos Macacos (sul, oeste, norte, leste).
const AREA = '-21.725,-43.91,-21.70,-43.885';

const CONSULTA = '[out:json][timeout:90];' +
    'way["highway"](' + AREA + ');out body;>;out skel qt;' +
    'node(id:' + [PORTARIA, ...ATRACOES].join(',') + ');out body;';

async function consultarOverpass() {
    let espera = 5000;
    for (let tentativa = 1; tentativa <= 6; tentativa++) {
        const resposta = await fetch(SERVIDOR_OVERPASS, {
            method: 'POST',
            headers: { 'User-Agent': 'projeto-ibitipoca/1.0' },
            body: new URLSearchParams({ data: CONSULTA })
        });
        // O servidor público responde 429/502/504 quando está lotado.
        if (resposta.ok) return resposta.json();
        if (![429, 502, 503, 504].includes(resposta.status)) {
            throw new Error('Overpass respondeu HTTP ' + resposta.status);
        }
        console.warn('Overpass ocupado (HTTP ' + resposta.status + '); nova tentativa em ' +
            espera / 1000 + ' s.');
        await new Promise(resolver => setTimeout(resolver, espera));
        espera *= 2;
    }
    throw new Error('Overpass indisponível após várias tentativas.');
}

function distanciaMetros([lon1, lat1], [lon2, lat2]) {
    const raio = 6371008.8;
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * raio * Math.asin(Math.sqrt(h));
}

const dados = await consultarOverpass();
const nos = new Map();
const vias = [];
for (const elemento of dados.elements) {
    if (elemento.type === 'node') {
        // O mesmo nó pode vir duas vezes: sem tags (">") e com tags (node(id:...)).
        const anterior = nos.get(elemento.id);
        nos.set(elemento.id, {
            local: [elemento.lon, elemento.lat],
            tags: elemento.tags || (anterior && anterior.tags) || {}
        });
    } else if (elemento.type === 'way') {
        vias.push(elemento);
    }
}

// Grafo não orientado: nó do OSM -> [{ para, metros, via }].
const grafo = new Map();
function ligar(a, b, metros, via) {
    if (!grafo.has(a)) grafo.set(a, []);
    grafo.get(a).push({ para: b, metros: metros, via: via });
}
for (const via of vias) {
    for (let i = 1; i < via.nodes.length; i++) {
        const a = via.nodes[i - 1];
        const b = via.nodes[i];
        const metros = distanciaMetros(nos.get(a).local, nos.get(b).local);
        ligar(a, b, metros, via.id);
        ligar(b, a, metros, via.id);
    }
}

function dijkstra(origem) {
    const custo = new Map([[origem, 0]]);
    const anterior = new Map();
    const visitados = new Set();
    // A rede é pequena (menos de mil nós): a busca linear basta.
    const abertos = new Set([origem]);
    while (abertos.size) {
        let atual = null;
        for (const no of abertos) {
            if (atual === null || custo.get(no) < custo.get(atual)) atual = no;
        }
        abertos.delete(atual);
        visitados.add(atual);
        for (const aresta of grafo.get(atual) || []) {
            if (visitados.has(aresta.para)) continue;
            const novo = custo.get(atual) + aresta.metros;
            if (!(novo >= custo.get(aresta.para))) {
                custo.set(aresta.para, novo);
                anterior.set(aresta.para, { no: atual, via: aresta.via });
                abertos.add(aresta.para);
            }
        }
    }
    return { custo, anterior };
}

// Cada atração é ligada ao nó de via mais próximo.
const paradas = [PORTARIA, ...ATRACOES].map(id => {
    const ponto = nos.get(id);
    const nome = id === PORTARIA ? NOME_PORTARIA : ponto && ponto.tags.name;
    if (!ponto || !nome) throw new Error('Nó ' + id + ' ausente ou sem nome no OSM.');
    let melhor = null;
    let metros = Infinity;
    for (const no of grafo.keys()) {
        const d = distanciaMetros(ponto.local, nos.get(no).local);
        if (d < metros) { metros = d; melhor = no; }
    }
    if (!(metros <= AFASTAMENTO_MAXIMO_METROS)) {
        throw new Error(nome + ' está a ' + metros.toFixed(1) + ' m da trilha mais próxima.');
    }
    return { id: id, nome: nome, tags: ponto.tags, local: ponto.local, no: melhor, afastamento: metros };
});

const buscas = paradas.map(p => dijkstra(p.no));
const n = paradas.length;
for (let i = 1; i < n; i++) {
    if (!buscas[0].custo.has(paradas[i].no)) {
        throw new Error(paradas[i].nome + ' não está na mesma rede de trilhas da portaria.');
    }
}

// Held-Karp: menor volta que sai da portaria (0), visita todas e retorna.
const m = n - 1;
const custoEntre = (i, j) => buscas[i].custo.get(paradas[j].no);
const tabela = new Map();
for (let k = 1; k <= m; k++) tabela.set((1 << (k - 1)) + ',' + k, { custo: custoEntre(0, k), de: 0 });
for (let mascara = 1; mascara < (1 << m); mascara++) {
    for (let k = 1; k <= m; k++) {
        const bit = 1 << (k - 1);
        if (!(mascara & bit) || mascara === bit) continue;
        const sem = mascara ^ bit;
        let melhor = null;
        for (let j = 1; j <= m; j++) {
            const entrada = tabela.get(sem + ',' + j);
            if (!entrada) continue;
            const custo = entrada.custo + custoEntre(j, k);
            if (melhor === null || custo < melhor.custo) melhor = { custo: custo, de: j };
        }
        tabela.set(mascara + ',' + k, melhor);
    }
}
const todas = (1 << m) - 1;
let fim = null;
for (let k = 1; k <= m; k++) {
    const custo = tabela.get(todas + ',' + k).custo + custoEntre(k, 0);
    if (fim === null || custo < fim.custo) fim = { custo: custo, k: k };
}
const ordem = [];
for (let mascara = todas, k = fim.k; k !== 0;) {
    ordem.unshift(k);
    const de = tabela.get(mascara + ',' + k).de;
    mascara ^= 1 << (k - 1);
    k = de;
}
ordem.unshift(0);
ordem.push(0);

// Junta os trechos nó a nó, sem repetir o nó de ligação entre eles.
function trecho(i, j) {
    const anterior = buscas[i].anterior;
    const caminho = [paradas[j].no];
    const usadas = new Set();
    while (caminho[0] !== paradas[i].no) {
        const passo = anterior.get(caminho[0]);
        usadas.add(passo.via);
        caminho.unshift(passo.no);
    }
    return { caminho, usadas };
}
const percurso = [paradas[0].no];
const viasUsadas = new Set();
for (let t = 1; t < ordem.length; t++) {
    const { caminho, usadas } = trecho(ordem[t - 1], ordem[t]);
    percurso.push(...caminho.slice(1));
    usadas.forEach(v => viasUsadas.add(v));
}
const coordenadas = percurso.map(no => nos.get(no).local);
const acumulado = [0];
for (let i = 1; i < coordenadas.length; i++) {
    acumulado.push(acumulado[i - 1] + distanciaMetros(coordenadas[i - 1], coordenadas[i]));
}
const distancia = acumulado[acumulado.length - 1];

// Posição de cada atração: primeira passagem pelo seu nó, na ordem da volta.
let indice = 0;
const atracoes = ordem.slice(1, -1).map(k => {
    const p = paradas[k];
    while (percurso[indice] !== p.no) indice++;
    return {
        nome: p.nome,
        tipo: p.tags.waterway || p.tags.tourism || p.tags.natural || 'atracao',
        osm: 'node/' + p.id,
        localizacao: p.local,
        afastamentoTrilha: Math.round(p.afastamento * 10) / 10,
        posicao: Math.round(acumulado[indice] * 10) / 10
    };
});

const arquivo = {
    formato: 'ibitipoca-circuito-v1',
    nome: 'Circuito das Águas',
    fonte: {
        servico: 'Overpass API (' + SERVIDOR_OVERPASS + ')',
        consulta: CONSULTA,
        dadosOsm: dados.osm3s && dados.osm3s.timestamp_osm_base,
        geradoEm: new Date().toISOString(),
        dadosMapa: '© colaboradores do OpenStreetMap (ODbL)',
        observacao: 'Volta mais curta pelas trilhas mapeadas no OSM entre a portaria e as ' +
            'atrações; não é o traçado oficial publicado pelo parque.'
    },
    portaria: { nome: paradas[0].nome, osm: 'node/' + PORTARIA, localizacao: paradas[0].local },
    distancia: Math.round(distancia * 10) / 10,
    vias: [...viasUsadas].sort((a, b) => a - b).map(id => 'way/' + id),
    atracoes: atracoes,
    coordenadas: coordenadas
};

await writeFile(ARQUIVO, JSON.stringify(arquivo, null, 1) + '\n', 'utf8');
console.log('Circuito gravado: ' + (distancia / 1000).toFixed(2) + ' km, ' +
    coordenadas.length + ' pontos, ' + atracoes.length + ' atrações, ' +
    viasUsadas.size + ' vias do OSM.');
console.log('Ordem: ' + atracoes.map(a => a.nome + ' (' + Math.round(a.posicao) + ' m)').join(' → '));
