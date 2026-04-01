package embeddings

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/ahvholding/ahvclaw/db"
)

var (
	routerURL string
	apiKey    string
	dimension = 1536
)

func Init(url, key string) {
	routerURL = url
	apiKey = key
}

// GenerateEmbedding tries to get embeddings from the router, falls back to simple hash-based embeddings
func GenerateEmbedding(text string) ([]float32, error) {
	if routerURL != "" {
		emb, err := apiEmbedding(text)
		if err == nil {
			return emb, nil
		}
	}
	return hashEmbedding(text), nil
}

func apiEmbedding(text string) ([]float32, error) {
	body, _ := json.Marshal(map[string]interface{}{
		"input": text,
		"model": "text-embedding-3-small",
	})

	req, err := http.NewRequest("POST", routerURL+"/v1/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("embedding API returned %d", resp.StatusCode)
	}

	respBody, _ := io.ReadAll(resp.Body)
	var result struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil || len(result.Data) == 0 {
		return nil, fmt.Errorf("failed to parse embedding response")
	}

	return result.Data[0].Embedding, nil
}

func hashEmbedding(text string) []float32 {
	text = strings.ToLower(text)
	words := strings.Fields(text)
	vec := make([]float32, dimension)

	for i := 0; i < len(text)-2; i++ {
		trigram := text[i : i+3]
		hash := uint32(0)
		for _, c := range trigram {
			hash = hash*31 + uint32(c)
		}
		idx := hash % uint32(dimension)
		vec[idx] += 1.0
	}

	for _, word := range words {
		hash := uint32(0)
		for _, c := range word {
			hash = hash*37 + uint32(c)
		}
		idx := (hash + 500) % uint32(dimension)
		vec[idx] += 2.0
	}

	var norm float64
	for _, v := range vec {
		norm += float64(v * v)
	}
	if norm > 0 {
		norm = math.Sqrt(norm)
		for i := range vec {
			vec[i] = float32(float64(vec[i]) / norm)
		}
	}

	return vec
}

// StoreMemoryEmbedding generates and stores embedding for a memory
func StoreMemoryEmbedding(memoryID string, content string) error {
	emb, err := GenerateEmbedding(content)
	if err != nil {
		return err
	}

	vecStr := pgvectorString(emb)

	_, err = db.Pool.Exec(context.Background(),
		`INSERT INTO memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)
		 ON CONFLICT (memory_id) DO UPDATE SET embedding = $2::vector`,
		memoryID, vecStr)
	return err
}

// SearchByEmbedding finds memories similar to the query using vector cosine distance
func SearchByEmbedding(userID string, query string, limit int) ([]map[string]interface{}, error) {
	emb, err := GenerateEmbedding(query)
	if err != nil {
		return nil, err
	}

	vecStr := pgvectorString(emb)

	rows, err := db.Pool.Query(context.Background(),
		`SELECT m.type, m.key, m.content, 1 - (me.embedding <=> $1::vector) AS similarity
		 FROM memories m
		 JOIN memory_embeddings me ON me.memory_id = m.id
		 WHERE m.user_id = $2
		 ORDER BY me.embedding <=> $1::vector
		 LIMIT $3`,
		vecStr, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var mType, mKey, mContent string
		var sim float64
		if err := rows.Scan(&mType, &mKey, &mContent, &sim); err != nil {
			continue
		}
		results = append(results, map[string]interface{}{
			"type":       mType,
			"key":        mKey,
			"content":    mContent,
			"similarity": sim,
		})
	}
	return results, nil
}

func pgvectorString(vec []float32) string {
	parts := make([]string, len(vec))
	for i, v := range vec {
		parts[i] = fmt.Sprintf("%f", v)
	}
	return "[" + strings.Join(parts, ",") + "]"
}
