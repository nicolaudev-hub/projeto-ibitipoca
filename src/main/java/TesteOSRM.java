
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

public class TesteOSRM {

    public static void main(String[] args) {
        String url = "https://router.project-osrm.org/route/v1/driving/"
                + "-43.3496,-21.7595;"
                + "-43.9131,-21.7214"
                + "?overview=false";

        HttpClient cliente = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .build();

        HttpRequest requisicao = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();

        try {
            HttpResponse<String> resposta = cliente.send(
                    requisicao,
                    HttpResponse.BodyHandlers.ofString()
            );

            System.out.println("Status HTTP: " + resposta.statusCode());

            if (resposta.statusCode() != 200) {
                System.out.println("Falha na requisição HTTP.");
                System.out.println(resposta.body());
                return;
            }

            processarRespostaOSRM(resposta.body());

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            System.err.println("Requisição interrompida.");

        } catch (Exception e) {
            System.err.println(
                    "Erro ao consultar o OSRM: " + e.getMessage()
            );
        }
    }

    public static void processarRespostaOSRM(String corpoResposta) {
        ObjectMapper mapper = new ObjectMapper();

        try {
            JsonNode raiz = mapper.readTree(corpoResposta);

            if (raiz == null || !raiz.isObject()) {
                System.err.println("A resposta não contém um objeto JSON válido.");
                return;
            }

            String codigo = raiz.path("code").asText("");

            if (!"Ok".equals(codigo)) {
                System.err.println("Erro retornado pelo OSRM: " + codigo);
                return;
            }

            JsonNode rotas = raiz.path("routes");

            if (!rotas.isArray() || rotas.isEmpty()) {
                System.err.println("O OSRM não retornou nenhuma rota.");
                return;
            }

            JsonNode primeiraRota = rotas.get(0);

            JsonNode distanciaNode = primeiraRota.path("distance");
            JsonNode duracaoNode = primeiraRota.path("duration");

            if (!distanciaNode.isNumber() || !duracaoNode.isNumber()) {
                System.err.println(
                        "A rota não contém distância ou duração válidas."
                );
                return;
            }

            double distanciaMetros = distanciaNode.asDouble();
            double duracaoSegundos = duracaoNode.asDouble();

            System.out.printf(
                    "Distância: %.2f metros (%.2f km)%n",
                    distanciaMetros,
                    distanciaMetros / 1000
            );

            System.out.printf(
                    "Duração estimada: %.0f segundos (%.1f minutos)%n",
                    duracaoSegundos,
                    duracaoSegundos / 60
            );

        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            System.err.println("A resposta recebida não é um JSON válido.");

        } catch (Exception e) {
            System.err.println(
                    "Erro ao processar a resposta do OSRM: " + e.getMessage()
            );
        }
    }
}
