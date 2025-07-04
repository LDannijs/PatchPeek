# Use Node.js base image
FROM node:20

# Create app directory
WORKDIR /app

COPY public ./public

# Copy package files and install deps
COPY package*.json ./
ENV NODE_ENV=production
RUN npm install

# Copy the rest of your app
COPY . .

# Expose port (same as your app)
EXPOSE 3000

# Run the app
CMD ["node", "server.mjs"]
