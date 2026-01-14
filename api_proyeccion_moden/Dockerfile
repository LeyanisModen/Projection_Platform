FROM python:3.11-slim

# Evitar que Python genere archivos .pyc y que el buffer se llene
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

WORKDIR /app

# Instalar dependencias de sistema necesarias para psycopg2 y otras herramientas
RUN apt-get update && apt-get install -y \
    libpq-dev \
    gcc \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Instalar dependencias de Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el resto del código
COPY . .

# Exponer el puerto de Django
EXPOSE 8000

# Comando para iniciar el servidor
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
