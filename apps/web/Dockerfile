FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG VITE_API_URL=http://localhost:8001
ARG VITE_WHISPER_MODEL=small.en
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_WHISPER_MODEL=${VITE_WHISPER_MODEL}
RUN npm run build

FROM nginx:1.28-alpine

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
