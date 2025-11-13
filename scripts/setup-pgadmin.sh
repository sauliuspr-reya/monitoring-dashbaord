#!/bin/bash
# Setup pgAdmin 4 locally using Docker
# Usage: ./scripts/setup-pgadmin.sh

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Setting up pgAdmin 4 locally"
echo "=========================================="
echo ""

# Configuration
PGADMIN_PORT="${PGADMIN_PORT:-5050}"
PGADMIN_EMAIL="${PGADMIN_EMAIL:-admin@example.com}"
PGADMIN_PASSWORD="${PGADMIN_PASSWORD:-admin}"
CONTAINER_NAME="pgadmin4"

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
  echo "❌ Docker is not running. Please start Docker first."
  exit 1
fi

# Check if container already exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo -e "${YELLOW}Container '${CONTAINER_NAME}' already exists${NC}"
  read -p "Remove existing container and recreate? (y/N): " RECREATE
  if [ "$RECREATE" = "y" ] || [ "$RECREATE" = "Y" ]; then
    echo "Stopping and removing existing container..."
    docker stop ${CONTAINER_NAME} > /dev/null 2>&1 || true
    docker rm ${CONTAINER_NAME} > /dev/null 2>&1 || true
  else
    echo "Starting existing container..."
    docker start ${CONTAINER_NAME}
    echo ""
    echo -e "${GREEN}✓ pgAdmin is starting...${NC}"
    echo ""
    echo "Access pgAdmin at: http://localhost:${PGADMIN_PORT}"
    echo "Email: ${PGADMIN_EMAIL}"
    echo "Password: ${PGADMIN_PASSWORD}"
    echo ""
    echo "To stop: docker stop ${CONTAINER_NAME}"
    echo "To view logs: docker logs -f ${CONTAINER_NAME}"
    exit 0
  fi
fi

# Create pgAdmin container
echo "Creating pgAdmin 4 container..."
docker run -d \
  --name ${CONTAINER_NAME} \
  -p ${PGADMIN_PORT}:80 \
  -e PGADMIN_DEFAULT_EMAIL="${PGADMIN_EMAIL}" \
  -e PGADMIN_DEFAULT_PASSWORD="${PGADMIN_PASSWORD}" \
  -e PGADMIN_CONFIG_SERVER_MODE='False' \
  -v pgadmin-data:/var/lib/pgadmin \
  --restart unless-stopped \
  dpage/pgadmin4:latest

if [ $? -eq 0 ]; then
  echo ""
  echo -e "${GREEN}✓ pgAdmin 4 container created successfully!${NC}"
  echo ""
  echo "=========================================="
  echo "Access Information:"
  echo "=========================================="
  echo "URL:      http://localhost:${PGADMIN_PORT}"
  echo "Email:    ${PGADMIN_EMAIL}"
  echo "Password: ${PGADMIN_PASSWORD}"
  echo ""
  echo "Waiting for pgAdmin to start (this may take 30-60 seconds)..."
  echo ""
  
  # Wait for pgAdmin to be ready
  MAX_WAIT=60
  WAIT_TIME=0
  while [ $WAIT_TIME -lt $MAX_WAIT ]; do
    if curl -s http://localhost:${PGADMIN_PORT} > /dev/null 2>&1; then
      echo -e "${GREEN}✓ pgAdmin is ready!${NC}"
      break
    fi
    echo -n "."
    sleep 2
    WAIT_TIME=$((WAIT_TIME + 2))
  done
  
  echo ""
  echo "=========================================="
  echo "Next Steps:"
  echo "=========================================="
  echo "1. Open http://localhost:${PGADMIN_PORT} in your browser"
  echo "2. Login with the credentials above"
  echo "3. Right-click 'Servers' → 'Register' → 'Server'"
  echo "4. Add your PostgreSQL databases:"
  echo "   - General tab: Name your server"
  echo "   - Connection tab: Enter host, port, database, user, password"
  echo ""
  echo "To monitor replication:"
  echo "  - Navigate to: Servers → [Your Server] → Databases → [Database] → Subscriptions"
  echo "  - View replication status and lag"
  echo ""
  echo "Useful commands:"
  echo "  Stop:    docker stop ${CONTAINER_NAME}"
  echo "  Start:   docker start ${CONTAINER_NAME}"
  echo "  Logs:    docker logs -f ${CONTAINER_NAME}"
  echo "  Remove:  docker rm -f ${CONTAINER_NAME}"
  echo ""
else
  echo "❌ Failed to create pgAdmin container"
  exit 1
fi

