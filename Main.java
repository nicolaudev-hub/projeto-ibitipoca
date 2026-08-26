import java.util.ArrayList;
import java.util.List;
public class Main{
	public static void main(String[] args) {
		System.out.println("=== GPS OFFLINE: PROJETO IBITIPOCA ===");
		
		// 1. Configuração dos pontos turístico slocais
		String inicio = "Portaria do Parque";
		String fim = "Janela do Céu";
		
		// 2. Simulação do trajeto offline
		List<String> rota = new ArrayList<>();
		rota.add("Porta do Parque");
		rota.add("Circuito Janela do Céu");
		rota.add("Lombada");
		rota.add("Janela do Céu");

		// 3. Exibição do resultado na tela
		System.out.println("\nCalculando rota sem internet...");
		System.out.println("Início: " + fim);
		System.out.println("\n[TRAJETO LOCALIZADO]:");

		for (int i = 0; i < rota.size(); i++) {
			System.out.println((i + 1) + "." + rota.get (i));
		}
	}
}		
