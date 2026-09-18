FROM python:3.12-bookworm
ARG MIROFISH_COMMIT=39d849138ef254f6c737ab4c4705e5545dbe31d4

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv

RUN git clone https://github.com/666ghj/MiroFish.git /src/MiroFish \
    && git -C /src/MiroFish checkout --detach "$MIROFISH_COMMIT" \
    && test "$(git -C /src/MiroFish rev-parse HEAD)" = "$MIROFISH_COMMIT"

WORKDIR /src/MiroFish/backend
RUN uv sync --frozen --no-dev

ENV FLASK_HOST=0.0.0.0
ENV FLASK_PORT=5001
ENV FLASK_DEBUG=False
EXPOSE 5001
CMD ["uv", "run", "--frozen", "python", "run.py"]
