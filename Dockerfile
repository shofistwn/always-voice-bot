FROM python:3.10-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY main.py .

# Create logs directory
RUN mkdir -p logs

# Set environment to unbuffered for real-time logs
ENV PYTHONUNBUFFERED=1

# Run the application
CMD ["python", "-u", "main.py"]