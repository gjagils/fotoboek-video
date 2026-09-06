FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js generate.js archive.js freeze.js thailand-films.css ./
COPY assets ./assets
EXPOSE 3000
CMD ["node", "server.js"]
