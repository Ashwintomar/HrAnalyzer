## Multi-stage Dockerfile for hr-analyzer
# - Builds a minimal production image
# - Listens on $PORT (Railway/Koyeb provide this env var)

# Use an official Node.js runtime as the base image
FROM node:20-bullseye-slim AS base

# Create app directory
WORKDIR /usr/src/app

# System deps required for native addons (better-sqlite3 / sqlite-vec) if prebuild not available
RUN apt-get update && apt-get install -y --no-install-recommends \
		build-essential \
		python3 \
		ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Copy only package manifests first (leverage Docker layer caching)
COPY package.json package-lock.json* ./

# Install dependencies (production only). If a lockfile exists use fast, reliable 'npm ci';
# otherwise fall back to 'npm install' (generates a lockfile) so first deploy without
# committed package-lock.json still succeeds on Railway.
RUN if [ -f package-lock.json ]; then \
			echo "✅ package-lock.json found -> using npm ci" && \
			npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund ; \
		else \
			echo "⚠️  No package-lock.json found -> using npm install (please commit the lockfile for reproducible builds)" && \
			npm install --omit=dev --no-audit --no-fund && \
			npm prune --omit=dev ; \
		fi

############################################
# Application source
############################################

# Copy application source
COPY . .

# Expose the port (optional metadata - actual binding uses $PORT)
EXPOSE 3000

# Ensure Node uses production mode unless overridden
ENV NODE_ENV=production

# Default PORT used by the app if not provided by platform
ENV PORT=3000

# Ensure non-root user can read/write (e.g., SQLite DB files created at runtime)
RUN chown -R node:node /usr/src/app

# Drop privileges (optional improvement) - after chown
USER node

# Start the app
CMD ["node", "index.js"]
