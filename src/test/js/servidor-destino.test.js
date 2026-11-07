// Testes do ServidorWeb: encaminhamento de rotas (/osrm) e busca (/api/buscar).
// Sobe o servidor Java compilado (mvn verify) com OSRM e Nominatim falsos.
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..', '..', '..');
const CLASSES = path.join(RAIZ, 'target', 'classes');
const compilado = ['ServidorWeb', 'ProxyOsrm', 'BuscaNominatim']
    .every(c => fs.existsSync(path.join(CLASSES, c + '.class')));

// Mesmo critério de tiles.test.js: o executável real da JVM.
function localizarJava() {
    const candidatos = [];
    if (process.env.JAVA_HOME) candidatos.push(path.join(process.env.JAVA_HOME, 'bin', 'java'));
    candidatos.push('java');
    for (const candidato of candidatos) {
        const r = spawnSync(candidato, ['-XshowSettings:properties', '-version'], { encoding: 'utf8' });
        const home = /java\.home = (.+)/.exec(r.stderr || '');
        if (home) return path.join(home[1].trim(), 'bin', 'java');
    }
    throw new Error('Java não encontrado');
}

// Servidor HTTP falso que registra cada requisição recebida.
function servidorFalso(responder) {
    const recebidas = [];
    const servidor = http.createServer((req, res) => {
        recebidas.push({ url: req.url, headers: req.headers, em: Date.now() });
        responder(req, res);
    });
    return new Promise(ok => servidor.listen(0, '127.0.0.1', () => ok({
        recebidas: recebidas,
        url: 'http://127.0.0.1:' + servidor.address().port,
        fechar: () => new Promise(fim => { servidor.closeAllConnections(); servidor.close(fim); })
    })));
}

function json(res, status, corpo) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(corpo));
}

async function subirServidorWeb(env) {
    const porta = 20000 + Math.floor(Math.random() * 20000);
    // Sem proxy de saída: os serviços falsos estão no próprio computador.
    const ambiente = { ...process.env, PORT: String(porta), ...env };
    for (const v of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'JAVA_TOOL_OPTIONS']) {
        delete ambiente[v];
    }
    const processo = spawn(localizarJava(), ['-cp', CLASSES, 'ServidorWeb'], {
        env: ambiente,
        stdio: ['ignore', 'pipe', 'inherit']
    });
    await new Promise((ok, falha) => {
        processo.on('error', falha);
        processo.on('exit', codigo =>
            falha(new Error('ServidorWeb encerrou antes de iniciar: ' + codigo)));
        processo.stdout.on('data', d => {
            if (String(d).includes('Servidor iniciado')) ok();
        });
    });
    return { base: 'http://127.0.0.1:' + porta, encerrar: () => processo.kill() };
}

const ROTA = '/osrm/route/v1/driving/-43.928103,-21.716948;-43.903018,-21.711889';

test('servidor Java: /osrm encaminha só o serviço de rotas ao OSRM',
    { skip: !compilado && 'rode mvn verify antes', timeout: 30000 }, async () => {
        const osrm = await servidorFalso((req, res) => req.url.includes('-40.1')
            ? json(res, 400, { code: 'NoRoute', message: 'Impossible route' })
            : json(res, 200, { code: 'Ok', vindo: req.url }));
        const web = await subirServidorWeb({ OSRM_URL: osrm.url, NOMINATIM_URL: 'http://127.0.0.1:9' });
        try {
            const r = await fetch(web.base + ROTA + '?overview=full&geometries=geojson&steps=true');
            assert.equal(r.status, 200);
            assert.equal(r.headers.get('cache-control'), 'no-store');
            const corpo = await r.json();
            // O prefixo /osrm sai; caminho e parâmetros chegam intactos.
            assert.equal(corpo.vindo,
                ROTA.replace('/osrm', '') + '?overview=full&geometries=geojson&steps=true');

            // Outros serviços do OSRM e URLs malformadas não passam.
            for (const caminho of [
                '/osrm/table/v1/driving/-43.9,-21.7;-43.8,-21.6',
                '/osrm/route/v1/driving/abc',
                '/osrm/route/v1/foot/-43.9,-21.7;-43.8,-21.6',
                ROTA + '?overview=<script>'
            ]) {
                const negado = await fetch(web.base + caminho);
                assert.equal(negado.status, 400, caminho);
                assert.equal((await negado.json()).code, 'InvalidUrl');
            }
            assert.equal(osrm.recebidas.length, 1);

            // Resposta de erro do OSRM (400 NoRoute) chega igual ao app.
            const semRota = await fetch(web.base + '/osrm/route/v1/driving/-43.9,-21.7;-40.1,-20.3');
            assert.equal(semRota.status, 400);
            assert.equal((await semRota.json()).code, 'NoRoute');

            // OSRM fora do ar: 502 no mesmo formato de erro.
            await osrm.fechar();
            const fora = await fetch(web.base + ROTA);
            assert.equal(fora.status, 502);
            assert.equal((await fora.json()).code, 'ProxyError');
        } finally {
            web.encerrar();
            await osrm.fechar().catch(() => {});
        }
    });

