.PHONY: help build up down restart logs clean status install dev

# Detect container compose tool (docker compose, docker-compose, podman-compose, podman compose)
COMPOSE ?= $(shell if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then echo "docker compose"; \
             elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; \
             elif command -v podman-compose >/dev/null 2>&1; then echo "podman-compose"; \
             elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then echo "podman compose"; \
             else echo "docker-compose"; fi)

CONTAINER_CLI ?= $(shell if command -v docker >/dev/null 2>&1; then echo "docker"; \
                   elif command -v podman >/dev/null 2>&1; then echo "podman"; \
                   else echo "docker"; fi)

# Default target
help:
	@echo "Available commands:"
	@echo "  make install  - Install local npm dependencies"
	@echo "  make dev      - Run bot in development mode (tsx)"
	@echo "  make build    - Build container image"
	@echo "  make up       - Start the bot container in background"
	@echo "  make down     - Stop the bot container"
	@echo "  make restart  - Restart the bot container"
	@echo "  make logs     - Show bot container logs (live)"
	@echo "  make clean    - Remove containers, images, and volumes"
	@echo "  make status   - Show container status"
	@echo ""
	@echo "Detected compose engine: $(COMPOSE)"

# Local Development
install:
	npm install

dev:
	npm run dev

# Build container image
build:
	@echo "Building container image using $(COMPOSE)..."
	$(COMPOSE) build

# Start the bot
up:
	@echo "Starting Always Voice Bot using $(COMPOSE)..."
	$(COMPOSE) up -d
	@echo "Bot started! Use 'make logs' to see output."

# Stop the bot
down:
	@echo "Stopping Always Voice Bot..."
	$(COMPOSE) down

# Restart the bot
restart:
	@echo "Restarting Always Voice Bot..."
	$(COMPOSE) restart
	@echo "Bot restarted!"

# Show logs
logs:
	@echo "Showing logs (Ctrl+C to exit)..."
	$(COMPOSE) logs -f

# Clean everything
clean:
	@echo "Cleaning up containers, images, and volumes..."
	$(COMPOSE) down -v
	$(CONTAINER_CLI) rmi always-voice 2>/dev/null || true
	@echo "Cleanup complete!"

# Show container status
status:
	@echo "Container status:"
	$(COMPOSE) ps
