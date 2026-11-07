/**
 * OffGrid — rota da posição atual até um destino escolhido pelo usuário
 *
 * Responsabilidades:
 * - Guardar o destino escolhido (por busca ou toque no mapa) e marcá-lo.
 * - Calcular, sob pedido, a rota da posição GPS atual até o destino pelo
 *   OSRM próprio (./osrm, publicado no mesmo domínio do app).
 * - Desenhar a rota numa camada própria, sem tocar nas outras rotas.
 * - Guardar a última rota calculada (geometria, etapas e destino) no
 *   aparelho, para continuar disponível sem internet.
 *
 * Generaliza a lógica de rota-parque.js para qualquer destino da região
 * coberta pelas rotas (Sudeste). Como lá: nunca desenha linha reta no lugar
 * de uma rota viária e só consulta o serviço quando calcular() é chamado.
 *
 * Integração:
 * const destino = RotaDestino.criar({ mapa, obterPosicao, aoMudar });
 * destino.definirDestino({ latitude, longitude, nome });
 * destino.calcular(); destino.restaurar(); destino.limpar();
 */
(function (global) {
    'use strict';

    const SERVIDOR_OSRM = './osrm';
    const CHAVE_ARMAZENAMENTO = 'offgrid-rota-destino-v1';
    const TEMPO_LIMITE_MS = 20000;
    // Leitura do GPS mais antiga que isso não representa a posição atual.
    const IDADE_MAXIMA_POSICAO_MS = 30000;
    const PRECISAO_MAXIMA_METROS = 100;
    // Distâncias máximas até a via mais próxima aceitas pelo OSRM. O destino
    // tem margem maior que a da portaria do parque: um ponto tocado no mapa ou
    // o centro de uma cidade raramente cai exatamente sobre uma rua.
    const AFASTAMENTO_MAXIMO_ORIGEM_METROS = 500;
    const AFASTAMENTO_MAXIMO_DESTINO_METROS = 2000;
    const AFASTAMENTO_AVISO_DESTINO_METROS = 150;

    // Área atendida pelas rotas: região Sudeste (oeste, sul, leste, norte).
    const COBERTURA = Object.freeze({ oeste: -53.11, sul: -25.32, leste: -39.67, norte: -14.23 });

    const ESTILO_LINHA = { color: '#1c7ed6', weight: 6, opacity: 0.9 };
    const ESTILO_DESTINO = {
        radius: 9,
        color: '#ffffff',
        weight: 3,
        fillColor: '#1c7ed6',
        fillOpacity: 1
    };

    function dentroDaCobertura(latitude, longitude) {
        return latitude >= COBERTURA.sul && latitude <= COBERTURA.norte &&
            longitude >= COBERTURA.oeste && longitude <= COBERTURA.leste;
    }

    // Normaliza e valida um destino; devolve null se não for utilizável.
    function normalizarDestino(destino) {
        if (!destino) return null;
        const latitude = Number(destino.latitude);
        const longitude = Number(destino.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
            Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
            return null;
        }
        const nome = typeof destino.nome === 'string' && destino.nome.trim()
            ? destino.nome.trim().slice(0, 200)
            : latitude.toFixed(5) + ', ' + longitude.toFixed(5);
        return { latitude: latitude, longitude: longitude, nome: nome };
    }

    function mesmoDestino(a, b) {
        return Boolean(a && b) && a.latitude === b.latitude && a.longitude === b.longitude;
    }

    function urlRota(origem, destino) {
        return SERVIDOR_OSRM + '/route/v1/driving/' +
            origem.longitude.toFixed(6) + ',' + origem.latitude.toFixed(6) + ';' +
            destino.longitude.toFixed(6) + ',' + destino.latitude.toFixed(6) +
            '?overview=full&geometries=geojson&steps=true';
    }

    // Confere a resposta do OSRM; lança erro com mensagem para o usuário.
    function validarResposta(dados) {
        if (!dados || dados.code === 'NoRoute') {
            throw new Error('O serviço não encontrou rota viária entre sua ' +
                'posição e o destino.');
        }
        if (dados.code === 'NoSegment') {
            throw new Error('Sua posição ou o destino está fora das vias ' +
                'conhecidas pelo serviço de rotas.');
        }
        if (dados.code !== 'Ok' || !Array.isArray(dados.routes) || !dados.routes.length) {
            throw new Error((dados && dados.message) ||
                'O serviço de rotas respondeu sem uma rota válida.');
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
            throw new Error('O destino está longe de qualquer via conhecida pelo ' +
                'serviço de rotas. Escolha um ponto mais perto de uma estrada.');
        }
        return { rota: rota, afastamentoDestino: pontos[1].distance };
    }

    function rotaSalvaValida(salva) {
        return Boolean(salva) && salva.formato === 1 &&
            typeof salva.criadaEm === 'number' &&
            salva.origem && typeof salva.origem.latitude === 'number' &&
            Boolean(normalizarDestino(salva.destino)) &&
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

        let destino = null;
        let rota = null;
        let calculando = null;
        let linha = null;
        let marcadorDestino = null;
        let ultimoEstado = { estado: 'sem-destino', mensagem: '', destino: null, rota: null };

        function informar(estado, mensagem, extras) {
            ultimoEstado = Object.assign({
                estado: estado,
                mensagem: mensagem,
                destino: destino,
                rota: rota
            }, extras);
            try {
                config.aoMudar(ultimoEstado);
            } catch (erro) {
                console.error('Erro no callback da rota até o destino:', erro);
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
                console.warn('Não foi possível guardar a rota até o destino:', erro);
                return false;
            }
        }

        function apagarSalva() {
            if (!config.armazenamento) return;
            try {
                config.armazenamento.removeItem(CHAVE_ARMAZENAMENTO);
            } catch (erro) {
                console.warn('Não foi possível apagar a rota salva:', erro);
            }
        }

        function marcarDestino() {
            const latLng = [destino.latitude, destino.longitude];
            if (marcadorDestino === null) {
                marcadorDestino = config.L.circleMarker(latLng, ESTILO_DESTINO);
            } else if (typeof marcadorDestino.setLatLng === 'function') {
                marcadorDestino.setLatLng(latLng);
            }
            // Texto vindo da busca entra como texto, nunca como HTML.
            if (typeof marcadorDestino.bindTooltip === 'function') {
                marcadorDestino.unbindTooltip && marcadorDestino.unbindTooltip();
                marcadorDestino.bindTooltip(textoSeguro(destino.nome));
            }
            if (!mapa.hasLayer(marcadorDestino)) marcadorDestino.addTo(mapa);
        }

        function textoSeguro(texto) {
            const doc = global.document;
            if (!doc || typeof doc.createElement !== 'function') return String(texto);
            const span = doc.createElement('span');
            span.textContent = texto;
            return span;
        }

        // Cria a linha uma única vez; depois só troca a geometria.
        function desenharRota(enquadrar) {
            const latLngs = rota.coordenadas.map(([lon, lat]) => [lat, lon]);
            if (linha === null) {
                linha = config.L.polyline(latLngs, ESTILO_LINHA);
            } else {
                linha.setLatLngs(latLngs);
            }
            if (!mapa.hasLayer(linha)) linha.addTo(mapa);
            if (enquadrar && typeof mapa.fitBounds === 'function' &&
                typeof linha.getBounds === 'function') {
                mapa.fitBounds(linha.getBounds(), { padding: [30, 30] });
            }
        }

        function removerRota() {
            if (linha && mapa.hasLayer(linha)) mapa.removeLayer(linha);
        }

        function removerTudo() {
            removerRota();
            if (marcadorDestino && mapa.hasLayer(marcadorDestino)) {
                mapa.removeLayer(marcadorDestino);
            }
        }

        function definirDestino(novo) {
            const normalizado = normalizarDestino(novo);
            if (!normalizado) {
                return informar('erro', 'Destino inválido.');
            }
            if (!dentroDaCobertura(normalizado.latitude, normalizado.longitude)) {
                return informar('fora-da-cobertura',
                    'Esse destino fica fora da região atendida pelas rotas ' +
                    '(Sudeste). Escolha outro ponto.');
            }
            if (!mesmoDestino(destino, normalizado) && rota) {
                // A rota anterior leva a outro lugar: deixa de valer.
                rota = null;
                removerRota();
            }
            destino = normalizado;
            marcarDestino();
            return informar('destino-definido',
                'Destino: ' + destino.nome + '. Toque em "Calcular rota" para ' +
                'traçar o caminho a partir da sua posição atual.');
        }

        function calcular() {
            if (calculando) return calculando;
            if (!destino) {
                return Promise.resolve(informar('sem-destino',
                    'Escolha um destino pela busca ou tocando no mapa.'));
            }

            const posicao = config.obterPosicao();
            const idade = posicao ? config.agora() - posicao.timestamp : Infinity;
            if (!posicao || !(idade <= IDADE_MAXIMA_POSICAO_MS) ||
                !(posicao.precisao <= PRECISAO_MAXIMA_METROS)) {
                return Promise.resolve(informar('aguardando-gps',
                    'Sem posição GPS atual e precisa. Permita o acesso à ' +
                    'localização, abra o app por https:// e aguarde o sinal ' +
                    '(o cartão "GPS" deve mostrar "GPS ativo").'));
            }
            if (!dentroDaCobertura(posicao.latitude, posicao.longitude)) {
                return Promise.resolve(informar('fora-da-cobertura',
                    'Sua posição está fora da região atendida pelas rotas (Sudeste).'));
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
            const destinoDoPedido = destino;
            informar('calculando', 'Calculando a rota até ' + destino.nome + '...');

            const controle = typeof AbortController === 'function'
                ? new AbortController() : null;
            const temporizador = setTimeout(() => {
                if (controle) controle.abort();
            }, TEMPO_LIMITE_MS);

            calculando = config.fetch(urlRota(origem, destinoDoPedido),
                controle ? { signal: controle.signal } : {})
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
                    const { rota: nova, afastamentoDestino } = validarResposta(dados);
                    // O usuário limpou ou trocou o destino durante o cálculo.
                    if (!destino) return informar('sem-destino', '');
                    if (!mesmoDestino(destino, destinoDoPedido)) {
                        return informar('destino-definido',
                            'Destino alterado durante o cálculo. Toque em ' +
                            '"Calcular rota" de novo.');
                    }
                    rota = {
                        formato: 1,
                        criadaEm: config.agora(),
                        origem: origem,
                        destino: destinoDoPedido,
                        distancia: nova.distance,
                        duracao: nova.duration,
                        coordenadas: nova.geometry.coordinates,
                        etapas: global.InstrucoesNavegacao
                            ? global.InstrucoesNavegacao.etapasDeOsrm(nova) : []
                    };
                    desenharRota(true);
                    const salvou = salvar(rota);
                    let mensagem = salvou
                        ? 'Rota calculada a partir da sua posição atual e salva neste aparelho.'
                        : 'Rota calculada, mas não pôde ser salva para uso offline.';
                    if (afastamentoDestino > AFASTAMENTO_AVISO_DESTINO_METROS) {
                        mensagem += ' A rota termina na via mais próxima, a ' +
                            Math.round(afastamentoDestino) + ' m do ponto escolhido.';
                    }
                    return informar('pronta', mensagem, { recalculadaAgora: true });
                })
                .catch(erro => {
                    const mensagem = erro && erro.name === 'AbortError'
                        ? 'O serviço de rotas demorou demais para responder.'
                        : erro && erro.name === 'TypeError'
                            ? 'Não foi possível acessar o serviço de rotas (sem internet?).'
                            : (erro && erro.message) || 'Falha ao calcular a rota.';
                    return informar('erro', mensagem +
                        (rota ? ' A rota salva anteriormente continua exibida.' : ''));
                })
                .finally(() => {
                    clearTimeout(temporizador);
                    calculando = null;
                });
            return calculando;
        }

        // Mostra a última rota salva (uso sem internet), sem recalcular.
        function restaurar() {
            const salva = lerSalva();
            if (!salva) return informar('sem-destino', '');
            destino = normalizarDestino(salva.destino);
            rota = salva;
            marcarDestino();
            desenharRota(false);
            return informar('pronta',
                'Exibindo a rota salva até ' + destino.nome + '; ela não foi ' +
                'recalculada a partir da sua posição atual.',
                { recalculadaAgora: false });
        }

        function limpar() {
            destino = null;
            rota = null;
            removerTudo();
            apagarSalva();
            return informar('sem-destino', '');
        }

        return {
            definirDestino: definirDestino,
            calcular: calcular,
            restaurar: restaurar,
            limpar: limpar,
            destinoAtual: () => destino,
            rotaAtual: () => rota,
            estadoAtual: () => ultimoEstado
        };
    }

    global.RotaDestino = Object.freeze({
        criar: criar,
        CHAVE_ARMAZENAMENTO: CHAVE_ARMAZENAMENTO,
        COBERTURA: COBERTURA,
        dentroDaCobertura: dentroDaCobertura,
        urlRota: urlRota
    });
})(window);
