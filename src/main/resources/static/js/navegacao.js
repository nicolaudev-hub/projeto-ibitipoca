/**
 * Projeto Ibitipoca — módulo de navegação GPS
 *
 * Responsabilidades:
 * - Acompanhar a localização com watchPosition().
 * - Atualizar o marcador e a precisão do GPS.
 * - Manter o mapa centralizado na posição (modo "seguir").
 * - Calcular a distância até o trecho mais próximo da rota.
 * - Detectar afastamento persistente da rota.
 *
 * Integração:
 * const nav = NavegacaoGPS.iniciar({ mapa, coordenadas, aoAtualizar });
 * nav.definirRota(coordenadas | null); nav.pararDeSeguir(); nav.parar();
 *
 * "coordenadas" é opcional: sem rota, o módulo só acompanha a posição (que
 * serve de origem para calcular uma rota); a distância até a rota e o
 * alerta de desvio passam a valer quando uma rota é definida.
 */
(function (global) {
    'use strict';

    const LIMITE_DESVIO_METROS = 60;
    const CONFIRMACOES_DESVIO = 3;
    // Exige que o afastamento dure algum tempo: o iOS pode entregar
    // várias leituras no mesmo segundo.
    const TEMPO_MINIMO_DESVIO_MS = 5000;
    const CONFIRMACOES_RETORNO = 2;
    // Leituras piores que isso não confirmam nem descartam um desvio.
    const PRECISAO_MAXIMA_METROS = 100;
    const ZOOM_ACOMPANHAMENTO = 15;
    const RAIO_TERRA_METROS = 6371000;

    function distanciaMetros(a, b) {
        const rad = valor => valor * Math.PI / 180;
        const lat1 = rad(a[0]);
        const lat2 = rad(b[0]);
        const deltaLat = rad(b[0] - a[0]);
        const deltaLon = rad(b[1] - a[1]);

        const h =
            Math.sin(deltaLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(deltaLon / 2) ** 2;

        return 2 * RAIO_TERRA_METROS *
            Math.asin(Math.sqrt(Math.min(1, h)));
    }

    function distanciaAteSegmento(ponto, inicio, fim) {
        const latitudeMedia =
            (ponto[0] + inicio[0] + fim[0]) / 3 *
            Math.PI / 180;

        const escalaX = Math.cos(latitudeMedia);
        const projetar = coordenada => ({
            x: coordenada[1] * escalaX,
            y: coordenada[0]
        });

        const p = projetar(ponto);
        const a = projetar(inicio);
        const b = projetar(fim);

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const comprimento2 = dx * dx + dy * dy;

        let t = comprimento2 === 0 ? 0 :
            ((p.x - a.x) * dx + (p.y - a.y) * dy) /
            comprimento2;

        t = Math.max(0, Math.min(1, t));

        const pontoMaisProximo = [
            a.y + t * dy,
            (a.x + t * dx) / escalaX
        ];

        return distanciaMetros(ponto, pontoMaisProximo);
    }

    function menorDistanciaRota(posicao, coordenadas) {
        if (!coordenadas || coordenadas.length < 2) {
            return null;
        }

        let menor = Infinity;

        for (let i = 0; i < coordenadas.length - 1; i++) {
            const distancia = distanciaAteSegmento(
                posicao,
                coordenadas[i],
                coordenadas[i + 1]
            );

            if (distancia < menor) {
                menor = distancia;
            }
        }

        return menor;
    }

    /**
     * Máquina de estados do alerta de desvio.
     *
     * - Fora da rota: distância > limite + precisão (descarta o erro do GPS).
     * - Na rota: distância <= limite.
     * - Entre os dois: leitura ambígua, não altera os contadores.
     * - O alerta liga após CONFIRMACOES_DESVIO leituras fora da rota que
     *   cubram pelo menos TEMPO_MINIMO_DESVIO_MS, e desliga após
     *   CONFIRMACOES_RETORNO leituras na rota (histerese).
     */
    function criarDetectorDesvio() {
        let foraDaRota = false;
        let leiturasFora = 0;
        let inicioFora = null;
        let leiturasNaRota = 0;
        let ultimoTimestamp = null;

        function avaliar(distancia, precisao, timestamp) {
            if (timestamp === ultimoTimestamp) {
                return { foraDaRota: foraDaRota, leituraIgnorada: true };
            }
            ultimoTimestamp = timestamp;

            if (distancia === null || !(precisao <= PRECISAO_MAXIMA_METROS)) {
                return {
                    foraDaRota: foraDaRota,
                    leituraIgnorada: true,
                    precisaoInsuficiente: distancia !== null
                };
            }

            if (distancia > LIMITE_DESVIO_METROS + precisao) {
                leiturasNaRota = 0;
                if (leiturasFora === 0) inicioFora = timestamp;
                leiturasFora++;

                if (leiturasFora >= CONFIRMACOES_DESVIO &&
                    timestamp - inicioFora >= TEMPO_MINIMO_DESVIO_MS) {
                    foraDaRota = true;
                }
            } else if (distancia <= LIMITE_DESVIO_METROS) {
                leiturasFora = 0;
                inicioFora = null;
                leiturasNaRota++;

                if (leiturasNaRota >= CONFIRMACOES_RETORNO) {
                    foraDaRota = false;
                }
            }

            return { foraDaRota: foraDaRota, leituraIgnorada: false };
        }

        return { avaliar: avaliar };
    }

    function criarBotaoCentralizar(mapa, aoClicar) {
        const Controle = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const botao = L.DomUtil.create('button', 'botao-centralizar');
                botao.type = 'button';
                botao.textContent = 'Centralizar';
                botao.title = 'Voltar a seguir sua posição';
                L.DomEvent.disableClickPropagation(botao);
                L.DomEvent.on(botao, 'click', aoClicar);
                return botao;
            }
        });

        return new Controle().addTo(mapa);
    }

    // Mantém a tela ligada: no iOS o GPS para quando a tela apaga.
    function manterTelaLigada() {
        if (!navigator.wakeLock || !global.document) {
            return function () {};
        }

        let bloqueio = null;
        let ativo = true;

        function solicitar() {
            if (!ativo || global.document.visibilityState !== 'visible') return;
            navigator.wakeLock.request('screen')
                .then(novo => { bloqueio = novo; })
                .catch(erro => {
                    console.warn('Não foi possível manter a tela ligada:', erro);
                });
        }

        global.document.addEventListener('visibilitychange', solicitar);
        solicitar();

        return function liberar() {
            ativo = false;
            global.document.removeEventListener('visibilitychange', solicitar);
            if (bloqueio) bloqueio.release().catch(() => {});
            bloqueio = null;
        };
    }

    function iniciar(configuracao) {
        const mapa = configuracao && configuracao.mapa;
        let coordenadas = (configuracao && configuracao.coordenadas) || null;
        const aoAtualizar = configuracao &&
            typeof configuracao.aoAtualizar === 'function'
            ? configuracao.aoAtualizar
            : function () {};

        if (!mapa || typeof mapa.addLayer !== 'function') {
            throw new Error('É necessário fornecer o mapa Leaflet.');
        }

        function validarRota(rota) {
            if (rota !== null && (!Array.isArray(rota) || rota.length < 2)) {
                throw new Error('A rota precisa ter pelo menos duas coordenadas.');
            }
        }
        validarRota(coordenadas);

        if (!navigator.geolocation) {
            aoAtualizar({
                estado: 'indisponivel',
                mensagem: 'Este navegador não oferece suporte a GPS.'
            });

            return semGPS();
        }

        // Safari e Chrome só liberam o GPS em HTTPS ou localhost.
        if (global.isSecureContext === false) {
            aoAtualizar({
                estado: 'indisponivel',
                mensagem: 'O GPS exige HTTPS. Abra a aplicação por um ' +
                    'endereço https:// (ou localhost no computador).'
            });

            return semGPS();
        }

        // Mesma interface, sem efeito, quando o GPS não está disponível.
        function semGPS() {
            return {
                parar: function () {},
                definirRota: rota => { validarRota(rota); },
                pararDeSeguir: function () {}
            };
        }

        let marcador = null;
        let circuloPrecisao = null;
        let idObservacao = null;
        let ultimaPosicao = null;
        let seguindo = true;
        let encerrado = false;
        let detector = criarDetectorDesvio();

        function emitir(dados) {
            try {
                aoAtualizar(dados);
            } catch (erro) {
                console.error('Erro no callback da navegação:', erro);
            }
        }

        function centralizar() {
            seguindo = true;
            if (ultimaPosicao) {
                mapa.setView(ultimaPosicao, Math.max(
                    mapa.getZoom(),
                    Math.min(ZOOM_ACOMPANHAMENTO, mapa.getMaxZoom())
                ));
            }
        }

        // Arrastar o mapa pausa o acompanhamento até o usuário pedir de volta.
        function pararDeSeguir() {
            seguindo = false;
        }

        mapa.on('dragstart', pararDeSeguir);
        const botaoCentralizar = criarBotaoCentralizar(mapa, centralizar);
        const liberarTela = manterTelaLigada();

        emitir({
            estado: 'aguardando',
            mensagem: 'Aguardando permissão e sinal do GPS.'
        });

        function aoReceberPosicao(resultado) {
            if (encerrado) return;

            const latitude = resultado.coords.latitude;
            const longitude = resultado.coords.longitude;
            const precisao = resultado.coords.accuracy;
            const posicao = [latitude, longitude];
            const primeiraPosicao = ultimaPosicao === null;
            ultimaPosicao = posicao;

            if (marcador === null) {
                marcador = L.circleMarker(posicao, {
                    radius: 9,
                    color: '#ffffff',
                    weight: 3,
                    fillColor: '#087f5b',
                    fillOpacity: 1
                }).addTo(mapa);

                marcador.bindPopup('Sua localização');
            } else {
                marcador.setLatLng(posicao);
            }

            if (circuloPrecisao === null) {
                circuloPrecisao = L.circle(posicao, {
                    radius: precisao,
                    color: '#087f5b',
                    weight: 1,
                    fillOpacity: 0.08
                }).addTo(mapa);
            } else {
                circuloPrecisao.setLatLng(posicao);
                circuloPrecisao.setRadius(precisao);
            }

            if (primeiraPosicao && seguindo) {
                centralizar();
            } else if (seguindo) {
                mapa.panTo(posicao);
            }

            // Sem rota definida não há distância nem desvio a avaliar.
            const distancia = coordenadas
                ? menorDistanciaRota(posicao, coordenadas)
                : null;

            const avaliacao = coordenadas
                ? detector.avaliar(distancia, precisao, resultado.timestamp)
                : {
                    foraDaRota: false,
                    precisaoInsuficiente: !(precisao <= PRECISAO_MAXIMA_METROS)
                };
            const foraDaRota = avaliacao.foraDaRota;

            let mensagem = foraDaRota
                ? 'Você parece estar fora da rota. Confira sua posição.'
                : 'GPS ativo.';
            if (avaliacao.precisaoInsuficiente) {
                mensagem += ' Precisão baixa: aguardando sinal melhor.';
            }

            emitir({
                estado: foraDaRota ? 'desvio' : 'ativo',
                latitude: latitude,
                longitude: longitude,
                precisaoMetros: precisao,
                distanciaRotaMetros: distancia,
                foraDaRota: foraDaRota,
                precisaoInsuficiente: Boolean(avaliacao.precisaoInsuficiente),
                seguindo: seguindo,
                mensagem: mensagem,
                timestamp: resultado.timestamp
            });
        }

        function aoErroGPS(erro) {
            if (encerrado) return;

            let mensagem;

            switch (erro.code) {
                case erro.PERMISSION_DENIED:
                    mensagem = 'Permissão de localização negada. ' +
                        'No iPhone: Ajustes > Privacidade > Serviços de ' +
                        'Localização > Safari.';
                    break;
                case erro.POSITION_UNAVAILABLE:
                    mensagem = 'Localização indisponível.';
                    break;
                case erro.TIMEOUT:
                    // O watchPosition continua ativo; é só sinal fraco.
                    mensagem = 'Sinal de GPS fraco, tentando novamente...';
                    break;
                default:
                    mensagem = 'Não foi possível obter a localização.';
            }

            if (erro.code === erro.PERMISSION_DENIED &&
                idObservacao !== null) {
                navigator.geolocation.clearWatch(idObservacao);
                idObservacao = null;
            }

            emitir({
                estado: 'erro',
                codigoErro: erro.code,
                mensagem: mensagem
            });
        }

        idObservacao = navigator.geolocation.watchPosition(
            aoReceberPosicao,
            aoErroGPS,
            {
                enableHighAccuracy: true,
                maximumAge: 1000,
                timeout: 15000
            }
        );

        return {
            // Troca a rota acompanhada (ou remove, com null); o histórico do
            // detector de desvio recomeça, porque era de outra rota.
            definirRota: function (novas) {
                validarRota(novas);
                coordenadas = novas;
                detector = criarDetectorDesvio();
            },

            // Ex.: depois de enquadrar uma rota recém-calculada. O botão
            // "Centralizar" retoma o acompanhamento.
            pararDeSeguir: pararDeSeguir,

            parar: function () {
                encerrado = true;

                if (idObservacao !== null) {
                    navigator.geolocation.clearWatch(idObservacao);
                    idObservacao = null;
                }

                mapa.off('dragstart', pararDeSeguir);
                botaoCentralizar.remove();
                liberarTela();

                if (marcador) mapa.removeLayer(marcador);
                if (circuloPrecisao) mapa.removeLayer(circuloPrecisao);

                marcador = null;
                circuloPrecisao = null;
            }
        };
    }

    global.NavegacaoGPS = Object.freeze({
        iniciar: iniciar,
        distanciaMetros: distanciaMetros,
        menorDistanciaRota: menorDistanciaRota,
        criarDetectorDesvio: criarDetectorDesvio,
        LIMITE_DESVIO_METROS: LIMITE_DESVIO_METROS
    });
})(window);
