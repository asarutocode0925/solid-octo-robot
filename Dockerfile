# Build stage: keep Vite and browser-only libraries out of the runtime image.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund
# Copy browser entry points explicitly so a wrong deployment directory fails clearly.
COPY index.html ./index.html
COPY vite.config.js ./vite.config.js
COPY client ./client
COPY shared ./shared
COPY tests ./tests
RUN test -f /app/client/main.js \
 && test -f /app/shared/game.js \
 && npm run check \
 && npm run build

# Runtime stage contains only the server and production dependencies.
FROM node:20-alpine AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY tests ./tests
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["npm", "start"]
