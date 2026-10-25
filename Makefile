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
	@echo "  make install        - Install local npm dependencies"
	@echo "  make dev            - Run bot locally in development mode"
	@echo "  make build          - Build bot container"
	@echo "  make up             - Build & start bot container in background"
	@echo "  make down           - Stop bot container"
	@echo "  make restart        - Restart bot container"
	@echo "  make logs           - Show live logs of the bot container"
	@echo "  make clean          - Remove containers, images, and volumes"
	@echo "  make status         - Show container status"
	@echo ""
	@echo "Detected compose engine: $(COMPOSE)"

# Local Development
install:
	npm install

dev:
	npm run dev

# Build container image
build:
	@echo "Building bot container using $(COMPOSE)..."
	$(COMPOSE) build

# Start the bot (always builds if code changed)
up:
	@echo "Starting Always Voice Bot using $(COMPOSE)..."
	$(COMPOSE) up -d --build
	@echo "Container started! Use 'make logs' to see output."

# Stop everything
down:
	@echo "Stopping bot container..."
	$(COMPOSE) down

# Restart container
restart:
	@echo "Restarting container..."
	$(COMPOSE) restart
	@echo "Container restarted!"

# Show logs
logs:
	@echo "Showing bot logs (Ctrl+C to exit)..."
	$(COMPOSE) logs -f

# Clean everything: containers, networks, volumes, and images
clean:
	@echo "Cleaning up containers, images, and volumes..."
	$(COMPOSE) down -v --rmi all --remove-orphans
	@echo "Cleanup complete!"

# Show container status
status:
	@echo "Container status:"
	$(COMPOSE) ps
