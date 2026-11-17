#!/usr/bin/env bash
set -e

echo "=========================================="
echo "🚀 Deploying NOC Website Monitoring..."
echo "=========================================="

APP_DIR="/var/www/noc-monitor"

# Ensure directory exists
if [ ! -d "$APP_DIR" ]; then
    echo "❌ Directory $APP_DIR does not exist."
    exit 1
fi

cd "$APP_DIR"

# Pull latest code from git
echo "📥 Pulling latest changes from main branch..."
git fetch origin main
git reset --hard origin/main

# Install dependencies (compiles native SQLite if needed)
echo "📦 Installing production dependencies..."
npm install --production

# Restart or reload process with PM2
echo "🔄 Reloading PM2 service (zero downtime)..."
if pm2 describe noc-monitor > /dev/null 2>&1; then
    pm2 reload ecosystem.config.js --update-env
else
    pm2 start ecosystem.config.js
fi
pm2 save

# Wait and verify health check endpoint
echo "🩺 Running local health check verification..."
sleep 3
if curl -sf http://127.0.0.1:3000/health > /dev/null; then
    echo "=========================================="
    echo "✅ Deployment successful! Service is healthy."
    echo "=========================================="
else
    echo "❌ Health check failed after deployment!"
    pm2 logs noc-monitor --lines 30 --nostream
    exit 1
fi
