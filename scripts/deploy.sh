#!/usr/bin/env bash
set -e

# Load environment & PATH for non-interactive SSH
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh" 2>/dev/null || true
[ -s "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true
[ -s "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null || true

echo "=========================================="
echo "🚀 Deploying NOC Website Monitoring..."
echo "=========================================="

APP_DIR="/var/www/noc-monitor"

if [ ! -d "$APP_DIR" ]; then
    echo "📁 Creating app directory $APP_DIR..."
    mkdir -p "$APP_DIR"
fi

cd "$APP_DIR"

# Ensure Git repository is set up
if [ ! -d ".git" ]; then
    echo "📥 First-time setup: cloning repository..."
    cd /var/www
    rm -rf "$APP_DIR"
    git clone https://github.com/paulchike/Website-monitoring.git noc-monitor
    cd "$APP_DIR"
else
    echo "📥 Pulling latest changes from main branch..."
    git fetch origin main
    git reset --hard origin/main
fi

# Ensure PM2 is available
if ! command -v pm2 &> /dev/null; then
    echo "📦 PM2 not found, installing PM2 globally..."
    npm install -g pm2
fi

# Install dependencies (compiles native SQLite if needed)
echo "📦 Installing production dependencies..."
npm install --production

# Sync production targets into SQLite database
if [ -f "scripts/sync-targets.js" ]; then
    echo "🎯 Synchronizing production monitoring targets..."
    node scripts/sync-targets.js
fi

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
    echo "⚠️ Direct localhost check pending, retrying in 3 seconds..."
    sleep 3
    if curl -sf http://127.0.0.1:3000/health > /dev/null; then
        echo "=========================================="
        echo "✅ Deployment successful! Service is healthy."
        echo "=========================================="
    else
        echo "❌ Health check failed after deployment!"
        pm2 logs noc-monitor --lines 30 --nostream || true
        exit 1
    fi
fi
