'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { ModelSelector } from './ModelSelector';

export function ChatPanel() {
  const {
    messages, setMessages, appendMessage, updateLastAssistantContent,
    activeConversationId, setActiveConversationId,
    selectedModel, loadConversations,
  } = useStore();

  const [isStreaming, setIsStreaming] = useState(false);
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeConversationId) {
      api.getMessages(activeConversationId).then((data) => {
        setMessages(data.messages || data || []);
      });
    } else {
      setMessages([]);
    }
  }, [activeConversationId, setMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, toolActivity]);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
  }, []);

  const sendMessage = useCallback(async (content: string, attachmentIds?: string[]) => {
    if (isStreaming) return;

    // Add user message to UI immediately
    appendMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content,
      created_at: new Date().toISOString(),
      attachments: attachmentIds?.map(id => ({ id, filename: '', mime_type: '', url: '' })),
    });

    // Add empty assistant message for streaming
    appendMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
    });

    setIsStreaming(true);
    setToolActivity(null);

    try {
      const ws = await api.createChatSocket();
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'chat',
          data: {
            conversation_id: activeConversationId,
            content,
            model: selectedModel,
            attachments: attachmentIds || [],
          },
        }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'delta': {
            const delta = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            if (delta.done) {
              setIsStreaming(false);
              setToolActivity(null);
              ws.close();
              loadConversations();
            } else if (delta.content) {
              updateLastAssistantContent(delta.content);
            }
            break;
          }
          case 'conversation_id': {
            const id = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            setActiveConversationId(typeof id === 'object' ? id.id : id);
            break;
          }
          case 'tool_call':
            setToolActivity(`Running: ${(typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data).name}...`);
            break;
          case 'tool_result': {
            setToolActivity(null);
            const result = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            const resultText = result.error
              ? `\n\n**Tool Error (${result.name}):** ${result.error}`
              : `\n\n**Tool (${result.name}):** ${(result.content || 'Done').substring(0, 500)}`;
            updateLastAssistantContent(resultText);
            break;
          }
          case 'error': {
            setIsStreaming(false);
            setToolActivity(null);
            const errData = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            updateLastAssistantContent('\n\n**Error:** ' + errData.message);
            ws.close();
            break;
          }
        }
      };

      ws.onerror = () => {
        setIsStreaming(false);
        setToolActivity(null);
        updateLastAssistantContent('\n\nConnection error. Please try again.');
      };

      ws.onclose = () => {
        setIsStreaming(false);
      };
    } catch (err) {
      setIsStreaming(false);
      updateLastAssistantContent('\n\nFailed to connect. Please try again.');
    }
  }, [activeConversationId, selectedModel, appendMessage, updateLastAssistantContent, setActiveConversationId, isStreaming, loadConversations]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
        <ModelSelector />
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-zinc-600">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-zinc-400 mb-2">AHVclaw</h2>
              <p>Start a conversation with AI</p>
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {toolActivity && (
          <div className="flex items-center gap-2 text-zinc-400 text-sm animate-pulse">
            <div className="w-2 h-2 bg-yellow-500 rounded-full"></div>
            {toolActivity}
          </div>
        )}
      </div>
      <ChatInput onSend={sendMessage} disabled={isStreaming} />
    </div>
  );
}
