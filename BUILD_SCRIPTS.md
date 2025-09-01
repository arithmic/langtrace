# 🐳 Docker Build Scripts

This directory contains multiple Docker build and push scripts optimized for different platforms.

## 📁 Available Scripts

### 1. `build-and-push.sh` (macOS/Original)
- **Platform**: macOS optimized
- **Target**: linux/amd64
- **Features**: Basic build and push with macOS-specific checks

```bash
./build-and-push.sh [tag]
```

### 2. `build-and-push-linux.sh` (Linux Optimized)  
- **Platform**: Linux optimized
- **Target**: linux/amd64
- **Features**: Linux-specific system checks, resource monitoring, cleanup

```bash
./build-and-push-linux.sh [tag]
```

### 3. `build-and-push-universal.sh` (Cross-Platform)
- **Platform**: macOS, Linux, Windows (WSL/Git Bash)
- **Target**: Configurable (linux/amd64, linux/arm64, etc.)
- **Features**: Auto OS detection, multi-platform builds, Docker Buildx support

```bash
./build-and-push-universal.sh [tag] [platform]
```

## 🚀 Usage Examples

### Quick Start (Any Platform)
```bash
# Use universal script (recommended)
./build-and-push-universal.sh

# Or platform-specific
./build-and-push-linux.sh        # On Linux
./build-and-push.sh              # On macOS
```

### Advanced Usage
```bash
# Build specific version
./build-and-push-universal.sh v1.2.3

# Build for ARM64 (Apple Silicon, ARM servers)
./build-and-push-universal.sh latest linux/arm64

# Build for multiple architectures
./build-and-push-universal.sh v1.0.0 linux/amd64
```

## ⚙️ Configuration

**Before running any script**, update the configuration in the script:

```bash
# Edit any of the scripts and update:
DOCKERHUB_USERNAME="your-username"      # Your DockerHub username
REPOSITORY_NAME="your-repo-name"        # Your repository name
```

## 🎯 Platform Targets

| Platform | Architecture | Use Case |
|----------|--------------|----------|
| `linux/amd64` | x86_64 | Most cloud providers, Intel/AMD servers |
| `linux/arm64` | ARM64 | Apple Silicon, ARM servers, AWS Graviton |
| `linux/arm/v7` | ARMv7 | Raspberry Pi, IoT devices |

## 🔍 Features Comparison

| Feature | Original | Linux | Universal |
|---------|----------|-------|-----------|
| macOS Support | ✅ | ❌ | ✅ |
| Linux Support | ⚠️ | ✅ | ✅ |
| Windows Support | ❌ | ❌ | ✅ |
| Multi-platform Build | ❌ | ❌ | ✅ |
| Resource Monitoring | ❌ | ✅ | ✅ |
| Auto Cleanup | ❌ | ✅ | ✅ |
| Docker Buildx | ❌ | ✅ | ✅ |

## 📋 Prerequisites

### All Scripts
- Docker installed and running
- DockerHub account and login (`docker login`)
- Dockerfile in current directory

### Universal Script Additional
- Docker Buildx (for multi-platform builds)
- Sufficient disk space (2GB+ recommended)
- 4GB+ RAM recommended

## 🛠️ Troubleshooting

### Common Issues

1. **"Docker not running"**
   ```bash
   # macOS
   open -a Docker
   
   # Linux
   sudo systemctl start docker
   
   # Windows
   # Start Docker Desktop
   ```

2. **"Not logged into DockerHub"**
   ```bash
   docker login
   ```

3. **"Permission denied"**
   ```bash
   chmod +x build-and-push*.sh
   ```

4. **"Buildx not found"**
   ```bash
   # Install Docker Buildx
   docker buildx install
   ```

### Platform-Specific Notes

#### Linux
- May need `sudo` for Docker commands
- Ensure user is in `docker` group: `sudo usermod -aG docker $USER`

#### macOS  
- Ensure Docker Desktop is running
- May need to allocate more resources in Docker Desktop settings

#### Windows
- Use WSL2 or Git Bash
- Ensure Docker Desktop WSL integration is enabled

## 📤 After Build

Your Docker image will be available at:
- **DockerHub**: `https://hub.docker.com/r/your-username/your-repo`
- **Pull Command**: `docker pull your-username/your-repo:latest`
- **Run Command**: `docker run -p 3000:3000 your-username/your-repo:latest`

## 🌟 Recommended Usage

For most users, use the **Universal script**:
```bash
./build-and-push-universal.sh
```

It automatically detects your OS and uses the best build method available.