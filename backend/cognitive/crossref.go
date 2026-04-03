package cognitive

import (
	"context"

	"log"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/jackc/pgx/v5"
	"github.com/google/uuid"
)

// LinkEntities creates a cross-reference between two entities
func LinkEntities(ctx context.Context, userID uuid.UUID, srcType string, srcID uuid.UUID, tgtType string, tgtID uuid.UUID, relation string, strength float64) error {
	_, err := db.Pool.Exec(ctx,
		`INSERT INTO cross_references (user_id, source_type, source_id, target_type, target_id, relation, strength)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (user_id, source_type, source_id, target_type, target_id, relation) DO UPDATE SET strength=$7`,
		userID, srcType, srcID, tgtType, tgtID, relation, strength,
	)
	return err
}

// GetEntityGraph returns the knowledge graph around an entity (2 hops).
// Uses a single batch query for second-hop to avoid N+1 queries.
func GetEntityGraph(ctx context.Context, userID uuid.UUID, sourceType string, sourceID uuid.UUID) (map[string]interface{}, error) {
	direct, err := GetRelatedEntities(ctx, userID, sourceType, sourceID)
	if err != nil {
		return nil, err
	}

	if len(direct) == 0 {
		return map[string]interface{}{
			"center":     map[string]interface{}{"type": sourceType, "id": sourceID},
			"direct":     direct,
			"second_hop": []CrossRef{},
		}, nil
	}

	// Collect neighbor IDs for batch second-hop query
	var neighborIDs []uuid.UUID
	seen := map[string]bool{sourceType + ":" + sourceID.String(): true}
	for _, d := range direct {
		otherType := d.TargetType
		otherID := d.TargetID
		if otherType == sourceType && otherID == sourceID {
			otherType = d.SourceType
			otherID = d.SourceID
		}
		key := otherType + ":" + otherID.String()
		if !seen[key] {
			seen[key] = true
			neighborIDs = append(neighborIDs, otherID)
		}
	}

	// Single batch query for all second-hop connections
	var secondHop []CrossRef
	if len(neighborIDs) > 0 {
		rows, err := db.Pool.Query(ctx,
			`SELECT id, user_id, source_type, source_id, target_type, target_id, relation, strength, created_at
			 FROM cross_references
			 WHERE user_id=$1 AND (source_id = ANY($2) OR target_id = ANY($2))
			   AND source_id != $3 AND target_id != $3
			 ORDER BY strength DESC LIMIT 50`,
			userID, neighborIDs, sourceID,
		)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var r CrossRef
				if rows.Scan(&r.ID, &r.UserID, &r.SourceType, &r.SourceID, &r.TargetType, &r.TargetID,
					&r.Relation, &r.Strength, &r.CreatedAt) == nil {
					secondHop = append(secondHop, r)
				}
			}
		}
	}

	return map[string]interface{}{
		"center":     map[string]interface{}{"type": sourceType, "id": sourceID},
		"direct":     direct,
		"second_hop": secondHop,
	}, nil
}

// GetKnowledgeGraphStats returns summary statistics of the user's knowledge graph
func GetKnowledgeGraphStats(ctx context.Context, userID uuid.UUID) (map[string]interface{}, error) {
	embedCounts, err := CountEmbeddings(ctx, userID)
	if err != nil {
		return nil, err
	}

	var totalRefs int
	if err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM cross_references WHERE user_id=$1`, userID,
	).Scan(&totalRefs); err != nil {
		log.Printf("[cognitive] cross-ref count error: %v", err)
	}

	var lastConsolidation *string
	if err := db.Pool.QueryRow(ctx,
		`SELECT summary FROM consolidation_runs WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1`, userID,
	).Scan(&lastConsolidation); err != nil && err != pgx.ErrNoRows {
		log.Printf("[cognitive] last consolidation error: %v", err)
	}

	totalEmbeddings := 0
	for _, c := range embedCounts {
		totalEmbeddings += c
	}

	return map[string]interface{}{
		"total_embeddings":   totalEmbeddings,
		"embeddings_by_type": embedCounts,
		"total_cross_refs":   totalRefs,
		"last_consolidation": lastConsolidation,
	}, nil
}
