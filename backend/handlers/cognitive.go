package handlers

import (
	"time"

	"github.com/ahvholding/ahvclaw/cognitive"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// CognitiveSearch handles GET /api/cognitive/search?q=...&source_type=...&after=...&before=...
func CognitiveSearch(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	query := c.Query("q")
	if query == "" {
		return c.Status(400).JSON(fiber.Map{"error": "q parameter required"})
	}

	var sourceTypes []string
	if st := c.Query("source_type"); st != "" {
		sourceTypes = []string{st}
	}

	opts := cognitive.SearchOptions{
		UserID:      userID,
		Query:       query,
		Limit:       20,
		SourceTypes: sourceTypes,
		MinScore:    0.25,
	}

	if after := c.Query("after"); after != "" {
		t, err := time.Parse("2006-01-02", after)
		if err == nil {
			opts.TimeAfter = &t
		}
	}
	if before := c.Query("before"); before != "" {
		t, err := time.Parse("2006-01-02", before)
		if err == nil {
			opts.TimeBefore = &t
		}
	}

	results, err := cognitive.Search(c.Context(), opts)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	if results == nil {
		results = []cognitive.SearchResult{}
	}
	return c.JSON(results)
}

// CognitiveStats handles GET /api/cognitive/stats
func CognitiveStats(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	stats, err := cognitive.GetKnowledgeGraphStats(c.Context(), userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(stats)
}

// CognitiveGraph handles GET /api/cognitive/graph?source_type=...&source_id=...
func CognitiveGraph(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	sourceType := c.Query("source_type")
	sourceIDStr := c.Query("source_id")
	if sourceType == "" || sourceIDStr == "" {
		return c.Status(400).JSON(fiber.Map{"error": "source_type and source_id required"})
	}
	sourceID, err := uuid.Parse(sourceIDStr)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid source_id"})
	}

	graph, err := cognitive.GetEntityGraph(c.Context(), userID, sourceType, sourceID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(graph)
}

// CognitiveBackfill handles POST /api/cognitive/backfill
func CognitiveBackfill(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	count, err := cognitive.BackfillMessages(c.Context(), userID, 200)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"embedded": count})
}
