FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY dist ./dist
ENV NODE_ENV=production
CMD ["node", "dist/services/agent-runtime/worker-cli.js"]
