# Stage 1: Build
FROM node:22-alpine as build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build -- --configuration=production

# Stage 2: Serve with Nginx
FROM nginx:alpine
# Remove default config
RUN rm /etc/nginx/conf.d/default.conf
# Copy as template so envsubst replaces ${PORT} at runtime
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist/app_proyeccion_moden/browser /usr/share/nginx/html
# Default PORT for local Docker; Railway overrides this
ENV PORT=80
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
