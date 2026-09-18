FROM golang:1.25-bookworm AS builder
ARG TOXIPROXY_COMMIT=40f7fd31bee529d824116bd2a11a9e3425e904ec
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/Shopify/toxiproxy.git /src/toxiproxy \
    && git -C /src/toxiproxy checkout --detach "$TOXIPROXY_COMMIT" \
    && test "$(git -C /src/toxiproxy rev-parse HEAD)" = "$TOXIPROXY_COMMIT"
WORKDIR /src/toxiproxy
RUN CGO_ENABLED=0 go build -trimpath -o /out/toxiproxy-server ./cmd/server

FROM debian:bookworm-slim
COPY --from=builder /out/toxiproxy-server /usr/local/bin/toxiproxy-server
EXPOSE 8474
ENTRYPOINT ["toxiproxy-server"]
