// Integridade dos tiles locais gerados por scripts/gerar-tiles.mjs.
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const RAIZ = path.join(__dirname, '..', '..', '..');
const STATIC = path.join(RAIZ, 'src', 'main', 'resources', 'static');
const TILES = path.join(STATIC, 'tiles');
const manifesto = JSON.parse(fs.readFileSync(path.join(TILES, 'manifesto.json'), 'utf8'));
const caminhos = new Set(manifesto.tiles.map(t => t.caminho));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function listarPngs(pasta, base = '') {
    return fs.readdirSync(pasta, { withFileTypes: true }).flatMap(item => {
        const relativo = base ? base + '/' + item.name : item.name;
        if (item.isDirectory()) return listarPngs(path.join(pasta, item.name), relativo);
        return item.name.endsWith('.png') ? [relativo] : [];
    });
}

test('manifesto: campos e totais coerentes', () => {
    assert.match(manifesto.versao, /^[0-9a-f]{16}$/);
    assert.equal(manifesto.tamanhoTile, 512);
    assert.equal(manifesto.zoomMin, 0);
    assert.equal(manifesto.zoomMax, 12);
    assert.equal(manifesto.limites.length, 4);
    assert.equal(caminhos.size, manifesto.tiles.length, 'caminhos duplicados');
    const soma = manifesto.tiles.reduce((total, t) => total + t.bytes, 0);
    assert.equal(manifesto.totalBytes, soma);
});

test('manifesto: versão corresponde ao conteúdo', () => {
    const versao = crypto.createHash('sha256')
        .update(manifesto.tiles.map(t => t.caminho + ' ' + t.sha256).join('\n'))
        .digest('hex').slice(0, 16);
    assert.equal(manifesto.versao, versao);
});

test('arquivos: cada tile existe, é PNG e confere tamanho e hash', () => {
    for (const tile of manifesto.tiles) {
        const conteudo = fs.readFileSync(path.join(TILES, tile.caminho));
        assert.ok(conteudo.subarray(0, 8).equals(PNG), tile.caminho + ' não é PNG');
        assert.equal(conteudo.length, tile.bytes, tile.caminho);
        const hash = crypto.createHash('sha256').update(conteudo).digest('hex');
        assert.equal(hash, tile.sha256, tile.caminho);
    }
});

test('arquivos: não há PNG fora do manifesto', () => {
    const extras = listarPngs(TILES).filter(c => !caminhos.has(c));
    assert.deepEqual(extras, []);
});

test('cobertura: manifesto contém a grade completa da área em todos os zooms', async () => {
    const { tilesDaArea } = await import(
        pathToFileURL(path.join(RAIZ, 'scripts', 'gerar-tiles.mjs')).href
    );
    const esperados = tilesDaArea(manifesto.limites, manifesto.zoomMin, manifesto.zoomMax)
        .map(t => `${t.z}/${t.x}/${t.y}.png`);
    assert.deepEqual([...caminhos].sort(), esperados.sort());
    for (let z = manifesto.zoomMin; z <= manifesto.zoomMax; z++) {
        assert.ok(manifesto.tiles.some(t => t.caminho.startsWith(z + '/')), 'zoom ' + z);
    }
});

test('cobertura: a rota inteira está dentro da área dos tiles', () => {
    const [oeste, sul, leste, norte] = manifesto.limites;
    const texto = fs.readFileSync(
        path.join(STATIC, 'data', 'rota_navegacao_offline.json'), 'utf8'
    ).replace(/^﻿/, '');
    const fora = JSON.parse(texto).routes[0].geometry.coordinates
        .filter(([lon, lat]) => lon < oeste || lon > leste || lat < sul || lat > norte);
    assert.equal(fora.length, 0);
});

