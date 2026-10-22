FROM node:22-alpine
RUN apk add --no-cache wget
WORKDIR /app
COPY server.mjs .
USER node
EXPOSE 4000
CMD ["node", "server.mjs"]
