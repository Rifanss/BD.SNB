import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Lazy-initialized Gemini Client to prevent crashing if the key is missing on startup
let ai: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!ai) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("مفتاح واجهة برمجة التطبيقات (GEMINI_API_KEY) مفقود. يرجى إضافته في لوحة الأسرار (Secrets) في الإعدادات.");
    }
    ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return ai;
}

/**
 * Encodes raw 16-bit PCM buffer (24000Hz, mono) into a valid WAV format buffer.
 */
function encodeWav(pcmBuffer: Buffer, sampleRate: number = 24000): Buffer {
  const buffer = Buffer.alloc(44 + pcmBuffer.length);
  
  // "RIFF" chunk descriptor
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + pcmBuffer.length, 4); // File size - 8
  buffer.write("WAVE", 8);
  
  // "fmt " sub-chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Sub-chunk size
  buffer.writeUInt16LE(1, 20);  // Audio format (1 = PCM)
  buffer.writeUInt16LE(1, 22);  // Number of channels (1 = Mono)
  buffer.writeUInt32LE(sampleRate, 24); // Sample rate
  buffer.writeUInt32LE(sampleRate * 1 * 2, 28); // Byte rate (sampleRate * channels * bytesPerSample)
  buffer.writeUInt16LE(2, 32);  // Block align (channels * bytesPerSample)
  buffer.writeUInt16LE(16, 34); // Bits per sample
  
  // "data" sub-chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(pcmBuffer.length, 40); // Chunk size
  
  // Copy PCM audio samples
  pcmBuffer.copy(buffer, 44);
  
  return buffer;
}

// Single-speaker TTS generation route
app.post("/api/generate-tts", async (req, res) => {
  try {
    const { text, voice, role } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "الرجاء إدخال النص أولاً" });
    }
    
    const client = getGeminiClient();
    
    // Instruction prefix to enforce natural Saudi dialect, tone, and podcast style
    let promptPrefix = "";
    if (role === "host") {
      promptPrefix = "تحدث بنبرة واضحة ومثقفة ومحترفة كالمذيع، بلهجة سعودية عامية خفيفة وبسيطة جداً. يُمنع منعاً باتاً استخدام اللغة العربية الفصحى أو الأسلوب الرسمي. انطق النص بأسلوب حواري طبيعي كالمكالمات اليومية، وانطق النص التالي مباشرة دون أي إضافات:";
    } else {
      promptPrefix = "تحدث بنبرة عملية وواقعية كالمحصل، بلهجة سعودية عامية بسيطة ومحببة وقريبة من لغة الشارع السعودي اليومية المعتادة. يُمنع منعاً باتاً استخدام اللغة العربية الفصحى أو التحدث برسمية. انطق النص التالي مباشرة دون أي إضافات:";
    }
    
    const fullPrompt = `${promptPrefix}\n\n${text}`;
    
    const response = await client.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: fullPrompt }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice || 'Kore' },
          },
        },
      },
    });
    
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new Error("لم يتمكن نظام Gemini من توليد الصوت. يرجى مراجعة إعدادات النص والمحاولة مرة أخرى.");
    }
    
    const pcmBuffer = Buffer.from(base64Audio, "base64");
    const wavBuffer = encodeWav(pcmBuffer, 24000);
    
    res.setHeader("Content-Type", "audio/wav");
    res.send(wavBuffer);
  } catch (error: any) {
    console.error("Error in generate-tts:", error);
    res.status(500).json({ error: error.message || "حدث خطأ أثناء توليد الصوت." });
  }
});

