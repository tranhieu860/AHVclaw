#!/bin/bash
# AHVclaw Browser Companion V1 — Production Monitor
# Usage: ./companion-monitor.sh [hours=1]
# Shows critical events from both journalctl and browser_audit_log.

HOURS=${1:-1}
echo "═══════════════════════════════════════════════════════"
echo " AHVclaw Companion V1 — Production Monitor (last ${HOURS}h)"
echo "═══════════════════════════════════════════════════════"
echo ""

echo "── Backend Critical Events (journalctl) ──"
journalctl -u ahvclaw-api --since "${HOURS} hour ago" --no-pager 2>/dev/null \
    | grep -E "\[companion\]|\[companion-audit\]|\[computer-use\]" \
    | grep -iE "CRITICAL|KILL|rejected|failed|error|disconnect" \
    | tail -50
echo ""

echo "── Active Connections ──"
PGPASSWORD=ahvclaw_2024 psql -h 127.0.0.1 -U ahvclaw -d ahvclaw -t -c "
SELECT 'Grants: ' || count(*) FROM companion_grants WHERE status = 'active';
" 2>/dev/null
echo ""

echo "── Audit Log Critical Events (last ${HOURS}h) ──"
PGPASSWORD=ahvclaw_2024 psql -h 127.0.0.1 -U ahvclaw -d ahvclaw -c "
SELECT
    created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' AS time,
    action,
    result,
    blocked_reason,
    url
FROM browser_audit_log
WHERE created_at > NOW() - INTERVAL '${HOURS} hours'
  AND action IN (
    'handover_rejected', 'pending_timeout', 'renew_rejected',
    'kill_switch', 'revoke_all', 'tab_revoke_no_mapping',
    'helper_disconnect'
  )
ORDER BY created_at DESC
LIMIT 50;
" 2>/dev/null
echo ""

echo "── Payment Blocks (last ${HOURS}h) ──"
PGPASSWORD=ahvclaw_2024 psql -h 127.0.0.1 -U ahvclaw -d ahvclaw -c "
SELECT
    created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' AS time,
    action,
    url,
    blocked_reason
FROM browser_audit_log
WHERE created_at > NOW() - INTERVAL '${HOURS} hours'
  AND blocked_reason LIKE 'payment%'
ORDER BY created_at DESC
LIMIT 20;
" 2>/dev/null
echo ""

echo "── Summary ──"
PGPASSWORD=ahvclaw_2024 psql -h 127.0.0.1 -U ahvclaw -d ahvclaw -t -c "
SELECT
    action,
    count(*) AS cnt
FROM browser_audit_log
WHERE created_at > NOW() - INTERVAL '${HOURS} hours'
GROUP BY action
ORDER BY cnt DESC;
" 2>/dev/null

echo ""
echo "═══ Monitor complete ═══"
