package main

import (
	"context"
	"encoding/json"
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
	"github.com/ahvholding/ahvclaw/engine"
	"github.com/ahvholding/ahvclaw/handlers"
	"github.com/ahvholding/ahvclaw/autonomous"
	"github.com/ahvholding/ahvclaw/scheduler"
	"github.com/ahvholding/ahvclaw/skills"
	"github.com/ahvholding/ahvclaw/tools"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/google/uuid"
	"github.com/joho/godotenv"
)

// decryptBotConfig decrypts the bot_token field in channel config (mirrors handlers/bots.go).
func decryptBotConfig(raw *json.RawMessage) ([]byte, error) {
	if raw == nil {
		return []byte("{}"), nil
	}
	var cfg map[string]interface{}
	if err := json.Unmarshal(*raw, &cfg); err != nil {
		return *raw, nil
	}
	for _, field := range []string{"bot_token", "access_token", "app_secret"} {
		if token, ok := cfg[field].(string); ok && token != "" {
		decrypted, err := crypto.Decrypt(token)
		if err != nil {
			return nil, err
		}
		cfg[field] = decrypted
		}

	}
	return json.Marshal(cfg)
}

// SeedDefaultAgent creates the default "Main" agent if it does not exist.
func SeedDefaultAgent() {
	ctx := context.Background()
	var count int
	db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM agents WHERE name = 'Main'").Scan(&count)
	if count > 0 {
		return
	}
	var userID uuid.UUID
	err := db.Pool.QueryRow(ctx, "SELECT id FROM users WHERE role = 'admin' LIMIT 1").Scan(&userID)
	if err != nil {
		log.Println("[seed] no admin user found, skipping default agent")
		return
	}
	prompt := "B\u1ea1n l\u00e0 tr\u1ee3 l\u00fd AI th\u00f4ng minh c\u1ee7a AHV Holding. B\u1ea1n c\u00f3 th\u1ec3:\n" +
		"- T\u00ecm ki\u1ebfm web, ch\u1ee5p \u1ea3nh trang web\n" +
		"- \u0110\u1ecdc, vi\u1ebft, qu\u1ea3n l\u00fd file\n" +
		"- Ch\u1ea1y l\u1ec7nh terminal\n" +
		"- Qu\u1ea3n l\u00fd m\u00e1y ch\u1ee7 qua SSH\n" +
		"- Nh\u1edb th\u00f4ng tin v\u1ec1 ng\u01b0\u1eddi d\u00f9ng\n" +
		"- T\u00ecm ki\u1ebfm trong c\u01a1 s\u1edf ki\u1ebfn th\u1ee9c\n\n" +
		"H\u00e3y s\u1eed d\u1ee5ng c\u00e1c c\u00f4ng c\u1ee5 (tools) khi c\u1ea7n thi\u1ebft thay v\u00ec \u0111o\u00e1n. Lu\u00f4n tr\u1ea3 l\u1eddi b\u1eb1ng ti\u1ebfng Vi\u1ec7t tr\u1eeb khi ng\u01b0\u1eddi d\u00f9ng d\u00f9ng ti\u1ebfng kh\u00e1c.\n" +
		"Khi bi\u1ebft th\u00f4ng tin m\u1edbi v\u1ec1 ng\u01b0\u1eddi d\u00f9ng, h\u00e3y d\u00f9ng memory_save \u0111\u1ec3 ghi nh\u1edb."
	_, err = db.Pool.Exec(ctx,
		`INSERT INTO agents (user_id, name, model, system_prompt, is_public)
		 VALUES ($1, 'Main', 'AHV-Holding-TroLy', $2, true)`,
		userID, prompt)
	if err != nil {
		log.Printf("[seed] failed to create default agent: %v", err)
		return
	}
	log.Println("[seed] default Main agent created")
}

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
	// Seed default Main agent
	SeedDefaultAgent()


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
	channelRouter.BroadcastTo = func(userID string, eventType string, data interface{}) {
		handlers.Hub.BroadcastToUser(userID, handlers.Event{Type: eventType, Data: data})
	}
	channelManager := channels.NewManager(channelRouter)
	channelManager.RegisterAdapter("telegram", telegram.NewAdapter)
	channelManager.RegisterAdapter("zalo", zalo.NewAdapter)
	channelManager.RegisterAdapter("discord", discord.NewAdapter)
	handlers.ChannelManager = channelManager

	// Start task scheduler
	taskScheduler := scheduler.New(
		func(ctx context.Context, taskID, userID uuid.UUID, agentID *uuid.UUID, prompt string) (string, int, int, []string, error) {
			// Load agent system prompt if agentID specified
			systemPrompt := "You are an AI assistant executing a scheduled task. Complete the task described in the user message."
			model := "AHV-Holding-TroLy"
			if agentID != nil {
				var agentPrompt *string
				var agentModel *string
				db.Pool.QueryRow(ctx, "SELECT system_prompt, model FROM agents WHERE id = $1", *agentID).Scan(&agentPrompt, &agentModel)
				if agentPrompt != nil {
					systemPrompt = *agentPrompt
				}
				if agentModel != nil {
					model = *agentModel
				}
			}
			messages := []ai.ChatMessage{
				{Role: "system", Content: systemPrompt},
				{Role: "user", Content: prompt},
			}
			executor := tools.NewExecutor(fmt.Sprintf("/data/ahvclaw/workspaces/%s", userID.String()), userID.String())
			result, err := engine.ProcessChat(ctx, engine.ChatConfig{
				AIRouter:         handlers.Router,
				Model:            model,
				Messages:         messages,
				Tools:            allToolsForScheduler(),
				Executor:         executor,
				MaxToolRounds:    5,
				MaxContextTokens: 4000,
			})
			if err != nil {
				return "", 0, 0, nil, err
			}
			return result.Content, result.TokensIn, result.TokensOut, nil, nil
		},
		func(userID uuid.UUID, channel string, chatID *string, botID *uuid.UUID, content string) error {
			if channel == "web" {
				handlers.Hub.BroadcastToUser(userID.String(), handlers.Event{Type: "task_result", Data: content})
				return nil
			}
			if botID != nil {
				adapter, ok := channelManager.GetAdapter(botID.String())
				if ok && chatID != nil {
					return adapter.SendMessage(*chatID, content)
				}
			}
			return nil
		},
	)
	taskScheduler.Start()
	defer taskScheduler.Stop()

	// Start heartbeat daemon
	hbCtx, hbCancel := context.WithCancel(context.Background())
	defer hbCancel()
	hbDaemon := autonomous.NewDaemon(handlers.Router, func(userID uuid.UUID, channel, chatID, text string) {
		// Deliver via channel adapter if available
		if channelManager != nil && chatID != "" {
			if adapter, ok := channelManager.GetAdapter(chatID); ok {
				_ = adapter.SendMessage(chatID, text)
			}
		}
	})
	_ = hbDaemon
	go hbDaemon.Start(hbCtx)


	// Auto-start active bots after service starts
	go func() {
		time.Sleep(2 * time.Second)
		log.Println("[channels] auto-starting active bots...")
		rows, err := db.Pool.Query(context.Background(),
			"SELECT id, channel, channel_config FROM bots WHERE is_active = true")
		if err != nil {
			log.Printf("[channels] failed to query active bots: %v", err)
			return
		}
		defer rows.Close()
		started := 0
		for rows.Next() {
			var botID uuid.UUID
			var channel string
			var configRaw *json.RawMessage
			if err := rows.Scan(&botID, &channel, &configRaw); err != nil {
				log.Printf("[channels] failed to scan bot: %v", err)
				continue
			}
			// Decrypt config (same logic as handlers/bots.go)
			configJSON, err := decryptBotConfig(configRaw)
			if err != nil {
				log.Printf("[channels] failed to decrypt config for bot %s: %v", botID, err)
				continue
			}
			if err := channelManager.StartBot(botID.String(), channel, configJSON); err != nil {
				log.Printf("[channels] failed to auto-start bot %s: %v", botID, err)
			} else {
				log.Printf("[channels] auto-started bot %s (%s)", botID, channel)
				started++
			}
		}
		log.Printf("[channels] auto-started %d bots", started)
	}()

	// Wire silence detector
	silenceDetector := engine.NewSilenceDetector(
		func(convID uuid.UUID, content string, channel string, chatID string, botID uuid.UUID) {
			adapter, ok := channelManager.GetAdapter(botID.String())
			if !ok {
				log.Printf("[silence-detector] adapter not found for bot %s", botID)
				return
			}
			channelRouter.HandleInbound(channels.InboundMessage{
				BotID:   botID.String(),
				Channel: channel,
				ChannelUserID: chatID,
				ChatID:  chatID,
				Text:    content,
			}, adapter)
		},
		func(channel string, chatID string, botID uuid.UUID, text string) {
			adapter, ok := channelManager.GetAdapter(botID.String())
			if !ok {
				log.Printf("[silence-detector] fallback: adapter not found for bot %s", botID)
				return
			}
			if err := adapter.SendMessage(chatID, text); err != nil {
				log.Printf("[silence-detector] fallback send error: %v", err)
			}
		},
	)
	silenceDetector.Start()
	defer silenceDetector.Stop()

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
	app.Get("/webhook/zalo/:botID", handlers.ZaloWebhook)
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
// Tasks (all roles)
	protected.Get("/tasks", handlers.ListTasks)
	protected.Post("/tasks", handlers.CreateTask)
	protected.Get("/tasks/:id", handlers.GetTask)
	protected.Put("/tasks/:id", handlers.UpdateTask)
	protected.Delete("/tasks/:id", handlers.DeleteTask)
	protected.Post("/tasks/:id/pause", handlers.PauseTask)
	protected.Post("/tasks/:id/resume", handlers.ResumeTask)
	protected.Post("/tasks/:id/run", handlers.RunTaskNow)
	protected.Get("/tasks/:id/runs", handlers.ListTaskRuns)

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

	// Project routes
	protected.Get("/projects", handlers.ListProjects)
	protected.Post("/projects", handlers.CreateProject)
	protected.Get("/projects/:id", handlers.GetProject)
	protected.Put("/projects/:id", handlers.UpdateProject)
	protected.Delete("/projects/:id", handlers.DeleteProject)
	protected.Post("/projects/:id/files", handlers.UploadProjectFile)
	protected.Delete("/projects/:id/files/:fileId", handlers.DeleteProjectFile)

	// Autonomous agent
	protected.Get("/autonomous/status", handlers.GetAutonomousStatus)
	protected.Put("/autonomous/config", handlers.UpdateAutonomousConfig)
	protected.Post("/autonomous/stop", handlers.StopAutonomous)
	protected.Post("/autonomous/resume", handlers.ResumeAutonomous)

	// Goals
	protected.Get("/goals", handlers.ListGoals)
	protected.Post("/goals", handlers.CreateGoal)
	protected.Put("/goals/:id", handlers.UpdateGoalHandler)
	protected.Delete("/goals/:id", handlers.DeleteGoalHandler)

	// Reflections
	protected.Get("/reflections", handlers.ListReflections)
	protected.Get("/reflections/:date", handlers.GetReflection)

	// Trust
	protected.Get("/trust", handlers.ListTrustPermissions)
	protected.Put("/trust/:id", handlers.UpdateTrustScore)

	// Patterns
	protected.Get("/patterns", handlers.ListDetectedPatterns)
	protected.Post("/patterns/:id/accept", handlers.AcceptPattern)
	protected.Post("/patterns/:id/reject", handlers.RejectPattern)

	// Cognitive Memory
	protected.Get("/cognitive/search", handlers.CognitiveSearch)
	protected.Get("/cognitive/stats", handlers.CognitiveStats)
	protected.Get("/cognitive/graph", handlers.CognitiveGraph)
	protected.Post("/cognitive/backfill", handlers.CognitiveBackfill)

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
	app.Get("/ws/events", websocket.New(handlers.WSEvents()))

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


// allToolsForScheduler converts tools for scheduler use.
func allToolsForScheduler() []ai.Tool {
	var result []ai.Tool
	for _, d := range tools.AllTools {
		result = append(result, ai.Tool{
			Type: d.Type,
			Function: ai.ToolFunction{
				Name:        d.Function.Name,
				Description: d.Function.Description,
				Parameters:  d.Function.Parameters,
			},
		})
	}
	return result
}
