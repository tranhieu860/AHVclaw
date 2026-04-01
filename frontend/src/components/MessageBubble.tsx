'use client';

import { Bot, User } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Message {
  id: string;
  role: string;
  content: string | null;
  source?: string;
}

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const content = message.content || '...';

  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
          <Bot size={16} className="text-white" />
        </div>
      )}
      <div
        className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-zinc-800 text-zinc-200'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-700 prose-code:text-green-400">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
        {message.source && message.source !== 'web' && (
          <span className="text-[10px] text-zinc-500 mt-1 flex items-center gap-0.5">
            {message.source === 'telegram' && 'via Telegram'}
            {message.source === 'zalo' && 'via Zalo'}
            {message.source === 'discord' && 'via Discord'}
          </span>
        )}
      </div>
      {isUser && (
        <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center shrink-0">
          <User size={16} className="text-zinc-300" />
        </div>
      )}
    </div>
  );
}
