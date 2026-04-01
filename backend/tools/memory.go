package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/ahvholding/ahvclaw/db"
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

	validTypes := map[string]bool{"profile": true, "preference": true, "knowledge": true, "correction": true}
	if !validTypes[args.Type] {
		return &ToolResult{Name: "memory_save", Error: "type must be one of: profile, preference, knowledge, correction"}
	}

	_, err := db.Pool.Exec(context.Background(),
		"INSERT INTO memories (user_id, type, key, content) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
		e.UserID, args.Type, args.Key, args.Content)
	if err != nil {
		return &ToolResult{Name: "memory_save", Error: "failed to save memory: " + err.Error()}
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

	rows, err := db.Pool.Query(context.Background(),
		"SELECT type, key, content FROM memories WHERE user_id = $1 AND (key ILIKE $2 OR content ILIKE $2) ORDER BY updated_at DESC LIMIT 10",
		e.UserID, "%"+args.Query+"%")
	if err != nil {
		return &ToolResult{Name: "memory_search", Error: "search failed"}
	}
	defer rows.Close()

	var results []string
	for rows.Next() {
		var mType, mKey, mContent string
		if err := rows.Scan(&mType, &mKey, &mContent); err != nil {
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
