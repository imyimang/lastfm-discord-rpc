FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN rm -f .env.example .gitignore

CMD ["node", "app.js"]
