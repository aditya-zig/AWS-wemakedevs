FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY dist ./dist
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/services/agent-runtime/worker-server.js"]