test('servidor Java: /api/buscar respeita a política do Nominatim',
    { skip: !compilado && 'rode mvn verify antes', timeout: 30000 }, async () => {
        const nominatim = await servidorFalso((req, res) => json(res, 200, [
            { lat: '-21.76', lon: '-43.35', name: 'Juiz de Fora', display_name: 'Juiz de Fora, MG' }
        ]));
        const web = await subirServidorWeb({ NOMINATIM_URL: nominatim.url, OSRM_URL: 'http://127.0.0.1:9' });
        try {
            // Texto curto demais não consulta o serviço.
            const curta = await fetch(web.base + '/api/buscar?q=jf');
            assert.equal(curta.status, 400);
            assert.equal(nominatim.recebidas.length, 0);

            const r = await fetch(web.base + '/api/buscar?q=Juiz%20de%20Fora');
            assert.equal(r.status, 200);
            assert.equal(r.headers.get('x-cache'), 'MISS');
            assert.equal((await r.json())[0].name, 'Juiz de Fora');

            const pedido = nominatim.recebidas[0];
            assert.match(pedido.headers['user-agent'], /^OffGrid\/.+github\.com\/nicolaudev-hub/);
            const url = new URL(pedido.url, 'http://x');
            assert.equal(url.pathname, '/search');
            assert.equal(url.searchParams.get('q'), 'Juiz de Fora');
            assert.equal(url.searchParams.get('format'), 'jsonv2');
            assert.equal(url.searchParams.get('countrycodes'), 'br');
            assert.equal(url.searchParams.get('bounded'), '1');
            assert.equal(url.searchParams.get('viewbox'), '-53.11,-14.23,-39.67,-25.32');

            // A mesma busca (maiúsculas e espaços diferentes) vem do cache.
            const repetida = await fetch(web.base + '/api/buscar?q=%20juiz%20%20DE%20fora');
            assert.equal(repetida.status, 200);
            assert.equal(repetida.headers.get('x-cache'), 'HIT');
            await repetida.arrayBuffer();
            assert.equal(nominatim.recebidas.length, 1);

            // Buscas diferentes seguidas: no máximo 1 por segundo ao Nominatim.
            await Promise.all(['Lima Duarte', 'Conceição de Ibitipoca'].map(q =>
                fetch(web.base + '/api/buscar?q=' + encodeURIComponent(q)).then(x => x.arrayBuffer())));
            assert.equal(nominatim.recebidas.length, 3);
            const horarios = nominatim.recebidas.map(p => p.em).sort((a, b) => a - b);
            for (let i = 1; i < horarios.length; i++) {
                assert.ok(horarios[i] - horarios[i - 1] >= 1000,
                    'intervalo de ' + (horarios[i] - horarios[i - 1]) + ' ms');
            }
        } finally {
            web.encerrar();
            await nominatim.fechar();
        }
    });

test('servidor Java: busca com o Nominatim fora do ar responde 502',
    { skip: !compilado && 'rode mvn verify antes', timeout: 30000 }, async () => {
        const web = await subirServidorWeb({ NOMINATIM_URL: 'http://127.0.0.1:9', OSRM_URL: 'http://127.0.0.1:9' });
        try {
            const r = await fetch(web.base + '/api/buscar?q=Juiz%20de%20Fora');
            assert.equal(r.status, 502);
            assert.equal((await r.json()).code, 'SearchError');
            // As páginas continuam sendo entregues normalmente.
            const pagina = await fetch(web.base + '/index.html');
            assert.equal(pagina.status, 200);
            await pagina.arrayBuffer();
        } finally {
            web.encerrar();
        }
    });