// Multi-speaker dialogue generation route
app.post("/api/generate-dialogue", async (req, res) => {
  try {
    const { hostText, hostVoice, collectorText, collectorVoice, fullScript } = req.body;
    
    if (!fullScript && (!hostText || !hostText.trim() || !collectorText || !collectorText.trim())) {
      return res.status(400).json({ error: "الرجاء كتابة نص المذيع ونص المحصل لتوليد الحوار كامل." });
    }
    
    const client = getGeminiClient();
    
    if (fullScript) {
      // 1. Normalize speaker tags
      const normalizedScript = fullScript
        .replace(/المحصّل:/g, "المحصل:")
        .replace(/المحصّل :/g, "المحصل:");

      // 2. Helper to split script into chunks of speaker turns (e.g., 8 turns per chunk)
      const lines = normalizedScript.split("\n");
      const chunks: string[] = [];
      let currentChunkLines: string[] = [];
      let turnCount = 0;
      const turnsPerChunk = 8; // Safe chunk size to prevent API and network timeouts
      
      for (const line of lines) {
        const trimmed = line.trim();
        const isNewTurn = trimmed.startsWith("المذيع:") || 
                          trimmed.startsWith("المحصل:");
                          
        if (isNewTurn) {
          if (turnCount >= turnsPerChunk) {
            chunks.push(currentChunkLines.join("\n"));
            currentChunkLines = [];
            turnCount = 0;
          }
          turnCount++;
        }
        currentChunkLines.push(line);
      }
      
      if (currentChunkLines.length > 0) {
        chunks.push(currentChunkLines.join("\n"));
      }

      console.log(`Processing full script in ${chunks.length} chunks...`);

      const pcmBuffers: Buffer[] = [];
      
      // Process chunks in batches of 2 to maintain high speed while staying safe from rate limit spikes
      for (let i = 0; i < chunks.length; i += 2) {
        const batch = chunks.slice(i, i + 2);
        console.log(`Generating batch: chunks ${i} to ${i + batch.length - 1}...`);
        
        const results = await Promise.all(
          batch.map(async (chunkText, idx) => {
            const prompt = `حول الحوار التالي بدقة وجمال إلى ملف صوتي متصل للبودكاست.
انطق كل سطر بصوت المتحدث المذكور بدقة تامة وبأداء تمثيلي طبيعي جداً.
تحدث بالكامل باللهجة السعودية العامية البسيطة والأسلوب الطبيعي الواقعي المعتاد في المجالس السعودية ومكالماتهم اليومية.
يُمنع منعاً باتاً استخدام اللغة العربية الفصحى أو الكلمات الرسمية.
حافظ على الوقفات الطبيعية والنفس وعلامات الترقيم مثل الوقفات البسيطة وعلامات الاستفهام والتعجب والنقاط والفواصل بدقة تامة وبشكل مستمر دون أي تحريف أو حذف أو تعديل لأي حرف من الكلمات.

${chunkText}`;

            const response = await client.models.generateContent({
              model: "gemini-3.1-flash-tts-preview",
              contents: [{ parts: [{ text: prompt }] }],
              config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  multiSpeakerVoiceConfig: {
                    speakerVoiceConfigs: [
                      {
                        speaker: 'المذيع',
                        voiceConfig: {
                          prebuiltVoiceConfig: { voiceName: hostVoice || 'Charon' }
                        }
                      },
                      {
                        speaker: 'المحصل',
                        voiceConfig: {
                          prebuiltVoiceConfig: { voiceName: collectorVoice || 'Fenrir' }
                        }
                      }
                    ]
                  }
                }
              }
            });

            const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (!base64Audio) {
              throw new Error(`لم يتمكن نظام Gemini من توليد الصوت للجزء ${i + idx + 1}.`);
            }
            return Buffer.from(base64Audio, "base64");
          })
        );
        
        pcmBuffers.push(...results);
      }

      const combinedPcmBuffer = Buffer.concat(pcmBuffers);
      const wavBuffer = encodeWav(combinedPcmBuffer, 24000);
      
      res.setHeader("Content-Type", "audio/wav");
      res.send(wavBuffer);
      
    } else {
      // Standard path for short prompt (non-chunked)
      const prompt = `حول الحوار التالي بدقة وجمال إلى ملف صوتي متصل للبودكاست.
انطق كل سطر بصوت المتحدث المذكور بدقة تامة وبأداء تمثيلي طبيعي جداً.
تحدث بالكامل باللهجة السعودية العامية البسيطة والأسلوب الطبيعي الواقعي المعتاد في المجالس السعودية ومكالماتهم اليومية.
يُمنع منعاً باتاً استخدام اللغة العربية الفصحى أو الكلمات الرسمية.
حافظ على الوقفات الطبيعية والنفس وعلامات الترقيم مثل الوقفات البسيطة وعلامات الاستفهام.

المذيع: ${hostText}
المحصل: ${collectorText}`;

      const response = await client.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                {
                  speaker: 'المذيع',
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: hostVoice || 'Charon' }
                  }
                },
                {
                  speaker: 'المحصل',
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: collectorVoice || 'Fenrir' }
                  }
                }
              ]
            }
          }
        }
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error("لم يتمكن نظام Gemini من توليد الحوار المشترك. يرجى المحاولة مرة أخرى.");
      }
      
      const pcmBuffer = Buffer.from(base64Audio, "base64");
      const wavBuffer = encodeWav(pcmBuffer, 24000);
      
      res.setHeader("Content-Type", "audio/wav");
      res.send(wavBuffer);
    }
  } catch (error: any) {
    console.error("Error in generate-dialogue:", error);
    
    const errStr = String(error?.message || error || "");
    const isQuota = errStr.includes("429") || errStr.toLowerCase().includes("quota") || errStr.toLowerCase().includes("exhausted") || error?.status === 429;
    const statusCode = isQuota ? 429 : 500;
    
    res.status(statusCode).json({ error: error.message || "حدث خطأ أثناء توليد الحوار المشترك." });
  }
});

// Vite middleware for development or serving built assets in production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
