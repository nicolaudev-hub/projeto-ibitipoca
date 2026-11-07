/**
 * Projeto Ibitipoca — ligação do visual novo (novo.html) à navegação
 *
 * Mesma lógica do script do index.html, adaptada ao DOM novo:
 * - um único mapa Leaflet, com os tiles locais de ./tiles/;
 * - um único watchPosition, o de NavegacaoGPS (navegacao.js);
 * - instruções (instrucoes.js), rota do parque (rota-parque.js),
 *   Circuito das Águas (circuito-aguas.js),
 *   download offline (download-mapa.js) e Service Worker (registro-sw.js).
 *
 * Dos módulos do visual novo usa apenas theme.js, sidebar.js e
 * simulation.js, que dependem de App.dom e App.estado preenchidos aqui.
 * app.js, gps.js e route.js não são carregados: criariam outro mapa,
 * outro GPS e usariam o servidor de tiles externo definido em config.js.
 */
(function () {
    'use strict';

    // Evita inicialização duplicada se o script for incluído duas vezes.
    if (window.NovoAppIniciado) return;
    window.NovoAppIniciado = true;

    const $ = id => document.getElementById(id);

    App.dom = {
        app: $('app'),
        sidebar: $('sidebar'),
        resizer: $('resizer'),
        status: $('status'),
        conexao: $('conexao'),
        distancia: $('distancia'),
        tempo: $('tempo'),
        gps: $('gps'),
        stepsWrap: $('steps-wrap'),
        stepsList: $('steps-list'),
        btnGps: $('btn-gps'),
        btnSim: $('btn-sim'),
        btnTema: $('btn-tema'),
        btnToggle: $('btn-toggle')
    };

    // ---- Status ----
    let mensagemRota = '';
    let mensagemMapa = '';
    let mensagemOffline = '';

    function atualizarStatus(erro) {
        App.dom.status.textContent = [mensagemRota, mensagemMapa, mensagemOffline]
            .filter(Boolean).join(' ');
        App.dom.status.classList.toggle('status--error', Boolean(erro));
    }

    // Registrado após o carregamento para não competir com a rota e os tiles.
    window.addEventListener('load', () => {
        window.RegistroSW.registrar(resultado => {
            mensagemOffline = resultado.mensagem;
            atualizarStatus();
        });
    });

    function atualizarConexao() {
        const online = navigator.onLine;
        App.dom.conexao.innerHTML =
            '<span class="dot ' + (online ? 'dot--on' : 'dot--off') + '"></span>' +
            (online ? 'Com conexão' : 'Sem conexão');
    }

    atualizarConexao();
    window.addEventListener('online', atualizarConexao);
    window.addEventListener('offline', atualizarConexao);

    // ---- Mapa (único) ----
    const mapa = L.map('mapa').setView([-21.764227, -43.350427], 10);
    App.estado.mapa = mapa;

    // O painel de instruções muda de altura conforme o texto; o Leaflet só
    // percebe redimensionamento da janela, então avisamos uma vez por quadro.
    if (typeof ResizeObserver === 'function') {
        let quadroPendente = false;
        new ResizeObserver(() => {
            if (quadroPendente) return;
            quadroPendente = true;
            requestAnimationFrame(() => {
                quadroPendente = false;
                mapa.invalidateSize({ animate: false });
            });
        }).observe(mapa.getContainer());
    }

    // Ícone com URLs relativas, sem L.Icon.Default (que duplicava o caminho).
    const iconeMarcador = L.icon({
        iconUrl: './leaflet/images/marker-icon.png',
        shadowUrl: './leaflet/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
    });

    let tilesCarregados = false;
    let falhasTiles = 0;
    let versaoTiles = '';

    function atualizarEstadoMapa() {
        if (falhasTiles > 0) {
            mensagemMapa = 'Não foi possível carregar ' + falhasTiles +
                ' tile(s) do mapa de fundo.';
        } else if (tilesCarregados) {
            mensagemMapa = 'Mapa de fundo local carregado (versão ' + versaoTiles + ').';
        }
        atualizarStatus();
    }

    // Tiles PNG gerados por scripts/gerar-tiles.mjs e servidos pela aplicação.
    fetch('./tiles/manifesto.json')
        .then(resposta => {
            if (!resposta.ok) throw new Error('Manifesto dos tiles indisponível.');
            return resposta.json();
        })
        .then(manifesto => {
            const [oeste, sul, leste, norte] = manifesto.limites;
            const cobertura = L.latLngBounds([sul, oeste], [norte, leste]);
            versaoTiles = manifesto.versao;

            // Um tile de 512 px no zoom z equivale ao zoom z + 1 do Leaflet.
            const camadaMapa = L.tileLayer('./tiles/{z}/{x}/{y}.png', {
                tileSize: manifesto.tamanhoTile,
                zoomOffset: -1,
                minZoom: 1,
                maxZoom: 15,
                maxNativeZoom: manifesto.zoomMax + 1,
                bounds: cobertura,
                attribution: manifesto.atribuicao
            });
            camadaMapa.on('tileload', () => {
                tilesCarregados = true;
                atualizarEstadoMapa();
            });
            camadaMapa.on('tileerror', () => {
                falhasTiles++;
                atualizarEstadoMapa();
            });
            camadaMapa.addTo(mapa);
        })
        .catch(erro => {
            console.error('Erro ao preparar o mapa de fundo:', erro);
            mensagemMapa = erro.message || 'Não foi possível carregar o mapa de fundo.';
            atualizarStatus();
        });

    // ---- Download do mapa para uso offline ----
    const offlineEstado = $('offline-estado');
    const offlineProgresso = $('offline-progresso');
    const offlineDetalhe = $('offline-detalhe');
    const botaoBaixar = $('offline-baixar');
    const botaoCancelar = $('offline-cancelar');

    function formatarMB(bytes) {
        return (bytes / 1048576).toLocaleString('pt-BR', {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1
        }) + ' MB';
    }

    function mostrarDownload(r) {
        const contagem = r.concluidos + ' de ' + r.total + ' tiles';
        const baixando = r.estado === 'baixando';
        let estado;
        let detalhe = '';
        let rotuloBotao = 'Continuar download';

        switch (r.estado) {
            case 'baixando':
                estado = 'Baixando mapa: ' + r.percentual + '% (' + contagem + ')';
                detalhe = formatarMB(r.bytesConcluidos) + ' de ' +
                    formatarMB(r.bytesTotais) + ' guardados; ' +
                    formatarMB(r.bytesTransferidos) + ' transferidos nesta sessão.';
                if (r.falhas.length) {
                    detalhe += ' ' + r.falhas.length + ' falha(s) até agora.';
                }
                break;
            case 'completo':
                estado = 'Mapa disponível offline (' + r.total + ' tiles, ' +
                    formatarMB(r.bytesTotais) + ').';
                detalhe = 'Versão ' + r.versao + '.';
                if (r.persistente === false) {
                    detalhe += ' O navegador não garantiu armazenamento permanente; ' +
                        'no iPhone, use o app adicionado à Tela de Início.';
                }
                rotuloBotao = 'Mapa offline completo';
                break;
            case 'incompleto':
                if (r.concluidos === 0) {
                    estado = 'Mapa offline ainda não baixado.';
                    rotuloBotao = 'Baixar mapa offline (' + formatarMB(r.bytesTotais) + ')';
                } else {
                    estado = 'Mapa offline incompleto: ' + contagem + '.';
                }
                break;
            case 'cancelado':
                estado = 'Download cancelado: ' + contagem + ' guardados.';
                break;
            case 'parcial':
            case 'espaco':
            case 'erro':
                estado = r.mensagem;
                if (r.total) detalhe = contagem + ' guardados.';
                rotuloBotao = r.concluidos ? 'Continuar download' : 'Tentar novamente';
                break;
            default:
                estado = r.mensagem || 'Mapa offline indisponível.';
        }

        offlineEstado.textContent = estado;
        offlineEstado.classList.toggle('completo', r.estado === 'completo');
        offlineEstado.classList.toggle('problema',
            ['parcial', 'espaco', 'erro', 'indisponivel'].includes(r.estado));
        offlineDetalhe.textContent = detalhe;
        offlineProgresso.hidden = !r.total;
        offlineProgresso.value = r.percentual || 0;
        botaoBaixar.hidden = baixando;
        botaoBaixar.textContent = rotuloBotao;
        botaoBaixar.disabled = r.estado === 'completo' || r.estado === 'indisponivel';
        botaoCancelar.hidden = !baixando;
        if (!baixando) {
            botaoCancelar.disabled = false;
            botaoCancelar.textContent = 'Cancelar';
        }
    }

    const downloadMapa = window.DownloadMapa.criar({ aoProgresso: mostrarDownload });

    botaoBaixar.addEventListener('click', () => {
        botaoBaixar.disabled = true;
        downloadMapa.baixar();
    });

    botaoCancelar.addEventListener('click', () => {
        botaoCancelar.disabled = true;
        botaoCancelar.textContent = 'Cancelando...';
        downloadMapa.cancelar();
    });

    downloadMapa.verificar().then(resultado => {
        // Não sobrescreve o progresso se o usuário já iniciou o download.
        if (!downloadMapa.emAndamento()) mostrarDownload(resultado);
    });

    // ---- Instruções passo a passo ----
    // Usam as leituras que navegacao.js já entrega; não abrem outro GPS.
    const painelInstrucoes = $('painel-instrucoes');
    const instrIcone = $('instr-icone');
    const instrDestino = $('instr-destino');
    const instrTexto = $('instr-texto');
    const instrDistancia = $('instr-distancia');
    const instrRestante = $('instr-restante');
    const instrSeguinte = $('instr-seguinte');
    const instrAviso = $('instr-aviso');
    const instrAnuncio = $('instr-anuncio');
    const stepsTitulo = $('steps-titulo');

    let ultimaLeituraGPS = null;
    let acompanhadorPrincipal = null;
    let preparoPrincipal = null;
    let acompanhadorParque = null;
    let preparoParque = null;
    let rotaDoAcompanhadorParque = null;
    let acompanhadorDestino = null;
    let preparoDestino = null;
    let rotaDoAcompanhadorDestino = null;
    let motivoSemInstrucoes = 'Carregando instruções...';
    let preparoDaLista = null;
    let indiceDestacado = -1;

    // Prioridade das instruções: destino escolhido > parque > rota principal.
    function acompanhadorAtivo() {
        return acompanhadorDestino || acompanhadorParque || acompanhadorPrincipal;
    }

    function preparoAtivo() {
        if (acompanhadorDestino) return preparoDestino;
        return acompanhadorParque ? preparoParque : preparoPrincipal;
    }

    function tituloInstrucoes() {
        if (acompanhadorDestino) {
            return 'Instruções até ' + rotaDoAcompanhadorDestino.destino.nome;
        }
        return acompanhadorParque
            ? 'Instruções até a portaria do parque'
            : 'Instruções até o chalé';
    }

    function maiuscula(texto) {
        return texto.charAt(0).toUpperCase() + texto.slice(1);
    }

    // Lista das manobras da rota ativa; tocar numa delas mostra o ponto.
    function montarLista() {
        const preparo = preparoAtivo();
        if (preparo === preparoDaLista) return;
        preparoDaLista = preparo;
        indiceDestacado = -1;
        App.dom.stepsList.textContent = '';
        App.estado.stepEls = [];

        if (!preparo || !preparo.valido) {
            App.dom.stepsWrap.hidden = true;
            return;
        }

        stepsTitulo.textContent = tituloInstrucoes();

        preparo.manobras.forEach((manobra, i) => {
            const [lon, lat] = manobra.etapa.manobra.localizacao;
            const seguinte = preparo.manobras[i + 1];

            const li = document.createElement('li');
            li.className = 'step';
            li.tabIndex = 0;
            li.setAttribute('role', 'button');

            const icone = document.createElement('span');
            icone.className = 'step__icon';
            icone.textContent = manobra.icone;
            const corpo = document.createElement('span');
            corpo.className = 'step__body';
            const texto = document.createElement('span');
            texto.className = 'step__text';
            texto.textContent = maiuscula(manobra.texto);
            const meta = document.createElement('span');
            meta.className = 'step__meta';
            meta.textContent = seguinte
                ? 'Trecho de ' + window.InstrucoesNavegacao.formatarDistancia(
                    seguinte.posicao - manobra.posicao)
                : 'Destino';
            corpo.append(texto, meta);
            li.append(icone, corpo);

            // Só aproxima o mapa: o acompanhamento do GPS segue as regras de
            // navegacao.js (arrastar pausa; "Localização" retoma).
            const mostrar = () => mapa.setView([lat, lon], Math.max(mapa.getZoom(), 15));
            li.addEventListener('click', mostrar);
            li.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    mostrar();
                }
            });

            App.dom.stepsList.appendChild(li);
            App.estado.stepEls.push(li);
        });

        App.dom.stepsWrap.hidden = false;
    }

    function destacarManobra(indice) {
        if (typeof indice !== 'number' || indice === indiceDestacado) return;
        const anterior = App.estado.stepEls[indiceDestacado];
        if (anterior) anterior.classList.remove('step--active');
        indiceDestacado = indice;
        const atual = App.estado.stepEls[indice];
        if (atual) {
            atual.classList.add('step--active');
            atual.setAttribute('aria-current', 'step');
            if (anterior) anterior.removeAttribute('aria-current');
        }
    }

    function mostrarInstrucoes(r) {
        painelInstrucoes.classList.toggle('destino', acompanhadorDestino !== null);
        painelInstrucoes.classList.toggle('parque',
            acompanhadorDestino === null && acompanhadorParque !== null);
        instrDestino.textContent = tituloInstrucoes();
        montarLista();

        if (!r) {
            instrIcone.textContent = '…';
            instrTexto.textContent = motivoSemInstrucoes;
            instrDistancia.textContent = '';
            instrRestante.textContent = '';
            instrSeguinte.textContent = '';
            instrAviso.textContent = '';
            return;
        }

        instrIcone.textContent = r.icone || '…';
        instrTexto.textContent = r.instrucao || r.mensagem || '';
        instrDistancia.textContent = r.instrucao && r.estado !== 'chegou'
            ? 'Manobra: ' + (r.distanciaManobraTexto || '—') : '';
        instrRestante.textContent = r.instrucao
            ? 'Destino: ' + (r.restanteTexto || '—') : '';
        instrSeguinte.textContent = r.seguinte ? 'Depois: ' + r.seguinte : '';
        instrAviso.textContent = r.instrucao ? (r.mensagem || '') : '';
        painelInstrucoes.classList.toggle('alerta',
            ['fora-da-rota', 'sem-sinal', 'confirmando'].includes(r.estado));
        destacarManobra(r.indiceManobra);

        // Anuncia só quando a manobra muda, não a cada metro.
        const anuncio = r.textoManobra || r.mensagem || '';
        if (instrAnuncio.textContent !== anuncio) instrAnuncio.textContent = anuncio;
    }

    function alimentarInstrucoes() {
        const acompanhador = acompanhadorAtivo();
        if (!acompanhador) {
            mostrarInstrucoes(null);
            return;
        }
        try {
            mostrarInstrucoes(ultimaLeituraGPS
                ? acompanhador.atualizar(ultimaLeituraGPS)
                : acompanhador.estadoAtual());
        } catch (erro) {
            console.error('Erro ao atualizar as instruções:', erro);
        }
    }

    // Etapas do OSRM guardadas à parte; a rota principal não é alterada.
    const etapasPrincipal = fetch('./data/etapas_rota_principal.json')
        .then(resposta => {
            if (!resposta.ok) throw new Error('arquivo de etapas indisponível');
            return resposta.json();
        })
        .catch(erro => ({ erro: erro }));

    function prepararInstrucoesPrincipal(rota, coordenadas) {
        etapasPrincipal.then(dados => {
            if (dados.erro || dados.formato !== 'ibitipoca-etapas-v1') {
                throw new Error('Instruções indisponíveis: arquivo de etapas não carregado.');
            }
            // Etapas geradas para outra rota não são usadas.
            if (Math.abs(dados.rota.distancia - rota.distance) > 1) {
                throw new Error('Instruções indisponíveis: as etapas são de outra rota.');
            }
            const preparo = window.InstrucoesNavegacao.preparar(dados.etapas, coordenadas);
            if (!preparo.valido) throw new Error('Instruções indisponíveis: ' + preparo.motivo);
            preparoPrincipal = preparo;
            acompanhadorPrincipal = window.InstrucoesNavegacao.criarAcompanhador(preparo);
            alimentarInstrucoes();
        }).catch(erro => {
            console.warn(erro);
            motivoSemInstrucoes = erro.message;
            alimentarInstrucoes();
        });
    }

    // ---- Rota opcional até o parque ----
    const parqueEstado = $('parque-estado');
    const parqueDetalhe = $('parque-detalhe');
    const parqueCalcular = $('parque-calcular');
    const opcoesParque = document.querySelectorAll('input[name="rota-parque"]');

    function descreverRotaParque(rota, recalculadaAgora) {
        const quando = new Date(rota.criadaEm).toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        });
        let texto = (rota.distancia / 1000).toFixed(1).replace('.', ',') + ' km, cerca de ' +
            Math.max(1, Math.round(rota.duracao / 60)) + ' min. Calculada em ' + quando +
            ' a partir de ' + rota.origem.latitude.toFixed(5) + ', ' +
            rota.origem.longitude.toFixed(5) + '.';
        if (!recalculadaAgora) {
            texto += ' Rota salva: não foi recalculada a partir da posição atual.';
        }
        if (ultimaLeituraGPS) {
            const afastamento = window.NavegacaoGPS.distanciaMetros(
                [ultimaLeituraGPS.latitude, ultimaLeituraGPS.longitude],
                [rota.origem.latitude, rota.origem.longitude]);
            if (afastamento > 300) {
                texto += ' Você está a ' + window.InstrucoesNavegacao
                    .formatarDistancia(afastamento) + ' do ponto de origem dela.';
            }
        }
        if (!rota.etapas.length) texto += ' Esta rota não tem etapas de navegação.';
        return texto;
    }

    function mostrarParque(e) {
        const problema = ['erro', 'sem-rede', 'aguardando-gps'].includes(e.estado);
        parqueEstado.classList.toggle('problema', problema);
        parqueCalcular.hidden = !e.ativa;
        parqueCalcular.disabled = e.estado === 'calculando';

        if (!e.ativa) {
            parqueEstado.textContent = '';
            parqueDetalhe.textContent = '';
        } else {
            parqueEstado.textContent = e.mensagem;
            parqueDetalhe.textContent = e.rota
                ? descreverRotaParque(e.rota, e.estado === 'pronta' && e.recalculadaAgora)
                : '';
        }

        // As instruções seguem a rota do parque enquanto ela estiver exibida.
        const rota = e.ativa ? e.rota : null;
        if (rota !== rotaDoAcompanhadorParque) {
            rotaDoAcompanhadorParque = rota;
            acompanhadorParque = null;
            preparoParque = null;
            if (rota) {
                const coordenadasParque = rota.coordenadas.map(([lon, lat]) => [lat, lon]);
                preparoParque = window.InstrucoesNavegacao.preparar(rota.etapas, coordenadasParque);
                acompanhadorParque = window.InstrucoesNavegacao.criarAcompanhador(preparoParque);
            }
            alimentarInstrucoes();
        }
    }

    let rotaParque = null;
    try {
        rotaParque = window.RotaParque.criar({
            mapa: mapa,
            obterPosicao: () => ultimaLeituraGPS && {
                latitude: ultimaLeituraGPS.latitude,
                longitude: ultimaLeituraGPS.longitude,
                precisao: ultimaLeituraGPS.precisao,
                timestamp: ultimaLeituraGPS.recebidaEm
            },
            aoMudar: mostrarParque
        });
    } catch (erroParque) {
        console.error('Rota do parque indisponível:', erroParque);
        parqueEstado.textContent = 'Rota do parque indisponível nesta página.';
    }

    opcoesParque.forEach(opcao => opcao.addEventListener('change', () => {
        if (!rotaParque || !opcao.checked) return;
        if (opcao.value === 'sim') rotaParque.ativar();
        else rotaParque.desativar();
    }));

    parqueCalcular.addEventListener('click', () => {
        if (rotaParque) rotaParque.calcular();
    });

    // ---- Destino livre: rota da posição atual até o destino escolhido ----
    const formBusca = $('destino-busca');
    const campoBusca = $('destino-texto');
    const botaoBuscar = $('destino-buscar');
    const buscaEstado = $('destino-busca-estado');
    const listaResultados = $('destino-resultados');
    const botaoEscolherNoMapa = $('destino-mapa');
    const destinoEstado = $('destino-estado');
    const destinoDetalhe = $('destino-detalhe');
    const destinoCalcular = $('destino-calcular');
    const destinoLimpar = $('destino-limpar');

    function mostrarDestino(e) {
        const problema = ['erro', 'sem-rede', 'aguardando-gps', 'fora-da-cobertura']
            .includes(e.estado);
        destinoEstado.classList.toggle('problema', problema);
        destinoEstado.textContent = e.mensagem;
        destinoDetalhe.textContent = e.rota
            ? descreverRotaParque(e.rota, e.estado === 'pronta' && e.recalculadaAgora)
            : '';
        destinoCalcular.hidden = !e.destino;
        destinoCalcular.disabled = e.estado === 'calculando';
        destinoCalcular.textContent = e.rota ? 'Recalcular rota' : 'Calcular rota';
        destinoLimpar.hidden = !e.destino;

        // As instruções seguem a rota do destino enquanto ela existir.
        const rota = e.rota || null;
        if (rota !== rotaDoAcompanhadorDestino) {
            rotaDoAcompanhadorDestino = rota;
            acompanhadorDestino = null;
            preparoDestino = null;
            if (rota) {
                const coordenadasDestino = rota.coordenadas.map(([lon, lat]) => [lat, lon]);
                preparoDestino = window.InstrucoesNavegacao.preparar(rota.etapas, coordenadasDestino);
                acompanhadorDestino = window.InstrucoesNavegacao.criarAcompanhador(preparoDestino);
            }
            alimentarInstrucoes();
        }
    }

    let rotaDestino = null;
    let buscaDestino = null;
    try {
        rotaDestino = window.RotaDestino.criar({
            mapa: mapa,
            obterPosicao: () => ultimaLeituraGPS && {
                latitude: ultimaLeituraGPS.latitude,
                longitude: ultimaLeituraGPS.longitude,
                precisao: ultimaLeituraGPS.precisao,
                timestamp: ultimaLeituraGPS.recebidaEm
            },
            aoMudar: mostrarDestino
        });
        buscaDestino = window.BuscaDestino.criar();
        // Sem internet, a última rota calculada continua disponível.
        rotaDestino.restaurar();
    } catch (erroDestino) {
        console.error('Escolha de destino indisponível:', erroDestino);
        destinoEstado.textContent = 'Escolha de destino indisponível nesta página.';
    }

    function escolherDestino(destino) {
        if (!rotaDestino) return;
        listaResultados.hidden = true;
        listaResultados.textContent = '';
        buscaEstado.textContent = '';
        rotaDestino.definirDestino(destino);
    }

    function mostrarResultados(r) {
        buscaEstado.textContent = r.mensagem;
        buscaEstado.classList.toggle('problema', r.estado === 'erro' || r.estado === 'sem-rede');
        listaResultados.textContent = '';
        r.resultados.forEach(resultado => {
            const item = document.createElement('li');
            const botao = document.createElement('button');
            botao.type = 'button';
            botao.className = 'destino-resultado';
            const nome = document.createElement('span');
            nome.className = 'destino-resultado__nome';
            nome.textContent = resultado.nome;
            const descricao = document.createElement('span');
            descricao.className = 'destino-resultado__descricao';
            descricao.textContent = resultado.descricao;
            botao.append(nome, descricao);
            botao.addEventListener('click', () => escolherDestino(resultado));
            item.appendChild(botao);
            listaResultados.appendChild(item);
        });
        listaResultados.hidden = r.resultados.length === 0;
    }

    formBusca.addEventListener('submit', evento => {
        evento.preventDefault();
        if (!buscaDestino) return;
        botaoBuscar.disabled = true;
        buscaEstado.classList.remove('problema');
        buscaEstado.textContent = 'Buscando...';
        buscaDestino.buscar(campoBusca.value)
            .then(mostrarResultados)
            .finally(() => { botaoBuscar.disabled = false; });
    });

    // "Escolher no mapa": o próximo toque no mapa define o destino.
    let escolhendoNoMapa = false;
    function definirModoMapa(ligado) {
        escolhendoNoMapa = ligado;
        botaoEscolherNoMapa.setAttribute('aria-pressed', String(ligado));
        botaoEscolherNoMapa.classList.toggle('btn--active', ligado);
        botaoEscolherNoMapa.textContent = ligado
            ? 'Toque no mapa para marcar o destino (cancelar)'
            : 'Escolher no mapa';
        document.body.classList.toggle('escolhendo-destino', ligado);
    }

    botaoEscolherNoMapa.addEventListener('click', () => definirModoMapa(!escolhendoNoMapa));

    mapa.on('click', evento => {
        if (!escolhendoNoMapa) return;
        definirModoMapa(false);
        escolherDestino({
            latitude: evento.latlng.lat,
            longitude: evento.latlng.lng,
            nome: 'Ponto escolhido no mapa'
        });
    });

    destinoCalcular.addEventListener('click', () => {
        if (rotaDestino) rotaDestino.calcular();
    });

    destinoLimpar.addEventListener('click', () => {
        if (rotaDestino) rotaDestino.limpar();
        definirModoMapa(false);
    });

    // ---- Circuito das Águas (opcional) ----
    const circuitoEstado = $('circuito-estado');
    const opcoesCircuito = document.querySelectorAll('input[name="circuito-aguas"]');

    let circuitoAguas = null;
    try {
        circuitoAguas = window.CircuitoAguas.criar({
            mapa: mapa,
            aoMudar: e => {
                circuitoEstado.textContent = e.mensagem;
                circuitoEstado.classList.toggle('problema', e.estado === 'erro');
            }
        });
    } catch (erroCircuito) {
        console.error('Circuito das Águas indisponível:', erroCircuito);
        circuitoEstado.textContent = 'Circuito das Águas indisponível nesta página.';
    }

    opcoesCircuito.forEach(opcao => opcao.addEventListener('change', () => {
        if (!circuitoAguas || !opcao.checked) return;
        if (opcao.value === 'sim') circuitoAguas.ativar();
        else circuitoAguas.desativar();
    }));

    // ---- Controles do visual novo ----
    App.tema.init();
    App.sidebar.init();
    App.dom.btnSim.addEventListener('click', () => App.sim.toggle());

    // "Localização" aciona o botão "Centralizar" do próprio navegacao.js,
    // que retoma o acompanhamento; não abre outro GPS.
    App.dom.btnGps.addEventListener('click', () => {
        const centralizar = mapa.getContainer().querySelector('.botao-centralizar');
        if (centralizar) centralizar.click();
    });

    // ---- Rota principal e GPS ----
    fetch('./data/rota_navegacao_offline.json')
        .then(resposta => {
            if (!resposta.ok) {
                throw new Error('Não foi possível carregar o arquivo da rota.');
            }
            return resposta.json();
        })
        .then(dados => {
            if (dados.code !== 'Ok' || !dados.routes?.length) {
                throw new Error('O arquivo não contém uma rota válida.');
            }

            const rota = dados.routes[0];

            if (!rota.geometry?.coordinates?.length) {
                throw new Error('A rota não possui coordenadas.');
            }

            // OSRM: [longitude, latitude]. Leaflet: [latitude, longitude].
            const coordenadas = rota.geometry.coordinates.map(
                ([longitude, latitude]) => [latitude, longitude]
            );
            App.estado.pontos = coordenadas;

            const linhaRota = L.polyline(coordenadas, {
                color: App.mapa.corRota(),
                weight: 5,
                opacity: 0.95
            }).addTo(mapa);
            // theme.js recolore App.rota.linha ao trocar o tema.
            App.rota = { linha: linhaRota };

            L.marker(coordenadas[0], { icon: iconeMarcador })
                .addTo(mapa)
                .bindPopup('Início da rota');
            L.marker(coordenadas[coordenadas.length - 1], { icon: iconeMarcador })
                .addTo(mapa)
                .bindPopup('Fim da rota');

            mapa.fitBounds(linhaRota.getBounds(), { padding: [20, 20], maxZoom: 13 });

            App.dom.distancia.textContent = App.util.km(rota.distance);
            App.dom.tempo.textContent = App.util.tempo(rota.duration);
            mensagemRota = 'Rota carregada: ' + App.dom.distancia.textContent +
                ' · ' + App.dom.tempo.textContent + ' estimados pelo OSRM.';
            atualizarStatus();

            prepararInstrucoesPrincipal(rota, coordenadas);

            const cartaoGPS = $('cartao-gps');
            try {
                window.NavegacaoGPS.iniciar({
                    mapa: mapa,
                    coordenadas: coordenadas,
                    aoAtualizar: function (dados) {
                        const mensagens = {
                            aguardando: 'Aguardando permissão e sinal...',
                            indisponivel: 'GPS indisponível neste navegador.',
                            erro: dados.mensagem || 'Erro ao obter localização.',
                            ativo: dados.precisaoInsuficiente
                                ? 'GPS ativo (precisão baixa)'
                                : 'GPS ativo',
                            desvio: 'ATENÇÃO: possível desvio da rota!'
                        };

                        let texto = mensagens[dados.estado] ||
                            dados.mensagem ||
                            'Estado GPS desconhecido';
                        if (dados.estado === 'indisponivel' && dados.mensagem) {
                            texto = dados.mensagem;
                        }
                        if (typeof dados.precisaoMetros === 'number') {
                            texto += ' | Precisão: ±' + Math.round(dados.precisaoMetros) + ' m';
                        }
                        if (typeof dados.distanciaRotaMetros === 'number') {
                            texto += ' | Distância da rota: ' +
                                Math.round(dados.distanciaRotaMetros) + ' m';
                        }

                        App.dom.gps.textContent = texto;
                        cartaoGPS.classList.toggle('alerta', dados.estado === 'desvio');
                        App.dom.gps.setAttribute('aria-live',
                            dados.estado === 'desvio' || dados.estado === 'erro'
                                ? 'assertive' : 'polite');

                        if (typeof dados.latitude === 'number') {
                            ultimaLeituraGPS = {
                                latitude: dados.latitude,
                                longitude: dados.longitude,
                                precisao: dados.precisaoMetros,
                                timestamp: dados.timestamp,
                                recebidaEm: Date.now()
                            };
                            alimentarInstrucoes();
                        } else if (dados.estado === 'erro' && acompanhadorAtivo()) {
                            mostrarInstrucoes(acompanhadorAtivo().marcarSemSinal());
                        }
                    }
                });
            } catch (erroGPS) {
                App.dom.gps.textContent = 'Não foi possível iniciar o GPS: ' + erroGPS.message;
                console.error('Falha ao iniciar o GPS:', erroGPS);
            }
        })
        .catch(erro => {
            console.error('Erro ao carregar a rota:', erro);
            mensagemRota = 'Erro ao carregar a rota: ' + erro.message +
                ' Verifique se a aplicação Java está em execução.';
            atualizarStatus(true);
        });
})();
