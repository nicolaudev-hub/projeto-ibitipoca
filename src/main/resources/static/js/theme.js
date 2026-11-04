/* ============================================================
   theme.js — alternância de tema claro/escuro.
   Como o tema agora afeta o mapa inteiro (fundo + cores),
   ao trocar recolorimos a rota e o marcador de GPS.
   ============================================================ */

App.tema = {
    aplicar(claro) {
        document.body.classList.toggle("light", claro);
        try {
            localStorage.setItem("tema", claro ? "light" : "dark");
        } catch (_) {}
        this.recolorir();
    },

    /* Reaplica as cores dependentes do tema nos elementos do mapa. */
    recolorir() {
        if (App.rota && App.rota.linha) {
            App.rota.linha.setStyle({ color: App.mapa.corRota() });
        }
        if (App.gps && App.gps.marcador) {
            App.gps.marcador.setStyle({ fillColor: App.mapa.corGps() });
        }
    },

    init() {
        let salvo = "dark";
        try {
            salvo = localStorage.getItem("tema") || "dark";
        } catch (_) {}
        document.body.classList.toggle("light", salvo === "light");

        App.dom.btnTema.addEventListener("click", () =>
            this.aplicar(!document.body.classList.contains("light"))
        );
    },
};
