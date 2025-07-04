# Use Node.js base image
FROM node:20

# Create app directory
WORKDIR /app

# Copy only package files first (for layer caching)
COPY package*.json ./

# Install only production dependencies
ENV NODE_ENV=production
RUN npm install --omit=dev

# Copy the rest of the application
COPY . .

# Expose port
EXPOSE 3000

# Run the app
CMD ["node", "server.js"]
