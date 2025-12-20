FROM node:20-alpine AS base

# Install PostgreSQL client tools (pg_dump, psql) and Python with pip
RUN apk add --no-cache postgresql-client python3 py3-pip git

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

# Copy worker source files (needed for instrumentation hook to import workers)
# Next.js standalone doesn't include lib/ by default, so we need to copy it
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib

# Copy ts-node and its dependencies (needed for runtime TypeScript execution)
# The standalone build doesn't include ts-node, so we need to copy it from node_modules
RUN mkdir -p ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/ts-node ./node_modules/ts-node

# Copy ts-node's dependencies that might not be in standalone build
# Use a shell script to copy only if they exist
RUN --mount=from=builder,source=/app/node_modules,target=/tmp/node_modules \
    if [ -d /tmp/node_modules/make-error ]; then cp -r /tmp/node_modules/make-error ./node_modules/; fi && \
    if [ -d /tmp/node_modules/diff ]; then cp -r /tmp/node_modules/diff ./node_modules/; fi && \
    if [ -d /tmp/node_modules/yn ]; then cp -r /tmp/node_modules/yn ./node_modules/; fi && \
    if [ -d /tmp/node_modules/create-require ]; then cp -r /tmp/node_modules/create-require ./node_modules/; fi && \
    if [ -d /tmp/node_modules/@cspotcode ]; then cp -r /tmp/node_modules/@cspotcode ./node_modules/; fi && \
    chown -R nextjs:nodejs ./node_modules

# Install Python SDK for depth market maker
# Clone the reya-python-sdk repo and install dependencies
RUN git clone --branch feat/spot --depth 1 https://github.com/Reya-Labs/reya-python-sdk.git /app/reya-python-sdk && \
    cd /app/reya-python-sdk && \
    python3 -m venv .venv && \
    .venv/bin/pip install --no-cache-dir -e . && \
    chown -R nextjs:nodejs /app/reya-python-sdk

USER nextjs

# PORT can be overridden via environment variable, default to 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV BACKUP_DIR=/backup
ENV PYTHON_SDK_PATH=/app/reya-python-sdk

EXPOSE 3000

# Health check uses PORT environment variable (defaults to 3000)
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "const port = process.env.PORT || '3000'; require('http').get('http://localhost:' + port + '/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "server.js"]


