FROM python:3.12-bookworm
ARG BROWSER_USE_COMMIT=d8110c5ff87ccba887aaa726cdb780f2f84bef8d

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/browser-use/browser-use.git /src/browser-use \
    && git -C /src/browser-use checkout --detach "$BROWSER_USE_COMMIT" \
    && test "$(git -C /src/browser-use rev-parse HEAD)" = "$BROWSER_USE_COMMIT"

RUN python -m venv /opt/browser-use \
    && /opt/browser-use/bin/pip install --no-cache-dir /src/browser-use playwright \
    && /opt/browser-use/bin/playwright install chromium --with-deps --no-shell

WORKDIR /app
COPY services/browser-use-runner/server.py /app/services/browser-use-runner/server.py

ENV PATH="/opt/browser-use/bin:/usr/local/bin:/usr/bin:/bin"
ENV PORT=8792
EXPOSE 8792
CMD ["python", "/app/services/browser-use-runner/server.py"]
