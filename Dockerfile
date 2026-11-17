FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY backend ./backend
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
