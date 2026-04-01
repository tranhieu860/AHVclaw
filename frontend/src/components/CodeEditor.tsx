'use client';

import { useState, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { X, Save } from 'lucide-react';

interface EditorTab {
  path: string;
  content: string;
  language: string;
  modified: boolean;
}

function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java',
    html: 'html', css: 'css', scss: 'scss', json: 'json', yaml: 'yaml',
    yml: 'yaml', md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell',
    dockerfile: 'dockerfile', xml: 'xml', toml: 'toml',
  };
  return map[ext] || 'plaintext';
}

interface CodeEditorProps {
  tabs: EditorTab[];
  activeTab: number;
  onTabChange: (index: number) => void;
  onTabClose: (index: number) => void;
  onContentChange: (index: number, content: string) => void;
  onSave: (tab: EditorTab) => void;
}

export function CodeEditor({ tabs, activeTab, onTabChange, onTabClose, onContentChange, onSave }: CodeEditorProps) {
  if (tabs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500">
        <p>No files open. Use the chat to open or create files.</p>
      </div>
    );
  }

  const tab = tabs[activeTab];

  return (
    <div className="flex-1 flex flex-col">
      {/* Tab bar */}
      <div className="flex bg-zinc-900 border-b border-zinc-800 overflow-x-auto">
        {tabs.map((t, i) => (
          <div
            key={t.path}
            className={`flex items-center gap-1 px-3 py-1.5 text-xs cursor-pointer border-r border-zinc-800 shrink-0 ${
              i === activeTab ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-850'
            }`}
            onClick={() => onTabChange(i)}
          >
            <span>{t.path.split('/').pop()}</span>
            {t.modified && <span className="w-1.5 h-1.5 bg-blue-500 rounded-full"></span>}
            <button
              onClick={(e) => { e.stopPropagation(); onTabClose(i); }}
              className="ml-1 hover:text-white"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* Editor */}
      <div className="flex-1">
        <Editor
          height="100%"
          language={tab.language}
          value={tab.content}
          theme="vs-dark"
          onChange={(value) => onContentChange(activeTab, value || '')}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      </div>

      {/* Status bar for file */}
      <div className="h-6 bg-zinc-900 border-t border-zinc-800 flex items-center px-3 text-xs text-zinc-500 justify-between">
        <span>{tab.path}</span>
        <div className="flex items-center gap-2">
          <span>{tab.language}</span>
          {tab.modified && (
            <button
              onClick={() => onSave(tab)}
              className="flex items-center gap-1 text-blue-400 hover:text-blue-300"
            >
              <Save size={12} /> Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export type { EditorTab };
export { getLanguage };
