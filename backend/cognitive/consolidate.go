package cognitive

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/google/uuid"
)

const (
	DuplicateThreshold   = 0.95
	StaleMessageDays     = 90
	MaxDuplicatePairs    = 50
	MaxCrossRefEntries   = 20
	MaxCrossRefRelations = 10
	ConsolidationWindow  = 7 // days
)

// RunConsolidation performs memory consolidation for a user
func RunConsolidation(ctx context.Context, aiRouter *ai.RouterClient, userID uuid.UUID) (*ConsolidationRun, error) {
	// Phase -1: Clean duplicate memories (same user+type+key, keep newest)
	memDedup, _ := db.Pool.Exec(ctx, `
		DELETE FROM memories a USING memories b
		WHERE a.user_id = $1 AND b.user_id = $1
		  AND a.type = b.type AND a.key = b.key
		  AND a.updated_at < b.updated_at`, userID)
	if memDedup.RowsAffected() > 0 {
		log.Printf("[consolidation] deduplicated %d memory rows for user %s", memDedup.RowsAffected(), userID)
	}

	// Phase -1b: Prune heartbeat log memories (keep max 10)
	hbPrune, _ := db.Pool.Exec(ctx, `
		DELETE FROM memories
		WHERE user_id = $1 AND type = 'knowledge' AND key LIKE 'heartbeat-%'
		  AND id NOT IN (
			SELECT id FROM memories
			WHERE user_id = $1 AND type = 'knowledge' AND key LIKE 'heartbeat-%'
			ORDER BY updated_at DESC LIMIT 10
		  )`, userID)
	if hbPrune.RowsAffected() > 0 {
		log.Printf("[consolidation] pruned %d old heartbeat memories for user %s", hbPrune.RowsAffected(), userID)
	}

	run := &ConsolidationRun{
		UserID:    userID,
		StartedAt: time.Now(),
	}
	var runID uuid.UUID
	err := db.Pool.QueryRow(ctx,
		`INSERT INTO consolidation_runs (user_id, started_at) VALUES ($1, $2) RETURNING id`,
		userID, run.StartedAt,
	).Scan(&runID)
	if err != nil {
		return nil, err
	}
	run.ID = runID

	defer func() {
		now := time.Now()
		run.FinishedAt = &now
		bgCtx, bgCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer bgCancel()
		db.Pool.Exec(bgCtx,
			`UPDATE consolidation_runs SET finished_at=$1, entries_scanned=$2, duplicates_merged=$3,
			  stale_pruned=$4, new_crossrefs=$5, summary=$6 WHERE id=$7`,
			run.FinishedAt, run.EntriesScanned, run.DuplicatesMerged,
			run.StalePruned, run.NewCrossrefs, run.Summary, runID,
		)
	}()

	// Phase 1: Find and merge near-duplicates
	merged, scanned, err := mergeDuplicates(ctx, userID)
	if err != nil {
		log.Printf("[consolidate] merge error for %s: %v", userID, err)
	}
	run.DuplicatesMerged = merged
	run.EntriesScanned = scanned

	// Phase 2: Prune stale entries (messages older than 90 days with low relevance)
	pruned, err := pruneStale(ctx, userID)
	if err != nil {
		log.Printf("[consolidate] prune error for %s: %v", userID, err)
	}
	run.StalePruned = pruned

	// Phase 3: Discover cross-references using AI
	newRefs, err := discoverCrossRefs(ctx, aiRouter, userID)
	if err != nil {
		log.Printf("[consolidate] crossref error for %s: %v", userID, err)
	}
	run.NewCrossrefs = newRefs

	run.Summary = fmt.Sprintf("Scanned %d, merged %d duplicates, pruned %d stale, found %d cross-refs",
		run.EntriesScanned, run.DuplicatesMerged, run.StalePruned, run.NewCrossrefs)

	log.Printf("[consolidate] user %s: %s", userID, run.Summary)
	return run, nil
}

// mergeDuplicates finds entries with cosine similarity > 0.95 and merges them
func mergeDuplicates(ctx context.Context, userID uuid.UUID) (int, int, error) {
	// Phase 0: Remove exact duplicates by content_hash (fast, no vector ops)
	exactResult, hashErr := db.Pool.Exec(ctx,
		`DELETE FROM cognitive_embeddings a
		 USING cognitive_embeddings b
		 WHERE a.user_id = $1 AND b.user_id = $1
		   AND a.content_hash = b.content_hash
		   AND a.source_type = b.source_type
		   AND a.id < b.id`,
		userID,
	)
	exactMerged := 0
	if hashErr == nil {
		exactMerged = int(exactResult.RowsAffected())
	}

	// Phase 1: Vector near-duplicate detection (time-windowed to avoid O(n^2))
	rows, err := db.Pool.Query(ctx,
		`SELECT a.id, b.id, a.source_type, 1 - (a.embedding <=> b.embedding) AS sim
		 FROM cognitive_embeddings a
		 JOIN cognitive_embeddings b ON a.user_id = b.user_id AND a.source_type = b.source_type AND a.id < b.id
		 WHERE a.user_id = $1
		   AND a.created_at > NOW() - INTERVAL '7 days'
		   AND b.created_at > NOW() - INTERVAL '7 days'
		   AND 1 - (a.embedding <=> b.embedding) > 0.95
		 ORDER BY sim DESC LIMIT 50`,
		userID,
	)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()

	merged := 0
	scanned := 0
	for rows.Next() {
		var aID, bID uuid.UUID
		var srcType string
		var sim float64
		if rows.Scan(&aID, &bID, &srcType, &sim) != nil {
			continue
		}
		scanned++

		// Keep the entry with more cross-references
		var aRefs, bRefs int
		db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM cross_references WHERE (source_id=$1 OR target_id=$1) AND user_id=$2`, aID, userID).Scan(&aRefs)
		db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM cross_references WHERE (source_id=$1 OR target_id=$1) AND user_id=$2`, bID, userID).Scan(&bRefs)

		deleteID := aID
		if aRefs > bRefs {
			deleteID = bID
		}

		_, err := db.Pool.Exec(ctx, `DELETE FROM cognitive_embeddings WHERE id=$1`, deleteID)
		if err == nil {
			merged++
		}
	}

	return merged + exactMerged, scanned, nil
}

