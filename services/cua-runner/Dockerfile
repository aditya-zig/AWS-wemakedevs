FROM python:3.12-bookworm
ARG CUA_COMMIT=05f29785b508a4441ec3aa06c556a8e8b26c1d71

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git docker.io \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv

RUN git clone https://github.com/trycua/cua.git /src/cua \
    && git -C /src/cua checkout --detach "$CUA_COMMIT" \
    && test "$(git -C /src/cua rev-parse HEAD)" = "$CUA_COMMIT"

WORKDIR /src/cua
RUN uv sync --frozen --group dev

WORKDIR /app
COPY services/cua-runner/server.py /app/services/cua-runner/server.py

ENV PORT=8791
ENV CUA_ARTIFACT_ROOT=/artifacts
EXPOSE 8791
CMD ["/src/cua/.venv/bin/python", "/app/services/cua-runner/server.py"]
