/**
 * OffGrid — busca de destinos por nome
 *
 * Consulta ./api/buscar, que o ServidorWeb encaminha ao Nominatim
 * (OpenStreetMap) respeitando a política de uso: no máximo 1 busca por
 * segundo para o app inteiro, identificação do app e cache.
 *
 * A política do Nominatim não permite autocompletar: a busca só acontece
 * quando o usuário confirma (botão ou Enter), nunca a cada letra digitada.
 *
 * Integração:
 * const busca = BuscaDestino.criar();
 * busca.buscar('Juiz de Fora').then(r => r.resultados);
 * // r.estado: 'ok' | 'vazia' | 'invalida' | 'sem-rede' | 'erro'
 */
(function (global) {
    'use strict';

    const URL_BUSCA = './api/buscar';
    const TAMANHO_MINIMO = 3;
    const TAMANHO_MAXIMO = 120;
    const TEMPO_LIMITE_MS = 15000;

    // Converte um item do Nominatim (formato jsonv2) no formato do app.
    function converterResultado(item) {
        if (!item) return null;
        const latitude = Number(item.lat);
        const longitude = Number(item.lon);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        const descricao = typeof item.display_name === 'string' ? item.display_name.trim() : '';
        const nome = (typeof item.name === 'string' && item.name.trim()) ||
            descricao.split(',')[0].trim();
        if (!nome) return null;
        return {
            nome: nome,
            descricao: descricao,
            latitude: latitude,
            longitude: longitude,
            tipo: item.addresstype || item.type || ''
        };
    }

    function criar(opcoes) {
        const config = Object.assign({
            fetch: global.fetch && global.fetch.bind(global),
            estaOnline: () => !global.navigator || global.navigator.onLine !== false
        }, opcoes);

        let emAndamento = null;
        let textoEmAndamento = '';

        function buscar(textoBruto) {
            const texto = String(textoBruto || '').trim().replace(/\s+/g, ' ');
            if (texto.length < TAMANHO_MINIMO || texto.length > TAMANHO_MAXIMO) {
                return Promise.resolve({
                    estado: 'invalida',
                    resultados: [],
                    mensagem: 'Digite de ' + TAMANHO_MINIMO + ' a ' + TAMANHO_MAXIMO +
                        ' caracteres para buscar.'
                });
            }
            // Cliques repetidos no botão não geram buscas repetidas.
            if (emAndamento && texto === textoEmAndamento) return emAndamento;
            if (!config.estaOnline()) {
                return Promise.resolve({
                    estado: 'sem-rede',
                    resultados: [],
                    mensagem: 'Sem internet: a busca precisa de conexão. Você ainda ' +
                        'pode escolher o destino tocando no mapa.'
                });
            }

            const controle = typeof AbortController === 'function'
                ? new AbortController() : null;
            const temporizador = setTimeout(() => {
                if (controle) controle.abort();
            }, TEMPO_LIMITE_MS);

            textoEmAndamento = texto;
            emAndamento = config.fetch(URL_BUSCA + '?q=' + encodeURIComponent(texto),
                controle ? { signal: controle.signal } : {})
                .then(resposta => {
                    if (resposta.status === 429) {
                        throw new Error('Muitas buscas seguidas. Aguarde alguns ' +
                            'segundos e tente de novo.');
                    }
                    if (resposta.status === 400) {
                        throw new Error('Busca inválida. Revise o texto digitado.');
                    }
                    if (!resposta.ok) {
                        throw new Error('O serviço de busca está indisponível ' +
                            '(HTTP ' + resposta.status + ').');
                    }
                    return resposta.json().catch(() => {
                        throw new Error('O serviço de busca respondeu em formato inesperado.');
                    });
                })
                .then(dados => {
                    if (!Array.isArray(dados)) {
                        throw new Error('O serviço de busca respondeu em formato inesperado.');
                    }
                    const resultados = dados.map(converterResultado).filter(Boolean);
                    if (!resultados.length) {
                        return {
                            estado: 'vazia',
                            resultados: [],
                            mensagem: 'Nada encontrado para "' + texto + '" na região ' +
                                'Sudeste. Tente o nome da cidade junto, ou toque no mapa.'
                        };
                    }
                    return {
                        estado: 'ok',
                        resultados: resultados,
                        mensagem: resultados.length === 1
                            ? '1 resultado. Toque nele para definir o destino.'
                            : resultados.length + ' resultados. Toque em um para definir o destino.'
                    };
                })
                .catch(erro => ({
                    estado: 'erro',
                    resultados: [],
                    mensagem: erro && erro.name === 'AbortError'
                        ? 'A busca demorou demais. Tente de novo.'
                        : erro && erro.name === 'TypeError'
                            ? 'Não foi possível acessar o serviço de busca (sem internet?).'
                            : (erro && erro.message) || 'Falha na busca.'
                }))
                .finally(() => {
                    clearTimeout(temporizador);
                    emAndamento = null;
                    textoEmAndamento = '';
                });
            return emAndamento;
        }

        return { buscar: buscar };
    }

    global.BuscaDestino = Object.freeze({
        criar: criar,
        converterResultado: converterResultado
    });
})(window);
