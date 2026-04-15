# syntax=docker/dockerfile:1
FROM python:3.13-slim

# Install uv for fast dependency resolution
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

# Install dependencies first (layer cache)
COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt

# Copy application
COPY . .

# Ensure data directory exists (bind mount target)
RUN mkdir -p /data

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/settings')" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
