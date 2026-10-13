
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;

public class TesteOSRM {

    public static void main(String[] args) {

        String url = "https://router.project-osrm.org/route/v1/driving/"
                + "-43.3496,-21.7595;-43.9131,-21.7214"
                + "?overview=full&geometries=geojson";

        HttpClient cliente = HttpClient.newHttpClient();

        HttpRequest requisicao = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .GET()
                .build();

        try {
            HttpResponse<String> resposta = cliente.send(
                    requisicao,
                    HttpResponse.BodyHandlers.ofString()
            );

            System.out.println("Status HTTP: " + resposta.statusCode());

            if (resposta.statusCode() != 200) {
                System.err.println("Erro ao consultar o OSRM.");
                System.err.println(resposta.body());
                return;
            }

            processarRespostaOSRM(resposta.body());

        } catch (IOException e) {
            System.err.println("Erro de comunicação: " + e.getMessage());

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            System.err.println("Requisição interrompida.");
        }
    }

    private static void processarRespostaOSRM(String resposta) {

        try {
            // 1. Interpretar o JSON recebido da API.
            ObjectMapper mapper = new ObjectMapper();
            JsonNode raiz = mapper.readTree(resposta);

            JsonNode rotas = raiz.path("routes");

            if (!rotas.isArray() || rotas.isEmpty()) {
                System.err.println("Nenhuma rota encontrada na resposta.");
                return;
            }

            // 2. Obter a primeira rota.
            JsonNode primeiraRota = rotas.get(0);

            // 3. Extrair a geometria e as coordenadas.
            JsonNode geometria = primeiraRota.path("geometry");
            JsonNode coordenadas = geometria.path("coordinates");

            if (!coordenadas.isArray() || coordenadas.isEmpty()) {
                System.err.println(
                        "A geometria da rota não contém coordenadas."
                );
                return;
            }

            System.out.println(
                    "Quantidade de coordenadas: " + coordenadas.size()
            );

            // 4. Converter as coordenadas em objetos Localizacao.
            List<Localizacao> localizacoes = new ArrayList<>();

            for (int i = 0; i < coordenadas.size(); i++) {

                JsonNode ponto = coordenadas.get(i);

                // GeoJSON retorna longitude no índice 0
                // e latitude no índice 1.
                double longitude = ponto.get(0).asDouble();
                double latitude = ponto.get(1).asDouble();

                // A altitude 0.0 é provisória:
                // o OSRM não forneceu a altitude real.
                Localizacao localizacao =
                        new Localizacao(latitude, longitude, 0.0);

                localizacoes.add(localizacao);
            }

            System.out.println(
                    "Total de localizações: " + localizacoes.size()
            );

            // 5. Transformar as localizações em pontos de rota.
            List<PontoRota> pontosRota = new ArrayList<>();

            for (int i = 0; i < localizacoes.size(); i++) {

                Localizacao localizacao = localizacoes.get(i);

                PontoRota pontoRota = new PontoRota(
                        "Ponto " + (i + 1),
                        localizacao
                );

                pontosRota.add(pontoRota);
            }

            System.out.println(
                    "Total de pontos da rota: " + pontosRota.size()
            );

            // 6. Exibir distância e duração calculadas pelo OSRM.
            double distanciaMetros =
                    primeiraRota.path("distance").asDouble();

            double duracaoSegundos =
                    primeiraRota.path("duration").asDouble();

            System.out.printf(
                    "Distância: %.2f metros (%.2f km)%n",
                    distanciaMetros,
                    distanciaMetros / 1000.0
            );

            System.out.printf(
                    "Duração estimada: %.0f segundos (%.1f minutos)%n",
                    duracaoSegundos,
                    duracaoSegundos / 60.0
            );

            // 7. Salvar os pontos para uso offline.
            String caminho = "rota_osrm.txt";

            try {
                ArquivoRota.salvar(pontosRota, caminho);

                System.out.println(
                        "Rota salva com sucesso em: " + caminho
                );

                System.out.println(
                        "Total de pontos gravados offline: " + pontosRota.size()
                );

            } catch (IOException e) {
                System.err.println(
                        "Erro ao salvar o arquivo de rota: " + e.getMessage()
                );
                return;
            }

// 8. Testar a leitura do arquivo salvo.
            try {
                List<PontoRota> rotaCarregada = ArquivoRota.carregar(caminho);

                System.out.println("\n--- Teste de leitura offline ---");
                System.out.println("Pontos recuperados: " + rotaCarregada.size());

                if (rotaCarregada.size() == pontosRota.size()) {
                    System.out.println("Sucesso: todos os pontos foram recuperados!");
                } else {
                    System.out.println("Atenção: a quantidade recuperada é diferente.");
                }

            } catch (IOException e) {
                System.err.println("Erro ao carregar a rota: " + e.getMessage());
            }


        } catch (IOException e) {
            System.err.println(
                    "Erro ao interpretar o JSON: " + e.getMessage()
            );
        }
    }
}
