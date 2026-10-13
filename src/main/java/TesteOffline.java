
import java.io.IOException;
import java.util.List;

public class TesteOffline {

    public static void main(String[] args) {

        try {
            // Carregar a rota do arquivo local.
            List<PontoRota> rotaCarregada =
                    ArquivoRota.carregar("rota_osrm.txt");

            int pontosInvalidos = 0;

            for (int i = 0; i < rotaCarregada.size(); i++) {

                // Recupera o ponto atual.
                PontoRota ponto = rotaCarregada.get(i);

                // Recupera a localização desse ponto.
                Localizacao localizacao = ponto.getLocalizacao();

                // Obtém as coordenadas.
                double latitude = localizacao.getLatitude();
                double longitude = localizacao.getLongitude();

                // Verifica se alguma coordenada está fora dos limites.
                if (latitude < -90 || latitude > 90
                        || longitude < -180 || longitude > 180) {

                    pontosInvalidos++;
                }
            }

            System.out.println("=== TESTE OFFLINE ===");
            System.out.println("Total de pontos: " + rotaCarregada.size());
            System.out.println("Pontos inválidos: " + pontosInvalidos);
            System.out.println("Pontos válidos: " + (rotaCarregada.size() - pontosInvalidos)
            );
            int saltosSuspeitos = 0;

            for (int i = 1; i < rotaCarregada.size(); i++) {
                PontoRota atual = rotaCarregada.get(i);
                PontoRota anterior = rotaCarregada.get(i - 1);

                Localizacao localizacaoAtual = atual.getLocalizacao();
                Localizacao localizacaoAnterior = anterior.getLocalizacao();

                double distancia = localizacaoAnterior.calcularDistancia(localizacaoAtual);

                if (distancia > 100) {
                    saltosSuspeitos++;
                    System.out.println(
                            "Exibição dos pontos" + anterior.getNome() + atual.getNome() + distancia());
                }
            }

            System.out.println("Total de saltos suspeitos: " + saltosSuspeitos);

            // Conferir os dados do primeiro ponto.
            if (!rotaCarregada.isEmpty()) {

                PontoRota primeiroPonto = rotaCarregada.get(0);

                Localizacao localizacao =
                        primeiroPonto.getLocalizacao();

                System.out.println(
                        "Primeiro ponto: " + primeiroPonto.getNome()
                );

                System.out.println(
                        "Latitude: " + localizacao.getLatitude()
                );

                System.out.println(
                        "Longitude: " + localizacao.getLongitude()
                );

                System.out.println(
                        "Altitude: " + localizacao.getAltitude()
                );
            }

        } catch (IOException e) {
            System.err.println(
                    "Erro ao carregar a rota: " + e.getMessage()
            );
        }
    }
}
