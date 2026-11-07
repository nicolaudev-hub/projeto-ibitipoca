// Testes da busca de destinos por nome (js/busca-destino.js).
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');

// Formato real do Nominatim (format=jsonv2), resumido.
const RESPOSTA_JF = [
    {
        place_id: 1, lat: '-21.7609533', lon: '-43.3501129', category: 'boundary',
        type: 'administrative', addresstype: 'city', name: 'Juiz de Fora',
        display_name: 'Juiz de Fora, Região Geográfica Imediata de Juiz de Fora, Minas Gerais, Brasil'
    },
    {
        place_id: 2, lat: '-21.7642', lon: '-43.3496', category: 'highway',
        type: 'residential', addresstype: 'road', name: '',
        display_name: 'Rua Halfeld, Centro, Juiz de Fora, Minas Gerais, Brasil'
    },
    // Itens sem coordenadas válidas são descartados.
    { place_id: 3, lat: 'abc', lon: '1', name: 'Quebrado', display_name: 'Quebrado' }
];

function respostaJson(corpo, status) {
    return Promise.resolve(new Response(JSON.stringify(corpo), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' }
    }));
}

function criarAmbiente(opcoes) {
    opcoes = Object.assign({ rede: () => respostaJson(RESPOSTA_JF), online: true }, opcoes);
    const contexto = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
        AbortController: AbortController, navigator: {}, encodeURIComponent: encodeURIComponent };
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(STATIC, 'js', 'busca-destino.js'), 'utf8'), contexto);
    const chamadas = [];
    return {
        chamadas: chamadas,
        BuscaDestino: contexto.BuscaDestino,
        busca: contexto.BuscaDestino.criar({
            fetch: (url, init) => { chamadas.push(url); return opcoes.rede(url, init); },
            estaOnline: () => opcoes.online
        })
    };
}

test('texto curto ou vazio: não consulta o serviço', async () => {
    const amb = criarAmbiente();
    for (const texto of ['', '  ', 'jf', null]) {
        const r = await amb.busca.buscar(texto);
        assert.equal(r.estado, 'invalida');
        assert.equal(r.resultados.length, 0);
    }
    const longo = await amb.busca.buscar('a'.repeat(121));
    assert.equal(longo.estado, 'invalida');
    assert.equal(amb.chamadas.length, 0);
});

test('consulta ./api/buscar com o texto codificado e espaços normalizados', async () => {
    const amb = criarAmbiente();
    await amb.busca.buscar('  Juiz   de Fora ');
    assert.deepEqual(amb.chamadas, ['./api/buscar?q=Juiz%20de%20Fora']);
});

test('converte os resultados do Nominatim e descarta os inválidos', async () => {
    const amb = criarAmbiente();
    const r = await amb.busca.buscar('Juiz de Fora');
    assert.equal(r.estado, 'ok');
    assert.equal(r.resultados.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(r.resultados[0])), {
        nome: 'Juiz de Fora',
        descricao: 'Juiz de Fora, Região Geográfica Imediata de Juiz de Fora, Minas Gerais, Brasil',
        latitude: -21.7609533,
        longitude: -43.3501129,
        tipo: 'city'
    });
    // Sem "name", usa o primeiro trecho do endereço.
    assert.equal(r.resultados[1].nome, 'Rua Halfeld');
    assert.match(r.mensagem, /2 resultados/);
});

test('nenhum resultado: sugere outra busca ou o toque no mapa', async () => {
    const amb = criarAmbiente({ rede: () => respostaJson([]) });
    const r = await amb.busca.buscar('lugar inexistente');
    assert.equal(r.estado, 'vazia');
    assert.match(r.mensagem, /toque no mapa/);
});

test('sem internet: explica e não consulta o serviço', async () => {
    const amb = criarAmbiente({ online: false });
    const r = await amb.busca.buscar('Juiz de Fora');
    assert.equal(r.estado, 'sem-rede');
    assert.match(r.mensagem, /tocando no mapa/);
    assert.equal(amb.chamadas.length, 0);
});

for (const [nome, rede, padrao] of [
    ['limite de buscas (429)', () => respostaJson({ code: 'TooManyRequests' }, 429), /Aguarde alguns segundos/],
    ['serviço com erro (502)', () => respostaJson({ code: 'SearchError' }, 502), /indisponível \(HTTP 502\)/],
    ['rede indisponível', () => Promise.reject(new TypeError('Failed to fetch')), /sem internet/],
    ['resposta que não é lista', () => respostaJson({ erro: 1 }), /formato inesperado/]
]) {
    test('falha (' + nome + '): mensagem clara, sem resultados', async () => {
        const amb = criarAmbiente({ rede: rede });
        const r = await amb.busca.buscar('Juiz de Fora');
        assert.equal(r.estado, 'erro');
        assert.match(r.mensagem, padrao);
        assert.equal(r.resultados.length, 0);
    });
}

test('cliques repetidos na mesma busca geram uma única requisição', async () => {
    const amb = criarAmbiente();
    const [a, b] = await Promise.all([amb.busca.buscar('Juiz de Fora'), amb.busca.buscar('Juiz de Fora')]);
    assert.equal(amb.chamadas.length, 1);
    assert.equal(a, b);
    // Terminada a primeira, uma nova busca consulta de novo.
    await amb.busca.buscar('Juiz de Fora');
    assert.equal(amb.chamadas.length, 2);
});

test('a busca só acontece ao confirmar: novo-app.js usa o submit do formulário', () => {
    const app = fs.readFileSync(path.join(STATIC, 'js', 'novo-app.js'), 'utf8');
    assert.match(app, /formBusca\.addEventListener\('submit'/);
    // Política do Nominatim: nada de autocompletar a cada tecla.
    assert.doesNotMatch(app, /campoBusca\.addEventListener\('(input|keyup|keydown)'/);
});
