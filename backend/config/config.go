package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port            int
	DatabaseURL     string
	JWTSecret       string
	RouterURL       string
	RouterAPIKey    string
	DataDir         string
	AllowedOrigins  string
	EncryptionKey   string
	STTURL          string
	STTAPIKey       string
}

func Load() *Config {
	return &Config{
		Port:           getEnvInt("PORT", 3101),
		DatabaseURL:    getEnv("DATABASE_URL", "postgres://ahv_hrm:ahv_hrm_2024@localhost:5432/ahvclaw?sslmode=disable"),
		JWTSecret:      getEnv("JWT_SECRET", "ahvclaw-dev-secret-change-in-production"),
		RouterURL:      getEnv("ROUTER_URL", "http://localhost:8080"),
		RouterAPIKey:   getEnv("ROUTER_API_KEY", ""),
		DataDir:        getEnv("DATA_DIR", "/data/ahvclaw"),
		AllowedOrigins: getEnv("ALLOWED_ORIGINS", "http://localhost:3100,https://claw.ahvchat.com"),
		EncryptionKey:  getEnv("ENCRYPTION_KEY", "ahvclaw-dev-key-32-bytes-long!!"),
		STTURL:         getEnv("STT_URL", ""),
		STTAPIKey:      getEnv("STT_API_KEY", ""),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}
