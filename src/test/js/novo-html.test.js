// Testes da página de testes do visual novo (novo.html + js/novo-app.js).
// Executar na raiz do projeto: node --test src/test/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const ler = arquivo => fs.readFileSync(path.join(STATIC, arquivo), 'utf8');

const HTML = ler('novo.html');
const APP = ler(path.join('js', 'novo-app.js'));
const scripts = [...HTML.matchAll(/<script src="\.\/([^"]+)"><\/script>/g)].map(m => m[1]);

test('novo.html: carrega os módulos de navegação testados', () => {
    for (const modulo of ['js/navegacao.js', 'js/instrucoes.js', 'js/rota-parque.js',
        'js/registro-sw.js', 'js/download-mapa.js']) {
        assert.ok(scripts.includes(modulo), modulo);
    }
    // Leaflet primeiro; a ligação por último.
    assert.equal(scripts[0], 'leaflet/leaflet.js');
    assert.equal(scripts[scripts.length - 1], 'js/novo-app.js');
});

test('novo.html: não carrega os scripts que criam outro mapa ou outro GPS', () => {
    for (const proibido of ['js/app.js', 'js/gps.js', 'js/route.js']) {
        assert.ok(!scripts.includes(proibido), proibido);
    }
});

test('novo.html: todos os scripts e estilos existem em static/', () => {
    const locais = [...HTML.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(m => m[1]);
    const ausentes = locais.filter(f => !fs.existsSync(path.join(STATIC, f)));
    assert.deepEqual(ausentes, []);
});

test('novo.html: sem tiles de localhost:8081 nem recursos externos obrigatórios', () => {
    // config.js (do visual novo) ainda define App.CONFIG.tiles com
    // localhost:8081, mas só App.mapa.criar() o lia — e ele não é chamado.
    for (const s of scripts.filter(s => s.startsWith('js/') && s !== 'js/config.js')) {
        assert.doesNotMatch(ler(s), /localhost:8081/, s);
    }
    assert.doesNotMatch(HTML, /localhost:8081/);
    assert.doesNotMatch(APP, /CONFIG\.tiles|App\.mapa\.criar/);
    assert.doesNotMatch(HTML, /(?:src|href)="https?:/);
    assert.match(APP, /'\.\/tiles\/manifesto\.json'/);
    assert.match(APP, /'\.\/tiles\/\{z\}\/\{x\}\/\{y\}\.png'/);
});

test('novo-app.js: um único mapa e nenhum watchPosition próprio', () => {
    assert.equal((APP.match(/L\.map\(/g) || []).length, 1);
    assert.doesNotMatch(APP, /\.(watchPosition|getCurrentPosition)\(/);
    assert.doesNotMatch(APP, /App\.mapa\.criar|App\.gps|App\.rota\.carregar/);
    assert.match(APP, /NavegacaoGPS\.iniciar\(/);
    // Os módulos do visual novo carregados também não abrem GPS nem mapa.
    for (const s of scripts.filter(s => /js\/(config|util|map|simulation|theme|sidebar)\.js/.test(s))) {
        const codigo = ler(s);
        assert.doesNotMatch(codigo, /\.watchPosition\(/, s);
        if (s !== 'js/map.js') assert.doesNotMatch(codigo, /L\.map\(/, s);
    }
});

test('novo-app.js: não dispara eventos artificiais do Leaflet', () => {
    assert.doesNotMatch(APP, /\.fire\(/);
});

test('novo.html: tem todos os elementos usados por novo-app.js e pelos módulos', () => {
    const ids = new Set([...APP.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));
    ids.add('mapa');
    assert.ok(ids.size > 25, 'deveria encontrar os IDs usados');
    for (const id of ids) {
        assert.match(HTML, new RegExp('id="' + id + '"'), id);
    }
    // Elementos exigidos pelo download do mapa e pela rota do parque.
    for (const id of ['offline-estado', 'offline-progresso', 'offline-detalhe',
        'offline-baixar', 'offline-cancelar', 'parque-estado', 'parque-calcular',
        'cartao-gps', 'painel-instrucoes']) {
        assert.match(HTML, new RegExp('id="' + id + '"'), id);
    }
    assert.match(HTML, /name="rota-parque" value="nao" checked/);
    assert.doesNotMatch(HTML, /value="sim" checked/);
});

test('novo.html: IDs únicos', () => {
    const ids = [...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(repetidos, []);
});

test('novo-app.js: textos vindos de dados entram como texto, não como HTML', () => {
    // O único innerHTML monta o indicador de conexão com textos fixos.
    const usos = [...APP.matchAll(/innerHTML\s*=/g)];
    assert.equal(usos.length, 1);
    assert.match(APP, /App\.dom\.conexao\.innerHTML =/);
});
