FROM eclipse-temurin:21-jdk-bookworm AS builder
ARG ZAP_COMMIT=0c440107128299bc48e59950cb09378271a31c9c
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/zaproxy/zaproxy.git /src/zaproxy \
    && git -C /src/zaproxy checkout --detach "$ZAP_COMMIT" \
    && test "$(git -C /src/zaproxy rev-parse HEAD)" = "$ZAP_COMMIT"
WORKDIR /src/zaproxy
RUN ZAP_WEEKLY_ADDONS_NO_TEST=true ./gradlew :zap:prepareDistWeekly --no-daemon

FROM eclipse-temurin:21-jre-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 zap
COPY --from=builder --chown=zap:zap /src/zaproxy/zap/build/distFilesWeekly/ /zap/
RUN chmod +x /zap/zap.sh
USER zap
WORKDIR /zap
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=15 CMD curl -fsS http://127.0.0.1:8080/JSON/core/view/version/ >/dev/null || exit 1
ENTRYPOINT ["/zap/zap.sh", "-daemon", "-host", "0.0.0.0", "-port", "8080", "-config", "api.disablekey=true", "-config", "api.addrs.addr.name=.*", "-config", "api.addrs.addr.regex=true", "-config", "database.recoverylog=false"]
