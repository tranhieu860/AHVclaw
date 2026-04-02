'use client';

import { Bot, User, Paperclip, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  url: string;
}

interface Message {
  id: string;
  role: string;
  content: string | null;
  source?: string;
  thinking?: string;
  attachments?: Attachment[];
}

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 border-t border-zinc-700/50 pt-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-400 transition"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Suy nghi</span>
      </button>
      {open && (
        <pre className="mt-1.5 text-xs text-zinc-500 bg-zinc-900/50 rounded-lg p-2.5 whitespace-pre-wrap break-words font-mono max-h-60 overflow-y-auto leading-relaxed">
          {content}
        </pre>
      )}
    </div>
  );
}

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const content = message.content || '...';
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';

  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
          <Bot size={16} className="text-white" />
        </div>
      )}
      <div
        className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${isUser ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-200'}`}
      >
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {message.attachments.map((att: Attachment) => {
              const url = `${apiUrl}/api/uploads/${att.id}`;
              const isImage = att.mime_type?.startsWith('image/') || false;
              return isImage ? (
                <img
                  key={att.id}
                  src={url}
                  alt={att.filename || 'image'}
                  className="max-w-xs max-h-48 rounded-lg cursor-pointer hover:opacity-90 transition"
                  onClick={() => window.open(url, '_blank')}
                />
              ) : (
                <a
                  key={att.id}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 bg-zinc-700/50 text-zinc-300 text-xs px-2.5 py-1.5 rounded-lg hover:bg-zinc-600/50 transition"
                >
                  <Paperclip size={12} />
                  {att.filename || 'file'}
                </a>
              );
            })}
          </div>
        )}
        {isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-700 prose-code:text-green-400">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
        {message.thinking && <ThinkingBlock content={message.thinking} />}
        {message.source && message.source !== 'web' && (
          <span className="text-[9px] px-1 rounded bg-zinc-700/50 text-zinc-400 ml-1 inline-block mt-0.5">
            {message.source === 'telegram' ? '🔵 TG' : message.source === 'zalo' ? '🟢 ZL' : message.source === 'discord' ? '🟣 DC' : message.source}
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
