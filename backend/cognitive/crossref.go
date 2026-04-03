package cognitive

import (
	"context"

	"github.com/ahvholding/ahvclaw/db"
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

// GetEntityGraph returns the knowledge graph around an entity (2 hops)
func GetEntityGraph(ctx context.Context, userID uuid.UUID, sourceType string, sourceID uuid.UUID) (map[string]interface{}, error) {
	direct, err := GetRelatedEntities(ctx, userID, sourceType, sourceID)
	if err != nil {
		return nil, err
	}

	var secondHop []CrossRef
	seen := map[string]bool{sourceType + ":" + sourceID.String(): true}
	for _, d := range direct {
		otherType := d.TargetType
		otherID := d.TargetID
		if otherType == sourceType && otherID == sourceID {
			otherType = d.SourceType
			otherID = d.SourceID
		}
		key := otherType + ":" + otherID.String()
		if seen[key] {
			continue
		}
		seen[key] = true

		hop2, _ := GetRelatedEntities(ctx, userID, otherType, otherID)
		for _, h := range hop2 {
			hKey := h.TargetType + ":" + h.TargetID.String()
			if h.SourceType == sourceType && h.SourceID == sourceID {
				continue
			}
			if !seen[hKey] {
				secondHop = append(secondHop, h)
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
	db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM cross_references WHERE user_id=$1`, userID,
	).Scan(&totalRefs)

	var lastConsolidation *string
	db.Pool.QueryRow(ctx,
		`SELECT summary FROM consolidation_runs WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1`, userID,
	).Scan(&lastConsolidation)

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
