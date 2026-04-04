package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Bridge manages connections to external MCP servers.
type Bridge struct {
	mu          sync.RWMutex
	connections map[uuid.UUID]*ExternalMCP
	client      *http.Client
}

type ExternalMCP struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	URL      string    `json:"url"`
	APIKey   string    `json:"-"`
	IsActive bool      `json:"is_active"`
}

// NewBridge creates a new MCP bridge manager.
func NewBridge() *Bridge {
	return &Bridge{
		connections: make(map[uuid.UUID]*ExternalMCP),
		client:      &http.Client{Timeout: 30 * time.Second},
	}
}

// Register adds an external MCP server.
func (b *Bridge) Register(ext ExternalMCP) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.connections[ext.ID] = &ext
}

// Remove removes an external MCP server.
func (b *Bridge) Remove(id uuid.UUID) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.connections, id)
}

// ListTools fetches tools from an external MCP server.
func (b *Bridge) ListTools(ctx context.Context, id uuid.UUID) ([]MCPToolInfo, error) {
	b.mu.RLock()
	ext, ok := b.connections[id]
	b.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("MCP connection %s not found", id)
	}

	req := JSONRPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "tools/list",
	}
	respData, err := b.sendRequest(ctx, ext, req)
	if err != nil {
		return nil, err
	}

	var resp JSONRPCResponse
	if err := json.Unmarshal(respData, &resp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("MCP error: %s", resp.Error.Message)
	}

	resultMap, ok := resp.Result.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected result type")
	}
	toolsRaw, _ := json.Marshal(resultMap["tools"])
	var tools []MCPToolInfo
	json.Unmarshal(toolsRaw, &tools)
	return tools, nil
}

// CallTool invokes a tool on an external MCP server.
func (b *Bridge) CallTool(ctx context.Context, id uuid.UUID, toolName string, args json.RawMessage) (*MCPToolResult, error) {
	b.mu.RLock()
	ext, ok := b.connections[id]
	b.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("MCP connection %s not found", id)
	}

	params, _ := json.Marshal(MCPCallToolParams{Name: toolName, Arguments: args})
	req := JSONRPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "tools/call",
		Params:  params,
	}
	respData, err := b.sendRequest(ctx, ext, req)
	if err != nil {
		return nil, err
	}

	var resp JSONRPCResponse
	if err := json.Unmarshal(respData, &resp); err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("MCP error: %s", resp.Error.Message)
	}

	resultRaw, _ := json.Marshal(resp.Result)
	var result MCPToolResult
	json.Unmarshal(resultRaw, &result)
	return &result, nil
}

func (b *Bridge) sendRequest(ctx context.Context, ext *ExternalMCP, rpcReq JSONRPCRequest) ([]byte, error) {
	body, _ := json.Marshal(rpcReq)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", ext.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if ext.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+ext.APIKey)
	}

	resp, err := b.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("MCP request failed: %w", err)
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// GetAll returns all registered external MCP connections.
func (b *Bridge) GetAll() []*ExternalMCP {
	b.mu.RLock()
	defer b.mu.RUnlock()
	var list []*ExternalMCP
	for _, ext := range b.connections {
		list = append(list, ext)
	}
	return list
}
