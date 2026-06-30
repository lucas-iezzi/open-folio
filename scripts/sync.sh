#!/bin/bash
# Run this from your LOCAL machine, not from inside the SSH session.
# It syncs the database and images between local and the production server.

SERVER=root@24.144.117.207
LOCAL_DB="$(dirname "$0")/../data/portfolio.db"
LOCAL_IMAGES="$(dirname "$0")/../public/images/"
# Double quotes prevent local ~ expansion — tilde is expanded on the remote server
REMOTE_DB="$SERVER:~/portfolio/data/portfolio.db"
REMOTE_IMAGES="$SERVER:~/portfolio/public/images/"

echo ""
echo "Sync portfolio — which direction?"
echo "  1) Push local → server  (overwrites server DB and images)"
echo "  2) Pull server → local  (overwrites local DB)"
echo ""
read -p "Enter 1 or 2: " choice

if [ "$choice" = "1" ]; then
    echo ""
    echo "Ensuring remote directories exist..."
    ssh "$SERVER" 'mkdir -p ~/portfolio/data ~/portfolio/public/images/projects ~/portfolio/public/images/logos ~/portfolio/public/images/studio-temp' || { echo "ERROR: SSH mkdir failed. Check server connection."; exit 1; }
    echo ""
    echo "Pushing DB..."
    rsync -avz "$LOCAL_DB" "$REMOTE_DB" || { echo "ERROR: DB sync failed."; exit 1; }
    echo ""
    echo "Pushing images (new project folders will be created automatically)..."
    rsync -avz "$LOCAL_IMAGES" "$REMOTE_IMAGES" || { echo "ERROR: Image sync failed."; exit 1; }
    echo ""
    echo ""
    echo "Cleaning up server temp files..."
    ssh "$SERVER" 'rm -rf ~/portfolio/public/images/studio-temp/*/; echo "  studio-temp cleared."'
    echo ""
    echo "Restarting app on server..."
    ssh "$SERVER" 'pm2 restart portfolio' || echo "WARNING: pm2 restart failed — restart manually with: pm2 restart portfolio"
    echo ""
    echo "✓ Push complete."
elif [ "$choice" = "2" ]; then
    echo ""
    echo "Pulling DB from server..."
    rsync -avz "$REMOTE_DB" "$LOCAL_DB"
    echo ""
    echo "Done. Images not pulled (large, rarely change)."
else
    echo "Invalid choice. Exiting."
    exit 1
fi
