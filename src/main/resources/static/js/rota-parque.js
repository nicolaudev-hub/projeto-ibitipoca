/**
 * Projeto Ibitipoca — rota opcional até o Parque Estadual do Ibitipoca
 *
 * Responsabilidades:
 * - Calcular, sob pedido, a rota da posição GPS atual até a portaria do
 *   parque usando o OSRM público (o mesmo serviço da rota principal).
 * - Desenhar a rota numa camada própria, sem tocar na rota principal.
 * - Guardar a última rota calculada (geometria e etapas) no aparelho para
 *   uso sem internet, identificando quando e de onde foi calculada.
 *
 * Nunca desenha linha reta como substituta de uma rota viária e nunca faz
 * requisições a cada leitura do GPS: só quando calcular() é chamado.
 *
 * Integração:
 * const parque = RotaParque.criar({ mapa, obterPosicao, aoMudar });
 * parque.ativar(); parque.desativar(); parque.calcular();
 */
(function (global) {
    'use strict';

    // Cancela de cobrança da portaria de visitantes, no fim da LMG-871
    // (Conceição de Ibitipoca, Lima Duarte). Fonte: OpenStreetMap,
    // node 2074946673 (barrier=lift_gate, fee=yes), junto ao prédio
    // "Portaria" (way 197214959). Conferido em 30/10/2026.
    const DESTINO = Object.freeze({
        latitude: -21.7118892,
        longitude: -43.9030178,
        nome: 'Portaria do Parque Estadual do Ibitipoca'
    });

    const SERVIDOR_OSRM = 'https://router.project-osrm.org';
    const CHAVE_ARMAZENAMENTO = 'ibitipoca-rota-parque-v1';
    const TEMPO_LIMITE_MS = 20000;
    // Leitura do GPS mais antiga que isso não representa a posição atual.
    const IDADE_MAXIMA_POSICAO_MS = 30000;
    const PRECISAO_MAXIMA_METROS = 100;
    // Distâncias máximas até a via mais próxima aceitas pelo OSRM.
    const AFASTAMENTO_MAXIMO_ORIGEM_METROS = 500;
    const AFASTAMENTO_MAXIMO_DESTINO_METROS = 50;

    const ESTILO_LINHA = {
        color: '#e8590c',
        weight: 5,
        opacity: 0.9,
        dashArray: '10 8'
    };

    function urlRota(origem) {
        return SERVIDOR_OSRM + '/route/v1/driving/' +
            origem.longitude.toFixed(6) + ',' + origem.latitude.toFixed(6) + ';' +
            DESTINO.longitude + ',' + DESTINO.latitude +
            '?overview=full&geometries=geojson&steps=true';
    }

    // Confere a resposta do OSRM; lança erro com mensagem para o usuário.
    function validarResposta(dados) {
        if (!dados || dados.code === 'NoRoute' || dados.code === 'NoSegment') {
            throw new Error('O serviço não encontrou rota viária entre sua ' +
                'posição e o parque.');
        }
        if (dados.code !== 'Ok' || !Array.isArray(dados.routes) || !dados.routes.length) {
            throw new Error('O serviço de rotas respondeu sem uma rota válida.');
        }
        const rota = dados.routes[0];
        const coordenadas = rota.geometry && rota.geometry.coordinates;
        if (!Array.isArray(coordenadas) || coordenadas.length < 2) {
            throw new Error('A rota recebida não possui geometria.');
        }
        const pontos = dados.waypoints || [];
        if (!pontos[0] || !(pontos[0].distance <= AFASTAMENTO_MAXIMO_ORIGEM_METROS)) {
            throw new Error('Sua posição está longe de uma via conhecida pelo ' +
                'serviço de rotas.');
        }
        if (!pontos[1] || !(pontos[1].distance <= AFASTAMENTO_MAXIMO_DESTINO_METROS)) {
            throw new Error('A portaria do parque está fora da cobertura do ' +
                'serviço de rotas.');
        }
        return rota;
    }

    function rotaSalvaValida(salva) {
        return Boolean(salva) && salva.formato === 1 &&
            typeof salva.criadaEm === 'number' &&
            salva.origem && typeof salva.origem.latitude === 'number' &&
            salva.destino && salva.destino.latitude === DESTINO.latitude &&
            salva.destino.longitude === DESTINO.longitude &&
            Array.isArray(salva.coordenadas) && salva.coordenadas.length >= 2 &&
            Array.isArray(salva.etapas);
    }

    function criar(opcoes) {
        const config = Object.assign({
            L: global.L,
            fetch: global.fetch && global.fetch.bind(global),
            armazenamento: (function () {
                try { return global.localStorage; } catch (erro) { return null; }
            })(),
            estaOnline: () => !global.navigator || global.navigator.onLine !== false,
            agora: () => Date.now(),
            obterPosicao: () => null,
            aoMudar: function () {}
        }, opcoes);

        const mapa = config.mapa;
        if (!mapa || typeof mapa.addLayer !== 'function') {
            throw new Error('É necessário fornecer o mapa Leaflet.');
        }

        let ativa = false;
        let rota = null;
        let calculando = null;
        let linha = null;
        let marcadorDestino = null;
        let ultimoEstado = { estado: 'desativada', mensagem: '' };

        function informar(estado, mensagem, extras) {
            ultimoEstado = Object.assign({
                estado: estado,
                mensagem: mensagem,
                ativa: ativa,
                rota: rota
            }, extras);
            try {
                config.aoMudar(ultimoEstado);
            } catch (erro) {
                console.error('Erro no callback da rota do parque:', erro);
            }
            return ultimoEstado;
        }

        function lerSalva() {
            if (!config.armazenamento) return null;
            try {
                const salva = JSON.parse(config.armazenamento.getItem(CHAVE_ARMAZENAMENTO));
                return rotaSalvaValida(salva) ? salva : null;
            } catch (erro) {
                return null;
            }
        }

        function salvar(nova) {
            if (!config.armazenamento) return false;
            try {
                config.armazenamento.setItem(CHAVE_ARMAZENAMENTO, JSON.stringify(nova));
                return true;
            } catch (erro) {
                console.warn('Não foi possível guardar a rota do parque:', erro);
                return false;
            }
        }

        // Cria as camadas uma única vez; depois só troca a geometria.
        function desenhar() {
            const latLngs = rota.coordenadas.map(([lon, lat]) => [lat, lon]);
            if (linha === null) {
                linha = config.L.polyline(latLngs, ESTILO_LINHA);
                marcadorDestino = config.L.circleMarker(
                    [DESTINO.latitude, DESTINO.longitude], {
                        radius: 8,
                        color: '#ffffff',
                        weight: 3,
                        fillColor: '#e8590c',
                        fillOpacity: 1
                    }).bindPopup(DESTINO.nome);
            } else {
                linha.setLatLngs(latLngs);
            }
            if (!mapa.hasLayer(linha)) linha.addTo(mapa);
            if (!mapa.hasLayer(marcadorDestino)) marcadorDestino.addTo(mapa);
        }

        function remover() {
            if (linha && mapa.hasLayer(linha)) mapa.removeLayer(linha);
            if (marcadorDestino && mapa.hasLayer(marcadorDestino)) {
                mapa.removeLayer(marcadorDestino);
            }
        }

        function mostrarPronta(recalculadaAgora, mensagem) {
            if (ativa) desenhar();
            return informar('pronta', mensagem, { recalculadaAgora: recalculadaAgora });
        }

        function calcular() {
            if (calculando) return calculando;

            const posicao = config.obterPosicao();
            const idade = posicao ? config.agora() - posicao.timestamp : Infinity;
            if (!posicao || !(idade <= IDADE_MAXIMA_POSICAO_MS) ||
                !(posicao.precisao <= PRECISAO_MAXIMA_METROS)) {
                return Promise.resolve(informar('aguardando-gps',
                    'Sem posição GPS atual e precisa. Permita o acesso à ' +
                    'localização, abra o app por https:// e aguarde o sinal ' +
                    '(o cartão "GPS" deve mostrar "GPS ativo").'));
            }

            if (!config.estaOnline()) {
                return Promise.resolve(informar('sem-rede',
                    'Sem internet: não é possível calcular a rota agora.' +
                    (rota ? ' A rota salva anteriormente continua exibida.' : '')));
            }

            const origem = {
                latitude: posicao.latitude,
                longitude: posicao.longitude,
                precisao: posicao.precisao
            };
            informar('calculando', 'Calculando a rota até o parque...');

            const controle = typeof AbortController === 'function'
                ? new AbortController() : null;
            const temporizador = setTimeout(() => {
                if (controle) controle.abort();
            }, TEMPO_LIMITE_MS);

            calculando = config.fetch(urlRota(origem), controle ? { signal: controle.signal } : {})
                .then(resposta => {
                    if (!resposta.ok && resposta.status !== 400) {
                        throw new Error('O serviço de rotas está indisponível ' +
                            '(HTTP ' + resposta.status + ').');
                    }
                    return resposta.json().catch(() => {
                        throw new Error('O serviço de rotas respondeu em formato inesperado.');
                    });
                })
                .then(dados => {
                    const nova = validarResposta(dados);
                    rota = {
                        formato: 1,
                        criadaEm: config.agora(),
                        origem: origem,
                        destino: { latitude: DESTINO.latitude, longitude: DESTINO.longitude },
                        distancia: nova.distance,
                        duracao: nova.duration,
                        coordenadas: nova.geometry.coordinates,
                        etapas: global.InstrucoesNavegacao
                            ? global.InstrucoesNavegacao.etapasDeOsrm(nova) : []
                    };
                    const salvou = salvar(rota);
                    return mostrarPronta(true, salvou
                        ? 'Rota calculada a partir da sua posição atual e salva neste aparelho.'
                        : 'Rota calculada, mas não pôde ser salva para uso offline.');
                })
                .catch(erro => {
                    const mensagem = erro && erro.name === 'AbortError'
                        ? 'O serviço de rotas demorou demais para responder.'
                        : erro && erro.name === 'TypeError'
                            ? 'Não foi possível acessar o serviço de rotas (sem internet?).'
                            : (erro && erro.message) || 'Falha ao calcular a rota.';
                    return informar('erro', mensagem +
                        (rota ? ' A rota salva anteriormente continua exibida.' : '') +
                        ' A navegação até o chalé não foi afetada.');
                })
                .finally(() => {
                    clearTimeout(temporizador);
                    calculando = null;
                });
            return calculando;
        }

        function ativar() {
            if (ativa) return Promise.resolve(ultimoEstado);
            ativa = true;
            if (rota === null) rota = lerSalva();
            if (rota) {
                return Promise.resolve(mostrarPronta(false,
                    'Exibindo a rota salva; ela não foi recalculada a partir da ' +
                    'sua posição atual.'));
            }
            return calcular();
        }

        function desativar() {
            ativa = false;
            remover();
            return informar('desativada', '');
        }

        return {
            ativar: ativar,
            desativar: desativar,
            calcular: calcular,
            estaAtiva: () => ativa,
            rotaAtual: () => rota,
            estadoAtual: () => ultimoEstado
        };
    }

    global.RotaParque = Object.freeze({
        criar: criar,
        DESTINO: DESTINO,
        CHAVE_ARMAZENAMENTO: CHAVE_ARMAZENAMENTO,
        urlRota: urlRota
    });
})(window);
