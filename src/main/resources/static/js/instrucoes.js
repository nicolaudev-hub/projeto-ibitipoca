/**
 * Projeto Ibitipoca — instruções de navegação passo a passo
 *
 * Responsabilidades:
 * - Relacionar as manobras do OSRM (tipo, modificador, via, localização)
 *   com a geometria da rota exibida no mapa.
 * - Acompanhar o progresso ao longo da rota a partir das leituras do GPS
 *   e informar a próxima manobra, a distância até ela e a distância
 *   restante pela estrada.
 *
 * Não acessa o GPS nem o mapa: recebe as leituras já obtidas por
 * navegacao.js. O alerta de desvio da rota principal continua sendo
 * responsabilidade exclusiva de navegacao.js.
 *
 * Integração:
 * const preparo = InstrucoesNavegacao.preparar(etapas, coordenadas);
 * const acompanhador = InstrucoesNavegacao.criarAcompanhador(preparo);
 * acompanhador.atualizar({ latitude, longitude, precisao, timestamp })
 * acompanhador.marcarSemSinal()
 */
(function (global) {
    'use strict';

    const RAIO_TERRA_METROS = 6371000;
    // Manobra a mais que isso da geometria invalida o conjunto de etapas.
    const TOLERANCIA_MANOBRA_METROS = 25;
    // Leituras piores que isso mantêm a instrução, sem distância.
    const PRECISAO_MAXIMA_METROS = 100;
    // Afastamento (além da precisão) que impede localizar a posição na rota.
    const LIMITE_FORA_ROTA_METROS = 80;
    // Recuos menores que isso são oscilação do GPS e não reduzem o progresso.
    const RECUO_IGNORADO_METROS = 150;
    // Passada a manobra por essa margem, a instrução avança.
    const MARGEM_PASSAGEM_METROS = 20;
    // Limita o avanço entre leituras: saltos maiores exigem confirmação.
    const VELOCIDADE_MAXIMA_MS = 45;
    const AVANCO_MINIMO_METROS = 300;
    const CONFIRMACOES_SALTO = 3;
    const RAIO_CHEGADA_METROS = 40;
    const AVISO_CHEGADA_METROS = 300;
    const ABAIXO_AGORA_METROS = 30;

    function distanciaMetros(a, b) {
        const rad = valor => valor * Math.PI / 180;
        const deltaLat = rad(b[0] - a[0]);
        const deltaLon = rad(b[1] - a[1]);
        const h =
            Math.sin(deltaLat / 2) ** 2 +
            Math.cos(rad(a[0])) * Math.cos(rad(b[0])) *
            Math.sin(deltaLon / 2) ** 2;
        return 2 * RAIO_TERRA_METROS * Math.asin(Math.sqrt(Math.min(1, h)));
    }

    // Projeção local equiretangular, como em navegacao.js.
    function projetarNoSegmento(ponto, inicio, fim) {
        const escalaX = Math.cos((ponto[0] + inicio[0] + fim[0]) / 3 * Math.PI / 180);
        const px = ponto[1] * escalaX;
        const ax = inicio[1] * escalaX;
        const bx = fim[1] * escalaX;
        const dx = bx - ax;
        const dy = fim[0] - inicio[0];
        const comprimento2 = dx * dx + dy * dy;
        let t = comprimento2 === 0 ? 0 :
            ((px - ax) * dx + (ponto[0] - inicio[0]) * dy) / comprimento2;
        t = Math.max(0, Math.min(1, t));
        const maisProximo = [inicio[0] + t * dy, (ax + t * dx) / escalaX];
        return { t: t, distancia: distanciaMetros(ponto, maisProximo) };
    }

    // ---- Texto das manobras (a partir dos campos do OSRM) ----

    const DIRECAO = {
        'left': 'à esquerda',
        'right': 'à direita',
        'slight left': 'levemente à esquerda',
        'slight right': 'levemente à direita',
        'sharp left': 'acentuadamente à esquerda',
        'sharp right': 'acentuadamente à direita',
        'straight': 'em frente',
        'uturn': 'em retorno'
    };

    const ICONE = {
        'left': '↰',
        'right': '↱',
        'slight left': '↖',
        'slight right': '↗',
        'sharp left': '↙',
        'sharp right': '↘',
        'straight': '↑',
        'uturn': '↶'
    };

    function lado(modificador) {
        if (/left/.test(modificador || '')) return 'à esquerda';
        if (/right/.test(modificador || '')) return 'à direita';
        return 'em frente';
    }

    function nomeVia(etapa) {
        if (etapa.nome && etapa.ref) return etapa.nome + ' (' + etapa.ref + ')';
        return etapa.nome || etapa.ref || '';
    }

    // Frase sem a distância, por exemplo "vire à esquerda na Rua X".
    function descrever(etapa) {
        const m = etapa.manobra;
        const mod = m.modificador;
        const via = nomeVia(etapa);
        const naVia = via ? ' na ' + via : '';
        const pelaVia = via ? ' pela ' + via : '';

        switch (m.tipo) {
            case 'depart':
                return 'siga' + pelaVia;
            case 'arrive':
                return 'chegada ao destino';
            case 'turn':
            case 'end of road': {
                let frase;
                if (mod === 'uturn') frase = 'faça o retorno';
                else if (mod === 'straight') frase = 'siga em frente';
                else frase = 'vire ' + (DIRECAO[mod] || '');
                if (m.tipo === 'end of road') frase = 'no fim da via, ' + frase;
                return frase + naVia;
            }
            case 'new name':
                return 'continue' + pelaVia;
            case 'continue':
                return (mod === 'uturn' ? 'faça o retorno' :
                    mod && mod !== 'straight' ? 'siga ' + lado(mod) : 'continue') + pelaVia;
            case 'fork':
                return 'na bifurcação, mantenha-se ' + lado(mod) + naVia;
            case 'merge':
                return via ? 'entre ' + lado(mod) + naVia : 'entre na via ' + lado(mod);
            case 'on ramp':
                return 'pegue o acesso ' + lado(mod) + naVia;
            case 'off ramp':
                return 'pegue a saída ' + lado(mod) + naVia;
            case 'roundabout':
            case 'rotary':
                return m.saida
                    ? 'na rotatória, pegue a ' + m.saida + 'ª saída' + naVia
                    : 'entre na rotatória';
            case 'exit roundabout':
            case 'exit rotary':
                return 'saia da rotatória' + naVia;
            default:
                // Tipo sem tradução: não inventa uma conversão.
                return 'siga a rota' + pelaVia;
        }
    }

    function icone(etapa) {
        const m = etapa.manobra;
        if (m.tipo === 'arrive') return '⚑';
        if (m.tipo === 'roundabout' || m.tipo === 'rotary') return '⟳';
        if (m.tipo === 'new name' || m.tipo === 'depart') return '↑';
        return ICONE[m.modificador] || '↑';
    }

    function formatarDistancia(metros) {
        const passo = metros >= 100 ? 50 : 10;
        const arredondado = Math.max(passo, Math.round(metros / passo) * passo);
        if (arredondado >= 1000) {
            return (Math.round(metros / 100) / 10).toLocaleString('pt-BR') + ' km';
        }
        return arredondado + ' m';
    }

    function maiuscula(texto) {
        return texto.charAt(0).toUpperCase() + texto.slice(1);
    }

    // ---- Conversão e preparo ----

    // Converte uma resposta do OSRM (steps=true) para o formato das etapas.
    function etapasDeOsrm(rotaOsrm) {
        if (!rotaOsrm || !Array.isArray(rotaOsrm.legs)) return [];
        return rotaOsrm.legs.map((trecho, indiceTrecho) =>
            (trecho.steps || []).map(etapa => {
                const manobra = {
                    tipo: etapa.maneuver.type,
                    localizacao: etapa.maneuver.location,
                    rumoAntes: etapa.maneuver.bearing_before,
                    rumoDepois: etapa.maneuver.bearing_after
                };
                if (etapa.maneuver.modifier) manobra.modificador = etapa.maneuver.modifier;
                if (etapa.maneuver.exit) manobra.saida = etapa.maneuver.exit;
                return {
                    trecho: indiceTrecho,
                    nome: etapa.name || '',
                    ref: etapa.ref || '',
                    distancia: etapa.distance,
                    duracao: etapa.duration,
                    manobra: manobra
                };
            })).flat();
    }

    /**
     * Relaciona cada manobra a uma posição ao longo da geometria.
     * coordenadas: [[lat, lon], ...] (as mesmas desenhadas no mapa).
     * Retorna { valido: false, motivo } se os dados não forem confiáveis.
     */
    function preparar(etapas, coordenadas) {
        if (!Array.isArray(coordenadas) || coordenadas.length < 2) {
            return { valido: false, motivo: 'A rota não possui geometria suficiente.' };
        }
        if (!Array.isArray(etapas) || etapas.length < 2) {
            return { valido: false, motivo: 'A rota não possui etapas de navegação.' };
        }

        const acumulado = [0];
        for (let i = 1; i < coordenadas.length; i++) {
            acumulado.push(acumulado[i - 1] +
                distanciaMetros(coordenadas[i - 1], coordenadas[i]));
        }
        const total = acumulado[acumulado.length - 1];
        const ultimoTrecho = etapas[etapas.length - 1].trecho;

        const manobras = [];
        let segmento = 0;
        for (const etapa of etapas) {
            const m = etapa && etapa.manobra;
            if (!m || !Array.isArray(m.localizacao)) {
                return { valido: false, motivo: 'Etapa sem localização da manobra.' };
            }
            const ponto = [m.localizacao[1], m.localizacao[0]];

            // Procura para frente: as manobras seguem a ordem da rota.
            let melhor = null;
            for (let i = segmento; i < coordenadas.length - 1; i++) {
                const p = projetarNoSegmento(ponto, coordenadas[i], coordenadas[i + 1]);
                if (p.distancia <= TOLERANCIA_MANOBRA_METROS &&
                    (melhor === null || p.distancia < melhor.distancia)) {
                    melhor = { segmento: i, t: p.t, distancia: p.distancia };
                } else if (melhor !== null) {
                    break;
                }
            }
            if (melhor === null) {
                return {
                    valido: false,
                    motivo: 'As etapas não correspondem à geometria da rota.'
                };
            }
            segmento = melhor.segmento;

            // Chegada/partida em ponto intermediário não é manobra ao volante.
            const intermediaria =
                (m.tipo === 'arrive' && etapa.trecho !== ultimoTrecho) ||
                (m.tipo === 'depart' && etapa.trecho !== 0);
            if (intermediaria) continue;

            const inicio = acumulado[melhor.segmento];
            const comprimento = acumulado[melhor.segmento + 1] - inicio;
            manobras.push({
                posicao: inicio + melhor.t * comprimento,
                etapa: etapa,
                texto: descrever(etapa),
                icone: icone(etapa),
                via: nomeVia(etapa)
            });
        }

        if (manobras[manobras.length - 1].etapa.manobra.tipo !== 'arrive') {
            return { valido: false, motivo: 'As etapas não terminam no destino.' };
        }

        return {
            valido: true,
            coordenadas: coordenadas,
            acumulado: acumulado,
            total: total,
            manobras: manobras
        };
    }

    // ---- Acompanhamento ----

    function criarAcompanhador(preparo) {
        if (!preparo || !preparo.valido) {
            const motivo = (preparo && preparo.motivo) ||
                'Instruções indisponíveis para esta rota.';
            return {
                atualizar: () => ({ estado: 'sem-dados', mensagem: motivo }),
                marcarSemSinal: () => ({ estado: 'sem-dados', mensagem: motivo }),
                estadoAtual: () => ({ estado: 'sem-dados', mensagem: motivo })
            };
        }

        const coordenadas = preparo.coordenadas;
        const acumulado = preparo.acumulado;
        const total = preparo.total;
        const manobras = preparo.manobras;

        let progresso = null;
        let ultimoTimestamp = null;
        let chegou = false;
        let recuo = null;
        let salto = null;
        let ultimo = { estado: 'aguardando', mensagem: 'Aguardando sinal do GPS.' };

        // Índice do segmento que contém a posição s ao longo da rota.
        function segmentoEm(s) {
            let baixo = 0;
            let alto = acumulado.length - 2;
            while (baixo < alto) {
                const meio = (baixo + alto + 1) >> 1;
                if (acumulado[meio] <= s) baixo = meio; else alto = meio - 1;
            }
            return baixo;
        }

        function projetar(posicao, sMin, sMax) {
            const primeiro = segmentoEm(Math.max(0, sMin));
            const ultimoSeg = segmentoEm(Math.min(total, sMax));
            let melhor = null;
            for (let i = primeiro; i <= ultimoSeg; i++) {
                const p = projetarNoSegmento(posicao, coordenadas[i], coordenadas[i + 1]);
                if (melhor === null || p.distancia < melhor.distancia) {
                    melhor = {
                        distancia: p.distancia,
                        posicao: acumulado[i] + p.t * (acumulado[i + 1] - acumulado[i])
                    };
                }
            }
            return melhor;
        }

        function resumo(estado, confiavel, extras) {
            if (progresso === null) {
                return Object.assign({ estado: estado }, extras);
            }
            // A partida (índice 0) descreve a via inicial, não é a próxima manobra.
            const indice = manobras.findIndex((m, i) =>
                i > 0 && m.posicao + MARGEM_PASSAGEM_METROS > progresso);
            const proxima = manobras[indice === -1 ? manobras.length - 1 : indice];
            const seguinte = indice === -1 ? null : manobras[indice + 1] || null;
            const atual = manobras[Math.max(0, (indice === -1 ? manobras.length : indice) - 1)];
            const distancia = Math.max(0, proxima.posicao - progresso);
            const restante = Math.max(0, total - progresso);

            let instrucao;
            if (chegou) {
                instrucao = 'Você chegou ao destino.';
            } else if (proxima.etapa.manobra.tipo === 'arrive') {
                instrucao = confiavel && restante <= AVISO_CHEGADA_METROS
                    ? 'Você está chegando ao destino.'
                    : 'Continue até o destino.';
            } else if (!confiavel) {
                instrucao = 'Próxima manobra: ' + proxima.texto + '.';
            } else if (distancia < ABAIXO_AGORA_METROS) {
                instrucao = 'Agora, ' + proxima.texto + '.';
            } else {
                instrucao = 'Em ' + formatarDistancia(distancia) + ', ' + proxima.texto + '.';
            }

            return Object.assign({
                estado: chegou ? 'chegou' : estado,
                indiceManobra: manobras.indexOf(proxima),
                icone: chegou ? '⚑' : proxima.icone,
                instrucao: instrucao,
                textoManobra: proxima.texto,
                // Sem leitura confiável não há número a mostrar.
                distanciaManobraMetros: confiavel && !chegou ? distancia : null,
                distanciaManobraTexto: confiavel && !chegou
                    ? formatarDistancia(distancia) : null,
                restanteMetros: confiavel ? restante : null,
                restanteTexto: confiavel ? formatarDistancia(restante) : null,
                viaAtual: atual.via,
                seguinte: seguinte && !chegou ? maiuscula(seguinte.texto) : null
            }, extras);
        }

        function guardar(resultado) {
            ultimo = resultado;
            return resultado;
        }

        function atualizar(leitura) {
            if (!leitura || typeof leitura.latitude !== 'number' ||
                typeof leitura.longitude !== 'number') {
                return ultimo;
            }
            if (leitura.timestamp === ultimoTimestamp) return ultimo;

            const precisao = leitura.precisao;
            if (!(precisao <= PRECISAO_MAXIMA_METROS)) {
                return guardar(resumo('precisao-baixa', false, {
                    mensagem: 'Precisão do GPS baixa: aguardando sinal melhor.'
                }));
            }

            const posicao = [leitura.latitude, leitura.longitude];
            const limite = LIMITE_FORA_ROTA_METROS + precisao;
            const intervalo = ultimoTimestamp === null ? 0 :
                Math.max(0, (leitura.timestamp - ultimoTimestamp) / 1000);
            ultimoTimestamp = leitura.timestamp;

            if (progresso === null) {
                const inicial = projetar(posicao, 0, total);
                if (inicial.distancia > limite) {
                    return guardar(resumo('fora-da-rota', false, {
                        mensagem: 'Você está longe desta rota; as instruções ' +
                            'começam quando estiver sobre ela.'
                    }));
                }
                progresso = inicial.posicao;
            } else {
                const avanco = Math.max(AVANCO_MINIMO_METROS,
                    VELOCIDADE_MAXIMA_MS * intervalo + precisao);
                const local = projetar(posicao,
                    progresso - RECUO_IGNORADO_METROS - precisao, progresso + avanco);

                if (local.distancia <= limite) {
                    salto = null;
                    if (local.posicao >= progresso) {
                        progresso = local.posicao;
                        recuo = 0;
                    } else if (progresso - local.posicao > RECUO_IGNORADO_METROS) {
                        // Retorno real pela rota: aceita após confirmação.
                        recuo = (recuo || 0) + 1;
                        if (recuo >= CONFIRMACOES_SALTO) {
                            progresso = local.posicao;
                            chegou = false;
                            recuo = 0;
                        }
                    } else {
                        recuo = 0;
                    }
                } else {
                    const global = projetar(posicao, 0, total);
                    if (global.distancia > limite) {
                        salto = null;
                        return guardar(resumo('fora-da-rota', false, {
                            mensagem: 'Você parece estar fora desta rota. ' +
                                'A última instrução foi mantida; a rota não é recalculada.'
                        }));
                    }
                    // Salto do GPS: só reposiciona se as leituras concordarem.
                    const coerente = salto !== null &&
                        Math.abs(global.posicao - salto.posicao) <=
                        AVANCO_MINIMO_METROS + VELOCIDADE_MAXIMA_MS * intervalo;
                    salto = {
                        posicao: global.posicao,
                        leituras: coerente ? salto.leituras + 1 : 1
                    };
                    if (salto.leituras < CONFIRMACOES_SALTO) {
                        return guardar(resumo('confirmando', false, {
                            mensagem: 'Posição mudou bruscamente; confirmando no GPS.'
                        }));
                    }
                    progresso = salto.posicao;
                    salto = null;
                    chegou = false;
                }
            }

            if (total - progresso <= RAIO_CHEGADA_METROS) chegou = true;

            return guardar(resumo('navegando', true, {
                mensagem: chegou ? 'Destino alcançado.' : ''
            }));
        }

        // Perda de sinal: mantém a última instrução, sem números.
        function marcarSemSinal() {
            if (progresso === null) return ultimo;
            return guardar(resumo('sem-sinal', false, {
                mensagem: 'Sinal de GPS perdido; última instrução mantida.'
            }));
        }

        return {
            atualizar: atualizar,
            marcarSemSinal: marcarSemSinal,
            estadoAtual: () => ultimo
        };
    }

    global.InstrucoesNavegacao = Object.freeze({
        preparar: preparar,
        criarAcompanhador: criarAcompanhador,
        etapasDeOsrm: etapasDeOsrm,
        descrever: descrever,
        formatarDistancia: formatarDistancia
    });
})(window);
