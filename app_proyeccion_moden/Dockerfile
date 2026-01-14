# Stage 1: Build
FROM node:22 AS build

WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copiar código y construir aplicación
COPY . .
RUN npm run build --configuration=production

# Stage 2: Serve
FROM nginx:stable-alpine

# Copiar configuración personalizada de Nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copiar los archivos construidos desde la etapa anterior
COPY --from=build /app/dist/app_proyeccion_moden/browser /usr/share/nginx/html

# Exponer el puerto 80 para Nginx
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
