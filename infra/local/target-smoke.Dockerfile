FROM node:22-bookworm-slim
WORKDIR /app
COPY infra/local/target-smoke-server.mjs ./server.mjs
EXPOSE 8081
CMD ["node", "server.mjs"]
