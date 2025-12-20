.PHONY: help build up down restart logs clean setup

# Default target
help:
	@echo "Available commands:"
	@echo "  make build    - Build Docker image"
	@echo "  make up       - Start the bot in background"
	@echo "  make down     - Stop the bot"
	@echo "  make restart  - Restart the bot"
	@echo "  make logs     - Show bot logs (live)"
	@echo "  make clean    - Remove containers, images, and volumes"
	@echo "  make status   - Show container status"

# Build Docker image
build:
	@echo "Building Docker image..."
	docker-compose build

# Start the bot
up:
	@echo "Starting Always Voice Bot..."
	docker-compose up -d
	@echo "Bot started! Use 'make logs' to see output."

# Stop the bot
down:
	@echo "Stopping Always Voice Bot..."
	docker-compose down

# Restart the bot
restart:
	@echo "Restarting Always Voice Bot..."
	docker-compose restart
	@echo "Bot restarted!"

# Show logs
logs:
	@echo "Showing logs (Ctrl+C to exit)..."
	docker-compose logs -f

# Clean everything
clean:
	@echo "Cleaning up containers, images, and volumes..."
	docker-compose down -v
	docker rmi always-voice 2>/dev/null || true
	@echo "Cleanup complete!"

# Show container status
status:
	@echo "Container status:"
	docker-compose ps