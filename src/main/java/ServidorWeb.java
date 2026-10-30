import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;

public class ServidorWeb {

    public static void main(String[] args) throws IOException {
        int porta = Integer.parseInt(
                System.getenv().getOrDefault("PORT", "8080")
        );
        HttpServer servidor = HttpServer.create(
                new InetSocketAddress("0.0.0.0", porta), 0
        );

        servidor.createContext("/config.json", ServidorWeb::atenderConfiguracao);
        servidor.createContext("/", ServidorWeb::atenderRequisicao);
        servidor.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> servidor.stop(1)));

        System.out.println("Servidor iniciado na porta " + porta + ".");
    }

    private static void atenderConfiguracao(HttpExchange requisicao)
            throws IOException {
        if (!requisicao.getRequestMethod().equals("GET")) {
            requisicao.getResponseHeaders().set("Allow", "GET");
            requisicao.sendResponseHeaders(405, -1);
            requisicao.close();
            return;
        }

        String configurada = System.getenv().getOrDefault("TILE_SERVER_URL", "").trim();
        String baseTiles = "";
        String erro = "";
        if (!configurada.isEmpty()) {
            try {
                baseTiles = validarBaseTiles(configurada);
            } catch (IllegalArgumentException e) {
                erro = "TILE_SERVER_URL deve ser uma origem HTTPS; HTTP só é aceito em localhost.";
            }
        }
        String json = "{\"tileServerBaseUrl\":\"" + escaparJson(baseTiles)
                + "\",\"error\":\"" + escaparJson(erro) + "\"}";
        byte[] conteudo = json.getBytes(StandardCharsets.UTF_8);
        requisicao.getResponseHeaders().set("Content-Type", "application/json; charset=UTF-8");
        requisicao.getResponseHeaders().set("Cache-Control", "no-store");
        requisicao.sendResponseHeaders(200, conteudo.length);
        try (OutputStream saida = requisicao.getResponseBody()) {
            saida.write(conteudo);
        }
    }

    private static String validarBaseTiles(String valor) {
        URI uri = URI.create(valor);
        String esquema = uri.getScheme();
        String host = uri.getHost();
        boolean https = esquema != null && esquema.equalsIgnoreCase("https");
        boolean localhost = esquema != null && esquema.equalsIgnoreCase("http")
                && "localhost".equalsIgnoreCase(host);
        if ((!https && !localhost) || host == null || uri.getRawUserInfo() != null
                || (uri.getRawPath() != null && !uri.getRawPath().isEmpty()
                && !uri.getRawPath().equals("/"))
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || uri.getPort() == 0 || uri.getPort() > 65535) {
            throw new IllegalArgumentException("Origem de tiles inválida");
        }
        return valor.replaceAll("/+$", "");
    }

    private static String escaparJson(String valor) {
        StringBuilder escapado = new StringBuilder();
        for (char caractere : valor.toCharArray()) {
            switch (caractere) {
                case '"' -> escapado.append("\\\"");
                case '\\' -> escapado.append("\\\\");
                case '\b' -> escapado.append("\\b");
                case '\f' -> escapado.append("\\f");
                case '\n' -> escapado.append("\\n");
                case '\r' -> escapado.append("\\r");
                case '\t' -> escapado.append("\\t");
                default -> {
                    if (caractere < 0x20) {
                        escapado.append(String.format("\\u%04x", (int) caractere));
                    } else {
                        escapado.append(caractere);
                    }
                }
            }
        }
        return escapado.toString();
    }

    private static void atenderRequisicao(HttpExchange requisicao)
            throws IOException {

        if (!requisicao.getRequestMethod().equals("GET")) {
            requisicao.getResponseHeaders().set("Allow", "GET");
            requisicao.sendResponseHeaders(405, -1);
            requisicao.close();
            return;
        }

        String caminho = requisicao.getRequestURI().getPath();

        if (caminho.equals("/")) {
            caminho = "/index.html";
        }

        if (caminho.contains("..") || caminho.contains("\\")) {
            requisicao.sendResponseHeaders(400, -1);
            requisicao.close();
            return;
        }

        String recurso = "/static" + caminho;

        try (InputStream entrada =
                     ServidorWeb.class.getResourceAsStream(recurso)) {

            if (entrada == null) {
                byte[] mensagem = "Recurso nao encontrado."
                        .getBytes(StandardCharsets.UTF_8);

                requisicao.sendResponseHeaders(404, mensagem.length);

                try (OutputStream saida = requisicao.getResponseBody()) {
                    saida.write(mensagem);
                }
                return;
            }

            byte[] conteudo = entrada.readAllBytes();

            requisicao.getResponseHeaders().set(
                    "Content-Type", determinarTipo(caminho)
            );

            requisicao.sendResponseHeaders(200, conteudo.length);

            try (OutputStream saida = requisicao.getResponseBody()) {
                saida.write(conteudo);
            }
        } finally {
            requisicao.close();
        }
    }

    private static String determinarTipo(String caminho) {
        if (caminho.endsWith(".html")) {
            return "text/html; charset=UTF-8";
        }
        if (caminho.endsWith(".js")) {
            return "application/javascript; charset=UTF-8";
        }
        if (caminho.endsWith(".css")) {
            return "text/css; charset=UTF-8";
        }
        if (caminho.endsWith(".json")) {
            return "application/json; charset=UTF-8";
        }
        if (caminho.endsWith(".png")) {
            return "image/png";
        }
        return "application/octet-stream";
    }
}
