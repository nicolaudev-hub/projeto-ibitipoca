FROM maven:3.9.11-eclipse-temurin-25 AS build

WORKDIR /app

# Resolve as dependências antes de copiar o código para aproveitar o cache.
COPY pom.xml ./
RUN mvn -B dependency:go-offline

COPY src ./src
RUN mvn -B clean package dependency:copy-dependencies \
    -DincludeScope=runtime \
    -DoutputDirectory=target/dependency

FROM eclipse-temurin:25-jre

WORKDIR /app
COPY --from=build /app/target/classes ./target/classes
COPY --from=build /app/target/dependency ./target/dependency

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "exec java -cp 'target/classes:target/dependency/*' ServidorWeb"]
