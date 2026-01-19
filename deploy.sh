#!/bin/bash
set -e

# Configuration
REMOTE_HOST="root@192.168.1.95"
REMOTE_DIR="/opt/paycallendar"
REPO_URL="https://github.com/drapik/paycallendar.git"

echo "🚀 Starting deployment to $REMOTE_HOST..."

# Deploy to remote server via SSH
ssh "$REMOTE_HOST" << 'ENDSSH'
set -e

echo "📥 Pulling latest changes from GitHub..."
cd /opt/paycallendar

# Check if directory is a git repository
if [ ! -d .git ]; then
    echo "❌ Not a git repository. Cloning..."
    cd /opt
    rm -rf paycallendar
    git clone https://github.com/drapik/paycallendar.git
    cd paycallendar
else
    # Stash any local changes
    git stash
    
    # Pull latest changes
    git pull origin main
fi

echo "🛑 Stopping current containers..."
docker compose down

echo "🔨 Building new Docker image..."
docker compose build

echo "🚀 Starting containers..."
docker compose up -d

echo "🧹 Cleaning up old Docker images..."
docker image prune -f

echo "✅ Deployment complete!"

# Check container status
echo "📊 Container status:"
docker ps | grep paycallendar || echo "⚠️  Container not running!"

ENDSSH

echo "✅ Deployment finished successfully!"
