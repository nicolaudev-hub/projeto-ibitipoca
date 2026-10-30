# Hospedagem no Railway

A aplicação possui dois serviços: Java e TileServer GL. O arquivo MBTiles deve permanecer fora do Git. A rota principal, os recursos Leaflet e os componentes da interface são empacotados como recursos Maven.

## Serviço Java

1. Crie um serviço conectado ao repositório e à branch `main`.
2. Utilize o `Dockerfile` da raiz do projeto.
3. Configure `PORT=8080`. O servidor Java faz bind em `0.0.0.0` e respeita a variável `PORT`.
4. Gere um domínio HTTPS público nas configurações de Networking. O Railway termina o TLS na borda e encaminha as requisições HTTP ao container.

## Serviço TileServer GL

1. Crie outro serviço a partir do mesmo repositório e configure o arquivo `Dockerfile.tileserver`.
2. Configure `PORT=8080`, mantendo a porta interna esperada pela imagem.
3. Anexe um volume persistente com ponto de montagem `/data`.
4. Envie o arquivo `D:\mapas-ibitipoca\mapa-ibitipoca.mbtiles` para `/mapa-ibitipoca.mbtiles` no volume. Utilize `railway volume browse /` ou `railway volume files upload <arquivo-local> /mapa-ibitipoca.mbtiles`. Se houver vários volumes, selecione explicitamente o volume do TileServer com `--volume`.
5. Confirme que `/data/mapa-ibitipoca.mbtiles` existe no volume. O Railway monta volumes durante a execução, não durante o build. Mantenha o volume anexado e faça backups conforme necessário.
6. Gere um domínio HTTPS público para o serviço TileServer GL.
7. Configure `TILESERVER_GL_ALLOWED_HOSTS=${{RAILWAY_PUBLIC_DOMAIN}}` nas variáveis do serviço. O valor deve conter apenas o hostname, sem esquema. Para domínios personalizados, inclua os hosts permitidos separados por vírgula. A imagem utiliza `localhost` como allowlist inicial até a configuração ser aplicada.

## URL pública e proxy

No serviço Java, configure `TILE_SERVER_URL` com a URL HTTPS real do TileServer GL, por exemplo, `https://<dominio-publico-do-tileserver>`. Substitua o exemplo pelo domínio gerado pelo Railway; não utilize domínios fictícios na configuração de produção.

A aplicação disponibiliza essa configuração por meio de `/config.json` e utiliza a URL configurada para construir os endereços dos tiles.

O Railway encaminha os cabeçalhos `X-Forwarded-Host` e `X-Forwarded-Proto`. O TileServer GL pode utilizá-los para montar URLs absolutas de TileJSON e restringe os hosts conforme `TILESERVER_GL_ALLOWED_HOSTS`. A opção `--public_url` pode fixar uma URL canônica, mas não deve receber valores fictícios. O TileServer GL habilita CORS por padrão para chamadas do navegador entre domínios.

## Recursos e modo offline

A rota principal está em `src/main/resources/static/data/rota_navegacao_offline.json`. A versão local validada contém uma rota, três waypoints, 2.418 coordenadas, 89.585,1 metros e duração estimada de 6.356,3 segundos. A página ativa consulta esse arquivo.

Os recursos Leaflet e os componentes JavaScript da navegação são mantidos localmente no projeto. Os tiles do mapa também possuem uma cópia local em `src/main/resources/static/tiles/`, com manifesto e imagens organizadas por nível de zoom.

**Há duas formas de disponibilizar os tiles:**

- **Modo com TileServer GL:** os tiles são fornecidos pelo serviço configurado em `TILE_SERVER_URL`, exigindo conectividade com esse serviço.
- **Modo offline:** a aplicação pode utilizar os tiles locais disponíveis no projeto, desde que a implementação ativa os carregue corretamente e os arquivos necessários estejam disponíveis no dispositivo.

O funcionamento offline depende da disponibilidade dos tiles necessários à área e ao nível de zoom desejados. A presença da rota e dos arquivos Leaflet, isoladamente, não garante que todo o mapa esteja disponível offline.

A navegação GPS utiliza a localização fornecida pelo dispositivo para mostrar a posição do usuário em relação à rota. A precisão e a atualização dependem do GPS, das permissões do navegador e das condições de recepção do sinal.

Backups, arquivos de teste de rota, versões antigas da página e bibliotecas não utilizadas permanecem fora dos recursos de produção conforme as regras definidas no `pom.xml` e no `.gitignore`.

Para desenvolvimento local, configure `TILE_SERVER_URL=http://localhost:8081` e mantenha o TileServer local nessa porta. HTTP é aceito somente em localhost; a hospedagem pública deve utilizar HTTPS.

## Publicação

Antes de publicar:

1. Inclua no commit somente os arquivos de produção desejados.
2. Crie os dois serviços no Railway.
3. Configure o volume persistente e carregue o arquivo MBTiles.
4. Gere os domínios públicos HTTPS.
5. Configure `TILESERVER_GL_ALLOWED_HOSTS` e `TILE_SERVER_URL` com os valores reais.
6. Valide a interface, o carregamento dos tiles, a navegação GPS e o comportamento offline nos dispositivos pretendidos.

Nenhum domínio, custo ou deploy é presumido neste documento.