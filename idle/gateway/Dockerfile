FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js tibia.js acessorios.js leilao.js editor.js ./
COPY public ./public
USER node
CMD ["node", "server.js"]
