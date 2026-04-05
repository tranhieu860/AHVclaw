package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/embeddings"
)

func (e *Executor) memorySave(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Type    string `json:"type"`
		Key     string `json:"key"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "memory_save", Error: "invalid arguments"}
	}
	if args.Type == "" || args.Key == "" || args.Content == "" {
		return &ToolResult{Name: "memory_save", Error: "type, key, and content are required"}
	}

	validTypes := map[string]bool{"user": true, "profile": true, "preference": true, "knowledge": true, "correction": true, "feedback": true}
	if !validTypes[args.Type] {
		return &ToolResult{Name: "memory_save", Error: "type must be one of: profile, preference, knowledge, correction"}
	}

	var memoryID string
	err := db.Pool.QueryRow(context.Background(),
		`INSERT INTO memories (user_id, type, key, content, updated_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (user_id, type, key) DO UPDATE SET content = $4, updated_at = now()
		 RETURNING id`,
		e.UserID, args.Type, args.Key, args.Content).Scan(&memoryID)
	if err != nil {
		_ = db.Pool.QueryRow(context.Background(),
			"SELECT id FROM memories WHERE user_id = $1 AND type = $2 AND key = $3",
			e.UserID, args.Type, args.Key).Scan(&memoryID)
	}

	// Store embedding asynchronously
	if memoryID != "" {
		go func() {
			if err := embeddings.StoreMemoryEmbedding(memoryID, args.Key+" "+args.Content); err != nil {
				log.Printf("Failed to store memory embedding: %v", err)
			}
		}()
	}

	return &ToolResult{Name: "memory_save", Content: fmt.Sprintf("Saved memory: [%s] %s", args.Type, args.Key)}
}

func (e *Executor) memorySearch(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "memory_search", Error: "invalid arguments"}
	}
	if args.Query == "" {
		return &ToolResult{Name: "memory_search", Error: "query is required"}
	}

	// Try vector search first
	vectorResults, err := embeddings.SearchByEmbedding(e.UserID, args.Query, 10)
	if err == nil && len(vectorResults) > 0 {
		content := fmt.Sprintf("Found %d memories (semantic search):\n", len(vectorResults))
		for _, r := range vectorResults {
			content += fmt.Sprintf("- [%s] %s: %s (similarity: %.2f)\n",
				r["type"], r["key"], r["content"], r["similarity"])
		}
		return &ToolResult{Name: "memory_search", Content: content}
	}

	// Fallback to trigram similarity search
	rows, err := db.Pool.Query(context.Background(),
		`SELECT type, key, content,
		 GREATEST(similarity(key, $2), similarity(content, $2)) AS sim
		 FROM memories
		 WHERE user_id = $1
		 AND (key % $2 OR content % $2 OR key ILIKE $3 OR content ILIKE $3)
		 ORDER BY sim DESC
		 LIMIT 10`,
		e.UserID, args.Query, "%"+args.Query+"%")
	if err != nil {
		rows, err = db.Pool.Query(context.Background(),
			`SELECT type, key, content, 0::float AS sim
			 FROM memories WHERE user_id = $1 AND (key ILIKE $2 OR content ILIKE $2)
			 ORDER BY updated_at DESC LIMIT 10`,
			e.UserID, "%"+args.Query+"%")
		if err != nil {
			return &ToolResult{Name: "memory_search", Error: "search failed"}
		}
	}
	defer rows.Close()

	var results []string
	for rows.Next() {
		var mType, mKey, mContent string
		var sim float64
		if err := rows.Scan(&mType, &mKey, &mContent, &sim); err != nil {
			continue
		}
		results = append(results, fmt.Sprintf("[%s] %s: %s", mType, mKey, mContent))
	}

	if len(results) == 0 {
		return &ToolResult{Name: "memory_search", Content: "No memories found matching: " + args.Query}
	}

	content := fmt.Sprintf("Found %d memories:\n", len(results))
	for _, r := range results {
		content += "- " + r + "\n"
	}
	return &ToolResult{Name: "memory_search", Content: content}
}
