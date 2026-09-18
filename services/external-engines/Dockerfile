FROM golang:1.25-bookworm AS k6-builder
ARG K6_COMMIT=3fcf5388d78cb382f0c0d42ec556a06bfd1b8dee
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/grafana/k6.git /src/k6 \
    && git -C /src/k6 checkout --detach "$K6_COMMIT" \
    && test "$(git -C /src/k6 rev-parse HEAD)" = "$K6_COMMIT"
WORKDIR /src/k6
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags "-X go.k6.io/k6/v2/internal/build.BuildOrigin=verifiai-pinned-source" \
    -o /out/k6

FROM python:3.12-bookworm
ARG STRIX_COMMIT=976835194d11171989c5f231fbd6eb0a8e4465dd
ARG SCHEMATHESIS_COMMIT=94e23b5e497e83404aa681f5443ee32de2c3746f
ARG LOCUST_COMMIT=b9636d95bffc94c3a1bf8bfd500633e63297470f

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git nodejs docker.io \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/verifiai-tools
ENV PATH="/opt/verifiai-tools/bin:/usr/local/bin:/usr/bin:/bin"

RUN git clone https://github.com/usestrix/strix.git /src/strix \
    && git -C /src/strix checkout --detach "$STRIX_COMMIT" \
    && test "$(git -C /src/strix rev-parse HEAD)" = "$STRIX_COMMIT" \
    && /opt/verifiai-tools/bin/pip install --no-cache-dir /src/strix

RUN git clone https://github.com/schemathesis/schemathesis.git /src/schemathesis \
    && git -C /src/schemathesis checkout --detach "$SCHEMATHESIS_COMMIT" \
    && test "$(git -C /src/schemathesis rev-parse HEAD)" = "$SCHEMATHESIS_COMMIT" \
    && /opt/verifiai-tools/bin/pip install --no-cache-dir /src/schemathesis

RUN git clone https://github.com/locustio/locust.git /src/locust \
    && git -C /src/locust checkout --detach "$LOCUST_COMMIT" \
    && test "$(git -C /src/locust rev-parse HEAD)" = "$LOCUST_COMMIT" \
    && /opt/verifiai-tools/bin/pip install --no-cache-dir /src/locust

COPY --from=k6-builder /out/k6 /usr/local/bin/k6

WORKDIR /app
COPY packages/adapters ./packages/adapters
COPY services/external-engines ./services/external-engines

ENV PORT=8789
EXPOSE 8789
CMD ["node", "services/external-engines/server.mjs"]
