#!/bin/bash

# Build and Push Docker Image Script for Langtrace (Linux Version)
# Usage: ./build-and-push-linux.sh [tag]

set -e  # Exit on any error

# Configuration - CHANGE THESE VALUES
DOCKERHUB_USERNAME="kuldeeparithmic"  # Replace with your DockerHub username
REPOSITORY_NAME="folium-langtrace-linux"
DEFAULT_TAG="latest"

# Colors for output (Linux compatible)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get tag from argument or use default
TAG=${1:-$DEFAULT_TAG}
IMAGE_NAME="$DOCKERHUB_USERNAME/$REPOSITORY_NAME"
FULL_IMAGE_NAME="$IMAGE_NAME:$TAG"

echo -e "${BLUE}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Langtrace Docker Build & Push (Linux)    ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════╝${NC}"
echo -e "${CYAN}Repository: $FULL_IMAGE_NAME${NC}"
echo -e "${CYAN}Platform: Linux/amd64${NC}"
echo

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: Docker is not running. Please start Docker and try again.${NC}"
    echo -e "${YELLOW}   Try: sudo systemctl start docker${NC}"
    exit 1
fi

# Check if logged into DockerHub
if ! docker system info 2>/dev/null | grep -q "Username:"; then
    echo -e "${YELLOW}⚠️  You're not logged into DockerHub. Please run: docker login${NC}"
    read -p "Do you want to login now? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        docker login
    else
        echo -e "${RED}❌ Cannot proceed without DockerHub login${NC}"
        exit 1
    fi
fi

# Validate configuration
if [[ "$DOCKERHUB_USERNAME" == "your-username" ]]; then
    echo -e "${RED}❌ Error: Please update DOCKERHUB_USERNAME in the script${NC}"
    echo -e "${YELLOW}   Edit line 8: DOCKERHUB_USERNAME=\"your-actual-username\"${NC}"
    exit 1
fi

# Check if Dockerfile exists
if [[ ! -f "Dockerfile" ]]; then
    echo -e "${RED}❌ Error: Dockerfile not found in current directory${NC}"
    exit 1
fi

# Check available disk space
AVAILABLE_SPACE=$(df . | tail -1 | awk '{print $4}')
if [[ $AVAILABLE_SPACE -lt 2000000 ]]; then  # Less than 2GB
    echo -e "${YELLOW}⚠️  Warning: Low disk space detected. Docker build may fail.${NC}"
fi

# Check system resources
TOTAL_MEM=$(grep MemTotal /proc/meminfo | awk '{print $2}')
if [[ $TOTAL_MEM -lt 4000000 ]]; then  # Less than 4GB
    echo -e "${YELLOW}⚠️  Warning: Low memory detected. Build may be slow.${NC}"
fi

echo -e "${BLUE}🏗️  Building Docker image for Linux/amd64...${NC}"
echo -e "${YELLOW}Command: docker buildx build --platform linux/amd64 -t $FULL_IMAGE_NAME .${NC}"
echo

# Build the Docker image with explicit platform
if command -v docker-buildx-plugin >/dev/null 2>&1 || docker buildx version >/dev/null 2>&1; then
    # Use buildx if available (better for multi-platform)
    docker buildx build --platform linux/amd64 -t "$FULL_IMAGE_NAME" --load .
else
    # Fallback to regular build
    docker build -t "$FULL_IMAGE_NAME" .
fi

if [[ $? -eq 0 ]]; then
    echo -e "${GREEN}✅ Docker image built successfully!${NC}"
else
    echo -e "${RED}❌ Docker build failed${NC}"
    exit 1
fi

# Also tag as latest if not already latest
if [[ "$TAG" != "latest" ]]; then
    docker tag "$FULL_IMAGE_NAME" "$IMAGE_NAME:latest"
    echo -e "${GREEN}✅ Tagged as latest${NC}"
fi

echo
echo -e "${BLUE}📤 Pushing to DockerHub...${NC}"

# Push the specific tag
echo -e "${YELLOW}Pushing: $FULL_IMAGE_NAME${NC}"
docker push "$FULL_IMAGE_NAME"

# Push latest if we tagged it
if [[ "$TAG" != "latest" ]]; then
    echo -e "${YELLOW}Pushing: $IMAGE_NAME:latest${NC}"
    docker push "$IMAGE_NAME:latest"
fi

echo
echo -e "${GREEN}🎉 Success! Image pushed to DockerHub${NC}"
echo -e "${BLUE}📋 Image Details:${NC}"
echo -e "   Repository: https://hub.docker.com/r/$IMAGE_NAME"
echo -e "   Pull command: ${YELLOW}docker pull $FULL_IMAGE_NAME${NC}"
echo -e "   Run command: ${YELLOW}docker run -p 3000:3000 $FULL_IMAGE_NAME${NC}"

# Show image size and details
echo
echo -e "${BLUE}📊 Image Information:${NC}"
docker images "$FULL_IMAGE_NAME" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"

# Linux-specific optimizations info
echo
echo -e "${PURPLE}🐧 Linux Optimizations Applied:${NC}"
echo -e "   ✅ Platform: linux/amd64"
echo -e "   ✅ Multi-stage build optimization"
echo -e "   ✅ Layer caching enabled"

# Show system resource usage
echo
echo -e "${CYAN}💻 System Resources:${NC}"
echo -e "   Memory: $(free -h | awk 'NR==2{printf \"%.1fGB used / %.1fGB total (%.0f%%)\", $3/1024/1024, $2/1024/1024, $3*100/$2}')"
echo -e "   Disk: $(df -h . | awk 'NR==2{printf \"%s used / %s total (%s)\", $3, $2, $5}')"

# Cleanup dangling images
echo
read -p "Clean up dangling Docker images? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Cleaning up dangling images...${NC}"
    docker image prune -f
    echo -e "${GREEN}✅ Cleanup completed${NC}"
fi

echo
echo -e "${GREEN}✅ Build and push completed successfully!${NC}"
echo -e "${CYAN}🚀 Your image is now publicly available for deployment!${NC}"