FROM node:22-alpine AS server
WORKDIR /app
RUN npm install express ws
COPY server.js ./
EXPOSE 3000

FROM nginx:alpine AS ui
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY ui/ /usr/share/nginx/html
