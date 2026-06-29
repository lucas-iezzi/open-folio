#!/bin/bash
# Run this from your LOCAL machine, not from inside the SSH session.
# It syncs the database and images between local and the production server.

SERVER=root@24.144.117.207
LOCAL_DB="$(dirname "$0")/../data/portfolio.db"
LOCAL_IMAGES="$(dirname "$0")/../public/images/"
REMOTE_DB=$SERVER:~/portfolio/data/portfolio.db
REMOTE_IMAGES=$SERVER:~/portfolio/public/images/

echo ""
echo "Sync portfolio — which direction?"
echo "  1) Push local → server  (overwrites server DB and images)"
echo "  2) Pull server → local  (overwrites local DB)"
echo ""
read -p "Enter 1 or 2: " choice

if [ "$choice" = "1" ]; then
    echo ""
    echo "Pushing DB..."
    rsync -avz "$LOCAL_DB" "$REMOTE_DB"
    echo ""
    echo "Pushing images..."
    rsync -avz "$LOCAL_IMAGES" "$REMOTE_IMAGES"
    echo ""
    echo "Done. You may want to restart the app on the server:"
    echo "  ssh $SERVER 'pm2 restart portfolio'"
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
