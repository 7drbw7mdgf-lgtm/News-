FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY . .
RUN useradd --create-home --uid 10001 pheme && mkdir -p /tmp/pheme-reader && chown -R pheme:pheme /tmp/pheme-reader
USER pheme
EXPOSE 8080
CMD ["python", "-u", "backend/server.py"]
