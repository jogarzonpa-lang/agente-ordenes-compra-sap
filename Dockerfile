# Despliegue en Hugging Face Spaces (SDK Docker) o cualquier plataforma con contenedores.
FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY . .
RUN mkdir -p out && chown -R bun:bun /app
USER bun
ENV PORT=7860
EXPOSE 7860
CMD ["bun", "run", "src/server.ts"]
