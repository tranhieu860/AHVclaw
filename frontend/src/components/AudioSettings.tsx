'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Eye, EyeOff, Loader2, CheckCircle, XCircle, Volume2, Mic, Info } from 'lucide-react';
import { api } from '@/lib/api';

interface VoiceSettingsState {
  voice_enabled: boolean;
  minimax_api_key: string;
  minimax_voice_id: string;
  minimax_model: string;
  auto_voice_reply: boolean;
  stt_provider: string;
  stt_api_key: string;
  has_minimax_key: boolean;
  has_stt_key: boolean;
}

const TTS_MODELS = [
  { value: 'speech-02-hd', label: 'speech-02-hd (Chất lượng cao)' },
  { value: 'speech-02', label: 'speech-02 (Cân bằng)' },
  { value: 'speech-01', label: 'speech-01 (Nhanh)' },
];

const TTS_VOICES = [
  { value: 'female-shaonv', label: 'Thiếu nữ (female-shaonv)' },
  { value: 'female-yujie', label: 'Nữ trẻ trung (female-yujie)' },
  { value: 'female-tianmei', label: 'Nữ ngọt ngào (female-tianmei)' },
  { value: 'male-qn-qingse', label: 'Nam trẻ trung (male-qn-qingse)' },
  { value: 'male-qn-jingying', label: 'Nam chuyên nghiệp (male-qn-jingying)' },
  { value: 'male-qn-badao', label: 'Nam mạnh mẽ (male-qn-badao)' },
  { value: 'presenter_male', label: 'Nam MC (presenter_male)' },
  { value: 'presenter_female', label: 'Nữ MC (presenter_female)' },
];

const STT_PROVIDERS = [
  { value: '', label: '9Router Whisper (mặc định)' },
  { value: 'groq', label: 'Groq Whisper (nhanh)' },
  { value: 'openai', label: 'OpenAI Whisper' },
  { value: 'google', label: 'Google Speech-to-Text' },
];

type StatusType = 'idle' | 'loading' | 'success' | 'error';

interface StatusState {
  type: StatusType;
  message: string;
}

