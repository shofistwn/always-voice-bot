.PHONY: help build up down restart logs clean status install dev

# Default target
help:
	@echo "Available commands:"
	@echo "  make install  - Install local npm dependencies"
	@echo "  make dev      - Run bot in development mode (tsx)"
	@echo "  make build    - Build Docker image (or compile TypeScript)"
	@echo "  make up       - Start the bot container in background"
	@echo "  make down     - Stop the bot container"
	@echo "  make restart  - Restart the bot container"
	@echo "  make logs     - Show bot container logs (live)"
	@echo "  make clean    - Remove containers, images, and volumes"
	@echo "  make status   - Show container status"

# Local Development
install:
	npm install

dev:
	npm run dev

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
