FROM node:20-bookworm

WORKDIR /usr/src/app

# Run with plain node - clustering and restart behavior is handled inside the app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
