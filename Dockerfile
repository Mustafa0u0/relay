# Two stages so the image carries the built server and not the toolchain.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public

# Rooms are written here. Mount a volume over it, or they go when the
# container does.
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "dist/main.js"]
