/**
 * Projeto Ibitipoca — Circuito das Águas (opcional)
 *
 * Responsabilidades:
 * - Carregar, sob pedido, o traçado do circuito (data/circuito_aguas.json,
 *   gerado por scripts/gerar-circuito-aguas.mjs a partir do OpenStreetMap).
 * - Desenhar o circuito e as atrações numa camada própria, sem tocar na
 *   rota principal nem na rota até o parque.
 *
 * O arquivo é um recurso do app guardado pelo Service Worker, então o
 * circuito aparece sem internet depois da primeira visita. Não usa GPS.
 *
 * Integração:
 * const circuito = CircuitoAguas.criar({ mapa, aoMudar });
 * circuito.ativar(); circuito.desativar();
 */
(function (global) {
    'use strict';

    const ARQUIVO = './data/circuito_aguas.json';
    const FORMATO = 'ibitipoca-circuito-v1';

    const ESTILO_LINHA = {
        color: '#0b7285',
        weight: 5,
        opacity: 0.9
    };

    const ESTILO_ATRACAO = {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: '#1c7ed6',
        fillOpacity: 1
    };

    const ESTILO_PORTARIA = {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: '#0b7285',
        fillOpacity: 1
    };

    function ponto(valor) {
        return Array.isArray(valor) && valor.length === 2 &&
            Number.isFinite(valor[0]) && Number.isFinite(valor[1]);
    }

    // Confere o arquivo; lança erro com mensagem para o usuário.
    function validar(dados) {
        if (!dados || dados.formato !== FORMATO) {
            throw new Error('O arquivo do circuito está em formato desconhecido.');
        }
        if (!Array.isArray(dados.coordenadas) || dados.coordenadas.length < 2 ||
            !dados.coordenadas.every(ponto)) {
            throw new Error('O arquivo do circuito não possui um traçado válido.');
        }
        if (!Array.isArray(dados.atracoes) || !dados.atracoes.every(a =>
            a && typeof a.nome === 'string' && ponto(a.localizacao) &&
            typeof a.posicao === 'number')) {
            throw new Error('O arquivo do circuito possui atrações inválidas.');
        }
        if (!(typeof dados.distancia === 'number' && dados.distancia > 0)) {
            throw new Error('O arquivo do circuito não informa a distância.');
        }
        return dados;
    }

    function formatarKm(metros) {
        return (metros / 1000).toFixed(1).replace('.', ',') + ' km';
    }

    // Os popups do Leaflet aceitam HTML; os nomes entram como texto.
    function escapar(texto) {
        return String(texto).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function criar(opcoes) {
        const config = Object.assign({
            L: global.L,
            fetch: global.fetch && global.fetch.bind(global),
            aoMudar: function () {}
        }, opcoes);

        const mapa = config.mapa;
        if (!mapa || typeof mapa.addLayer !== 'function') {
            throw new Error('É necessário fornecer o mapa Leaflet.');
        }

        let ativo = false;
        let dados = null;
        let carregando = null;
        let camadas = [];
        let linha = null;
        let ultimoEstado = { estado: 'desativado', mensagem: '' };

        function informar(estado, mensagem) {
            ultimoEstado = { estado: estado, mensagem: mensagem, ativo: ativo, circuito: dados };
            try {
                config.aoMudar(ultimoEstado);
            } catch (erro) {
                console.error('Erro no callback do Circuito das Águas:', erro);
            }
            return ultimoEstado;
        }

        // Cria as camadas uma única vez; depois só as adiciona e remove.
        function desenhar() {
            if (!camadas.length) {
                const L = config.L;
                linha = L.polyline(dados.coordenadas.map(([lon, lat]) => [lat, lon]), ESTILO_LINHA);
                camadas.push(linha);
                if (dados.portaria && ponto(dados.portaria.localizacao)) {
                    const [lon, lat] = dados.portaria.localizacao;
                    camadas.push(L.circleMarker([lat, lon], ESTILO_PORTARIA).bindPopup(
                        '<strong>' + escapar(dados.nome) + '</strong><br>' +
                        'Início e fim: ' + escapar(dados.portaria.nome)));
                }
                dados.atracoes.forEach((atracao, i) => {
                    const [lon, lat] = atracao.localizacao;
                    camadas.push(L.circleMarker([lat, lon], ESTILO_ATRACAO).bindPopup(
                        '<strong>' + (i + 1) + '. ' + escapar(atracao.nome) + '</strong><br>' +
                        formatarKm(atracao.posicao) + ' a partir da portaria, pelo circuito'));
                });
            }
            camadas.forEach(c => { if (!mapa.hasLayer(c)) c.addTo(mapa); });
        }

        // Só aproxima o mapa uma vez; o acompanhamento do GPS segue as
        // regras de navegacao.js (arrastar pausa; "Centralizar" retoma).
        function enquadrar() {
            if (typeof mapa.fitBounds === 'function' && linha && linha.getBounds) {
                mapa.fitBounds(linha.getBounds(), { padding: [20, 20] });
            }
        }

        function remover() {
            camadas.forEach(c => { if (mapa.hasLayer(c)) mapa.removeLayer(c); });
        }

        function mostrar() {
            desenhar();
            enquadrar();
            return informar('pronto', dados.nome + ': ' + formatarKm(dados.distancia) +
                ' (ida e volta a partir da portaria), ' + dados.atracoes.length + ' atrações.');
        }

        function carregar() {
            if (carregando) return carregando;
            informar('carregando', 'Carregando o Circuito das Águas...');
            carregando = config.fetch(ARQUIVO)
                .then(resposta => {
                    if (!resposta.ok) {
                        throw new Error('Arquivo do circuito indisponível (HTTP ' +
                            resposta.status + ').');
                    }
                    return resposta.json().catch(() => {
                        throw new Error('O arquivo do circuito está em formato inesperado.');
                    });
                })
                .then(validar)
                .then(validos => {
                    dados = validos;
                    return ativo ? mostrar() : informar('desativado', '');
                })
                .catch(erro => {
                    const mensagem = erro && erro.name === 'TypeError'
                        ? 'Não foi possível carregar o circuito (sem internet e sem cópia ' +
                          'guardada neste aparelho).'
                        : (erro && erro.message) || 'Falha ao carregar o circuito.';
                    return informar('erro', mensagem +
                        ' A navegação até o chalé não foi afetada.');
                })
                .finally(() => {
                    carregando = null;
                });
            return carregando;
        }

        function ativar() {
            if (ativo) return Promise.resolve(ultimoEstado);
            ativo = true;
            return dados ? Promise.resolve(mostrar()) : carregar();
        }

        function desativar() {
            ativo = false;
            remover();
            return informar('desativado', '');
        }

        return {
            ativar: ativar,
            desativar: desativar,
            estaAtivo: () => ativo,
            circuitoAtual: () => dados,
            estadoAtual: () => ultimoEstado
        };
    }

    global.CircuitoAguas = Object.freeze({
        criar: criar,
        validar: validar,
        ARQUIVO: ARQUIVO
    });
})(window);
