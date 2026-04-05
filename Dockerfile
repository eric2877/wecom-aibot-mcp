FROM node:18-alpine

WORKDIR /app

# Install dependencies
RUN apk add --no-cache curl jq bash

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build
RUN npm run build

# Create config directory
RUN mkdir -p /root/.wecom-aibot-mcp

# Set environment
ENV NODE_ENV=production

# Entry point
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["--help"]