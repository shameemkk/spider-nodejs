FROM node:20-bookworm

WORKDIR /usr/src/app

RUN npm install -g pm2

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["pm2-runtime", "index.js"]
