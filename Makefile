.PHONY: help build up down restart logs logs-bot logs-nodelink nodelink clean status install dev

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
	@echo "  make dev            - Run bot locally (starts NodeLink in background first)"
	@echo "  make nodelink       - Start only the NodeLink audio server in background"
	@echo "  make build          - Pull NodeLink image & build bot container"
	@echo "  make up             - Build & start both bot & NodeLink containers in background"
	@echo "  make down           - Stop both bot & NodeLink containers"
	@echo "  make restart        - Restart all containers"
	@echo "  make logs           - Show live logs of all containers"
	@echo "  make logs-bot       - Show live logs of the bot only"
	@echo "  make logs-nodelink  - Show live logs of the NodeLink server only"
	@echo "  make clean          - Remove containers, images, and volumes"
	@echo "  make status         - Show container status"
	@echo ""
	@echo "Detected compose engine: $(COMPOSE)"

# Local Development
install:
	npm install

dev:
	@echo "Ensuring NodeLink audio node is running..."
	$(COMPOSE) up -d nodelink
	NODELINK_HOST=localhost NODELINK_PORT=3000 npm run dev

# Start only NodeLink audio server
nodelink:
	@echo "Starting NodeLink audio node using $(COMPOSE)..."
	$(COMPOSE) up -d nodelink
	@echo "NodeLink started on port 3000 (and mapped 2333)."

# Build container image & pull NodeLink
build:
	@echo "Pulling NodeLink image and building bot container using $(COMPOSE)..."
	@mkdir -p data && chmod 777 data 2>/dev/null || true
	$(COMPOSE) pull nodelink 2>/dev/null || true
	$(COMPOSE) build

# Start the bot & NodeLink (always builds if code changed)
up:
	@echo "Starting Always Voice Bot & NodeLink using $(COMPOSE)..."
	@mkdir -p data && chmod 777 data 2>/dev/null || true
	$(COMPOSE) up -d --build
	@echo "Containers started! Use 'make logs' or 'make logs-bot' to see output."

# Stop everything
down:
	@echo "Stopping bot and NodeLink containers..."
	$(COMPOSE) down

# Restart everything
restart:
	@echo "Restarting containers..."
	$(COMPOSE) restart
	@echo "Containers restarted!"

# Show all logs
logs:
	@echo "Showing all container logs (Ctrl+C to exit)..."
	$(COMPOSE) logs -f

# Show bot logs only
logs-bot:
	@echo "Showing bot logs (Ctrl+C to exit)..."
	$(COMPOSE) logs -f always-voice

# Show NodeLink logs only
logs-nodelink:
	@echo "Showing NodeLink server logs (Ctrl+C to exit)..."
	$(COMPOSE) logs -f nodelink

# Clean everything: containers, networks, volumes, and images
clean:
	@echo "Cleaning up containers, images, and volumes..."
	$(COMPOSE) down -v --rmi all --remove-orphans
	@echo "Cleanup complete!"

# Show container status
status:
	@echo "Container status:"
	$(COMPOSE) ps
