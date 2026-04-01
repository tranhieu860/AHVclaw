package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ahvholding/ahvclaw/db"
	"github.com/google/uuid"
)

func (e *Executor) knowledgeSearch(argsJSON json.RawMessage) *ToolResult {
	var args struct {
		KbID  string `json:"kb_id"`
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal(argsJSON, &args); err != nil {
		return &ToolResult{Name: "knowledge_search", Error: "invalid arguments"}
	}
	if args.Query == "" {
		return &ToolResult{Name: "knowledge_search", Error: "query is required"}
	}
	if args.Limit <= 0 || args.Limit > 20 {
		args.Limit = 5
	}

	userID, err := uuid.Parse(e.UserID)
	if err != nil {
		return &ToolResult{Name: "knowledge_search", Error: "invalid user"}
	}

	ctx := context.Background()
	pattern := "%" + strings.ReplaceAll(args.Query, "%", "") + "%"

	var query string
	var queryArgs []interface{}

	if args.KbID != "" {
		kbID, err := uuid.Parse(args.KbID)
		if err != nil {
			return &ToolResult{Name: "knowledge_search", Error: "invalid kb_id"}
		}
		var ownerID uuid.UUID
		err = db.Pool.QueryRow(ctx, "SELECT user_id FROM knowledge_bases WHERE id = $1", kbID).Scan(&ownerID)
		if err != nil || ownerID != userID {
			return &ToolResult{Name: "knowledge_search", Error: "knowledge base not found"}
		}
		query = `SELECT c.content, c.position, d.filename, kb.name
			FROM chunks c
			JOIN documents d ON d.id = c.document_id
			JOIN knowledge_bases kb ON kb.id = d.kb_id
			WHERE d.kb_id = $1 AND c.content ILIKE $2
			ORDER BY c.position LIMIT $3`
		queryArgs = []interface{}{kbID, pattern, args.Limit}
	} else {
		query = `SELECT c.content, c.position, d.filename, kb.name
			FROM chunks c
			JOIN documents d ON d.id = c.document_id
			JOIN knowledge_bases kb ON kb.id = d.kb_id
			WHERE kb.user_id = $1 AND c.content ILIKE $2
			ORDER BY c.position LIMIT $3`
		queryArgs = []interface{}{userID, pattern, args.Limit}
	}

	rows, err := db.Pool.Query(ctx, query, queryArgs...)
	if err != nil {
		return &ToolResult{Name: "knowledge_search", Error: "search failed: " + err.Error()}
	}
	defer rows.Close()

	type result struct {
		Content  string
		Position int
		Filename string
		KBName   string
	}

	var results []result
	for rows.Next() {
		var r result
		if err := rows.Scan(&r.Content, &r.Position, &r.Filename, &r.KBName); err != nil {
			continue
		}
		results = append(results, r)
	}

	if len(results) == 0 {
		return &ToolResult{Name: "knowledge_search", Content: "No results found for: " + args.Query}
	}

	content := fmt.Sprintf("Found %d results:\n", len(results))
	for _, r := range results {
		content += fmt.Sprintf("--- [%s] %s (chunk %d) ---\n%s\n\n", r.KBName, r.Filename, r.Position, r.Content)
	}
	return &ToolResult{Name: "knowledge_search", Content: content}
}
