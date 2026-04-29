FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    adb \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --break-system-packages -r requirements.txt

COPY app.py .

EXPOSE 8080
CMD ["python3", "-u", "app.py"]
