FROM docker.io/oven/bun:1.4.4-distroless
WORKDIR /app
# The app has no runtime dependencies; package.json only lists dev tools.
COPY package.json ./
COPY src ./src
USER 1001:1001
EXPOSE 8080
ENTRYPOINT ["bun", "src/main.ts"]
