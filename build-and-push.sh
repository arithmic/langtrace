#!/bin/bash

# Build and Push Docker Image Script for Langtrace
# Usage: ./build-and-push.sh [tag]

set -e  # Exit on any error

# Configuration - CHANGE THESE VALUES
DOCKERHUB_USERNAME="kuldeeparithmic"  # Replace with your DockerHub username
REPOSITORY_NAME="folium-langtrace"
DEFAULT_TAG="latest"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get tag from argument or use default
TAG=${1:-$DEFAULT_TAG}
IMAGE_NAME="$DOCKERHUB_USERNAME/$REPOSITORY_NAME"
FULL_IMAGE_NAME="$IMAGE_NAME:$TAG"

echo -e "${BLUE}=== Langtrace Docker Build & Push Script ===${NC}"
echo -e "${BLUE}Repository: $FULL_IMAGE_NAME${NC}"
echo

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: Docker is not running. Please start Docker and try again.${NC}"
    exit 1
fi

# Check if logged into DockerHub
if ! docker info 2>/dev/null | grep -q "Username:"; then
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

echo -e "${BLUE}🏗️  Building Docker image...${NC}"
echo -e "${YELLOW}Command: docker build -t $FULL_IMAGE_NAME .${NC}"
echo

# Build the Docker image
docker build -t "$FULL_IMAGE_NAME" .

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

# Show image size
echo
echo -e "${BLUE}📊 Image Information:${NC}"
docker images "$FULL_IMAGE_NAME" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"

echo
echo -e "${GREEN}✅ Build and push completed successfully!${NC}"