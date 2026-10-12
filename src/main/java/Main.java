
import java.util.List;

public class Main {

    public static void main(String[] args) {
        System.out.println("=== GPS OFFLINE: PROJETO IBITIPOCA ===");

        String inicio = "Portaria do Parque";
        String fim = "Janela do Céu";

        // 1. Carrega a rota salva no arquivo
        List<PontoRota> rota;

        try {
            rota = ArquivoRota.carregar("rota.txt");

            if (rota.isEmpty()) {
                System.out.println("O arquivo da rota está vazio.");
                return;
            }

            System.out.println("Rota carregada do arquivo: "
                    + rota.size() + " pontos.");

        } catch (java.io.IOException e) {
            System.out.println("Erro ao carregar a rota: "
                    + e.getMessage());
            return;
        }

        // 2. Exibe origem e destino
        System.out.println("\nCalculando rota salva localmente...");
        System.out.println("Início: " + inicio);
        System.out.println("Destino: " + fim);

        System.out.println("\n[ DISTÂNCIA ACUMULADA POR PONTO ]");

        // 3. Calcula a distância acumulada
        double distanciaAcumulada = 0;

        System.out.printf("%d. %s - %.2f metros%n",
                1,
                rota.get(0).getNome(),
                distanciaAcumulada);

        for (int i = 0; i < rota.size() - 1; i++) {
            Localizacao atual = rota.get(i).getLocalizacao();
            Localizacao proxima = rota.get(i + 1).getLocalizacao();

            double distanciaTrecho =
                    atual.calcularDistancia(proxima);

            distanciaAcumulada += distanciaTrecho;

            System.out.printf("%d. %s - %.2f metros%n",
                    i + 2,
                    rota.get(i + 1).getNome(),
                    distanciaAcumulada);
        }

        System.out.printf(
                "%nDistância total estimada: %.2f metros%n",
                distanciaAcumulada);

        // 4. Simula a localização atual do usuário
        Localizacao localizacaoAtual =
                new Localizacao(-21.705, -43.915, 1000);

        // 5. Encontra o ponto cadastrado mais próximo
        PontoRota pontoMaisProximo =
                encontrarPontoMaisProximo(localizacaoAtual, rota);

        if (pontoMaisProximo == null) {
            System.out.println("Não foi possível localizar um ponto da rota.");
            return;
        }

        double distanciaAtePonto =
                localizacaoAtual.calcularDistancia(
                        pontoMaisProximo.getLocalizacao());

        // 6. Identifica o próximo ponto da sequência
        int indicePontoMaisProximo =
                rota.indexOf(pontoMaisProximo);

        System.out.println("\n[ NAVEGAÇÃO ATUAL ]");
        System.out.println("Ponto mais próximo: "
                + pontoMaisProximo.getNome());

        System.out.printf("Distância até o ponto: %.2f metros%n",
                distanciaAtePonto);

        if (indicePontoMaisProximo < rota.size() - 1) {
            PontoRota proximoPonto =
                    rota.get(indicePontoMaisProximo + 1);

            System.out.println("Próximo ponto da rota: "
                    + proximoPonto.getNome());
        } else {
            System.out.println("Você chegou ao destino!");
        }

        // 7. Exibe os pontos e suas coordenadas
        System.out.println("\n[ PONTOS DA ROTA ]");

        for (int i = 0; i < rota.size(); i++) {
            PontoRota ponto = rota.get(i);
            Localizacao localizacao = ponto.getLocalizacao();

            System.out.println((i + 1) + ". " + ponto.getNome());
            System.out.println("   Latitude: "
                    + localizacao.getLatitude());
            System.out.println("   Longitude: "
                    + localizacao.getLongitude());
            System.out.println("   Altitude: "
                    + localizacao.getAltitude());
        }
    }

    public static PontoRota encontrarPontoMaisProximo(
            Localizacao localizacaoAtual,
            List<PontoRota> rota) {

        PontoRota pontoMaisProximo = null;
        double menorDistancia = Double.MAX_VALUE;

        for (PontoRota ponto : rota) {
            double distancia =
                    localizacaoAtual.calcularDistancia(
                            ponto.getLocalizacao());

            if (distancia < menorDistancia) {
                menorDistancia = distancia;
                pontoMaisProximo = ponto;
            }
        }

        return pontoMaisProximo;
    }
}
