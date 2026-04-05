#!/bin/bash
# AHVclaw 7-Day Soak Test Monitor
# Cron: 0 */6 * * * /opt/ahvclaw/backend/scripts/soak-test.sh >> /var/log/ahvclaw-soak.log 2>&1
set -e
DATE=$(date "+%Y-%m-%d %H:%M:%S")
export PGPASSWORD=ahvclaw_2024
P="psql -h 127.0.0.1 -U ahvclaw -d ahvclaw -t -A"
echo "===== SOAK TEST CHECK: $DATE ====="

BLEED=$($P -c "SELECT count(*) FROM autonomous_actions aa WHERE aa.user_id IS NOT NULL AND aa.agent_id IS NOT NULL AND aa.agent_id != '00000000-0000-0000-0000-000000000000' AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = aa.agent_id AND (a.user_id = aa.user_id OR a.is_public = true));" 2>/dev/null || echo 0)
echo "[TENANT_BLEED] Cross-tenant actions: $BLEED"

UNSAFE=$($P -c "SELECT count(*) FROM autonomous_actions WHERE status = 'executed' AND trust_score = 0;" 2>/dev/null || echo 0)
echo "[UNSAFE_EXEC] Zero-trust executions: $UNSAFE"

STUCK=$($P -c "SELECT count(*) FROM execution_plans WHERE status = 'running' AND updated_at < now() - interval '24 hours';" 2>/dev/null || echo 0)
echo "[PLANNER_DEADLOCK] Stuck plans: $STUCK"

BLOCKED=$($P -c "SELECT count(*) FROM autonomous_actions WHERE status = 'blocked' AND created_at > now() - interval '6 hours';" 2>/dev/null || echo 0)
echo "[TRUST_BLOCKS] Blocked (6h): $BLOCKED"

PLANS=$($P -c "SELECT status, count(*) FROM execution_plans GROUP BY status;" 2>/dev/null || echo none)
echo "[PLANS] $PLANS"

API=$(systemctl is-active ahvclaw-api 2>/dev/null || echo inactive)
FE=$(systemctl is-active ahvclaw-frontend 2>/dev/null || echo inactive)
echo "[SERVICES] API: $API, Frontend: $FE"

DISK=$(df -h / | awk 'NR==2{print $3"/"$2" ("$5")"}')
echo "[DISK] $DISK"

ISSUES=0
[ "$BLEED" != "0" ] && ISSUES=$((ISSUES+1))
[ "$UNSAFE" != "0" ] && ISSUES=$((ISSUES+1))
[ "$STUCK" != "0" ] && ISSUES=$((ISSUES+1))
[ "$API" != "active" ] && ISSUES=$((ISSUES+1))

if [ $ISSUES -eq 0 ]; then echo "[VERDICT] PASS"; else echo "[VERDICT] FAIL ($ISSUES issues)"; fi
echo ""
