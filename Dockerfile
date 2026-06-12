FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY proto/ proto/
COPY src/ src/
RUN npx tsc

FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist/ dist/
COPY proto/ proto/
USER appuser
EXPOSE 10000
EXPOSE 10001
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
