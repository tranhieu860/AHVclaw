'use client';

import { useEffect, useRef, useState } from 'react';

export function TerminalPanel() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState<string[]>(['$ Welcome to AHVclaw Terminal', '$ Type commands and press Enter', '']);
  const [isRunning, setIsRunning] = useState(false);
  const outputEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [output]);

  const handleCommand = async () => {
    if (!input.trim() || isRunning) return;

    const cmd = input.trim();
    setOutput(prev => [...prev, `$ ${cmd}`]);
    setInput('');
    setIsRunning(true);

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101'}/api/terminal/exec`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
        },
        body: JSON.stringify({ command: cmd }),
      });

      if (response.ok) {
        const data = await response.json();
        const lines = (data.output || data.error || 'No output').split('\n');
        setOutput(prev => [...prev, ...lines, '']);
      } else {
        const err = await response.json().catch(() => ({ error: 'Command failed' }));
        setOutput(prev => [...prev, `Error: ${err.error}`, '']);
      }
    } catch (err) {
      setOutput(prev => [...prev, `Error: Failed to execute command`, '']);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-black font-mono text-sm">
      {/* Output area */}
      <div className="flex-1 overflow-y-auto p-3 text-green-400">
        {output.map((line, i) => (
          <div key={i} className={line.startsWith('$') ? 'text-zinc-300' : line.startsWith('Error') ? 'text-red-400' : 'text-green-400'}>
            {line || '\u00A0'}
          </div>
        ))}
        <div ref={outputEndRef} />
      </div>

      {/* Input */}
      <div className="flex items-center border-t border-zinc-800 bg-zinc-950 px-3 py-1">
        <span className="text-green-400 mr-2">$</span>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCommand()}
          className="flex-1 bg-transparent text-green-400 outline-none font-mono text-sm"
          placeholder={isRunning ? 'Running...' : 'Type a command...'}
          disabled={isRunning}
          autoFocus
        />
      </div>
    </div>
  );
}
