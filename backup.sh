#!/bin/bash
BACKUP_DIR=/data/ahvclaw/backups
TIMESTAMP=$(date +%Y%m%d-%H%M)
PGPASSWORD=ahvclaw_2024 pg_dump -h 127.0.0.1 -U ahvclaw ahvclaw | gzip > "$BACKUP_DIR/ahvclaw-$TIMESTAMP.sql.gz"
# Keep last 7 days
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +7 -delete
echo "$(date): Backup completed" >> /var/log/ahvclaw-backup.log
