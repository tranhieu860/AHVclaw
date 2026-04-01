package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/auth"
	"github.com/ahvholding/ahvclaw/config"
	"github.com/ahvholding/ahvclaw/crypto"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/handlers"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	cfg := config.Load()

	if err := db.Connect(cfg.DatabaseURL); err != nil {
		log.Fatal("DB connection failed:", err)
	}
	defer db.Close()

	if err := db.RunMigrations(); err != nil {
		log.Fatal("Migrations failed:", err)
	}

	// Init encryption
	if err := crypto.Init(cfg.EncryptionKey); err != nil {
		log.Fatal("Crypto init failed:", err)
	}

	app := fiber.New(fiber.Config{
		AppName:      "AHVclaw API",
		ServerHeader: "AHVclaw",
		BodyLimit:    50 * 1024 * 1024, // 50MB
	})

	app.Use(recover.New())
	app.Use(logger.New(logger.Config{Format: "${time} ${status} ${method} ${path} ${latency}\n"}))
	app.Use(cors.New(cors.Config{
		AllowOrigins:     cfg.AllowedOrigins,
		AllowCredentials: true,
		AllowHeaders:     "Origin, Content-Type, Accept, Authorization",
	}))

	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"status":  "ok",
			"service": "ahvclaw-api",
			"version": "0.1.0",
		})
	})

	// Init auth
	auth.Init(cfg.JWTSecret)

	// Init AI router client
	handlers.Router = ai.NewRouterClient(cfg.RouterURL, cfg.RouterAPIKey)

	// Routes
	api := app.Group("/api")

	// Public routes
	api.Post("/auth/register", handlers.Register)
	api.Post("/auth/login", handlers.Login)
	api.Post("/auth/refresh", handlers.RefreshToken)

	// Models endpoint (public)
	api.Get("/models", func(c *fiber.Ctx) error {
		data, err := handlers.Router.ListModels()
		if err != nil {
			return c.Status(502).JSON(fiber.Map{"error": "failed to fetch models"})
		}
		return c.Send(data)
	})

	// Protected routes
	protected := api.Group("", auth.Middleware())
	protected.Get("/auth/me", handlers.GetMe)

	// Conversations
	protected.Get("/conversations", handlers.ListConversations)
	protected.Get("/conversations/:id", handlers.GetConversation)
	protected.Delete("/conversations/:id", handlers.DeleteConversation)

	// Memories
	protected.Get("/memories", handlers.ListMemories)
	protected.Post("/memories", handlers.CreateMemory)
	protected.Put("/memories/:id", handlers.UpdateMemory)
	protected.Delete("/memories/:id", handlers.DeleteMemory)
	protected.Post("/memories/search", handlers.SearchMemories)

	// Server management
	protected.Get("/servers", handlers.ListServers)
	protected.Post("/servers", handlers.CreateServer)
	protected.Delete("/servers/:id", handlers.DeleteServer)
	protected.Post("/servers/:id/exec", handlers.ServerExec)
	protected.Get("/servers/:id/status", handlers.ServerStatus)

	// WebSocket ticket endpoint
	protected.Post("/ws/ticket", handlers.CreateWSTicket)
	// Terminal exec endpoint
	protected.Post("/terminal/exec", handlers.TerminalExec)

	// Browser automation
	protected.Post("/browser/action", handlers.BrowserAction)

	// Knowledge Base
	protected.Get("/knowledge-bases", handlers.ListKnowledgeBases)
	protected.Post("/knowledge-bases", handlers.CreateKnowledgeBase)
	protected.Delete("/knowledge-bases/:id", handlers.DeleteKnowledgeBase)
	protected.Get("/knowledge-bases/:id/documents", handlers.ListDocuments)
	protected.Post("/knowledge-bases/:id/documents", handlers.CreateDocument)
	protected.Post("/knowledge-bases/:id/search", handlers.SearchKnowledgeBase)

	// Skills
	protected.Get("/skills", handlers.ListSkills)
	protected.Post("/skills", handlers.CreateSkill)

	// Agents
	protected.Get("/agents", handlers.ListAgents)
	protected.Post("/agents", handlers.CreateAgent)
	protected.Get("/agents/:id", handlers.GetAgent)


	// WebSocket chat
	app.Use("/ws", handlers.WSUpgrade())
	app.Get("/ws/chat", handlers.WSChat())

	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		log.Println("Shutting down...")
		_ = app.Shutdown()
	}()

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("AHVclaw API starting on %s", addr)
	if err := app.Listen(addr); err != nil {
		log.Fatal(err)
	}
}