// Reproduz o cálculo do Leaflet 1.9.4 (GridLayer._pxBoundsToTileRange) para
// a camada do index.html: tileSize 512, zoomOffset -1, minZoom 1,
// maxNativeZoom zoomMax + 1, maxZoom 17, bounds = limites do manifesto.
test('Leaflet: nenhum zoom de 1 a 17 pede tile ausente', () => {
    const [oeste, sul, leste, norte] = manifesto.limites;
    const projetar = (lat, lon, z) => {
        const escala = 256 * 2 ** z;
        const r = lat * Math.PI / 180;
        return {
            x: (lon + 180) / 360 * escala,
            y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * escala
        };
    };
    for (let zoomMapa = 1; zoomMapa <= 17; zoomMapa++) {
        const zoomTile = Math.min(zoomMapa, manifesto.zoomMax + 1);
        const no = projetar(norte, oeste, zoomTile);
        const se = projetar(sul, leste, zoomTile);
        const tam = manifesto.tamanhoTile;
        const urlZ = zoomTile - 1;
        for (let x = Math.floor(no.x / tam); x <= Math.ceil(se.x / tam) - 1; x++) {
            for (let y = Math.floor(no.y / tam); y <= Math.ceil(se.y / tam) - 1; y++) {
                assert.ok(caminhos.has(`${urlZ}/${x}/${y}.png`),
                    `zoom ${zoomMapa} pediria ${urlZ}/${x}/${y}.png`);
            }
        }
    }
});

test('index.html: usa os tiles locais e não depende do config.json', () => {
    const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
    assert.match(html, /'\.\/tiles\/manifesto\.json'/);
    assert.match(html, /'\.\/tiles\/\{z\}\/\{x\}\/\{y\}\.png'/);
    assert.match(html, /minZoom: 1,/);
    assert.match(html, /bounds: cobertura/);
    assert.doesNotMatch(html, /config\.json/);
});

// Sobe o ServidorWeb compilado (mvn verify) e confere a entrega real.
const CLASSES = path.join(RAIZ, 'target', 'classes');
const compilado = fs.existsSync(path.join(CLASSES, 'ServidorWeb.class')) &&
    fs.existsSync(path.join(CLASSES, 'static', 'tiles', 'manifesto.json'));

// Executável real da JVM. JAVA_HOME pode apontar para um JDK removido, e o
// "java" do PATH no Windows (javapath) é um lançador que cria outro processo,
// que não seria encerrado por kill(). Por isso pergunta o java.home à JVM.
function localizarJava() {
    const { spawnSync } = require('node:child_process');
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

test('servidor Java: entrega manifesto e tiles; tile ausente responde 404',
    { skip: !compilado && 'rode mvn verify antes', timeout: 20000 }, async () => {
        const porta = 20000 + Math.floor(Math.random() * 20000);
        const servidor = spawn(localizarJava(), ['-cp', CLASSES, 'ServidorWeb'], {
            env: { ...process.env, PORT: String(porta) },
            stdio: ['ignore', 'pipe', 'inherit']
        });
        try {
            await new Promise((ok, falha) => {
                servidor.on('error', falha);
                servidor.on('exit', codigo =>
                    falha(new Error('ServidorWeb encerrou antes de iniciar: ' + codigo)));
                servidor.stdout.on('data', d => {
                    if (String(d).includes('Servidor iniciado')) ok();
                });
            });
            const base = `http://localhost:${porta}`;

            const resposta = await fetch(base + '/tiles/manifesto.json');
            assert.equal(resposta.status, 200);
            assert.equal((await resposta.json()).versao, manifesto.versao);

            const amostra = [manifesto.tiles[0], manifesto.tiles.at(-1),
                manifesto.tiles[Math.floor(manifesto.tiles.length / 2)]];
            for (const tile of amostra) {
                const r = await fetch(base + '/tiles/' + tile.caminho);
                assert.equal(r.status, 200, tile.caminho);
                assert.equal(r.headers.get('content-type'), 'image/png');
                const conteudo = Buffer.from(await r.arrayBuffer());
                assert.equal(crypto.createHash('sha256').update(conteudo).digest('hex'),
                    tile.sha256, tile.caminho);
            }

            const ausente = await fetch(base + '/tiles/12/0/0.png');
            assert.equal(ausente.status, 404);
            await ausente.arrayBuffer();
        } finally {
            servidor.kill();
        }
    });
