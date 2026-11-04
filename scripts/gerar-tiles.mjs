// Gera os tiles PNG locais a partir de um TileServer GL em execução.
//
// Uso (na raiz do projeto):
//   node scripts/gerar-tiles.mjs [--origem http://localhost:8081]
//       [--estilo basic-preview] [--dados mapa-ibitipoca]
//       [--saida src/main/resources/static/tiles]
//
// A área e os zooms vêm do próprio TileServer (/data.json). Todos os tiles
// são baixados e conferidos antes de qualquer gravação; se a pasta de saída
// já existir, o script para sem alterar nada.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TAMANHO_TILE = 512;
const TENTATIVAS = 3;
const DOWNLOADS_SIMULTANEOS = 4;
const ASSINATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function lerArgumentos(argv) {
    const opcoes = {
        origem: 'http://localhost:8081',
        estilo: 'basic-preview',
        dados: '',
        saida: path.join('src', 'main', 'resources', 'static', 'tiles')
    };
    for (let i = 0; i < argv.length; i += 2) {
        const nome = argv[i].replace(/^--/, '');
        if (!(nome in opcoes) || argv[i + 1] === undefined) {
            throw new Error('Argumento inválido: ' + argv[i]);
        }
        opcoes[nome] = argv[i + 1];
    }
    opcoes.origem = opcoes.origem.replace(/\/+$/, '');
    return opcoes;
}

// Tiles da grade XYZ que intersectam [oeste, sul, leste, norte].
export function tilesDaArea(limites, zoomMin, zoomMax) {
    const [oeste, sul, leste, norte] = limites;
    const tiles = [];
    for (let z = zoomMin; z <= zoomMax; z++) {
        const n = 2 ** z;
        const coluna = lon => Math.min(n - 1, Math.floor((lon + 180) / 360 * n));
        const linha = lat => {
            const r = lat * Math.PI / 180;
            const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
            return Math.min(n - 1, Math.floor(y * n));
        };
        for (let x = coluna(oeste); x <= coluna(leste); x++) {
            for (let y = linha(norte); y <= linha(sul); y++) {
                tiles.push({ z, x, y });
            }
        }
    }
    return tiles;
}

async function buscarJson(url) {
    const resposta = await fetch(url);
    if (!resposta.ok) throw new Error(url + ' respondeu ' + resposta.status);
    return resposta.json();
}

async function baixarTile(url) {
    let ultimoErro;
    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
        try {
            const resposta = await fetch(url);
            if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
            const conteudo = Buffer.from(await resposta.arrayBuffer());
            if (!conteudo.subarray(0, 8).equals(ASSINATURA_PNG)) {
                throw new Error('resposta não é PNG');
            }
            return conteudo;
        } catch (erro) {
            ultimoErro = erro;
        }
    }
    throw new Error(url + ': ' + ultimoErro.message);
}

async function main() {
    const opcoes = lerArgumentos(process.argv.slice(2));

    if (existsSync(opcoes.saida)) {
        throw new Error('A pasta ' + opcoes.saida + ' já existe. Remova ou ' +
            'renomeie manualmente antes de gerar novamente.');
    }

    const conjuntos = await buscarJson(opcoes.origem + '/data.json');
    const dados = opcoes.dados
        ? conjuntos.find(item => item.id === opcoes.dados)
        : conjuntos[0];
    if (!dados) throw new Error('Conjunto de dados não encontrado no TileServer.');

    const estilos = await buscarJson(opcoes.origem + '/styles.json');
    if (!estilos.some(estilo => estilo.id === opcoes.estilo)) {
        throw new Error('Estilo ' + opcoes.estilo + ' não encontrado no TileServer.');
    }

    const tiles = tilesDaArea(dados.bounds, dados.minzoom, dados.maxzoom);
    console.log('Baixando ' + tiles.length + ' tiles de ' + opcoes.origem + '...');

    const fila = [...tiles];
    let concluidos = 0;
    async function trabalhador() {
        while (fila.length) {
            const tile = fila.shift();
            const caminho = `${tile.z}/${tile.x}/${tile.y}.png`;
            const url = `${opcoes.origem}/styles/${opcoes.estilo}/${TAMANHO_TILE}/${caminho}`;
            tile.caminho = caminho;
            tile.conteudo = await baixarTile(url);
            concluidos++;
            if (concluidos % 25 === 0) console.log('  ' + concluidos + '/' + tiles.length);
        }
    }
    await Promise.all(Array.from({ length: DOWNLOADS_SIMULTANEOS }, trabalhador));

    tiles.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
    const itens = tiles.map(tile => ({
        caminho: tile.caminho,
        bytes: tile.conteudo.length,
        sha256: createHash('sha256').update(tile.conteudo).digest('hex')
    }));
    const versao = createHash('sha256')
        .update(itens.map(item => item.caminho + ' ' + item.sha256).join('\n'))
        .digest('hex')
        .slice(0, 16);

    const manifesto = {
        versao: versao,
        geradoEm: new Date().toISOString(),
        estilo: opcoes.estilo,
        tamanhoTile: TAMANHO_TILE,
        zoomMin: dados.minzoom,
        zoomMax: dados.maxzoom,
        limites: dados.bounds,
        atribuicao: dados.attribution,
        totalBytes: itens.reduce((soma, item) => soma + item.bytes, 0),
        tiles: itens
    };

    // Só grava depois de todos os downloads terem dado certo.
    await mkdir(opcoes.saida, { recursive: false }).catch(() => {
        throw new Error('Não foi possível criar ' + opcoes.saida);
    });
    for (const tile of tiles) {
        const destino = path.join(opcoes.saida, tile.caminho);
        await mkdir(path.dirname(destino), { recursive: true });
        await writeFile(destino, tile.conteudo, { flag: 'wx' });
    }
    await writeFile(
        path.join(opcoes.saida, 'manifesto.json'),
        JSON.stringify(manifesto, null, 2) + '\n',
        { flag: 'wx' }
    );

    console.log('Gerados ' + itens.length + ' tiles (' +
        (manifesto.totalBytes / 1048576).toFixed(2) + ' MB), versão ' + versao + '.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(erro => {
        console.error('Erro: ' + erro.message);
        process.exitCode = 1;
    });
}
