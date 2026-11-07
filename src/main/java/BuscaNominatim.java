import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * /api/buscar?q=texto — busca de destinos no Nominatim (OpenStreetMap).
 *
 * As buscas passam pelo servidor, e não direto do navegador, para cumprir a
 * política de uso do Nominatim público
 * (https://operations.osmfoundation.org/policies/nominatim/):
 * - no máximo 1 requisição por segundo para o app inteiro, não por usuário;
 * - identificação do app no User-Agent;
 * - resultados guardados em cache, sem repetir buscas iguais.
 *
 * A busca fica restrita à região Sudeste (a área coberta pelas rotas). O
 * endereço do serviço vem de NOMINATIM_URL (padrão: o Nominatim público).
 */
public final class BuscaNominatim {

    static final String USER_AGENT =
            "OffGrid/0.2 (+https://github.com/nicolaudev-hub/projeto-ibitipoca)";

    // Caixa da região Sudeste no formato do Nominatim: oeste,norte,leste,sul.
    static final String VIEWBOX_SUDESTE = "-53.11,-14.23,-39.67,-25.32";

    private static final int TAMANHO_MINIMO = 3;
    private static final int TAMANHO_MAXIMO = 120;
    private static final long INTERVALO_NANOS = Duration.ofMillis(1100).toNanos();
    // Quem teria de esperar mais que isso na fila recebe 429 em vez de esperar.
    private static final long ESPERA_MAXIMA_NANOS = Duration.ofSeconds(5).toNanos();
    private static final int ITENS_CACHE = 500;
    private static final long VALIDADE_CACHE_NANOS = Duration.ofHours(24).toNanos();

    private static final HttpClient CLIENTE = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    private record Guardada(byte[] corpo, long guardadaEm) { }

    private final String base;
    private final Object travaIntervalo = new Object();
    private long proximaLiberada = System.nanoTime();
    private final Map<String, Guardada> cache = new LinkedHashMap<>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Guardada> mais) {
            return size() > ITENS_CACHE;
        }
    };

    private BuscaNominatim(String base) {
        this.base = base.replaceAll("/+$", "");
    }

    static BuscaNominatim doAmbiente() {
        return new BuscaNominatim(System.getenv().getOrDefault(
                "NOMINATIM_URL", "https://nominatim.openstreetmap.org"));
    }

    void atender(HttpExchange requisicao) throws IOException {
        try {
            if (!requisicao.getRequestMethod().equals("GET")) {
                requisicao.getResponseHeaders().set("Allow", "GET");
                requisicao.sendResponseHeaders(405, -1);
                return;
            }

            String texto = parametro(requisicao.getRequestURI().getRawQuery(), "q");
            texto = texto == null ? "" : texto.strip().replaceAll("\\s+", " ");
            if (texto.length() < TAMANHO_MINIMO || texto.length() > TAMANHO_MAXIMO) {
                ProxyOsrm.responderErro(requisicao, 400, "InvalidQuery",
                        "Digite de " + TAMANHO_MINIMO + " a " + TAMANHO_MAXIMO + " caracteres.");
                return;
            }

            String chave = texto.toLowerCase(Locale.ROOT);
            byte[] guardado = lerCache(chave);
            if (guardado != null) {
                responder(requisicao, guardado, "HIT");
                return;
            }

            long espera = reservarVez();
            if (espera < 0) {
                requisicao.getResponseHeaders().set("Retry-After", "5");
                ProxyOsrm.responderErro(requisicao, 429, "TooManyRequests",
                        "Muitas buscas ao mesmo tempo. Tente de novo em alguns segundos.");
                return;
            }
            if (espera > 0) {
                Thread.sleep(Duration.ofNanos(espera));
            }

            HttpRequest pedido = HttpRequest.newBuilder(URI.create(base + "/search?format=jsonv2"
                            + "&limit=8&countrycodes=br&bounded=1&viewbox=" + VIEWBOX_SUDESTE
                            + "&accept-language=pt-BR&q=" + URLEncoder.encode(texto, StandardCharsets.UTF_8)))
                    .timeout(Duration.ofSeconds(10))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .GET()
                    .build();

            HttpResponse<byte[]> resposta = CLIENTE.send(pedido, HttpResponse.BodyHandlers.ofByteArray());
            if (resposta.statusCode() != 200) {
                ProxyOsrm.responderErro(requisicao, 502, "SearchError",
                        "O serviço de busca respondeu com erro (HTTP " + resposta.statusCode() + ").");
                return;
            }
            guardarCache(chave, resposta.body());
            responder(requisicao, resposta.body(), "MISS");
        } catch (HttpTimeoutException e) {
            ProxyOsrm.responderErro(requisicao, 504, "SearchTimeout",
                    "O serviço de busca demorou demais para responder.");
        } catch (IOException e) {
            ProxyOsrm.responderErro(requisicao, 502, "SearchError",
                    "O serviço de busca está indisponível.");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            ProxyOsrm.responderErro(requisicao, 503, "SearchError", "Busca interrompida.");
        } finally {
            requisicao.close();
        }
    }

    /**
     * Reserva o próximo horário livre para chamar o Nominatim, mantendo pelo
     * menos INTERVALO_NANOS entre chamadas. Devolve quantos nanossegundos
     * esperar, ou -1 se a fila já estiver longa demais.
     */
    private long reservarVez() {
        synchronized (travaIntervalo) {
            long agora = System.nanoTime();
            long vez = Math.max(proximaLiberada, agora);
            long espera = vez - agora;
            if (espera > ESPERA_MAXIMA_NANOS) {
                return -1;
            }
            proximaLiberada = vez + INTERVALO_NANOS;
            return espera;
        }
    }

    private byte[] lerCache(String chave) {
        synchronized (cache) {
            Guardada guardada = cache.get(chave);
            if (guardada == null) {
                return null;
            }
            if (System.nanoTime() - guardada.guardadaEm() > VALIDADE_CACHE_NANOS) {
                cache.remove(chave);
                return null;
            }
            return guardada.corpo();
        }
    }

    private void guardarCache(String chave, byte[] corpo) {
        synchronized (cache) {
            cache.put(chave, new Guardada(corpo, System.nanoTime()));
        }
    }

    private static void responder(HttpExchange requisicao, byte[] corpo, String cacheStatus)
            throws IOException {
        requisicao.getResponseHeaders().set("Content-Type", "application/json; charset=UTF-8");
        requisicao.getResponseHeaders().set("Cache-Control", "private, max-age=300");
        requisicao.getResponseHeaders().set("X-Cache", cacheStatus);
        requisicao.sendResponseHeaders(200, corpo.length);
        try (OutputStream saida = requisicao.getResponseBody()) {
            saida.write(corpo);
        }
    }

    static String parametro(String consulta, String nome) {
        if (consulta == null) {
            return null;
        }
        for (String par : consulta.split("&")) {
            int igual = par.indexOf('=');
            String chave = igual < 0 ? par : par.substring(0, igual);
            if (chave.equals(nome)) {
                String valor = igual < 0 ? "" : par.substring(igual + 1);
                try {
                    return URLDecoder.decode(valor, StandardCharsets.UTF_8);
                } catch (IllegalArgumentException e) {
                    return null;
                }
            }
        }
        return null;
    }
}
