FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY album-index.js server.js generate.js archive.js freeze.js refresh.js streaming.js views.js thailand-films.css ./
COPY assets ./assets
EXPOSE 3000
CMD ["node", "server.js"]
