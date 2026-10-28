# SWE Mock Interview — frontend (Next.js production build). Built from frontend/ context.
FROM node:20-slim

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

EXPOSE 3000
# BACKEND_ORIGIN (docker-compose: http://backend:8000) drives next.config.ts rewrites
CMD ["npm", "run", "start"]
