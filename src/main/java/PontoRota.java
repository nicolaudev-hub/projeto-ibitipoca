public class PontoRota {
    private String nome;
    private Localizacao localizacao;

    public PontoRota(String nome, Localizacao localizacao) {
        this.nome = nome;
        this.localizacao = localizacao;
    }

    public String getNome() {
        return nome;
    }

    public Localizacao getLocalizacao() {
        return localizacao;
    }
}