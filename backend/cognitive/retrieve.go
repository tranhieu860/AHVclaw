package cognitive

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/embeddings"
	"github.com/google/uuid"
)

// Search performs unified contextual retrieval across all cognitive embeddings
func Search(ctx context.Context, opts SearchOptions) ([]SearchResult, error) {
	if opts.Limit == 0 {
		opts.Limit = 15
	}
	if opts.MinScore == 0 {
		opts.MinScore = 0.3
	}

	// Generate query embedding
	queryVec, err := embeddings.GenerateEmbedding(opts.Query)
	if err != nil {
		return nil, fmt.Errorf("query embedding failed: %w", err)
	}
	vecStr := pgvectorString(queryVec)

	// Build SQL with optional filters
	var conditions []string
	var args []interface{}
	argIdx := 1

	conditions = append(conditions, fmt.Sprintf("ce.user_id = $%d", argIdx))
	args = append(args, opts.UserID)
	argIdx++

	// Source type filter
	if len(opts.SourceTypes) > 0 {
		placeholders := make([]string, len(opts.SourceTypes))
		for i, st := range opts.SourceTypes {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, st)
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf("ce.source_type IN (%s)", strings.Join(placeholders, ",")))
	}

	// Temporal filters
	if opts.TimeAfter != nil {
		conditions = append(conditions, fmt.Sprintf("ce.created_at >= $%d", argIdx))
		args = append(args, *opts.TimeAfter)
		argIdx++
	}
	if opts.TimeBefore != nil {
		conditions = append(conditions, fmt.Sprintf("ce.created_at <= $%d", argIdx))
		args = append(args, *opts.TimeBefore)
		argIdx++
	}

	// Multi-user isolation: messages scoped to conversation, other types shared
	if opts.ConversationID != nil {
		conditions = append(conditions, fmt.Sprintf(
			"(ce.source_type != 'message' OR ce.metadata->>'conversation_id' = $%d)", argIdx))
		args = append(args, opts.ConversationID.String())
		argIdx++
	}

	whereClause := strings.Join(conditions, " AND ")

	// Fetch more than needed for post-processing (time weighting may reorder)
	fetchLimit := opts.Limit * 3
	if fetchLimit > 100 {
		fetchLimit = 100
	}

	query := fmt.Sprintf(`
		SELECT ce.id, ce.user_id, ce.source_type, ce.source_id, ce.content_hash,
		       ce.content_preview, ce.metadata, ce.created_at, ce.updated_at,
		       1 - (ce.embedding <=> $%d::vector) AS similarity
		FROM cognitive_embeddings ce
		WHERE %s
		ORDER BY ce.embedding <=> $%d::vector
		LIMIT %d`,
		argIdx, whereClause, argIdx, fetchLimit,
	)
	args = append(args, vecStr)

	rows, err := db.Pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("cognitive search query failed: %w", err)
	}
	defer rows.Close()

	var results []SearchResult
	now := time.Now()

	for rows.Next() {
		var entry CognitiveEntry
		var similarity float64
		var metaJSON []byte
		if err := rows.Scan(&entry.ID, &entry.UserID, &entry.SourceType, &entry.SourceID,
			&entry.ContentHash, &entry.ContentPreview, &metaJSON,
			&entry.CreatedAt, &entry.UpdatedAt, &similarity); err != nil {
			continue
		}
		json.Unmarshal(metaJSON, &entry.Metadata)

		// Time-weighted scoring: recent items get a boost
		timeWeight := calcTimeWeight(now, entry.CreatedAt)
		finalScore := similarity*0.7 + timeWeight*0.3

		if finalScore < opts.MinScore {
			continue
		}

		results = append(results, SearchResult{
			Entry:      entry,
			Similarity: similarity,
			TimeWeight: timeWeight,
			FinalScore: finalScore,
		})
	}

	// Sort by final score descending
	sortByScore(results)

	// Trim to limit
	if len(results) > opts.Limit {
		results = results[:opts.Limit]
	}

	return results, nil
}

// BuildContextString creates a formatted context string for injection into system prompt
func BuildContextString(results []SearchResult) string {
	if len(results) == 0 {
		return ""
	}

	var b strings.Builder
	b.WriteString("\n[Relevant knowledge from long-term memory:]\n")

	grouped := map[string][]SearchResult{}
	for _, r := range results {
		grouped[r.Entry.SourceType] = append(grouped[r.Entry.SourceType], r)
	}

	typeLabels := map[string]string{
		SourceMessage:    "Past conversations",
		SourceMemory:     "Memories",
		SourceReflection: "Self-reflections",
		SourcePattern:    "Detected patterns",
		SourceGoal:       "Goals",
	}

	for _, srcType := range []string{SourceMemory, SourceReflection, SourceGoal, SourcePattern, SourceMessage} {
		items, ok := grouped[srcType]
		if !ok || len(items) == 0 {
			continue
		}
		label := typeLabels[srcType]
		if label == "" {
			label = srcType
		}
		b.WriteString(fmt.Sprintf("\n**%s:**\n", label))
		for _, item := range items {
			ts := item.Entry.CreatedAt.Format("2006-01-02")
			b.WriteString(fmt.Sprintf("- [%s] %s\n", ts, item.Entry.ContentPreview))
		}
	}

	return b.String()
}

// calcTimeWeight returns 0.0-1.0 based on recency (exponential decay, half-life = 7 days)
func calcTimeWeight(now, created time.Time) float64 {
	daysSince := now.Sub(created).Hours() / 24
	if daysSince < 0 {
		daysSince = 0
	}
	halfLife := 7.0 // days
	return math.Exp(-0.693 * daysSince / halfLife)
}

func sortByScore(results []SearchResult) {
	sort.Slice(results, func(i, j int) bool {
		return results[i].FinalScore > results[j].FinalScore
	})
}

// GetRelatedEntities returns cross-referenced entities for a given source
func GetRelatedEntities(ctx context.Context, userID uuid.UUID, sourceType string, sourceID uuid.UUID) ([]CrossRef, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_id, source_type, source_id, target_type, target_id, relation, strength, created_at
		 FROM cross_references
		 WHERE user_id=$1 AND ((source_type=$2 AND source_id=$3) OR (target_type=$2 AND target_id=$3))
		 ORDER BY strength DESC LIMIT 20`,
		userID, sourceType, sourceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var refs []CrossRef
	for rows.Next() {
		var r CrossRef
		if rows.Scan(&r.ID, &r.UserID, &r.SourceType, &r.SourceID, &r.TargetType, &r.TargetID,
			&r.Relation, &r.Strength, &r.CreatedAt) == nil {
			refs = append(refs, r)
		}
	}
	return refs, nil
}

// CountEmbeddings returns total cognitive embeddings for a user
func CountEmbeddings(ctx context.Context, userID uuid.UUID) (map[string]int, error) {
	rows, err := db.Pool.Query(ctx,
		`SELECT source_type, COUNT(*) FROM cognitive_embeddings WHERE user_id=$1 GROUP BY source_type`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var st string
		var c int
		if rows.Scan(&st, &c) == nil {
			counts[st] = c
		}
	}
	return counts, nil
}

// SearchTemporally searches with time-range awareness (e.g., "last week", "yesterday")
func SearchTemporally(ctx context.Context, userID uuid.UUID, query string, after, before time.Time, limit int) ([]SearchResult, error) {
	return Search(ctx, SearchOptions{
		UserID:     userID,
		Query:      query,
		Limit:      limit,
		TimeAfter:  &after,
		TimeBefore: &before,
		MinScore:   0.2, // lower threshold for temporal queries
	})
}
