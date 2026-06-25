import { useState, useRef, useEffect, MouseEvent } from "react";
import { Mic, User, Music, Play, Pause, RotateCcw, Download, Sparkles, AlertCircle, Volume2, HelpCircle, Activity, Settings, Info } from "lucide-react";
import { VOICE_OPTIONS, SAMPLE_SCRIPTS, type VoiceOption, type PodcastScript } from "./data";

export default function App() {
  // Input states
  const [hostText, setHostText] = useState(SAMPLE_SCRIPTS[1].hostText);
  const [collectorText, setCollectorText] = useState(SAMPLE_SCRIPTS[1].collectorText);
  
  // Voice selection states
  const [hostVoice, setHostVoice] = useState("Charon");
  const [collectorVoice, setCollectorVoice] = useState("Fenrir");
  
  // Playback and UI state
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioName, setAudioName] = useState<string>("حلقة_بودكاست_القطاع.mp3");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState<string>("full_episode");

  // Voice Engine State (Smart switch between Cloud Gemini & Browser Local)
  const [voiceEngine, setVoiceEngine] = useState<"cloud" | "browser">("cloud");
  const [quotaExceededNotice, setQuotaExceededNotice] = useState(false);

  // HTML5 Audio tracking
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Browser TTS tracking
  const [isBrowserSpeaking, setIsBrowserSpeaking] = useState(false);
  const speechIntervalRef = useRef<number | null>(null);
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const currentPlaySessionRef = useRef<number | null>(null);

  // Auto lock config for the full episode
  useEffect(() => {
    if (activePreset === "full_episode") {
      setVoiceEngine("cloud");
      setHostVoice("Charon");
      setCollectorVoice("Fenrir");
    }
  }, [activePreset]);

  // Cancel any speech synthesis on unmount
  useEffect(() => {
    return () => {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (speechIntervalRef.current) {
        clearInterval(speechIntervalRef.current);
      }
    };
  }, []);

  // Apply script preset
  const handleApplyPreset = (script: PodcastScript) => {
    if (script.id === "full_episode") {
      setActivePreset(script.id);
      setVoiceEngine("cloud");
      setHostVoice("Charon");
      setCollectorVoice("Fenrir");
    } else {
      setHostText(script.hostText);
      setCollectorText(script.collectorText);
      setActivePreset(script.id);
    }
    setError(null);
  };

  // Browser-native Speech Synthesis helper
  const speakLocalText = (
    text: string, 
    voiceValue: string, 
    role: "host" | "collector",
    onStart: (estDuration: number) => void,
    onEnd: () => void
  ) => {
    if (!('speechSynthesis' in window)) {
      setError("متصفحك لا يدعم نظام توليد الأصوات المدمج. يرجى استخدام متصفح حديث.");
      onEnd();
      return;
    }

    window.speechSynthesis.cancel();

    // Clean up text by removing punctuation-only or decorative strings for better speech output
    const cleanText = text.replace(/[….,،?؟!]/g, " ");
    const utterance = new SpeechSynthesisUtterance(cleanText);
    
    // Attempt to set Arabic voice, preferring Saudi Arabia if available
    utterance.lang = 'ar-SA';
    const voices = window.speechSynthesis.getVoices();
    const arabicVoice = voices.find(v => v.lang.toLowerCase().includes('sa')) || 
                        voices.find(v => v.lang.toLowerCase().startsWith('ar'));
    
    if (arabicVoice) {
      utterance.voice = arabicVoice;
    }

    // Distinguish voices using pitch and rate parameters
    if (role === "host") {
      // Host: Calm, welcoming, slightly slower pacing
      utterance.pitch = 1.05;
      utterance.rate = 0.88;
    } else {
      // Collector: Faster, direct, realistic Saudi street style
      utterance.pitch = 0.92;
      utterance.rate = 0.98;
    }

    // Estimate duration based on word count (approx 130 words per minute / ~2.2 words per second)
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const estDuration = Math.max(wordCount * 0.45 + 1.2, 3); // minimum 3 seconds

    utterance.onstart = () => {
      onStart(estDuration);
    };

    utterance.onend = () => {
      onEnd();
    };

    utterance.onerror = (e) => {
      console.warn("SpeechSynthesis error:", e);
      onEnd();
    };

    currentUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  };

  // Generate TTS for single speaker
  const generateSingleSpeaker = async (role: "host" | "collector") => {
    setError(null);
    const text = role === "host" ? hostText : collectorText;
    const voice = role === "host" ? hostVoice : collectorVoice;
    const voiceLabel = VOICE_OPTIONS.find(v => v.value === voice)?.label || voice;
    
    if (!text.trim()) {
      setError(`الرجاء إدخال نص لبطاقة ${role === "host" ? "المذيع" : "المحصل"} أولاً.`);
      return;
    }

    // If local browser voice is selected
    if (voiceEngine === "browser") {
      playLocalSingle(text, voice, role);
      return;
    }

    try {
      setIsLoading(true);
      setLoadingMessage(`جاري توليد صوت ${role === "host" ? "المذيع" : "المحصل"} بنبرة ${voiceLabel}...`);
      
      const response = await fetch("/api/generate-tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text, voice, role }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errMessage = errorData.error || "";
        
        // Check for Quota or Rate limit error to trigger seamless auto-fallback
        if (errMessage.includes("quota") || errMessage.includes("limit") || response.status === 429) {
          triggerAutoFallback();
          // Attempt immediate playback via fallback
          playLocalSingle(text, voice, role);
          return;
        }
        throw new Error(errMessage || "فشل توليد الصوت من الخادم.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      
      // Stop local audio states
      stopLocalSpeaking();
      
      setAudioUrl(url);
      setAudioName(`${role === "host" ? "مذيع" : "محصل"}_بودكاست_${Date.now()}.mp3`);
      setIsPlaying(false);
      
      // Auto-play the newly generated audio
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.load();
          audioRef.current.play().catch(() => {});
          setIsPlaying(true);
        }
      }, 100);

    } catch (err: any) {
      console.error(err);
      setError(err.message || "حدث خطأ أثناء الاتصال بالخادم لتوليد الصوت.");
    } finally {
      setIsLoading(false);
    }
  };

  // Play single voice via browser local speech engine
  const playLocalSingle = (text: string, voice: string, role: "host" | "collector") => {
    stopLocalSpeaking();
    setIsLoading(true);
    setLoadingMessage(`جاري تشغيل الصوت محلياً عبر متصفحك...`);
    
    setAudioUrl("browser-native-tts");
    setAudioName(`${role === "host" ? "مذيع" : "محصل"}_محاكاة_المتصفح.mp3`);
    
    speakLocalText(text, voice, role, 
      (estDuration) => {
        setIsLoading(false);
        setDuration(estDuration);
        setCurrentTime(0);
        setIsPlaying(true);
        setIsBrowserSpeaking(true);

        // Start progressive mock ticker for the audio bar
        if (speechIntervalRef.current) clearInterval(speechIntervalRef.current);
        const startTime = Date.now();
        speechIntervalRef.current = window.setInterval(() => {
          const elapsed = (Date.now() - startTime) / 1000;
          if (elapsed >= estDuration) {
            clearInterval(speechIntervalRef.current!);
            setCurrentTime(estDuration);
            setIsPlaying(false);
            setIsBrowserSpeaking(false);
          } else {
            setCurrentTime(elapsed);
          }
        }, 100);
      },
      () => {
        setIsLoading(false);
        setIsPlaying(false);
        setIsBrowserSpeaking(false);
        if (speechIntervalRef.current) clearInterval(speechIntervalRef.current);
      }
    );
  };

  // Trigger Automatic Web Speech API Fallback
  const triggerAutoFallback = () => {
    setVoiceEngine("browser");
    setQuotaExceededNotice(true);
    setError("⚠️ تم تفعيل نظام محاكاة الصوت المدمج في جهازك تلقائياً لتجاوز حد حصة الـ API لخدمة Gemini. يمكنك الاستماع للحوار كاملاً ومتابعة التجربة مجاناً وبلا حدود!");
  };

  // Helper to parse the full Arabic script into structured turn-by-turn speaker dialogues
  const parseFullScript = (fullScript: string) => {
    const normalizedScript = fullScript
      .replace(/المحصّل:/g, "المحصل:")
      .replace(/المحصّل :/g, "المحصل:");
      
    const paragraphs = normalizedScript.split("\n\n");
    const turns: { role: "host" | "collector"; text: string }[] = [];
    
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (!trimmed) continue;
      
      const lines = trimmed.split("\n");
      for (const line of lines) {
        const lineTrimmed = line.trim();
        if (!lineTrimmed) continue;
        
        if (lineTrimmed.startsWith("المذيع:")) {
          turns.push({
            role: "host",
            text: lineTrimmed.replace(/^المذيع:\s*/, "").trim()
          });
        } else if (lineTrimmed.startsWith("المحصل:")) {
          turns.push({
            role: "collector",
            text: lineTrimmed.replace(/^المحصل:\s*/, "").trim()
          });
        }
      }
    }
    return turns;
  };

  // Generate complete combined dialogue
  const generateCompleteDialogue = async () => {
    setError(null);

    const activeScript = SAMPLE_SCRIPTS.find(s => s.id === activePreset);
    const isFullScript = !!activeScript?.fullScript;

    if (isFullScript) {
      if (!activeScript?.fullScript?.trim()) {
        setError("نص الحوار الكامل غير متوفر.");
        return;
      }
    } else {
      if (!hostText.trim() || !collectorText.trim()) {
        setError("يرجى كتابة نص المذيع ونص المحصل معاً لتوليد الحوار الكامل.");
        return;
      }
    }

    // If local browser voice is selected
    if (voiceEngine === "browser") {
      if (isFullScript) {
        const turns = parseFullScript(activeScript?.fullScript || "");
        playLocalDialogue(turns);
        return;
      }
      playLocalDialogue();
      return;
    }

    let shouldClearLoading = true;
    try {
      setIsLoading(true);
      setLoadingMessage("جاري دمج الحوار وتوليد حلقة البودكاست المتكاملة من Gemini...");
      
      const payload = isFullScript 
        ? {
            fullScript: activeScript.fullScript,
            hostVoice: "Charon",
            collectorVoice: "Fenrir"
          }
        : {
            hostText,
            hostVoice,
            collectorText,
            collectorVoice,
          };

      const response = await fetch("/api/generate-dialogue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errMessage = errorData.error || "";
        
        // Handle rate limit and auto-fallback
        if (errMessage.includes("quota") || errMessage.includes("limit") || response.status === 429) {
          shouldClearLoading = false;
          triggerAutoFallback();
          if (isFullScript) {
            const turns = parseFullScript(activeScript?.fullScript || "");
            playLocalDialogue(turns);
          } else {
            playLocalDialogue();
          }
          return;
        }
        throw new Error(errMessage || "فشل توليد الحوار المشترك.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      
      stopLocalSpeaking();
      
      setAudioUrl(url);
      setAudioName(isFullScript ? `الحلقة_الكاملة_بودكاست_القطاع_${Date.now()}.mp3` : `حلقة_بودكاست_كاملة_${Date.now()}.mp3`);
      setIsPlaying(false);
      
      // Auto-play
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.load();
          audioRef.current.play().catch(() => {});
          setIsPlaying(true);
        }
      }, 100);

    } catch (err: any) {
      console.error(err);
      setError(err.message || "حدث خطأ غير متوقع أثناء توليد الحوار المتكامل.");
    } finally {
      if (shouldClearLoading) {
        setIsLoading(false);
      }
    }
  };

  // Play connected conversation between host and collector via local browser SpeechSynthesis
  const playLocalDialogue = (customTurns?: { role: "host" | "collector"; text: string }[]) => {
    stopLocalSpeaking();
    setIsLoading(true);
    setLoadingMessage("جاري تشغيل حوار البودكاست المشترك عبر متصفحك...");

    setAudioUrl("browser-native-tts-dialogue");
    setAudioName(customTurns ? "الحلقة_الكاملة_محاكاة_المتصفح.mp3" : "حلقة_كاملة_محاكاة_المتصفح.mp3");

    // Get turns
    let turns: { role: "host" | "collector"; text: string }[] = [];
    if (customTurns && customTurns.length > 0) {
      turns = customTurns;
    } else {
      turns = [
        { role: "host", text: hostText },
        { role: "collector", text: collectorText }
      ];
    }

    if (turns.length === 0) {
      setIsLoading(false);
      setError("لا يوجد نص لتشغيله.");
      return;
    }

    // Estimate total duration
    let totalEst = 0;
    const turnEstimates = turns.map(t => {
      const words = t.text.split(/\s+/).filter(Boolean).length;
      const est = Math.max(words * 0.45 + 1.2, 3);
      totalEst += est;
      return est;
    });

    let startTime = Date.now();
    let currentTurnIdx = 0;
    const sessionId = Date.now();
    currentPlaySessionRef.current = sessionId;

    const playNextTurn = () => {
      if (currentPlaySessionRef.current !== sessionId) return;
      if (currentTurnIdx >= turns.length) {
        setIsPlaying(false);
        setIsBrowserSpeaking(false);
        if (speechIntervalRef.current) clearInterval(speechIntervalRef.current);
        return;
      }

      const turn = turns[currentTurnIdx];
      const voice = turn.role === "host" ? hostVoice : collectorVoice;
      
      speakLocalText(turn.text, voice, turn.role,
        () => {
          // On start of the very first turn
          if (currentTurnIdx === 0) {
            setIsLoading(false);
            setDuration(totalEst);
            setCurrentTime(0);
            setIsPlaying(true);
            setIsBrowserSpeaking(true);

            // Start ticking progress bar
            if (speechIntervalRef.current) clearInterval(speechIntervalRef.current);
            speechIntervalRef.current = window.setInterval(() => {
              if (currentPlaySessionRef.current !== sessionId) {
                clearInterval(speechIntervalRef.current!);
                return;
              }
              const elapsed = (Date.now() - startTime) / 1000;
              if (elapsed >= totalEst) {
                clearInterval(speechIntervalRef.current!);
                setCurrentTime(totalEst);
                setIsPlaying(false);
                setIsBrowserSpeaking(false);
              } else {
                setCurrentTime(elapsed);
              }
            }, 100);
          }
        },
        () => {
          // On end of this turn
          currentTurnIdx++;
          // Delay slightly between turns for a realistic podcast feel
          setTimeout(() => {
            playNextTurn();
          }, 500);
        }
      );
    };

    // Begin playing
    playNextTurn();
  };

  // Cancel and clean up all SpeechSynthesis
  const stopLocalSpeaking = () => {
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    if (speechIntervalRef.current) {
      clearInterval(speechIntervalRef.current);
    }
    setIsBrowserSpeaking(false);
  };

  // Manage custom player control triggers
  const togglePlayPause = () => {
    if (audioUrl?.startsWith("browser-native")) {
      if (isPlaying) {
        if (window.speechSynthesis) window.speechSynthesis.pause();
        setIsPlaying(false);
      } else {
        if (window.speechSynthesis) window.speechSynthesis.resume();
        setIsPlaying(true);
      }
      return;
    }

    if (!audioRef.current || !audioUrl) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  const restartAudio = () => {
    if (audioUrl?.startsWith("browser-native")) {
      if (audioUrl.includes("dialogue")) {
        const activeScript = SAMPLE_SCRIPTS.find(s => s.id === activePreset);
        const isFullScript = !!activeScript?.fullScript;
        if (isFullScript) {
          const turns = parseFullScript(activeScript?.fullScript || "");
          playLocalDialogue(turns);
        } else {
          playLocalDialogue();
        }
      } else {
        const isHost = audioName.startsWith("مذيع");
        playLocalSingle(
          isHost ? hostText : collectorText,
          isHost ? hostVoice : collectorVoice,
          isHost ? "host" : "collector"
        );
      }
      return;
    }

    if (!audioRef.current || !audioUrl) return;
    audioRef.current.currentTime = 0;
    audioRef.current.play().catch(() => {});
    setIsPlaying(true);
  };

  // Audio events tracking
  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleAudioEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const handleProgressClick = (e: MouseEvent<HTMLDivElement>) => {
    if (audioUrl?.startsWith("browser-native")) return; // Seek not supported for web speech mock
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;
    const percentage = clickX / width;
    const targetTime = percentage * duration;
    audioRef.current.currentTime = targetTime;
    setCurrentTime(targetTime);
  };

  const formatTime = (timeInSeconds: number) => {
    if (isNaN(timeInSeconds)) return "00:00";
    const minutes = Math.floor(timeInSeconds / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  };

  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-200 flex flex-col font-sans relative overflow-x-hidden pb-44" dir="rtl">
      {/* Hidden Audio element for execution */}
      {audioUrl && !audioUrl.startsWith("browser-native") && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleAudioEnded}
        />
      )}

      {/* Header Navigation */}
      <header className="h-20 flex items-center justify-between px-6 md:px-12 border-b border-slate-800 bg-[#0B0F19]/80 backdrop-blur-md sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Mic className="w-6 h-6 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-l from-slate-100 to-slate-400">
              بودكاست من داخل القطاع
            </h1>
            <p className="text-[10px] md:text-xs text-slate-400 hidden sm:block">منصة الإنتاج الصوتي باللهجة السعودية العامية البسيطة</p>
          </div>
        </div>
        
        {/* Active Engine Switcher (Sleek layout) */}
        <div className="flex gap-2 items-center bg-slate-900/90 border border-slate-800 rounded-full p-1.5">
          <button
            id="btn-engine-cloud"
            onClick={() => {
              setVoiceEngine("cloud");
              setError(null);
            }}
            className={`px-3 py-1.5 rounded-full text-[11px] font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
              voiceEngine === "cloud"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/10"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>صوت الذكاء الاصطناعي (Gemini)</span>
          </button>
          
          <button
            id="btn-engine-browser"
            onClick={() => {
              setVoiceEngine("browser");
              setError(null);
            }}
            className={`px-3 py-1.5 rounded-full text-[11px] font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
              voiceEngine === "browser"
                ? "bg-amber-600 text-white shadow-md shadow-amber-600/10"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>صوت المتصفح البديل (مجاني ومفتوح)</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-grow max-w-7xl w-full mx-auto px-4 md:px-10 py-6 md:py-8 flex flex-col gap-6">
        
        {/* Banner with brief info and Script presets selection */}
        <div className="bg-gradient-to-r from-indigo-950/40 to-slate-900/60 border border-slate-800 rounded-2xl p-6 relative overflow-hidden shadow-2xl">
          <div className="absolute top-0 left-0 p-8 opacity-5">
            <Mic className="w-40 h-40" />
          </div>
          <div className="relative z-10">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
              <div className="flex items-center gap-2 text-indigo-400 text-sm font-bold">
                <Sparkles className="w-4 h-4 animate-bounce" />
                <span>أهلاً بك في منصة البودكاست المبتكرة</span>
              </div>
              
              {/* Notice badge if automatic fallback happened */}
              {quotaExceededNotice && (
                <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs px-3 py-1 rounded-lg flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5 animate-pulse" />
                  <span>تم تفعيل الوضع المحلي لضمان استمرارية التشغيل</span>
                </div>
              )}
            </div>

            <h2 className="text-xl md:text-2xl font-bold text-slate-100 mb-2">
              حوار تفاعلي طبيعي بلهجة سعودية بسيطة!
            </h2>
            <p className="text-slate-400 text-xs md:text-sm max-w-3xl leading-relaxed mb-6">
              اكتب النص لكل شخصية، واختر نبرة الصوت المفضلة، وسيقوم النظام بتوليد الكلام بلهجة عامية دقيقة ومخارج حروف واضحة. حدد أحد السيناريوهات الجاهزة بالأسفل لتجربتها مباشرة!
            </p>

            {/* Quick Presets Selector */}
            <div>
              <div className="text-xs font-bold text-slate-400 mb-3 block">اختر سيناريو وحوار جاهز للتجربة السريعة:</div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                {SAMPLE_SCRIPTS.map((script) => (
                  <button
                    key={script.id}
                    id={`preset-btn-${script.id}`}
                    onClick={() => handleApplyPreset(script)}
                    className={`text-right p-3 rounded-xl border transition-all duration-200 cursor-pointer ${
                      activePreset === script.id
                        ? "bg-indigo-600/20 border-indigo-500 shadow-lg shadow-indigo-500/5 text-slate-100"
                        : "bg-slate-900/40 border-slate-800/80 hover:bg-slate-800/50 hover:border-slate-700 text-slate-300"
                    }`}
                  >
                    <div className="font-bold text-sm mb-1 flex items-center justify-between">
                      <span className="truncate">{script.title}</span>
                      {activePreset === script.id && <span className="text-[10px] bg-indigo-500 text-white px-1.5 py-0.5 rounded-md flex-shrink-0">محدد</span>}
                    </div>
                    <p className="text-xs text-slate-400 line-clamp-1">{script.description}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Global Error/Warning Banner if any */}
        {error && (
          <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 px-4 py-3 rounded-xl flex items-start gap-3 text-sm animate-fade-in" id="error-banner">
            <AlertCircle className="w-5 h-5 flex-shrink-0 text-amber-400 mt-0.5" />
            <div className="flex-1 leading-relaxed">{error}</div>
            <button onClick={() => setError(null)} className="text-xs hover:underline text-amber-400 font-bold cursor-pointer self-center">إغلاق</button>
          </div>
        )}

        {/* Dynamic Generating State Modal overlay or visual box */}
        {isLoading && (
          <div className="bg-indigo-950/50 border border-indigo-500/30 p-4 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-4 animate-pulse">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center">
                <Music className="w-4 h-4 text-white animate-spin" />
              </div>
              <div>
                <p className="font-bold text-sm text-slate-200">{loadingMessage}</p>
                <p className="text-xs text-slate-400">قد يستغرق توليد الصوت بضع ثوانٍ...</p>
              </div>
            </div>
            <div className="flex gap-1.5">
              <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
              <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
              <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
            </div>
          </div>
        )}

        {/* Conditional Layouts based on Preset Mode */}
        {activePreset === "full_episode" ? (
          <div className="w-full bg-slate-900/40 border border-slate-800 rounded-2xl p-6 flex flex-col shadow-lg relative min-h-[500px]" id="full-episode-view">
            {/* Full Episode Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-800/80">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-indigo-500/10 flex items-center justify-center border border-indigo-500/30">
                  <Mic className="w-6 h-6 text-indigo-400" />
                </div>
                <div>
                  <h2 className="font-bold text-slate-100 text-lg">النص الحواري الكامل للحلقة المعتمدة</h2>
                  <p className="text-xs text-indigo-400 font-bold uppercase tracking-wider">
                    المذيع: نبرة شارون (Charon) • المحصل: نبرة فينرير (Fenrir)
                  </p>
                </div>
              </div>
              
              {/* Informational locked voices badge */}
              <div className="bg-indigo-500/10 border border-indigo-500/20 px-3 py-1.5 rounded-xl text-xs text-indigo-300 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-400" />
                <span className="font-bold">توليد متصل بملف واحد (Gemini)</span>
              </div>
            </div>

            {/* Elegant notice about the constraints */}
            <div className="bg-indigo-950/40 border border-indigo-900/40 rounded-xl p-4 mb-6 text-xs text-slate-300 leading-relaxed flex items-start gap-3">
              <Info className="w-5 h-5 text-indigo-400 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block text-slate-100 mb-1">⚠️ شروط الإنتاج الصوتي الإلزامية:</span>
                تلتزم المنصة بتوليد كامل نص الحوار المعتمد حرفياً ١٠٠٪ دفعة واحدة بملف صوتي واحد دون تعديل لضمان الأداء السلس باللهجة السعودية العامية البسيطة. تم قفل محرك الصوت على خيار السحابي لخدمة <strong className="text-white">Gemini AI</strong> التزاماً بالشروط.
              </div>
            </div>

            {/* Scrollable Script Log */}
            <div className="bg-slate-950/60 rounded-xl border border-slate-800/80 p-6 max-h-[480px] overflow-y-auto flex flex-col gap-4 font-sans text-sm">
              {SAMPLE_SCRIPTS.find(s => s.id === "full_episode")?.fullScript?.split("\n\n").map((paragraph, index) => {
                const isHost = paragraph.startsWith("المذيع:");
                const isCollector = paragraph.startsWith("المحصّل:") || paragraph.startsWith("المحصل:");
                const textContent = paragraph.replace(/^(المذيع:|المحصّل:|المحصل:)\s*/, "").trim();
                
                if (!textContent) return null;

                return (
                  <div 
                    key={index} 
                    className={`flex flex-col gap-1.5 p-3.5 rounded-xl border transition-all ${
                      isHost 
                        ? "bg-indigo-950/10 border-indigo-950/30 ml-8 text-right" 
                        : isCollector 
                        ? "bg-amber-950/5 border-amber-950/10 mr-8 text-right"
                        : "bg-slate-900/10 border-slate-800/40 mx-4"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {isHost ? (
                        <>
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-black bg-indigo-600 text-white">المذيع</span>
                          <span className="text-[10px] text-indigo-400 font-bold">بصوت Charon (رجالي سعودي عامي)</span>
                        </>
                      ) : isCollector ? (
                        <>
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-black bg-amber-600 text-slate-950">المحصل</span>
                          <span className="text-[10px] text-amber-400 font-bold">بصوت Fenrir (رجالي سعودي عامي)</span>
                        </>
                      ) : (
                        <span className="text-[10px] text-slate-400 font-bold">راوي</span>
                      )}
                    </div>
                    <p className="text-slate-200 leading-relaxed text-xs md:text-sm">{textContent}</p>
                  </div>
                );
              })}
            </div>

            {/* Large generate button for the full episode */}
            <div className="mt-6">
              {voiceEngine === "browser" ? (
                <button
                  id="btn-play-full-episode"
                  disabled={isLoading}
                  onClick={generateCompleteDialogue}
                  className="w-full py-4 bg-gradient-to-l from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 disabled:opacity-50 text-white rounded-xl font-bold flex items-center justify-center gap-3 transition-all shadow-xl shadow-amber-600/20 active:scale-[0.99] cursor-pointer text-base md:text-lg"
                >
                  <Activity className="w-5 h-5 animate-pulse text-amber-100" />
                  تشغيل الحلقة الكاملة عبر محاكاة المتصفح (مجاناً وبلا حدود)
                </button>
              ) : (
                <button
                  id="btn-play-full-episode"
                  disabled={isLoading}
                  onClick={generateCompleteDialogue}
                  className="w-full py-4 bg-gradient-to-l from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 disabled:opacity-50 text-white rounded-xl font-bold flex items-center justify-center gap-3 transition-all shadow-xl shadow-indigo-600/20 active:scale-[0.99] cursor-pointer text-base md:text-lg"
                >
                  <Sparkles className="w-5 h-5 animate-pulse" />
                  إنتاج الحلقة الكاملة بملف صوتي واحد (صوت Gemini)
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            
            {/* Section 1: The Host (المذيع) */}
            <section className="flex flex-col gap-4" id="section-host">
              <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-6 flex flex-col h-full shadow-lg relative">
                
                {/* Header inside host card */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 pb-4 border-b border-slate-800/80">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-indigo-500/10 flex items-center justify-center border border-indigo-500/30">
                      <Mic className="w-6 h-6 text-indigo-400" />
                    </div>
                    <div>
                      <h2 className="font-bold text-slate-100 text-lg">نص المذيع</h2>
                      <p className="text-xs text-indigo-400 font-bold uppercase tracking-wider">صوت هادئ ومحترف • مقدم الحلقات</p>
                    </div>
                  </div>
                  
                  {/* Voice Selection */}
                  <div className="flex flex-col">
                    <label className="text-[10px] text-slate-400 mb-1 font-bold">نبرة صوت المذيع:</label>
                    <select
                      id="host-voice-select"
                      value={hostVoice}
                      onChange={(e) => setHostVoice(e.target.value)}
                      className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                    >
                      {VOICE_OPTIONS.map((v) => (
                        <option key={v.value} value={v.value}>
                          {v.label} ({v.gender === "male" ? "رجالي" : "نسائي"})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Informative description */}
                <p className="text-xs text-slate-400 mb-3 leading-relaxed">
                  {VOICE_OPTIONS.find(v => v.value === hostVoice)?.description}
                </p>
                
                {/* Text Input area */}
                <div className="flex-grow flex flex-col">
                  <textarea
                    id="host-textarea"
                    value={hostText}
                    onChange={(e) => setHostText(e.target.value)}
                    className="flex-grow w-full bg-slate-950/50 border border-slate-800/80 rounded-xl p-4 text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/50 resize-none transition-colors min-h-[160px] text-sm leading-relaxed"
                    placeholder="اكتب هنا النص الذي تريد أن يقوله المذيع بلهجة سعودية..."
                  ></textarea>
                  <div className="flex justify-between text-[11px] text-slate-500 mt-2">
                    <span>علامات الترقيم تضيف وقفات طبيعية كالبودكاست</span>
                    <span>{hostText.length} حرفاً</span>
                  </div>
                </div>
                
                {/* Trigger single button */}
                <button
                  id="btn-play-host"
                  disabled={isLoading}
                  onClick={() => generateSingleSpeaker("host")}
                  className="mt-4 w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-600/10 active:scale-[0.98] cursor-pointer"
                >
                  <Volume2 className="w-5 h-5" />
                  تشغيل صوت المذيع {voiceEngine === "browser" && "(محلياً)"}
                </button>
              </div>
            </section>

            {/* Section 2: The Collector (المحصل) */}
            <section className="flex flex-col gap-4" id="section-collector">
              <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-6 flex flex-col h-full shadow-lg relative">
                
                {/* Header inside collector card */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 pb-4 border-b border-slate-800/80">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center border border-amber-500/30">
                      <User className="w-6 h-6 text-amber-400" />
                    </div>
                    <div>
                      <h2 className="font-bold text-slate-100 text-lg">نص المحصل</h2>
                      <p className="text-xs text-amber-400 font-bold uppercase tracking-wider">صوت واقعي ومباشر • خبير وممارس القطاع</p>
                    </div>
                  </div>
                  
                  {/* Voice Selection */}
                  <div className="flex flex-col">
                    <label className="text-[10px] text-slate-400 mb-1 font-bold">نبرة صوت المحصل:</label>
                    <select
                      id="collector-voice-select"
                      value={collectorVoice}
                      onChange={(e) => setCollectorVoice(e.target.value)}
                      className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500 cursor-pointer"
                    >
                      {VOICE_OPTIONS.map((v) => (
                        <option key={v.value} value={v.value}>
                          {v.label} ({v.gender === "male" ? "رجالي" : "نسائي"})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Informative description */}
                <p className="text-xs text-slate-400 mb-3 leading-relaxed">
                  {VOICE_OPTIONS.find(v => v.value === collectorVoice)?.description}
                </p>
                
                {/* Text Input area */}
                <div className="flex-grow flex flex-col">
                  <textarea
                    id="collector-textarea"
                    value={collectorText}
                    onChange={(e) => setCollectorText(e.target.value)}
                    className="flex-grow w-full bg-slate-950/50 border border-slate-800/80 rounded-xl p-4 text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500/50 resize-none transition-colors min-h-[160px] text-sm leading-relaxed"
                    placeholder="اكتب هنا النص الذي تريد أن يقوله المحصل بأسلوب سعودي بسيط..."
                  ></textarea>
                  <div className="flex justify-between text-[11px] text-slate-500 mt-2">
                    <span>يقال بلهجة شعبية تقريبية للشارع السعودي</span>
                    <span>{collectorText.length} حرفاً</span>
                  </div>
                </div>
                
                {/* Trigger single button */}
                <button
                  id="btn-play-collector"
                  disabled={isLoading}
                  onClick={() => generateSingleSpeaker("collector")}
                  className="mt-4 w-full py-3 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-amber-600/10 active:scale-[0.98] cursor-pointer"
                >
                  <Volume2 className="w-5 h-5" />
                  تشغيل صوت المحصل {voiceEngine === "browser" && "(محلياً)"}
                </button>
              </div>
            </section>

          </div>
        )}

        {/* Quick Help Guide */}
        <div className="bg-slate-900/20 border border-slate-800/50 rounded-xl p-4 flex gap-3 text-xs text-slate-400 items-start leading-relaxed">
          <HelpCircle className="w-5 h-5 text-indigo-400 flex-shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-slate-300 block mb-1">💡 نصائح لإنتاج أفضل جودة:</span>
            {activePreset === "full_episode" ? (
              <>
                - اضغط على زر <strong className="text-slate-200">"إنتاج الحلقة الكاملة بملف صوتي واحد"</strong> بالأسفل لتوليد كامل الـ ٥ أجزاء معاً.
                <br />
                - يتميز توليد الحوار المتكامل بتنسيق نبرات ممتازة ومخارج حروف باللهجة السعودية العامية البسيطة جداً.
                <br />
                - الوقفات عند علامات الترقيم (الفواصل والوقفات ...) تساهم في إخراج العمل كالبودكاست الحقيقي المليء بالحياة والعمق.
              </>
            ) : (
              <>
                - يمكنك استخدام علامات المد والوقف لتمثيل السكتات والوقفات كالبودكاست الحقيقي مثل الفواصل والوقفات (...)
                <br />
                - الوضع السحابي (Gemini) يمنحك أفضل أداء صوتي ومخارج سعودية طبيعية جداً.
                <br />
                - إذا نفدت الحصة اليومية للحساب المجاني، لا تقلق! اضغط على <strong className="text-slate-200">صوت المتصفح البديل</strong> في الأعلى لتستمر بإنتاج حلقاتك والاستماع إليها مجاناً وبلا حدود.
              </>
            )}
          </div>
        </div>

      </main>

      {/* Footer Player & Dialogue Generation Control Bar */}
      <footer className="fixed bottom-0 left-0 right-0 z-30 bg-[#0B0F19]/95 border-t border-slate-800/80 px-4 md:px-10 py-4 shadow-2xl backdrop-blur-md flex flex-col md:flex-row items-center gap-4 justify-between">
        
        {/* Left Side: Audio Player Control (Conditional view) */}
        <div className="w-full md:w-auto flex-1 flex flex-col gap-1.5 min-w-[280px]">
          {audioUrl ? (
            <div>
              <div className="flex justify-between items-end mb-1">
                <span className="text-xs text-slate-300 font-bold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  الملف الصوتي الحالي:
                  <span className="text-slate-400 font-normal truncate max-w-[150px]">{audioName.split("_")[0]}</span>
                </span>
                <span className="text-[10px] text-slate-400 font-mono">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
              </div>
              
              {/* custom progress bar */}
              <div 
                onClick={handleProgressClick}
                className={`h-2 w-full bg-slate-800 rounded-full overflow-hidden relative ${audioUrl.startsWith("browser-native") ? "cursor-not-allowed" : "cursor-pointer group"}`}
                title={audioUrl.startsWith("browser-native") ? "التمرير غير متاح أثناء التشغيل المحلي" : "انقر لتغيير موضع التشغيل"}
              >
                <div 
                  className="absolute inset-y-0 right-0 bg-gradient-to-l from-indigo-500 to-amber-500 transition-all duration-100"
                  style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%`, right: 'auto', left: 0 }}
                ></div>
                {!audioUrl.startsWith("browser-native") && (
                  <div className="absolute top-0 bottom-0 w-1 bg-white opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `${duration ? (currentTime / duration) * 100 : 0}%` }}></div>
                )}
              </div>

              {/* Action Buttons for custom audio element */}
              <div className="flex gap-4 mt-2 items-center">
                <button
                  id="btn-play-pause"
                  onClick={togglePlayPause}
                  className="text-slate-200 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 px-3 py-1 rounded-lg text-xs flex items-center gap-1 transition-all cursor-pointer"
                  title={isPlaying ? "إيقاف مؤقت" : "تشغيل"}
                >
                  {isPlaying ? (
                    <>
                      <Pause className="w-3.5 h-3.5" />
                      <span>إيقاف</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      <span>تشغيل</span>
                    </>
                  )}
                </button>
                
                <button
                  id="btn-restart"
                  onClick={restartAudio}
                  className="text-slate-400 hover:text-white text-xs flex items-center gap-1 cursor-pointer"
                  title="إعادة من البداية"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>إعادة</span>
                </button>

                {!audioUrl.startsWith("browser-native") ? (
                  <a
                    id="btn-download"
                    href={audioUrl}
                    download={audioName}
                    className="text-indigo-400 hover:text-indigo-300 text-xs flex items-center gap-1 font-bold cursor-pointer"
                    title="تحميل الملف الصوتي بصيغة MP3"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>تحميل MP3</span>
                  </a>
                ) : (
                  <span className="text-[10px] text-slate-500 cursor-not-allowed flex items-center gap-1" title="التحميل كملف MP3 يتطلب تفعيل الوضع السحابي (Gemini AI)">
                    <Download className="w-3.5 h-3.5 text-slate-600" />
                    <span>التحميل متاح في الوضع السحابي فقط</span>
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="text-slate-500 text-xs text-center md:text-right py-4">
              لم يتم توليد أي مقطع صوتي بعد. اكتب النص بالأعلى ثم اضغط تشغيل أو توليد الحوار.
            </div>
          )}
        </div>

        {/* Center: Master Trigger Generate Complete Dialogue */}
        <div className="flex-shrink-0 my-2 md:my-0">
          <button
            id="btn-generate-dialogue"
            disabled={isLoading}
            onClick={generateCompleteDialogue}
            className="px-8 py-4 bg-white hover:bg-slate-100 disabled:bg-slate-400 disabled:cursor-not-allowed text-slate-950 font-black text-md md:text-lg rounded-2xl shadow-xl hover:shadow-2xl transition-all flex items-center justify-center gap-3 active:scale-[0.98] cursor-pointer"
          >
            <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
            </div>
            توليد الحوار كامل {voiceEngine === "browser" && "(محلياً)"}
          </button>
        </div>

        {/* Right Side: Format info */}
        <div className="flex-1 flex justify-end items-center gap-4 hidden sm:flex">
          <div className="flex flex-col items-end">
            <p className="text-[10px] text-slate-400">تنسيق مخرج الصوت الحالي</p>
            <p className="text-xs font-bold text-slate-200">
              {voiceEngine === "cloud" ? "WAVE @ 24kHz Mono" : "متحدث المتصفح (مباشر)"}
            </p>
          </div>
          <div className="w-10 h-10 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center">
            <Music className="w-5 h-5 text-indigo-400" />
          </div>
        </div>

      </footer>
    </div>
  );
}
