/* ============================================================
   map.js — criação e configuração do mapa Leaflet
   ============================================================ */

App.mapa = {
    criar() {
        const mapa = L.map("mapa", { zoomControl: true }).setView(
            App.CONFIG.centro,
            App.CONFIG.zoomInicial
        );

        L.tileLayer(App.CONFIG.tiles, {
            minZoom: 0,
            maxZoom: 14,
            attribution:
                "&copy; OpenStreetMap contributors &copy; OpenMapTiles",
        }).addTo(mapa);

        L.Icon.Default.mergeOptions({
            imagePath: "/leaflet/images/",
            iconUrl: "marker-icon.png",
            iconRetinaUrl: "marker-icon.png",
            shadowUrl: "marker-shadow.png",
        });

        App.estado.mapa = mapa;
        return mapa;
    },

    /* Cor atual da rota a partir do tema (CSS var). */
    corRota() {
        return (
            getComputedStyle(document.body)
                .getPropertyValue("--route")
                .trim() || "#6ee7b7"
        );
    },

    corGps() {
        return (
            getComputedStyle(document.body)
                .getPropertyValue("--gps")
                .trim() || "#5b8cff"
        );
    },
};
