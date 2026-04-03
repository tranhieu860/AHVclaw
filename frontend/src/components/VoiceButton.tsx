'use client';

import { useState, useRef, useCallback } from 'react';
import { Mic, Loader2 } from 'lucide-react';

interface VoiceButtonProps {
  onAudioReady: (audioBlob: Blob, mimeType: string) => void;
  disabled?: boolean;
}

export function VoiceButton({ onAudioReady, disabled }: VoiceButtonProps) {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    if (disabled || processing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;

        if (blob.size > 1000) {
          setProcessing(true);
          onAudioReady(blob, mimeType);
          setTimeout(() => setProcessing(false), 500);
        }
      };

      recorder.start(100);
      setRecording(true);
    } catch (err) {
      console.error('Mic access denied:', err);
    }
  }, [onAudioReady, disabled, processing]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  }, []);

  if (disabled) return null;

  return (
    <button
      onMouseDown={startRecording}
      onMouseUp={stopRecording}
      onMouseLeave={stopRecording}
      onTouchStart={(e) => { e.preventDefault(); startRecording(); }}
      onTouchEnd={(e) => { e.preventDefault(); stopRecording(); }}
      disabled={processing}
      className={`p-2 rounded-lg transition-all ${
        recording
          ? 'bg-red-500 text-white animate-pulse scale-110'
          : processing
          ? 'bg-zinc-700 text-zinc-400'
          : 'bg-transparent text-zinc-400 hover:text-white hover:bg-zinc-700'
      }`}
      title={recording ? 'Đang ghi âm... Thả để gửi' : 'Giữ để nói'}
    >
      {processing ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        <Mic size={16} />
      )}
    </button>
  );
}
