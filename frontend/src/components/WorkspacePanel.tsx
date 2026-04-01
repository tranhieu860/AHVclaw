'use client';

import { useState } from 'react';
import { MessageSquare, Code, TerminalSquare } from 'lucide-react';
import { ChatPanel } from './ChatPanel';
import { CodeEditor, EditorTab, getLanguage } from './CodeEditor';
import { TerminalPanel } from './Terminal';

type TabType = 'chat' | 'editor' | 'terminal';

export function WorkspacePanel() {
  const [activeTab, setActiveTab] = useState<TabType>('chat');
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeEditorTab, setActiveEditorTab] = useState(0);

  const handleEditorTabClose = (index: number) => {
    const newTabs = editorTabs.filter((_, i) => i !== index);
    setEditorTabs(newTabs);
    if (activeEditorTab >= newTabs.length) {
      setActiveEditorTab(Math.max(0, newTabs.length - 1));
    }
  };

  const handleContentChange = (index: number, content: string) => {
    const newTabs = [...editorTabs];
    newTabs[index] = { ...newTabs[index], content, modified: true };
    setEditorTabs(newTabs);
  };

  const handleSave = async (tab: EditorTab) => {
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101'}/api/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
        },
        body: JSON.stringify({ path: tab.path, content: tab.content }),
      });
      if (response.ok) {
        const newTabs = editorTabs.map(t =>
          t.path === tab.path ? { ...t, modified: false } : t
        );
        setEditorTabs(newTabs);
      }
    } catch (err) {
      console.error('Failed to save file:', err);
    }
  };

  const tabs: { type: TabType; label: string; icon: typeof MessageSquare }[] = [
    { type: 'chat', label: 'Chat', icon: MessageSquare },
    { type: 'editor', label: 'Editor', icon: Code },
    { type: 'terminal', label: 'Terminal', icon: TerminalSquare },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex bg-zinc-900 border-b border-zinc-800">
        {tabs.map(({ type, label, icon: Icon }) => (
          <button
            key={type}
            onClick={() => setActiveTab(type)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 ${
              activeTab === type
                ? 'border-blue-500 text-white'
                : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'chat' && <ChatPanel />}
        {activeTab === 'editor' && (
          <CodeEditor
            tabs={editorTabs}
            activeTab={activeEditorTab}
            onTabChange={setActiveEditorTab}
            onTabClose={handleEditorTabClose}
            onContentChange={handleContentChange}
            onSave={handleSave}
          />
        )}
        {activeTab === 'terminal' && <TerminalPanel />}
      </div>
    </div>
  );
}
