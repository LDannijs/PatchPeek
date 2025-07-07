FROM node:20-alpine	

WORKDIR /app

# Use --chown to avoid separate chown step
COPY --chown=node:node package*.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev

COPY --chown=node:node . .

EXPOSE 3000

# Set the user to root
USER root

# Run the app
CMD ["node", "server.mjs"]
