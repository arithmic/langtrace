# 🐳 Langtrace Docker Usage

This document explains how to use the Langtrace Docker image for both development and deployment.

## 📋 Prerequisites

- Docker installed on your system
- Docker Compose installed
- 8GB+ RAM recommended
- Ports 3000, 5432, 8123, 9000 available

## 🚀 Quick Start (Using Public Image)

### Option 1: Using Docker Compose (Recommended)

1. **Download the docker-compose file**:
   ```bash
   curl -O https://raw.githubusercontent.com/your-repo/langtrace/main/docker-compose.public.yml
   ```

2. **Update the image name** in `docker-compose.public.yml`:
   ```yaml
   langtrace:
     image: your-dockerhub-username/langtrace:latest  # Update this line
   ```

3. **Start all services**:
   ```bash
   docker-compose -f docker-compose.public.yml up -d
   ```

4. **Access Langtrace**:
   - Web UI: http://localhost:3000
   - Admin Login: admin@langtrace.ai / langtraceadminpw

### Option 2: Manual Docker Run

1. **Start PostgreSQL**:
   ```bash
   docker run -d --name langtrace-postgres \
     -e POSTGRES_USER=ltuser \
     -e POSTGRES_PASSWORD=ltpasswd \
     -e POSTGRES_DB=langtrace \
     -p 5432:5432 \
     postgres:15
   ```

2. **Start ClickHouse**:
   ```bash
   docker run -d --name langtrace-clickhouse \
     -e CLICKHOUSE_USER=lt_clickhouse_user \
     -e CLICKHOUSE_PASSWORD=clickhousepw \
     -p 8123:8123 -p 9000:9000 \
     clickhouse/clickhouse-server:24.1
   ```

3. **Start Langtrace** (replace with your image):
   ```bash
   docker run -d --name langtrace-app \
     --link langtrace-postgres:postgres \
     --link langtrace-clickhouse:clickhouse \
     -e POSTGRES_HOST="langtrace-postgres:5432" \
     -e CLICK_HOUSE_HOST="http://langtrace-clickhouse:8123" \
     -p 3000:3000 \
     your-dockerhub-username/langtrace:latest
   ```

## 🛠️ API Endpoints (No Authentication Required)

Once running, these APIs are available for agent integration:

### Agent Management
```bash
# Create/get agent mapping
curl "http://localhost:3000/api/v1/agents?agent_name=my_bot"

# List all agents
curl "http://localhost:3000/api/v1/agents/list"
```

### Project Management
```bash
# Create project
curl -X POST "http://localhost:3000/api/v1/projects/create" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Project","type":"agent"}'

# Generate API key
curl -X POST "http://localhost:3000/api/v1/api-keys/generate" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"your_project_id"}'
```

### Hierarchical Traces
```bash
# Get traces with parent-child relationships
curl -X POST "http://localhost:3000/api/v1/get-traces" \
  -H "Content-Type: application/json" \
  -d '{"page":1,"pageSize":10,"projectId":"your_project_id"}'
```

## 🔧 Environment Variables

Key environment variables you can customize:

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST` | `langtrace-postgres:5432` | PostgreSQL connection |
| `CLICK_HOUSE_HOST` | `http://langtrace-clickhouse:8123` | ClickHouse connection |
| `NEXT_PUBLIC_HOST` | `http://localhost:3000` | Application URL |
| `ADMIN_EMAIL` | `admin@langtrace.ai` | Admin login email |
| `ADMIN_PASSWORD` | `langtraceadminpw` | Admin login password |

## 📊 Health Checks

Check if services are running:

```bash
# Check Langtrace app
curl http://localhost:3000/api/health

# Check PostgreSQL
docker exec langtrace-postgres pg_isready

# Check ClickHouse  
curl http://localhost:8123/ping
```

## 🗂️ Data Persistence

Data is persisted in Docker volumes:
- `postgres_data`: PostgreSQL data
- `clickhouse_data`: ClickHouse data

To backup:
```bash
docker run --rm -v postgres_data:/data -v $(pwd):/backup alpine tar czf /backup/postgres_backup.tar.gz /data
docker run --rm -v clickhouse_data:/data -v $(pwd):/backup alpine tar czf /backup/clickhouse_backup.tar.gz /data
```

## 🔍 Troubleshooting

### Common Issues

1. **Port conflicts**: Change ports in docker-compose.yml
2. **Memory issues**: Increase Docker memory limit (8GB+)
3. **Database connection fails**: Wait 30s for databases to initialize

### View Logs
```bash
# All services
docker-compose -f docker-compose.public.yml logs -f

# Specific service
docker logs langtrace-app -f
```

### Reset Everything
```bash
docker-compose -f docker-compose.public.yml down -v
docker-compose -f docker-compose.public.yml up -d
```

## 🌐 Production Deployment

For production use:

1. **Change default passwords**
2. **Use environment-specific configs**
3. **Set up SSL/TLS**
4. **Configure reverse proxy**
5. **Set up monitoring**

Example production environment:
```bash
export ADMIN_PASSWORD="your-secure-password"
export NEXTAUTH_SECRET="your-secure-secret"
export POSTGRES_PASSWORD="your-db-password"
```

## 📈 Scaling

For high-load scenarios:
- Use external PostgreSQL/ClickHouse instances
- Scale horizontally with load balancer
- Use Redis for session storage
- Monitor with Prometheus/Grafana

## 🆘 Support

- GitHub Issues: [your-repo-url]
- Documentation: [your-docs-url]
- Docker Hub: [your-dockerhub-url]