#!/bin/bash

# Universal Build and Push Docker Image Script for Langtrace
# Works on macOS, Linux, and Windows (with WSL/Git Bash)
# Usage: ./build-and-push-universal.sh [tag] [platform]

set -e  # Exit on any error

# Configuration - CHANGE THESE VALUES
DOCKERHUB_USERNAME="kuldeeparithmic"  # Replace with your DockerHub username
REPOSITORY_NAME="folium-langtrace"
DEFAULT_TAG="latest"
DEFAULT_PLATFORM="linux/amd64"

# Colors for output (Universal compatibility)
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    PURPLE='\033[0;35m'
    CYAN='\033[0;36m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    PURPLE=''
    CYAN=''
    NC=''
fi

# Detect OS
detect_os() {
    case "$OSTYPE" in
        darwin*)  OS="macOS" ;;
        linux*)   OS="Linux" ;;
        msys*|mingw*|cygwin*) OS="Windows" ;;
        *) OS="Unknown" ;;
    esac
}

# Get arguments
TAG=${1:-$DEFAULT_TAG}
PLATFORM=${2:-$DEFAULT_PLATFORM}
IMAGE_NAME="$DOCKERHUB_USERNAME/$REPOSITORY_NAME"
FULL_IMAGE_NAME="$IMAGE_NAME:$TAG"

detect_os

echo -e "${BLUE}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║      Langtrace Universal Docker Builder      ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════╝${NC}"
echo -e "${CYAN}Repository: $FULL_IMAGE_NAME${NC}"
echo -e "${CYAN}Platform: $PLATFORM${NC}"
echo -e "${CYAN}OS: $OS${NC}"
echo

# Check if Docker is running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo -e "${RED}❌ Error: Docker is not running.${NC}"
        case "$OS" in
            "macOS")
                echo -e "${YELLOW}   Try: Open Docker Desktop application${NC}"
                ;;
            "Linux")
                echo -e "${YELLOW}   Try: sudo systemctl start docker${NC}"
                echo -e "${YELLOW}   Or: sudo service docker start${NC}"
                ;;
            "Windows")
                echo -e "${YELLOW}   Try: Start Docker Desktop${NC}"
                ;;
        esac
        exit 1
    fi
}

# Check if logged into DockerHub
check_docker_login() {
    # Different methods for different OS
    local is_logged_in=false
    
    if docker system info 2>/dev/null | grep -q "Username:"; then
        is_logged_in=true
    elif [[ -f "$HOME/.docker/config.json" ]] && grep -q "auths" "$HOME/.docker/config.json"; then
        is_logged_in=true
    fi
    
    if [[ "$is_logged_in" != "true" ]]; then
        echo -e "${YELLOW}⚠️  You're not logged into DockerHub.${NC}"
        read -p "Do you want to login now? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            docker login
        else
            echo -e "${RED}❌ Cannot proceed without DockerHub login${NC}"
            exit 1
        fi
    fi
}

# Check system resources (cross-platform)
check_resources() {
    echo -e "${CYAN}💻 System Information:${NC}"
    
    case "$OS" in
        "macOS")
            echo -e "   OS: macOS $(sw_vers -productVersion)"
            echo -e "   Memory: $(system_profiler SPHardwareDataType | grep "Memory:" | awk '{print $2 $3}')"
            echo -e "   Disk: $(df -h . | tail -1 | awk '{print $4 " available"}')"
            ;;
        "Linux")
            if [[ -f /proc/meminfo ]]; then
                echo -e "   Memory: $(free -h | awk 'NR==2{printf \"%.1fGB total\", $2/1024/1024}')"
            fi
            echo -e "   Disk: $(df -h . | tail -1 | awk '{print $4 " available"}')"
            ;;
        "Windows")
            echo -e "   Platform: Windows (WSL/Git Bash)"
            echo -e "   Disk: $(df -h . 2>/dev/null | tail -1 | awk '{print $4 " available"}' || echo "Unable to determine")"
            ;;
    esac
}

