/* ============================================================
   util.js — formatação, geometria e ícones de manobra
   ============================================================ */

App.util = {
    km(metros) {
        return (metros / 1000).toFixed(2).replace(".", ",") + " km";
    },

    distanciaCurta(metros) {
        return metros >= 1000
            ? (metros / 1000).toFixed(1).replace(".", ",") + " km"
            : Math.round(metros) + " m";
    },

    tempo(segundos) {
        const min = Math.round(segundos / 60);
        const h = Math.floor(min / 60);
        const m = min % 60;
        return h > 0 ? `${h} h ${m} min` : `${m} min`;
    },

    /* Distância aproximada entre [lat,lng] em metros (Haversine). */
    metros(a, b) {
        const R = 6371000;
        const rad = (x) => (x * Math.PI) / 180;
        const dLat = rad(b[0] - a[0]);
        const dLng = rad(b[1] - a[1]);
        const s =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a[0])) *
                Math.cos(rad(b[0])) *
                Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
    },

    /* Ícone (seta/símbolo) a partir do maneuver do OSRM. */
    iconeManobra(m) {
        if (m.type === "depart") return "◉";
        if (m.type === "arrive") return "⚑";
        if (m.type === "roundabout" || m.type === "rotary") return "⟳";
        switch (m.modifier) {
            case "left":
            case "slight left":
            case "sharp left":
                return "↰";
            case "right":
            case "slight right":
            case "sharp right":
                return "↱";
            case "uturn":
                return "⤶";
            default:
                return "↑";
        }
    },

    /* Texto legível em PT-BR a partir de um step do OSRM. */
    textoManobra(step) {
        const m = step.maneuver;
        const via = step.name && step.name !== "" ? step.name : "via sem nome";
        if (m.type === "depart") return `Saia por ${via}`;
        if (m.type === "arrive") return "Chegada ao destino";
        const dir = {
            left: "à esquerda",
            right: "à direita",
            "slight left": "levemente à esquerda",
            "slight right": "levemente à direita",
            "sharp left": "fechada à esquerda",
            "sharp right": "fechada à direita",
            straight: "em frente",
            uturn: "retorno",
        }[m.modifier];
        return dir ? `Vire ${dir} em ${via}` : `Siga por ${via}`;
    },
};
