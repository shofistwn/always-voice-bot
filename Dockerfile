FROM python:3.10-alpine

WORKDIR /app

RUN pip install --no-cache-dir websocket-client requests

COPY main.py .

CMD ["python", "-u", "main.py"]