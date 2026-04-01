package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ahvholding/ahvclaw/ai"
	"github.com/ahvholding/ahvclaw/auth"
	"github.com/ahvholding/ahvclaw/channels"
	"github.com/ahvholding/ahvclaw/channels/telegram"
	"github.com/ahvholding/ahvclaw/channels/zalo"
	"github.com/ahvholding/ahvclaw/channels/discord"
	"github.com/ahvholding/ahvclaw/config"
	"github.com/ahvholding/ahvclaw/crypto"
	"github.com/ahvholding/ahvclaw/db"
	"github.com/ahvholding/ahvclaw/embeddings"
	"github.com/ahvholding/ahvclaw/handlers"
	"github.com/ahvholding/ahvclaw/skills"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/google/uuid"
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

	if err := crypto.Init(cfg.EncryptionKey); err != nil {
		log.Fatal("Crypto init failed:", err)
	}

	// Init embeddings
	embeddings.Init(cfg.RouterURL, cfg.RouterAPIKey)
	// Seed built-in skills
	skills.SeedBuiltinSkills()

	app := fiber.New(fiber.Config{
		AppName:      "AHVclaw API",
		ServerHeader: "AHVclaw",
		BodyLimit:    50 * 1024 * 1024,
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
			"version": "0.2.0",
		})
	})

	auth.Init(cfg.JWTSecret)
	handlers.Router = ai.NewRouterClient(cfg.RouterURL, cfg.RouterAPIKey)

	// Init channel manager
	channelRouter := channels.NewRouter(handlers.Router)
	channelManager := channels.NewManager(channelRouter)
	channelManager.RegisterAdapter("telegram", telegram.NewAdapter)
	channelManager.RegisterAdapter("zalo", zalo.NewAdapter)
	channelManager.RegisterAdapter("discord", discord.NewAdapter)
	handlers.ChannelManager = channelManager

	// Rate limiters
	apiLimiter := limiter.New(limiter.Config{
		Max:        100,
		Expiration: 1 * time.Minute,
		KeyGenerator: func(c *fiber.Ctx) string {
			if userID, ok := c.Locals("user_id").(uuid.UUID); ok {
				return userID.String()
			}
			return c.IP()
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(429).JSON(fiber.Map{"error": "rate limit exceeded"})
		},
	})

	authLimiter := limiter.New(limiter.Config{
		Max:        10,
		Expiration: 1 * time.Minute,
		KeyGenerator: func(c *fiber.Ctx) string {
			return c.IP()
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(429).JSON(fiber.Map{"error": "too many auth attempts"})
		},
	})

