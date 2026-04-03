package channels

import (
	"log"
	"sync"
	"time"
)

// MessageQueue ensures messages for the same conversation are processed
// sequentially (one at a time), while different conversations run in parallel.
type MessageQueue struct {
	mu       sync.Mutex
	queues   map[string]chan queueItem // key = botID:chatID
	handler  func(InboundMessage, ChannelAdapter)
}

type queueItem struct {
	msg     InboundMessage
	adapter ChannelAdapter
}

func NewMessageQueue(handler func(InboundMessage, ChannelAdapter)) *MessageQueue {
	return &MessageQueue{
		queues:  make(map[string]chan queueItem),
		handler: handler,
	}
}

// Enqueue adds a message to the per-conversation queue.
// If no queue exists for this conversation, one is created with a worker goroutine.
func (mq *MessageQueue) Enqueue(msg InboundMessage, adapter ChannelAdapter) {
	key := msg.BotID + ":" + msg.ChatID

	mq.mu.Lock()
	ch, exists := mq.queues[key]
	if !exists {
		ch = make(chan queueItem, 20) // buffer up to 20 messages
		mq.queues[key] = ch
		go mq.worker(key, ch)
	}
	mq.mu.Unlock()

	// Non-blocking send; drop if queue is full (prevent goroutine leak)
	select {
	case ch <- queueItem{msg: msg, adapter: adapter}:
	default:
		log.Printf("[queue] queue full for %s, dropping message", key)
	}
}

// worker processes messages for one conversation sequentially.
// Exits after 5 minutes of inactivity to free resources.
func (mq *MessageQueue) worker(key string, ch chan queueItem) {
	idle := time.NewTimer(5 * time.Minute)
	defer idle.Stop()

	for {
		select {
		case item := <-ch:
			idle.Reset(5 * time.Minute)
			mq.handler(item.msg, item.adapter)

		case <-idle.C:
			// Cleanup idle queue
			mq.mu.Lock()
			// Double-check channel is empty before removing
			if len(ch) == 0 {
				delete(mq.queues, key)
				mq.mu.Unlock()
				return
			}
			mq.mu.Unlock()
			idle.Reset(5 * time.Minute)
		}
	}
}
