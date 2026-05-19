FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4317
ENV ARTIFACT_TOOL_NODE_MODULES=/app/node_modules

COPY package*.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 4317
CMD ["npm", "start"]