# Main execution
main() {
    check_docker
    check_docker_login
    check_resources
    
    # Validate configuration
    if [[ "$DOCKERHUB_USERNAME" == "your-username" ]]; then
        echo -e "${RED}❌ Error: Please update DOCKERHUB_USERNAME in the script${NC}"
        exit 1
    fi
    
    # Check if Dockerfile exists
    if [[ ! -f "Dockerfile" ]]; then
        echo -e "${RED}❌ Error: Dockerfile not found in current directory${NC}"
        exit 1
    fi
    
    echo
    echo -e "${BLUE}🏗️  Building Docker image...${NC}"
    echo -e "${YELLOW}Platform: $PLATFORM${NC}"
    echo
    
    # Choose build method based on platform requirements
    if [[ "$PLATFORM" != "linux/amd64" ]] || docker buildx version >/dev/null 2>&1; then
        # Use buildx for multi-platform or when available
        echo -e "${CYAN}Using Docker Buildx (recommended)${NC}"
        
        # Create builder if needed
        if ! docker buildx ls | grep -q "langtrace-builder"; then
            docker buildx create --name langtrace-builder --use 2>/dev/null || true
        fi
        
        docker buildx build \
            --platform "$PLATFORM" \
            -t "$FULL_IMAGE_NAME" \
            --load \
            .
    else
        # Fallback to regular build
        echo -e "${CYAN}Using standard Docker build${NC}"
        docker build -t "$FULL_IMAGE_NAME" .
    fi
    
    if [[ $? -eq 0 ]]; then
        echo -e "${GREEN}✅ Docker image built successfully!${NC}"
    else
        echo -e "${RED}❌ Docker build failed${NC}"
        exit 1
    fi
    
    # Tag as latest if not already
    if [[ "$TAG" != "latest" ]]; then
        docker tag "$FULL_IMAGE_NAME" "$IMAGE_NAME:latest"
        echo -e "${GREEN}✅ Tagged as latest${NC}"
    fi
    
    echo
    echo -e "${BLUE}📤 Pushing to DockerHub...${NC}"
    
    # Push images
    docker push "$FULL_IMAGE_NAME"
    if [[ "$TAG" != "latest" ]]; then
        docker push "$IMAGE_NAME:latest"
    fi
    
    echo
    echo -e "${GREEN}🎉 Success! Image pushed to DockerHub${NC}"
    echo -e "${BLUE}📋 Deployment Information:${NC}"
    echo -e "   Repository: https://hub.docker.com/r/$IMAGE_NAME"
    echo -e "   Pull: ${YELLOW}docker pull $FULL_IMAGE_NAME${NC}"
    echo -e "   Run: ${YELLOW}docker run -p 3000:3000 $FULL_IMAGE_NAME${NC}"
    
    # Show image details
    echo
    echo -e "${BLUE}📊 Image Information:${NC}"
    docker images "$FULL_IMAGE_NAME" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}" 2>/dev/null || \
        docker images "$FULL_IMAGE_NAME"
    
    # Cleanup option
    echo
    read -p "Clean up dangling Docker images? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Cleaning up...${NC}"
        docker image prune -f
        echo -e "${GREEN}✅ Cleanup completed${NC}"
    fi
    
    echo
    echo -e "${GREEN}✅ Build and push completed successfully!${NC}"
    echo -e "${PURPLE}Platform: $PLATFORM${NC}"
    echo -e "${CYAN}🚀 Ready for deployment on any Docker-compatible system!${NC}"
}

# Show usage if help requested
if [[ "$1" == "-h" ]] || [[ "$1" == "--help" ]]; then
    echo "Usage: $0 [tag] [platform]"
    echo ""
    echo "Arguments:"
    echo "  tag       Docker image tag (default: latest)"
    echo "  platform  Target platform (default: linux/amd64)"
    echo ""
    echo "Examples:"
    echo "  $0                          # Build with latest tag for linux/amd64"
    echo "  $0 v1.0.0                   # Build with v1.0.0 tag for linux/amd64"
    echo "  $0 latest linux/arm64       # Build for ARM64 architecture"
    echo "  $0 v1.0.0 linux/amd64      # Build specific version for AMD64"
    echo ""
    echo "Supported platforms:"
    echo "  linux/amd64, linux/arm64, linux/arm/v7"
    exit 0
fi

# Run main function
main