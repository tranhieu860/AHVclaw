'use client';

import { useState, useRef, useCallback } from 'react';
import { Send, Paperclip, X } from 'lucide-react';

interface Attachment {
  id: string;
  name: string;
}

interface ChatInputProps {
  onSend: (content: string, attachments?: string[]) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';

  const uploadFile = async (file: File): Promise<Attachment | null> => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
        },
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        return { id: data.id || data.file_id, name: file.name };
      }
    } catch {}
    return null;
  };

  const handleFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    setUploadProgress({ current: 0, total: fileArray.length });
    for (let i = 0; i < fileArray.length; i++) {
      setUploadProgress({ current: i + 1, total: fileArray.length });
      const att = await uploadFile(fileArray[i]);
      if (att) setAttachments(prev => [...prev, att]);
    }
    setUploadProgress(null);
  };

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  }, []);

  const handleFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
      e.target.value = '';
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    const attIds = attachments.map(a => a.id);
    onSend(trimmed, attIds.length > 0 ? attIds : undefined);
    setInput('');
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, []);

  return (
    <div className="p-3 md:p-4 border-t border-zinc-800 pb-[env(safe-area-inset-bottom,0.75rem)]">
      <div
        className={`bg-zinc-800 rounded-xl p-2 transition ${dragOver ? 'ring-2 ring-blue-500' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {uploadProgress && (
          <div className="px-2 pt-1">
            <div className="h-1 bg-zinc-700 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }} />
            </div>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-1 pb-1.5">
            {attachments.map(att => (
              <span key={att.id} className="flex items-center gap-1 bg-zinc-700 text-zinc-300 text-xs px-2 py-1 rounded">
                {att.name}
                <button onClick={() => removeAttachment(att.id)} className="text-zinc-500 hover:text-white">
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" multiple />
          <button
            onClick={handleFileSelect}
            disabled={disabled || uploadProgress !== null}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700 disabled:opacity-30 transition"
            title="Attach files"
          >
            <Paperclip size={16} />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={uploadProgress ? `Uploading ${uploadProgress.current}/${uploadProgress.total}...` : disabled ? 'AI is responding...' : 'Type a message...'}
            rows={1}
            disabled={disabled}
            className="flex-1 bg-transparent text-white text-sm resize-none outline-none placeholder-zinc-500 px-2 py-1.5 max-h-[200px] disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={(!input.trim() && attachments.length === 0) || disabled}
            className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white transition"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
