# Build from the repo root: `docker build -f backend/Dockerfile .`
# The repo root context (not just backend/) is required because app/main.py
# imports data/synthetic_alert_generator.py by walking up from its own path
# (Path(__file__).resolve().parents[2] / "data") - that only resolves if
# backend/ and data/ sit side by side inside the image the same way they do
# in the repo.
FROM python:3.11-slim

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY data/ data/

WORKDIR /app/backend
ENV PYTHONUNBUFFERED=1

# Render (and most hosts) inject $PORT; default it for a plain `docker run`.
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
