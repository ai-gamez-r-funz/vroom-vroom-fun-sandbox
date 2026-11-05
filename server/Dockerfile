# Build from the repository root (the server shares code from ../shared):
#   docker build -f server/Dockerfile -t vroom-server .
#   docker run -p 8787:8787 -v vroom-data:/app/server/data vroom-server
FROM node:22-alpine
WORKDIR /app
COPY shared ./shared
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/*.js ./server/
ENV PORT=8787
EXPOSE 8787
WORKDIR /app/server
CMD ["node", "index.js"]
