package mcp

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/ahvholding/ahvclaw/tools"
)

// MCP Protocol types following the Model Context Protocol specification.

type JSONRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type JSONRPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id"`
	Result  interface{} `json:"result,omitempty"`
	Error   *RPCError   `json:"error,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type MCPToolInfo struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

type MCPCallToolParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

type MCPToolResult struct {
	Content []MCPContent `json:"content"`
	IsError bool         `json:"isError,omitempty"`
}

type MCPContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// Server handles MCP JSON-RPC requests.
type Server struct {
	executor *tools.Executor
	tools    []tools.ToolDef
}

// NewServer creates an MCP server that exposes the given tools.
func NewServer(executor *tools.Executor, toolDefs []tools.ToolDef) *Server {
	return &Server{executor: executor, tools: toolDefs}
}

// HandleRequest processes a single JSON-RPC request and returns a response.
func (s *Server) HandleRequest(data []byte) []byte {
	var req JSONRPCRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return s.errorResponse(nil, -32700, "Parse error")
	}

	if req.JSONRPC != "2.0" {
		return s.errorResponse(req.ID, -32600, "Invalid JSON-RPC version")
	}

	var resp interface{}
	switch req.Method {
	case "initialize":
		resp = s.handleInitialize(req)
	case "tools/list":
		resp = s.handleToolsList(req)
	case "tools/call":
		resp = s.handleToolsCall(req)
	case "ping":
		resp = s.handlePing(req)
	default:
		return s.errorResponse(req.ID, -32601, fmt.Sprintf("Method not found: %s", req.Method))
	}

	out, _ := json.Marshal(resp)
	return out
}

func (s *Server) handleInitialize(req JSONRPCRequest) JSONRPCResponse {
	return JSONRPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result: map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]interface{}{
				"tools": map[string]bool{"listChanged": false},
			},
			"serverInfo": map[string]string{
				"name":    "ahvclaw",
				"version": "1.0.0",
			},
		},
	}
}

func (s *Server) handlePing(req JSONRPCRequest) JSONRPCResponse {
	return JSONRPCResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]string{}}
}

func (s *Server) handleToolsList(req JSONRPCRequest) JSONRPCResponse {
	var mcpTools []MCPToolInfo
	for _, t := range s.tools {
		schema := t.Function.Parameters
		if schema == nil {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		mcpTools = append(mcpTools, MCPToolInfo{
			Name:        t.Function.Name,
			Description: t.Function.Description,
			InputSchema: schema,
		})
	}
	return JSONRPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  map[string]interface{}{"tools": mcpTools},
	}
}

func (s *Server) handleToolsCall(req JSONRPCRequest) JSONRPCResponse {
	var params MCPCallToolParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return JSONRPCResponse{
			JSONRPC: "2.0", ID: req.ID,
			Error: &RPCError{Code: -32602, Message: "Invalid params"},
		}
	}

	log.Printf("[mcp] calling tool: %s", params.Name)
	result := s.executor.Execute(params.Name, params.Arguments)

	mcpResult := MCPToolResult{
		Content: []MCPContent{{Type: "text", Text: result.Content}},
	}
	if result.Error != "" {
		mcpResult.IsError = true
		mcpResult.Content = []MCPContent{{Type: "text", Text: result.Error}}
	}

	return JSONRPCResponse{JSONRPC: "2.0", ID: req.ID, Result: mcpResult}
}

func (s *Server) errorResponse(id interface{}, code int, message string) []byte {
	resp := JSONRPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &RPCError{Code: code, Message: message},
	}
	out, _ := json.Marshal(resp)
	return out
}
