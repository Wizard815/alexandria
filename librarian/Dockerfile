# Alexandria Librarian - Dockerfile

FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Build
RUN npm run build

# Expose port
EXPOSE 8080

# Run
CMD ["node", "dist/index.js"]
