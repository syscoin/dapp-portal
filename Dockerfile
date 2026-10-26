FROM node:26-alpine AS base-stage
RUN node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); if (major !== 26 || minor < 12 || (minor === 12 && patch < 1)) throw new Error("Node.js >=26.12.1 <27 is required");'

WORKDIR /usr/src/app
COPY package*.json ./

FROM base-stage AS build-stage
RUN apk add --update python3 make g++ && rm -rf /var/cache/apk/*
RUN npm cache clean --force && npm install
COPY . .
RUN npm run generate

FROM base-stage AS production-stage
COPY --from=build-stage /usr/src/app/.output/public ./dist
RUN npm i -g http-server

ARG PORT=3000
ENV PORT=${PORT}

WORKDIR /usr/src/app/dist

CMD http-server -p $PORT -c-1 --proxy="http://127.0.0.1:$PORT/index.html?"
