FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js generate.js ./
EXPOSE 3000
CMD ["node", "server.js"]
