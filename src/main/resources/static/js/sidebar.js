/* ============================================================
   sidebar.js — redimensionamento arrastável + toggle mobile
   Arrasta o .resizer para ajustar --sidebar-w (persistido).
   Também suporta teclado (setas) por acessibilidade.
   ============================================================ */

App.sidebar = {
    init() {
        const app = App.dom.app;
        const resizer = App.dom.resizer;

        // Restaura largura salva.
        try {
            const salvo = localStorage.getItem("sidebarW");
            if (salvo) app.style.setProperty("--sidebar-w", salvo + "px");
        } catch (_) {}

        const limites = () => {
            const cs = getComputedStyle(app);
            return {
                min: parseInt(cs.getPropertyValue("--sidebar-min")) || 280,
                max: parseInt(cs.getPropertyValue("--sidebar-max")) || 560,
            };
        };

        const aplicar = (px) => {
            const { min, max } = limites();
            const w = Math.min(max, Math.max(min, px));
            app.style.setProperty("--sidebar-w", w + "px");
            if (App.estado.mapa) App.estado.mapa.invalidateSize();
            return w;
        };

        const salvar = (w) => {
            try {
                localStorage.setItem("sidebarW", String(w));
            } catch (_) {}
        };

        // ---- Arrasto com mouse/touch ----
        let arrastando = false;

        const mover = (clientX) => {
            const left = app.getBoundingClientRect().left;
            aplicar(clientX - left);
        };

        const onDown = (e) => {
            arrastando = true;
            resizer.classList.add("is-active");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        };

        const onMove = (e) => {
            if (!arrastando) return;
            const x = e.touches ? e.touches[0].clientX : e.clientX;
            mover(x);
        };

        const onUp = () => {
            if (!arrastando) return;
            arrastando = false;
            resizer.classList.remove("is-active");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            const w = parseInt(
                getComputedStyle(app).getPropertyValue("--sidebar-w")
            );
            salvar(w);
        };

        resizer.addEventListener("mousedown", onDown);
        resizer.addEventListener("touchstart", onDown, { passive: false });
        window.addEventListener("mousemove", onMove);
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("mouseup", onUp);
        window.addEventListener("touchend", onUp);

        // ---- Teclado (acessibilidade) ----
        resizer.addEventListener("keydown", (e) => {
            const atual = parseInt(
                getComputedStyle(app).getPropertyValue("--sidebar-w")
            );
            if (e.key === "ArrowLeft") salvar(aplicar(atual - 16));
            else if (e.key === "ArrowRight") salvar(aplicar(atual + 16));
        });

        // ---- Toggle mobile ----
        App.dom.btnToggle.addEventListener("click", () => {
            app.classList.toggle("sidebar-collapsed");
            if (App.estado.mapa) {
                setTimeout(() => App.estado.mapa.invalidateSize(), 200);
            }
        });
    },
};