// pruneStale removes old message entries that are unlikely to be relevant
func pruneStale(ctx context.Context, userID uuid.UUID) (int, error) {
	result, err := db.Pool.Exec(ctx,
		`DELETE FROM cognitive_embeddings
		 WHERE user_id=$1 AND source_type='message' AND created_at < NOW() - INTERVAL '90 days'
		   AND id NOT IN (
		     SELECT source_id FROM cross_references WHERE user_id=$1 AND source_type='message'
		     UNION
		     SELECT target_id FROM cross_references WHERE user_id=$1 AND target_type='message'
		   )`,
		userID,
	)
	if err != nil {
		return 0, err
	}
	return int(result.RowsAffected()), nil
}

// discoverCrossRefs uses AI to find relationships between recent unlinked entries
func discoverCrossRefs(ctx context.Context, aiRouter *ai.RouterClient, userID uuid.UUID) (int, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT ce.id, ce.source_type, ce.content_preview
		 FROM cognitive_embeddings ce
		 WHERE ce.user_id = $1 AND ce.created_at > NOW() - INTERVAL '7 days'
		   AND NOT EXISTS (
		     SELECT 1 FROM cross_references cr
		     WHERE cr.user_id=$1 AND (
		       (cr.source_type=ce.source_type AND cr.source_id=ce.source_id)
		       OR (cr.target_type=ce.source_type AND cr.target_id=ce.source_id)
		     )
		   )
		 ORDER BY ce.created_at DESC LIMIT 20`,
		userID,
	)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type entry struct {
		id         uuid.UUID
		sourceType string
		preview    string
	}
	var entries []entry
	for rows.Next() {
		var e entry
		if rows.Scan(&e.id, &e.sourceType, &e.preview) == nil {
			entries = append(entries, e)
		}
	}

	if len(entries) < 2 {
		return 0, nil
	}

	// Build AI prompt to discover relationships
	var entryList string
	for i, e := range entries {
		entryList += fmt.Sprintf("%d. [%s] %s\n", i+1, e.sourceType, e.preview)
	}

	prompt := fmt.Sprintf(`Analyze these knowledge entries and find meaningful relationships between them.
Return ONLY valid JSON array of relationships:

Entries:
%s

Format: [{"source": <index>, "target": <index>, "relation": "<describes_relationship>", "strength": <0.5-1.0>}]

Rules:
- Only include relationships with clear evidence
- Strength 0.5-0.7: weak connection, 0.7-0.9: clear connection, 0.9-1.0: strong dependency
- Return empty array [] if no meaningful relationships found
- Maximum 10 relationships`, entryList)

	// Use engine.ProcessChat to call the AI
	result, err := engine.ProcessChat(ctx, engine.ChatConfig{
		AIRouter:         aiRouter,
		Model:            "AHV-Holding",
		Messages:         []ai.ChatMessage{{Role: "user", Content: prompt}},
		MaxToolRounds:    0,
		MaxContextTokens: 4000,
	})
	if err != nil {
		return 0, err
	}

	// Parse relationships
	raw := result.Content
	raw = stripCodeFences(raw)

	var rels []struct {
		Source   int     `json:"source"`
		Target   int     `json:"target"`
		Relation string  `json:"relation"`
		Strength float64 `json:"strength"`
	}
	if err := json.Unmarshal([]byte(raw), &rels); err != nil {
		trimmed := raw
		if len(trimmed) > 200 {
			trimmed = trimmed[:200]
		}
		log.Printf("[consolidate] crossref parse error: %v, raw: %s", err, trimmed)
		return 0, nil
	}

	created := 0
	for _, r := range rels {
		if r.Source < 1 || r.Source > len(entries) || r.Target < 1 || r.Target > len(entries) {
			continue
		}
		src := entries[r.Source-1]
		tgt := entries[r.Target-1]

		_, err := db.Pool.Exec(ctx,
			`INSERT INTO cross_references (user_id, source_type, source_id, target_type, target_id, relation, strength)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (user_id, source_type, source_id, target_type, target_id, relation) DO UPDATE SET strength=$7`,
			userID, src.sourceType, src.id, tgt.sourceType, tgt.id, r.Relation, r.Strength,
		)
		if err == nil {
			created++
		}
	}

	return created, nil
}

func stripCodeFences(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```json") {
		s = s[7:]
	} else if strings.HasPrefix(s, "```") {
		s = s[3:]
	}
	if strings.HasSuffix(s, "```") {
		s = s[:len(s)-3]
	}
	return strings.TrimSpace(s)
}
