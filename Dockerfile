FROM node:20-alpine AS base

# Install PostgreSQL client tools (pg_dump, psql)
RUN apk add --no-cache postgresql-client

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Ensure public directory exists (Next.js requires it)
RUN mkdir -p public

# Build Next.js with standalone output
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Create backup directory
RUN mkdir -p /backup && chown -R nextjs:nodejs /backup

# Copy built application
# Copy public directory if it exists (using bind mount to check and copy conditionally)
RUN mkdir -p ./public
RUN --mount=from=builder,source=/app/public,target=/tmp/public-source \
    if [ -d /tmp/public-source ] && [ "$(ls -A /tmp/public-source 2>/dev/null)" ]; then \
      cp -r /tmp/public-source/* ./public/ && \
      chown -R nextjs:nodejs ./public; \
    fi || true
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3002

ENV PORT=3002
ENV HOSTNAME="0.0.0.0"
ENV BACKUP_DIR=/backup

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "server.js"]


