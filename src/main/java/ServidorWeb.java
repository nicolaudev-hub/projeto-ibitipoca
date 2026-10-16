import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

public class ServidorWeb {

    public static void main(String[] args) throws IOException {
        HttpServer servidor = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 8080), 0
        );

        servidor.createContext("/", ServidorWeb::atenderRequisicao);
        servidor.start();

        System.out.println("Servidor iniciado!");
        System.out.println("Acesse: http://localhost:8080");
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
