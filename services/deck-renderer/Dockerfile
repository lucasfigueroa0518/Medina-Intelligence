FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4317

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 4317
CMD ["npm", "start"]
