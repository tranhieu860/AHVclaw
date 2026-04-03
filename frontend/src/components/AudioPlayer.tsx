'use client';

import { useState, useRef } from 'react';
import { Play, Pause, Volume2 } from 'lucide-react';

interface AudioPlayerProps {
  audioB64: string;
  format?: string;
}

export function AudioPlayer({ audioB64, format = 'mp3' }: AudioPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const getAudioSrc = () => {
    const mime = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`;
    return `data:${mime};base64,${audioB64}`;
  };

  const togglePlay = () => {
    if (!audioRef.current) {
      const audio = new Audio(getAudioSrc());
      audioRef.current = audio;
      audio.onloadedmetadata = () => setDuration(audio.duration);
      audio.ontimeupdate = () => setProgress(audio.currentTime);
      audio.onended = () => { setPlaying(false); setProgress(0); };
    }

    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setPlaying(!playing);
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const pct = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-2 bg-zinc-800/50 rounded-lg px-3 py-2 mt-1 max-w-xs">
      <button onClick={togglePlay} className="text-blue-400 hover:text-blue-300">
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className="flex-1 h-1 bg-zinc-700 rounded-full overflow-hidden">
        <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <Volume2 size={12} className="text-zinc-500" />
      <span className="text-zinc-500 text-[10px] min-w-[32px]">
        {duration > 0 ? formatTime(progress) : '0:00'}
      </span>
    </div>
  );
}
