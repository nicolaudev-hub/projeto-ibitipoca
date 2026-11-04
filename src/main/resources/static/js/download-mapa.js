/**
 * Projeto Ibitipoca — download do mapa para uso offline
 *
 * Responsabilidades:
 * - Ler a lista de tiles e a versão em tiles/manifesto.json.
 * - Baixar os tiles para o cache ibitipoca-tiles-<versão>, o mesmo que o
 *   Service Worker (sw.js) usa para servir o mapa sem conexão.
 * - Validar cada tile (tamanho, assinatura PNG e SHA-256 do manifesto).
 * - Informar progresso, permitir cancelar e retomar sem repetir downloads.
 * - Só declarar o mapa completo depois de conferir todos os tiles no cache.
 *
 * Integração:
 * const download = DownloadMapa.criar({ aoProgresso });
 * download.verificar()  -> Promise<resultado>
 * download.baixar()     -> Promise<resultado>
 * download.cancelar()
 *
 * resultado.estado: 'completo' | 'incompleto' | 'cancelado' | 'parcial' |
 *                   'espaco' | 'erro' | 'indisponivel'
 */
(function (global) {
    'use strict';

    const PREFIXO_CACHE_TILES = 'ibitipoca-tiles-';
    const DOWNLOADS_SIMULTANEOS = 4;
    const TENTATIVAS = 3;
    const ESPERA_ENTRE_TENTATIVAS_MS = 500;
    // Margem sobre o tamanho declarado: o navegador guarda metadados extras.
    const MARGEM_ESPACO = 1.2;
    const ASSINATURA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

    function nomeCacheTiles(versao) {
        return PREFIXO_CACHE_TILES + versao;
    }

    function erroDeEspaco(erro) {
        return Boolean(erro) && (erro.name === 'QuotaExceededError' ||
            erro.code === 22 || /quota/i.test(erro.message || ''));
    }

    function criar(opcoes) {
        const config = Object.assign({
            urlManifesto: './tiles/manifesto.json',
            baseTiles: './tiles/',
            caches: global.caches,
            fetch: global.fetch && global.fetch.bind(global),
            armazenamento: global.navigator && global.navigator.storage,
            subtle: global.crypto && global.crypto.subtle,
            esperar: ms => new Promise(resolver => setTimeout(resolver, ms)),
            simultaneos: DOWNLOADS_SIMULTANEOS,
            tentativas: TENTATIVAS,
            aoProgresso: function () {}
        }, opcoes);

        let emAndamento = null;
        let controle = null;

        function informar(dados) {
            try {
                config.aoProgresso(dados);
            } catch (erro) {
                console.error('Erro no callback do download do mapa:', erro);
            }
        }

        function lerManifesto() {
            return config.fetch(config.urlManifesto).then(resposta => {
                if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
                return resposta.json();
            }).then(manifesto => {
                if (!manifesto || !manifesto.versao || !Array.isArray(manifesto.tiles) ||
                    manifesto.tiles.length === 0) {
                    throw new Error('manifesto inválido');
                }
                return manifesto;
            });
        }

        function hex(buffer) {
            return Array.from(new Uint8Array(buffer))
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('');
        }

        // Confere o conteúdo contra o manifesto. Sem crypto.subtle (fora de
        // HTTPS), valida apenas tamanho e assinatura PNG.
        function validar(conteudo, tile) {
            const bytes = new Uint8Array(conteudo);
            if (bytes.length !== tile.bytes) return Promise.resolve(false);
            for (let i = 0; i < ASSINATURA_PNG.length; i++) {
                if (bytes[i] !== ASSINATURA_PNG[i]) return Promise.resolve(false);
            }
            if (!config.subtle || !tile.sha256) return Promise.resolve(true);
            return config.subtle.digest('SHA-256', conteudo)
                .then(hash => hex(hash) === tile.sha256);
        }

        function urlTile(tile) {
            return config.baseTiles + tile.caminho;
        }

        function tileGuardadoValido(cache, tile) {
            return cache.match(urlTile(tile))
                .then(resposta => resposta ? resposta.arrayBuffer() : null)
                .then(conteudo => conteudo ? validar(conteudo, tile) : false)
                .catch(() => false);
        }

        function resumo(estado, manifesto, contagem, extras) {
            const total = manifesto ? manifesto.tiles.length : 0;
            const concluidos = contagem ? contagem.concluidos : 0;
            return Object.assign({
                estado: estado,
                versao: manifesto ? manifesto.versao : null,
                total: total,
                concluidos: concluidos,
                percentual: total ? Math.floor(concluidos / total * 100) : 0,
                bytesTotais: manifesto ? manifesto.totalBytes : 0,
                bytesConcluidos: contagem ? contagem.bytesConcluidos : 0,
                bytesTransferidos: contagem ? contagem.bytesTransferidos : 0,
                falhas: contagem ? contagem.falhas.slice() : []
            }, extras);
        }

        function indisponivel() {
            return resumo('indisponivel', null, null, {
                mensagem: 'Armazenamento offline indisponível: requer HTTPS ' +
                    'e navegador compatível.'
            });
        }

        // Conta os tiles válidos já guardados, sem baixar nada.
        function conferir(manifesto) {
            return config.caches.open(nomeCacheTiles(manifesto.versao)).then(cache =>
                Promise.all(manifesto.tiles.map(tile =>
                    tileGuardadoValido(cache, tile)))
            ).then(validos => {
                const contagem = {
                    concluidos: 0, bytesConcluidos: 0, bytesTransferidos: 0, falhas: []
                };
                validos.forEach((valido, i) => {
                    if (valido) {
                        contagem.concluidos++;
                        contagem.bytesConcluidos += manifesto.tiles[i].bytes;
                    }
                });
                const completo = contagem.concluidos === manifesto.tiles.length;
                return resumo(completo ? 'completo' : 'incompleto', manifesto, contagem);
            });
        }

        function verificar() {
            if (!config.caches) return Promise.resolve(indisponivel());
            return lerManifesto()
                .then(conferir)
                .catch(erro => resumo('erro', null, null, {
                    mensagem: 'Não foi possível conferir o mapa offline: ' + erro.message
                }));
        }

        function espacoSuficiente(bytesFaltando) {
            if (!config.armazenamento || typeof config.armazenamento.estimate !== 'function') {
                return Promise.resolve(true);
            }
            return config.armazenamento.estimate().then(estimativa => {
                if (!estimativa || !estimativa.quota) return true;
                const livre = estimativa.quota - (estimativa.usage || 0);
                return livre >= bytesFaltando * MARGEM_ESPACO;
            }).catch(() => true);
        }

        // Pede ao navegador para não apagar os dados sob pouco espaço.
        function pedirPersistencia() {
            if (!config.armazenamento || typeof config.armazenamento.persist !== 'function') {
                return Promise.resolve(null);
            }
            return config.armazenamento.persist().catch(() => null);
        }

        function executar() {
            const sinal = { cancelado: false, abortar: null };
            controle = sinal;
            const abortador = typeof AbortController === 'function'
                ? new AbortController()
                : null;
            sinal.abortar = () => { if (abortador) abortador.abort(); };

            let manifesto;
            let cache;
            let persistente = null;
            const contagem = {
                concluidos: 0, bytesConcluidos: 0, bytesTransferidos: 0, falhas: []
            };
            let falhaDeEspaco = false;

            function progresso() {
                informar(resumo('baixando', manifesto, contagem));
            }

            function baixarTile(tile) {
                let tentativa = 0;
                function tentar() {
                    tentativa++;
                    return config.fetch(urlTile(tile), {
                        cache: 'no-store',
                        signal: abortador ? abortador.signal : undefined
                    }).then(resposta => {
                        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
                        return resposta.arrayBuffer();
                    }).then(conteudo => {
                        contagem.bytesTransferidos += conteudo.byteLength;
                        return validar(conteudo, tile).then(valido => {
                            if (!valido) throw new Error('conteúdo inválido');
                            return conteudo;
                        });
                    }).catch(erro => {
                        if (sinal.cancelado) throw erro;
                        if (tentativa >= config.tentativas) throw erro;
                        return config.esperar(ESPERA_ENTRE_TENTATIVAS_MS * tentativa)
                            .then(() => {
                                if (sinal.cancelado) throw new Error('cancelado');
                                return tentar();
                            });
                    });
                }
                return tentar();
            }

            function processar(tile) {
                return tileGuardadoValido(cache, tile).then(valido => {
                    if (valido) return true;
                    if (sinal.cancelado) return false;
                    // Remove cópia inválida: o sw.js serviria o cache antes da rede.
                    return cache.delete(urlTile(tile))
                        .then(() => baixarTile(tile))
                        .then(conteudo => cache.put(
                            urlTile(tile),
                            new Response(conteudo, {
                                status: 200,
                                headers: { 'Content-Type': 'image/png' }
                            })
                        ))
                        .then(() => true);
                }).then(guardado => {
                    if (!guardado) return;
                    contagem.concluidos++;
                    contagem.bytesConcluidos += tile.bytes;
                    progresso();
                }).catch(erro => {
                    if (erroDeEspaco(erro)) {
                        falhaDeEspaco = true;
                        sinal.cancelado = true;
                        sinal.abortar();
                        return;
                    }
                    if (sinal.cancelado) return;
                    contagem.falhas.push({ caminho: tile.caminho, motivo: erro.message });
                    progresso();
                });
            }

            function trabalhador(fila) {
                if (sinal.cancelado || fila.length === 0) return Promise.resolve();
                return processar(fila.shift()).then(() => trabalhador(fila));
            }

            return lerManifesto().catch(erro => {
                throw Object.assign(new Error('Não foi possível ler o manifesto do mapa ' +
                    '(sem conexão?): ' + erro.message), { inicio: true });
            }).then(dados => {
                manifesto = dados;
                return conferir(manifesto);
            }).then(atual => {
                if (atual.estado === 'completo') return atual;

                return espacoSuficiente(manifesto.totalBytes - atual.bytesConcluidos)
                    .then(suficiente => {
                        if (!suficiente) {
                            return resumo('espaco', manifesto, atual, {
                                mensagem: 'Espaço de armazenamento insuficiente para o mapa offline.'
                            });
                        }
                        return pedirPersistencia().then(resultado => {
                            persistente = resultado;
                            return config.caches.open(nomeCacheTiles(manifesto.versao));
                        }).then(aberto => {
                            cache = aberto;
                            progresso();
                            const fila = manifesto.tiles.slice();
                            const trabalhadores = [];
                            for (let i = 0; i < config.simultaneos; i++) {
                                trabalhadores.push(trabalhador(fila));
                            }
                            return Promise.all(trabalhadores);
                        }).then(() => conferir(manifesto)).then(final => {
                            // O estado final vem da conferência do cache, não dos contadores.
                            const extras = {
                                bytesTransferidos: contagem.bytesTransferidos,
                                falhas: contagem.falhas.slice(),
                                persistente: persistente
                            };
                            if (final.estado === 'completo') {
                                return Object.assign(final, extras);
                            }
                            if (falhaDeEspaco) {
                                return Object.assign(final, extras, {
                                    estado: 'espaco',
                                    mensagem: 'O armazenamento do aparelho ficou cheio. ' +
                                        'Libere espaço e toque em continuar.'
                                });
                            }
                            if (sinal.cancelado) {
                                return Object.assign(final, extras, { estado: 'cancelado' });
                            }
                            return Object.assign(final, extras, {
                                estado: 'parcial',
                                mensagem: (final.total - final.concluidos) +
                                    ' tile(s) não foram baixados. Verifique a conexão ' +
                                    'e toque em continuar.'
                            });
                        });
                    });
            }).catch(erro => resumo('erro', manifesto, contagem, {
                mensagem: erro.inicio ? erro.message
                    : 'Erro ao baixar o mapa offline: ' + erro.message
            }));
        }

        function baixar() {
            if (!config.caches) return Promise.resolve(indisponivel());
            if (!emAndamento) {
                emAndamento = executar().then(resultado => {
                    emAndamento = null;
                    controle = null;
                    informar(resultado);
                    return resultado;
                });
            }
            return emAndamento;
        }

        function cancelar() {
            if (!controle) return false;
            controle.cancelado = true;
            controle.abortar();
            return true;
        }

        return Object.freeze({
            verificar: verificar,
            baixar: baixar,
            cancelar: cancelar,
            emAndamento: () => emAndamento !== null
        });
    }

    global.DownloadMapa = Object.freeze({
        criar: criar,
        nomeCacheTiles: nomeCacheTiles
    });
})(window);
