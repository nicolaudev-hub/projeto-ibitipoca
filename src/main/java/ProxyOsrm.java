import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.regex.Pattern;

/**
 * Encaminha /osrm/route/v1/... para o servidor OSRM (variável OSRM_URL,
 * padrão http://localhost:5000).
 *
 * Em produção o Caddy já faz esse encaminhamento antes de a requisição chegar
 * aqui; este proxy existe para o app funcionar igual no desenvolvimento local
 * (sem Caddy) e para não depender do Caddy no futuro.
 *
 * Só o serviço de rotas passa: table, trip, match e nearest ficam de fora,
 * porque consomem muito mais processamento e o app não os usa.
 */
public final class ProxyOsrm {

    private static final String PREFIXO = "/osrm";

    // /osrm/route/v1/driving/lon,lat;lon,lat[;...]
    private static final String COORDENADA = "-?\\d{1,3}(\\.\\d+)?,-?\\d{1,2}(\\.\\d+)?";
    private static final Pattern CAMINHO_PERMITIDO = Pattern.compile(
            "^/osrm/route/v1/driving/" + COORDENADA + "(;" + COORDENADA + "){1,24}$");
    // Parâmetros do OSRM usam só estes caracteres (overview=full&steps=true...).
    private static final Pattern CONSULTA_PERMITIDA = Pattern.compile("^[A-Za-z0-9=&_.,;:-]{0,500}$");

    private static final Duration TEMPO_LIMITE = Duration.ofSeconds(20);
    private static final HttpClient CLIENTE = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    private final String base;

    private ProxyOsrm(String base) {
        this.base = base.replaceAll("/+$", "");
    }

    static ProxyOsrm doAmbiente() {
        return new ProxyOsrm(System.getenv().getOrDefault("OSRM_URL", "http://localhost:5000"));
    }

    void atender(HttpExchange requisicao) throws IOException {
        try {
            if (!requisicao.getRequestMethod().equals("GET")) {
                requisicao.getResponseHeaders().set("Allow", "GET");
                requisicao.sendResponseHeaders(405, -1);
                return;
            }

            String caminho = requisicao.getRequestURI().getRawPath();
            String consulta = requisicao.getRequestURI().getRawQuery();
            if (!CAMINHO_PERMITIDO.matcher(caminho).matches()
                    || (consulta != null && !CONSULTA_PERMITIDA.matcher(consulta).matches())) {
                responderErro(requisicao, 400, "InvalidUrl",
                        "Somente /osrm/route/v1/driving/ com coordenadas é aceito.");
                return;
            }

            String destino = base + caminho.substring(PREFIXO.length())
                    + (consulta == null ? "" : "?" + consulta);
            HttpRequest pedido = HttpRequest.newBuilder(URI.create(destino))
                    .timeout(TEMPO_LIMITE)
                    .GET()
                    .build();

            HttpResponse<byte[]> resposta;
            try {
                resposta = CLIENTE.send(pedido, HttpResponse.BodyHandlers.ofByteArray());
            } catch (HttpTimeoutException e) {
                responderErro(requisicao, 504, "ProxyTimeout",
                        "O serviço de rotas demorou demais para responder.");
                return;
            } catch (IOException e) {
                responderErro(requisicao, 502, "ProxyError",
                        "O serviço de rotas está indisponível.");
                return;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                responderErro(requisicao, 503, "ProxyError", "Requisição interrompida.");
                return;
            }

            String tipo = resposta.headers().firstValue("Content-Type")
                    .orElse("application/json; charset=UTF-8");
            requisicao.getResponseHeaders().set("Content-Type", tipo);
            requisicao.getResponseHeaders().set("Cache-Control", "no-store");
            byte[] corpo = resposta.body();
            requisicao.sendResponseHeaders(resposta.statusCode(), corpo.length == 0 ? -1 : corpo.length);
            if (corpo.length > 0) {
                try (OutputStream saida = requisicao.getResponseBody()) {
                    saida.write(corpo);
                }
            }
        } finally {
            requisicao.close();
        }
    }

    // Mesmo formato de erro do OSRM ({"code","message"}), que o front já trata.
    static void responderErro(HttpExchange requisicao, int status, String codigo, String mensagem)
            throws IOException {
        byte[] corpo = ("{\"code\":\"" + codigo + "\",\"message\":\"" + mensagem + "\"}")
                .getBytes(StandardCharsets.UTF_8);
        requisicao.getResponseHeaders().set("Content-Type", "application/json; charset=UTF-8");
        requisicao.getResponseHeaders().set("Cache-Control", "no-store");
        requisicao.sendResponseHeaders(status, corpo.length);
        try (OutputStream saida = requisicao.getResponseBody()) {
            saida.write(corpo);
        }
    }
}
