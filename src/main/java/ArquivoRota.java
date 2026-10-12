
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

public class ArquivoRota {

    public static void salvar(List<PontoRota> rota, String caminhoArquivo)
            throws IOException {

        try (BufferedWriter escritor =
                     new BufferedWriter(new FileWriter(caminhoArquivo))) {

            for (PontoRota ponto : rota) {
                Localizacao localizacao = ponto.getLocalizacao();

                escritor.write(
                        ponto.getNome() + ";" +
                                localizacao.getLatitude() + ";" +
                                localizacao.getLongitude() + ";" +
                                localizacao.getAltitude()
                );

                escritor.newLine();
            }
        }
    }

    public static List<PontoRota> carregar(String caminhoArquivo)
            throws IOException {

        List<PontoRota> rota = new ArrayList<>();

        try (BufferedReader leitor =
                     new BufferedReader(new FileReader(caminhoArquivo))) {

            String linha;

            while ((linha = leitor.readLine()) != null) {
                String[] dados = linha.split(";");

                String nome = dados[0];
                double latitude = Double.parseDouble(dados[1]);
                double longitude = Double.parseDouble(dados[2]);
                double altitude = Double.parseDouble(dados[3]);

                Localizacao localizacao =
                        new Localizacao(latitude, longitude, altitude);

                rota.add(new PontoRota(nome, localizacao));
            }
        }

        return rota;
    }
}
