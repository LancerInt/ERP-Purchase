import { useRef, useState } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../utils/api.js';

const LANGUAGES = [
  { code: 'en-IN', label: 'English', name: 'English' },
  { code: 'hi-IN', label: 'हिन्दी', name: 'Hindi' },
  { code: 'te-IN', label: 'తెలుగు', name: 'Telugu' },
  { code: 'ta-IN', label: 'தமிழ்', name: 'Tamil' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ', name: 'Kannada' },
  { code: 'ml-IN', label: 'മലയാളം', name: 'Malayalam' },
  { code: 'mr-IN', label: 'मराठी', name: 'Marathi' },
  { code: 'gu-IN', label: 'ગુજરાતી', name: 'Gujarati' },
  { code: 'bn-IN', label: 'বাংলা', name: 'Bengali' },
  { code: 'pa-IN', label: 'ਪੰਜਾਬੀ', name: 'Punjabi' },
];

export default function VoiceDictation({ onText, onAudio, disabled = false, compact = false }) {
  const [lang, setLang] = useState('en-IN');
  const [state, setState] = useState('idle');
  const recognitionRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const transcriptRef = useRef('');

  const speechSupported =
    typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  const teardown = () => {
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    recognitionRef.current = null;
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    } catch { /* ignore */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    streamRef.current = null;
  };

  const start = async () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error('Voice typing needs Chrome or Edge (Web Speech).');
      return;
    }
    transcriptRef.current = '';
    chunksRef.current = [];

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;
    recognitionRef.current = recognition;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) transcriptRef.current += `${event.results[i][0].transcript} `;
      }
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') {
        toast.error('Microphone access denied.');
        teardown();
        setState('idle');
      }
    };
    try {
      recognition.start();
      setState('recording');
    } catch {
      toast.error('Could not start the microphone.');
      teardown();
      setState('idle');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      recorderRef.current = rec;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        if (chunksRef.current.length && onAudio) {
          const type = rec.mimeType || 'audio/webm';
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const blob = new Blob(chunksRef.current, { type });
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          onAudio(new File([blob], `voice-note-${stamp}.${ext}`, { type: blob.type }));
        }
      };
      rec.start();
    } catch {
      // Recording mic unavailable/denied — keep going with transcription only.
    }
  };

  const stop = async () => {
    teardown();
    const raw = transcriptRef.current.trim();
    if (!raw) { setState('idle'); return; }
    const selected = LANGUAGES.find((l) => l.code === lang);
    setState('processing');
    try {
      const { data } = await apiClient.post('/api/purchase/speech/translate/', {
        text: raw,
        source_language: selected?.name || '',
      });
      onText?.((data?.translated_text || raw).trim());
      if (data?.status !== 'success') {
        toast('Added your words (auto-translation unavailable).', { icon: 'ℹ️' });
      }
    } catch {
      onText?.(raw);
      toast('Added your words (auto-translation unavailable).', { icon: 'ℹ️' });
    } finally {
      setState('idle');
    }
  };

  const toggle = () => {
    if (state === 'recording') stop();
    else if (state === 'idle') start();
  };

  if (!speechSupported) return null;

  return (
    <div className={`inline-flex items-center ${compact ? 'gap-0.5' : 'gap-1'}`}>
      <CustomSelect
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        disabled={disabled || state !== 'idle'}
        className={compact
          ? "text-[9px] border border-slate-200 rounded py-0 px-1 bg-white text-slate-500"
          : "text-xs border border-slate-200 rounded-md py-1 px-1.5 bg-white text-slate-600"}
        title="Dictation language"
      >
        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
      </CustomSelect>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || state === 'processing'}
        title={state === 'recording' ? 'Stop dictation' : 'Dictate (any language → English)'}
        className={`${compact ? 'p-0.5 rounded' : 'p-1.5 rounded-lg'} transition-all disabled:opacity-50 ${
          state === 'recording'
            ? 'bg-red-100 text-red-600 animate-pulse'
            : 'bg-slate-100 text-slate-500 hover:bg-primary-100 hover:text-primary-600'
        }`}
      >
        {state === 'processing'
          ? <Loader2 size={compact ? 11 : 16} className="animate-spin" />
          : state === 'recording' ? <MicOff size={compact ? 11 : 16} /> : <Mic size={compact ? 11 : 16} />}
      </button>
    </div>
  );
}
