# Build the bundle first: node gateway/build.mjs. Then, from gateway/:
#   docker build -t quay-gateway .
#   docker run --rm -p 8787:8787 -e ACCOUNT=<name>.testnet quay-gateway
FROM node:22-alpine
WORKDIR /app
COPY dist/quay-gateway.mjs ./
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
USER node
ENTRYPOINT ["node", "quay-gateway.mjs"]