export function AudioSettings() {
  const [settings, setSettings] = useState<VoiceSettingsState>({
    voice_enabled: false,
    minimax_api_key: '',
    minimax_voice_id: 'female-shaonv',
    minimax_model: 'speech-02-hd',
    auto_voice_reply: true,
    stt_provider: '',
    stt_api_key: '',
    has_minimax_key: false,
    has_stt_key: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  const [showMinimaxKey, setShowMinimaxKey] = useState(false);
  const [showSttKey, setShowSttKey] = useState(false);

  const [ttsStatus, setTtsStatus] = useState<StatusState>({ type: 'idle', message: '' });
  const [sttStatus, setSttStatus] = useState<StatusState>({ type: 'idle', message: '' });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const sttChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    api.getVoiceSettings()
      .then((data) => {
        setSettings({
          voice_enabled: !!data.voice_enabled,
          minimax_api_key: data.minimax_api_key || '',
          minimax_voice_id: data.minimax_voice_id || 'female-shaonv',
          minimax_model: data.minimax_model || 'speech-02-hd',
          auto_voice_reply: data.auto_voice_reply !== false,
          stt_provider: data.stt_provider || '',
          stt_api_key: data.stt_api_key || '',
          has_minimax_key: !!data.has_minimax_key,
          has_stt_key: !!data.has_stt_key,
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const payload: Record<string, string> = {
        voice_enabled: settings.voice_enabled ? 'true' : 'false',
        minimax_voice_id: settings.minimax_voice_id,
        minimax_model: settings.minimax_model,
        auto_voice_reply: settings.auto_voice_reply ? 'true' : 'false',
        stt_provider: settings.stt_provider,
      };
      // Only send API keys if user typed a new value (not masked placeholder)
      if (settings.minimax_api_key && !settings.minimax_api_key.includes('****')) {
        payload.minimax_api_key = settings.minimax_api_key;
      }
      if (settings.stt_api_key && !settings.stt_api_key.includes('****')) {
        payload.stt_api_key = settings.stt_api_key;
      }
      await api.updateVoiceSettings(payload);
      setSaveMsg('Đã lưu cài đặt âm thanh');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (err: any) {
      setSaveMsg('Lỗi: ' + (err.message || 'Không thể lưu'));
    } finally {
      setSaving(false);
    }
  };

  const handleTestTTS = async () => {
    setTtsStatus({ type: 'loading', message: 'Đang tổng hợp giọng nói...' });
    try {
      const result = await api.testTTS();
      if (!result.success || !result.audio_b64) {
        setTtsStatus({ type: 'error', message: result.error || 'Thử nghiệm thất bại' });
        return;
      }
      // Play returned audio
      const mime = result.format === 'mp3' ? 'audio/mpeg' : `audio/${result.format || 'mpeg'}`;
      const src = `data:${mime};base64,${result.audio_b64}`;
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(src);
      audioRef.current = audio;
      audio.onended = () => setTtsStatus({ type: 'idle', message: '' });
      audio.onerror = () => setTtsStatus({ type: 'error', message: 'Lỗi phát âm thanh' });
      await audio.play();
      setTtsStatus({ type: 'success', message: 'Đang phát giọng nói mẫu...' });
    } catch (err: any) {
      setTtsStatus({ type: 'error', message: err.message || 'Lỗi không xác định' });
    }
  };

  const handleTestSTT = useCallback(async () => {
    if (sttStatus.type === 'loading') return;
    setSttStatus({ type: 'loading', message: 'Đang ghi âm 3 giây...' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      sttChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) sttChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(sttChunksRef.current, { type: mimeType });
        if (blob.size < 500) {
          setSttStatus({ type: 'error', message: 'Không ghi được âm thanh' });
          return;
        }
        setSttStatus({ type: 'loading', message: 'Đang nhận dạng...' });
        try {
          const result = await api.testSTT(blob, mimeType);
          if (result.success && result.text) {
            setSttStatus({ type: 'success', message: `Kết quả: "${result.text}"` });
          } else {
            setSttStatus({ type: 'error', message: result.error || 'Không nhận dạng được' });
          }
        } catch (err: any) {
          setSttStatus({ type: 'error', message: err.message || 'Lỗi nhận dạng' });
        }
      };

      recorder.start(100);
      setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 3000);
    } catch {
      setSttStatus({ type: 'error', message: 'Không thể truy cập micro' });
    }
  }, [sttStatus.type]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-400 py-6">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Đang tải cài đặt âm thanh...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* TTS Section */}
      <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Volume2 size={18} className="text-blue-400" />
          <h3 className="text-sm font-semibold text-white">TTS — Chuyển văn bản thành giọng nói</h3>
        </div>

        <div className="space-y-4">
          {/* Provider (hardcoded) */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-zinc-300 font-medium">Nhà cung cấp</p>
              <p className="text-xs text-zinc-500 mt-0.5">Dịch vụ tổng hợp giọng nói</p>
            </div>
            <span className="text-sm text-zinc-400 bg-zinc-700/50 px-3 py-1.5 rounded-lg">MiniMax</span>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-sm text-zinc-300 font-medium mb-1.5">
              MiniMax API Key
              {settings.has_minimax_key && (
                <span className="ml-2 text-xs text-emerald-400 font-normal">● Đã cấu hình</span>
              )}
            </label>
            <div className="relative">
              <input
                type={showMinimaxKey ? 'text' : 'password'}
                value={settings.minimax_api_key}
                onChange={(e) => setSettings((s) => ({ ...s, minimax_api_key: e.target.value }))}
                placeholder={settings.has_minimax_key ? '••••••••••••••••' : 'Nhập MiniMax API key'}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 pr-10 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowMinimaxKey((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              >
                {showMinimaxKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Model */}
          <div>
            <label className="block text-sm text-zinc-300 font-medium mb-1.5">Model</label>
            <select
              value={settings.minimax_model}
              onChange={(e) => setSettings((s) => ({ ...s, minimax_model: e.target.value }))}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
            >
              {TTS_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* Voice */}
          <div>
            <label className="block text-sm text-zinc-300 font-medium mb-1.5">Giọng nói</label>
            <select
              value={settings.minimax_voice_id}
              onChange={(e) => setSettings((s) => ({ ...s, minimax_voice_id: e.target.value }))}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
            >
              {TTS_VOICES.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
          </div>

          {/* Auto voice reply toggle */}
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-zinc-300 font-medium">Tự động trả lời bằng giọng nói</p>
              <p className="text-xs text-zinc-500 mt-0.5">Phát giọng nói tự động sau mỗi phản hồi AI</p>
            </div>
            <button
              type="button"
              onClick={() => setSettings((s) => ({ ...s, auto_voice_reply: !s.auto_voice_reply }))}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                settings.auto_voice_reply ? 'bg-blue-600' : 'bg-zinc-600'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  settings.auto_voice_reply ? 'translate-x-4.5' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Test TTS */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={handleTestTTS}
              disabled={ttsStatus.type === 'loading' || !settings.has_minimax_key}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
            >
              {ttsStatus.type === 'loading' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Volume2 size={14} />
              )}
              Thử giọng
            </button>
            {ttsStatus.type !== 'idle' && (
              <div className={`flex items-center gap-1.5 text-xs ${
                ttsStatus.type === 'success' ? 'text-emerald-400' :
                ttsStatus.type === 'error' ? 'text-red-400' : 'text-zinc-400'
              }`}>
                {ttsStatus.type === 'success' && <CheckCircle size={12} />}
                {ttsStatus.type === 'error' && <XCircle size={12} />}
                {ttsStatus.message}
              </div>
            )}
            {!settings.has_minimax_key && (
              <p className="text-xs text-zinc-500">Cần cấu hình API key trước</p>
            )}
          </div>
        </div>
      </div>

      {/* STT Section */}
      <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Mic size={18} className="text-purple-400" />
          <h3 className="text-sm font-semibold text-white">STT — Chuyển giọng nói thành văn bản</h3>
        </div>

        <div className="space-y-4">
          {/* Provider */}
          <div>
            <label className="block text-sm text-zinc-300 font-medium mb-1.5">Nhà cung cấp STT</label>
            <select
              value={settings.stt_provider}
              onChange={(e) => setSettings((s) => ({ ...s, stt_provider: e.target.value }))}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
            >
              {STT_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* STT API Key */}
          <div>
            <label className="block text-sm text-zinc-300 font-medium mb-1.5">
              API Key (tùy chọn)
              {settings.has_stt_key && (
                <span className="ml-2 text-xs text-emerald-400 font-normal">● Đã cấu hình</span>
              )}
            </label>
            <div className="relative">
              <input
                type={showSttKey ? 'text' : 'password'}
                value={settings.stt_api_key}
                onChange={(e) => setSettings((s) => ({ ...s, stt_api_key: e.target.value }))}
                placeholder={settings.has_stt_key ? '••••••••' : 'Nhập API key cho nhà cung cấp đã chọn'}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 pr-10 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowSttKey((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              >
                {showSttKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Priority info card */}
          <div className="bg-zinc-900/60 border border-zinc-700/40 rounded-lg p-3.5">
            <div className="flex items-start gap-2">
              <Info size={13} className="text-zinc-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs text-zinc-400 font-medium mb-1.5">Thứ tự ưu tiên nhận dạng giọng nói</p>
                <ol className="space-y-1 text-xs text-zinc-500">
                  <li className="flex items-center gap-1.5">
                    <span className="w-4 h-4 rounded-full bg-emerald-800/60 text-emerald-400 text-[10px] flex items-center justify-center font-bold shrink-0">1</span>
                    <span>9Router Whisper <span className="text-zinc-600">(mặc định, miễn phí)</span></span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="w-4 h-4 rounded-full bg-blue-800/60 text-blue-400 text-[10px] flex items-center justify-center font-bold shrink-0">2</span>
                    <span>Groq Whisper <span className="text-zinc-600">(nhanh, cần API key)</span></span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="w-4 h-4 rounded-full bg-zinc-700 text-zinc-400 text-[10px] flex items-center justify-center font-bold shrink-0">3</span>
                    <span>API key của bạn <span className="text-zinc-600">(dự phòng)</span></span>
                  </li>
                </ol>
              </div>
            </div>
          </div>

          {/* Test STT */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={handleTestSTT}
              disabled={sttStatus.type === 'loading'}
              className="flex items-center gap-2 px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
            >
              {sttStatus.type === 'loading' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Mic size={14} />
              )}
              Thử nhận dạng
            </button>
            {sttStatus.type !== 'idle' && (
              <div className={`flex items-center gap-1.5 text-xs max-w-xs truncate ${
                sttStatus.type === 'success' ? 'text-emerald-400' :
                sttStatus.type === 'error' ? 'text-red-400' : 'text-zinc-400'
              }`}>
                {sttStatus.type === 'success' && <CheckCircle size={12} className="shrink-0" />}
                {sttStatus.type === 'error' && <XCircle size={12} className="shrink-0" />}
                <span className="truncate">{sttStatus.message}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          {saving ? 'Đang lưu...' : 'Lưu cài đặt âm thanh'}
        </button>
        {saveMsg && (
          <p className={`text-sm ${saveMsg.startsWith('Lỗi') ? 'text-red-400' : 'text-emerald-400'}`}>
            {saveMsg}
          </p>
        )}
      </div>
    </div>
  );
}
