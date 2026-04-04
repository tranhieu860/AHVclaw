package handlers

import (
	"io"

	"github.com/ahvholding/ahvclaw/mcp"
	"github.com/ahvholding/ahvclaw/tools"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

var mcpBridge = mcp.NewBridge()

// MCPEndpoint handles MCP JSON-RPC requests over HTTP POST.
func MCPEndpoint(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	body := c.Body()

	executor := tools.NewExecutor(
		"/data/ahvclaw/workspaces/"+userID.String(),
		userID.String(),
	)
	server := mcp.NewServer(executor, tools.AllTools)
	result := server.HandleRequest(body)

	c.Set("Content-Type", "application/json")
	return c.Send(result)
}

// MCPEndpointSSE handles MCP over Server-Sent Events (SSE transport).
func MCPEndpointSSE(c *fiber.Ctx) error {
	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")
	c.Set("Connection", "keep-alive")

	// Read JSON-RPC from request body
	body := c.Body()
	if len(body) == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "empty body"})
	}

	userID := c.Locals("user_id").(uuid.UUID)
	executor := tools.NewExecutor(
		"/data/ahvclaw/workspaces/"+userID.String(),
		userID.String(),
	)
	server := mcp.NewServer(executor, tools.AllTools)
	result := server.HandleRequest(body)

	// Write as SSE event
	c.Write([]byte("data: "))
	c.Write(result)
	c.Write([]byte("\n\n"))
	return nil
}

// MCPBridgeList returns all external MCP connections.
func MCPBridgeList(c *fiber.Ctx) error {
	return c.JSON(mcpBridge.GetAll())
}

// MCPBridgeAdd registers a new external MCP server.
func MCPBridgeAdd(c *fiber.Ctx) error {
	var req struct {
		Name   string `json:"name"`
		URL    string `json:"url"`
		APIKey string `json:"api_key"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	ext := mcp.ExternalMCP{
		ID:       uuid.New(),
		Name:     req.Name,
		URL:      req.URL,
		APIKey:   req.APIKey,
		IsActive: true,
	}
	mcpBridge.Register(ext)
	return c.Status(201).JSON(ext)
}

// MCPBridgeRemove removes an external MCP server.
func MCPBridgeRemove(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid ID"})
	}
	mcpBridge.Remove(id)
	return c.JSON(fiber.Map{"message": "removed"})
}

// MCPBridgeTools lists tools from an external MCP server.
func MCPBridgeTools(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid ID"})
	}
	toolsList, err := mcpBridge.ListTools(c.Context(), id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(toolsList)
}

// Suppress unused import warning
var _ = io.ReadAll