// Zalo webhook (public, no auth)
	app.Post("/webhook/zalo/:botID", handlers.ZaloWebhook)
	api := app.Group("/api")

	// Public routes with auth rate limiting
	api.Post("/auth/register", authLimiter, handlers.Register)
	api.Post("/auth/login", authLimiter, handlers.Login)
	api.Post("/auth/refresh", authLimiter, handlers.RefreshToken)

	api.Get("/models", func(c *fiber.Ctx) error {
		data, err := handlers.Router.ListModels()
		if err != nil {
			return c.Status(502).JSON(fiber.Map{"error": "failed to fetch models"})
		}
		return c.Send(data)
	})

	// Protected routes (all authenticated users) with general rate limiting
	protected := api.Group("", auth.Middleware(), apiLimiter)
	protected.Get("/auth/me", handlers.GetMe)

	// Conversations (all roles)
	protected.Get("/conversations", handlers.ListConversations)
	protected.Get("/conversations/:id", handlers.GetConversation)
	protected.Delete("/conversations/:id", handlers.DeleteConversation)

	// Memories (all roles)
	protected.Get("/memories", handlers.ListMemories)
	protected.Post("/memories", handlers.CreateMemory)
	protected.Put("/memories/:id", handlers.UpdateMemory)
	protected.Delete("/memories/:id", handlers.DeleteMemory)
	protected.Post("/memories/search", handlers.SearchMemories)

	// Knowledge Base (all roles)
	protected.Get("/knowledge-bases", handlers.ListKnowledgeBases)
	protected.Post("/knowledge-bases", handlers.CreateKnowledgeBase)
	protected.Delete("/knowledge-bases/:id", handlers.DeleteKnowledgeBase)
	protected.Get("/knowledge-bases/:id/documents", handlers.ListDocuments)
	protected.Post("/knowledge-bases/:id/documents", handlers.CreateDocument)
	protected.Post("/knowledge-bases/:id/search", handlers.SearchKnowledgeBase)

	// Skills (all roles)
	protected.Get("/skills", handlers.ListSkills)
	protected.Post("/skills", handlers.CreateSkill)

	// Agents (all roles)
	protected.Get("/agents", handlers.ListAgents)
	protected.Post("/agents", handlers.CreateAgent)
	protected.Get("/agents/:id", handlers.GetAgent)

	// Contacts (all roles)
	protected.Get("/contacts", handlers.ListContacts)
	protected.Get("/contacts/:id", handlers.GetContact)
	protected.Put("/contacts/:id", handlers.UpdateContact)
	protected.Delete("/contacts/:id", handlers.DeleteContact)
	protected.Post("/contacts/merge", handlers.MergeContacts)

	// Inbox (all roles)
	protected.Get("/inbox", handlers.ListInboxConversations)
	protected.Get("/inbox/:id", handlers.GetInboxConversation)
	protected.Post("/inbox/:id/reply", handlers.ReplyToConversation)
	protected.Post("/inbox/:id/takeover", handlers.TakeoverConversation)
	protected.Post("/inbox/:id/release", handlers.ReleaseConversation)
	protected.Post("/inbox/:id/assign", handlers.AssignAgent)
	protected.Post("/inbox/:id/archive", handlers.ArchiveConversation)

	protected.Post("/ws/ticket", handlers.CreateWSTicket)

	// Settings (all roles)
	protected.Get("/settings", handlers.GetSettings)
	protected.Put("/settings", handlers.UpdateSettings)
	protected.Get("/settings/storage", handlers.GetStorageInfo)
	protected.Post("/settings/password", handlers.ChangePassword)
	protected.Post("/settings/api-key", handlers.GenerateNewAPIKey)

	// Model Providers (all roles)
	protected.Get("/providers", handlers.ListProviders)
	protected.Post("/providers", handlers.CreateProvider)
	protected.Put("/providers/:id", handlers.UpdateProvider)
	protected.Delete("/providers/:id", handlers.DeleteProvider)
	protected.Post("/providers/:id/test", handlers.TestProvider)
	protected.Post("/upload", handlers.UploadFile)
	protected.Get("/uploads/:id", handlers.ServeUpload)
	protected.Delete("/uploads/:id", handlers.DeleteUpload)

	// Dev+ routes (admin and dev only)
	devRoutes := protected.Group("", auth.RequireRole("admin", "dev"))
	devRoutes.Post("/terminal/exec", handlers.TerminalExec)
	devRoutes.Post("/browser/action", handlers.BrowserAction)
	devRoutes.Get("/servers", handlers.ListServers)
	devRoutes.Post("/servers", handlers.CreateServer)
	devRoutes.Delete("/servers/:id", handlers.DeleteServer)
	devRoutes.Post("/servers/:id/exec", handlers.ServerExec)
	devRoutes.Get("/servers/:id/status", handlers.ServerStatus)

	// Bot management (dev+ only)
	devRoutes.Get("/bots", handlers.ListBots)
	devRoutes.Post("/bots", handlers.CreateBot)
	devRoutes.Get("/bots/:id", handlers.GetBot)
	devRoutes.Put("/bots/:id", handlers.UpdateBot)
	devRoutes.Delete("/bots/:id", handlers.DeleteBot)
	devRoutes.Post("/bots/:id/start", handlers.StartBot)
	devRoutes.Post("/bots/:id/stop", handlers.StopBot)
	devRoutes.Get("/bots/:id/status", handlers.BotStatus)

	// Admin only routes
	adminRoutes := protected.Group("", auth.RequireRole("admin"))
	adminRoutes.Get("/admin/users", handlers.AdminListUsers)
	adminRoutes.Put("/admin/users/:id/role", handlers.AdminUpdateUserRole)
	adminRoutes.Delete("/admin/users/:id", handlers.AdminDeleteUser)
	adminRoutes.Get("/admin/stats", handlers.AdminSystemStats)

	// WebSocket chat
	app.Use("/ws", handlers.WSUpgrade())
	app.Get("/ws/chat", handlers.WSChat())

	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		log.Println("Shutting down...")
		channelManager.StopAll()
		_ = app.Shutdown()
	}()

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("AHVclaw API starting on %s", addr)
	if err := app.Listen(addr); err != nil {
		log.Fatal(err)
	}
}
