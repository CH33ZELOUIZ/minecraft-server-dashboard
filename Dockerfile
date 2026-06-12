FROM node:22-alpine
RUN apk add --no-cache bash docker-cli python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3011
CMD ["node", "server.js"]
