/* ============================================================
   simulation.js — anima um marcador percorrendo a rota
   ============================================================ */

App.sim = {
    marcador: null,
    timer: null,
    i: 0,

    toggle() {
        if (this.timer) {
            this.parar();
            return;
        }
        if (!App.estado.pontos.length) return;

        this.i = 0;
        App.dom.btnSim.classList.add("btn--active");

        this.marcador = L.circleMarker(App.estado.pontos[0], {
            radius: 7,
            color: "#fff",
            weight: 2,
            fillColor: App.mapa.corRota(),
            fillOpacity: 1,
        }).addTo(App.estado.mapa);

        // Passo proporcional ao tamanho da rota para manter fluidez.
        const passo = Math.max(1, Math.floor(App.estado.pontos.length / 400));
        this.timer = setInterval(() => {
            this.i += passo;
            if (this.i >= App.estado.pontos.length) {
                this.parar();
                return;
            }
            this.marcador.setLatLng(App.estado.pontos[this.i]);
        }, 60);
    },

    parar() {
        clearInterval(this.timer);
        this.timer = null;
        App.dom.btnSim.classList.remove("btn--active");
        if (this.marcador) {
            App.estado.mapa.removeLayer(this.marcador);
            this.marcador = null;
        }
    },
};
