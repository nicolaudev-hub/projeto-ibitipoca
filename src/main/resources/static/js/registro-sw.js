/**
 * Projeto Ibitipoca — registro do Service Worker
 *
 * Falhas no registro nunca impedem o uso online: apenas são informadas.
 *
 * Integração:
 * RegistroSW.registrar(aoAtualizar) -> Promise<{ estado, mensagem }>
 *   estado: 'indisponivel' | 'pronto' | 'erro'
 */
(function (global) {
    'use strict';

    function registrar(aoAtualizar) {
        const informar = typeof aoAtualizar === 'function'
            ? aoAtualizar
            : function () {};

        function concluir(estado, mensagem) {
            const resultado = { estado: estado, mensagem: mensagem };
            try {
                informar(resultado);
            } catch (erro) {
                console.error('Erro no callback do Service Worker:', erro);
            }
            return resultado;
        }

        const navegador = global.navigator;

        // Service Worker exige HTTPS (ou localhost) e um navegador compatível.
        if (!navegador || !('serviceWorker' in navegador) ||
            global.isSecureContext === false) {
            return Promise.resolve(concluir(
                'indisponivel',
                'Cópia offline indisponível: requer HTTPS e navegador compatível.'
            ));
        }

        return navegador.serviceWorker.register('./sw.js')
            .then(() => navegador.serviceWorker.ready)
            .then(() => concluir(
                'pronto',
                'Arquivos do aplicativo guardados neste aparelho.'
            ))
            .catch(erro => {
                console.warn('Falha ao registrar o Service Worker:', erro);
                return concluir(
                    'erro',
                    'Não foi possível preparar a cópia offline.'
                );
            });
    }

    global.RegistroSW = Object.freeze({ registrar: registrar });
})(window);
