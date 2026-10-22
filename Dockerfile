FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# The bridge is plain ESM, so only runtime dependencies are needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bridge ./bridge

EXPOSE 8787
USER node
CMD ["node", "bridge/server.mjs"]
