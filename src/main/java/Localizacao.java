public class Localizacao {
    private double latitude;
    private double longitude;
    private double altitude;

    public Localizacao(double latitude, double longitude, double altitude) {
        this.latitude = latitude;
        this.longitude = longitude;
        this.altitude = altitude;
    }

    public double getLatitude() {
        return this.latitude;
    }

    public double getLongitude() {
        return this.longitude;
    }

    public double getAltitude() {
        return this.altitude;
    }

    public double calcularDistancia(Localizacao destino) {
        final double RAIO_TERRA = 6371000;

        double latitudeOrigem = Math.toRadians(this.latitude);
        double latitudeDestino = Math.toRadians(destino.getLatitude());

        double diferencaLatitude = Math.toRadians(destino.getLatitude() - this.latitude);
        double diferencaLongitude = Math.toRadians(destino.getLongitude() - this.longitude);

        double a = Math.pow(Math.sin(diferencaLatitude / 2), 2)
                + Math.cos(latitudeOrigem)
                * Math.cos(latitudeDestino)
                * Math.pow(Math.sin(diferencaLongitude / 2), 2);

        double c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return RAIO_TERRA * c;
    }
}