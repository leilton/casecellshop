# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache wget
COPY package*.json ./

# dev: hot reload with tsx, source mounted as a volume
FROM base AS dev
RUN npm install
COPY . .
EXPOSE 3000 9464
CMD ["npm", "run", "dev:api"]

# build: compiles TypeScript
FROM base AS build
RUN npm install
COPY . .
RUN npm run build

# prod: runtime dependencies + dist only
FROM node:22-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/api/server.js"]
