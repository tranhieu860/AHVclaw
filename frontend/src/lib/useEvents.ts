'use client';

import { useEffect, useRef, useCallback } from 'react';
import { api } from './api';
import { useStore } from './store';

export function useEvents() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const { user, appendMessage, loadConversations } = useStore();

  const connect = useCallback(async () => {
    if (!user) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = await api.createEventSocket();
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const evt = JSON.parse(event.data);
          switch (evt.type) {
            case 'new_message': {
              const data = evt.data;
              const activeId = useStore.getState().activeConversationId;
              if (activeId === data.conversation_id) {
                appendMessage({
                  id: crypto.randomUUID(),
                  role: data.role,
                  content: data.content,
                  source: data.source,
                  created_at: data.created_at,
                });
              }
              loadConversations();
              break;
            }
            case 'conversation_updated':
              loadConversations();
              break;
          }
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        reconnectTimer.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => { ws.close(); };
    } catch {
      reconnectTimer.current = setTimeout(connect, 5000);
    }
  }, [user, appendMessage, loadConversations]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);
}
