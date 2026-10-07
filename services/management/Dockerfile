FROM node:22-alpine AS build
WORKDIR /app/services/management
COPY services/management/package*.json ./
RUN npm install -g npm@11 && npm ci
COPY services/management/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production CONTRACTS_DIR=/app/contracts
WORKDIR /app/services/management
COPY --from=build /app/services/management/node_modules ./node_modules
COPY --from=build /app/services/management/dist ./dist
COPY --from=build /app/services/management/ui ./ui
COPY --from=build /app/services/management/package.json ./
COPY contracts /app/contracts
EXPOSE 3100
CMD ["node", "dist/main.js"]
