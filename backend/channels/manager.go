package channels

import (
	"fmt"
	"log"
	"sync"
)

// AdapterFactory is a function that creates a new ChannelAdapter.
// The handler parameter is provided so adapters can route inbound messages.
type AdapterFactory func(botID string, configJSON []byte, handler InboundHandler) (ChannelAdapter, error)

// Manager manages the lifecycle of channel bot adapters.
type Manager struct {
	mu        sync.RWMutex
	adapters  map[string]ChannelAdapter // botID -> adapter
	factories map[string]AdapterFactory // channel -> factory
	router    *Router
}

// NewManager creates a new channel manager.
func NewManager(router *Router) *Manager {
	return &Manager{
		adapters:  make(map[string]ChannelAdapter),
		factories: make(map[string]AdapterFactory),
		router:    router,
	}
}

// RegisterAdapter registers a factory for a channel type.
func (m *Manager) RegisterAdapter(channel string, factory AdapterFactory) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.factories[channel] = factory
	log.Printf("[channels] registered adapter for %s", channel)
}

// StartBot creates and starts an adapter for the given bot.
func (m *Manager) StartBot(botID, channel string, configJSON []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Stop existing adapter if running
	if adapter, ok := m.adapters[botID]; ok {
		adapter.Stop()
		delete(m.adapters, botID)
	}

	factory, ok := m.factories[channel]
	if !ok {
		return fmt.Errorf("no adapter registered for channel: %s", channel)
	}

	adapter, err := factory(botID, configJSON, m.router)
	if err != nil {
		return fmt.Errorf("create adapter: %w", err)
	}

	if err := adapter.ValidateConfig(); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}

	if err := adapter.Start(); err != nil {
		return fmt.Errorf("start adapter: %w", err)
	}

	m.adapters[botID] = adapter
	log.Printf("[channels] started bot %s on %s", botID, channel)
	return nil
}

// StopBot stops the adapter for the given bot.
func (m *Manager) StopBot(botID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	adapter, ok := m.adapters[botID]
	if !ok {
		return fmt.Errorf("bot %s is not running", botID)
	}

	if err := adapter.Stop(); err != nil {
		return fmt.Errorf("stop adapter: %w", err)
	}

	delete(m.adapters, botID)
	log.Printf("[channels] stopped bot %s", botID)
	return nil
}

// GetAdapter returns the adapter for the given bot.
func (m *Manager) GetAdapter(botID string) (ChannelAdapter, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	a, ok := m.adapters[botID]
	return a, ok
}

// IsRunning checks if a bot adapter is currently running.
func (m *Manager) IsRunning(botID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.adapters[botID]
	return ok
}

// StopAll stops all running adapters.
func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, adapter := range m.adapters {
		if err := adapter.Stop(); err != nil {
			log.Printf("[channels] error stopping bot %s: %v", id, err)
		}
	}
	m.adapters = make(map[string]ChannelAdapter)
	log.Println("[channels] all bots stopped")
}
