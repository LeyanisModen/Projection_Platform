# Usamos una imagen de Node ligera
# Force Rebuild 2
FROM node:22-alpine

WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm install

# Copiar el resto del código
COPY . .

# Construir la aplicación para producción
RUN npm run build -- --configuration=production

# Exponer el puerto (opcional, Railway lo ignora pero es buena práctica)
EXPOSE 8080

# Comando de inicio: Usamos sh -c para que se expanda la variable $PORT
CMD ["sh", "-c", "npx http-server dist/app_proyeccion_moden/browser -p $PORT --proxy http://proyeccion-backend:8000"]
