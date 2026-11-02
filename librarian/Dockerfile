# Alexandria Librarian - Dockerfile

FROM node:20-alpine

WORKDIR /app

# Install git for MCP repository management
RUN apk add --no-cache git

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Copy admin GUI
COPY ../library/admin-gui ./admin-gui

# Create MCP modules directory
RUN mkdir -p /app/mcp-modules

# Build
RUN npm run build

# Expose port (default 8090)
EXPOSE 8090

# Run
CMD ["node", "dist/index.js"]
