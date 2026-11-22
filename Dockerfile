# Uma imagem, dois papéis: o comando decide se o container é api ou worker.

FROM oven/bun:1.4.5-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.5-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
# Sem root dentro do container.
USER bun
EXPOSE 3000 3001
CMD ["bun", "src/main.api.ts"]
