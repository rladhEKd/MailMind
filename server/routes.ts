import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { aiChatRequestSchema, chatRequestSchema } from "@shared/schema";
import { 
  classifyEmail, 
  chatWithEmailContext,
  checkOllamaConnection,
  generateEmbedding // [신규] 임베딩 함수
} from "./ollama";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });

// [신규] 텍스트 청킹 함수 (약 500자 단위, 오버랩 100자)
// 텍스트를 의미 있는 단위로 잘라서 저장해야 검색 정확도가 올라갑니다.
function chunkString(str: string, size: number = 500, overlap: number = 100): string[] {
  if (!str) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < str.length) {
    const end = Math.min(start + size, str.length);
    chunks.push(str.slice(start, end));
    if (end === str.length) break;
    start += size - overlap;
  }
  return chunks;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // 1. 통계 API
  app.get("/api/stats", async (_req, res) => {
    try {
      const stats = await storage.getStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "통계 정보를 가져오지 못했습니다." });
    }
  });

  app.get("/api/ollama/status", async (_req, res) => {
    const connected = await checkOllamaConnection();
    res.json({ connected, baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434" });
  });

  app.get("/api/conversations", async (_req, res) => {
    const convs = await storage.getConversations();
    res.json(convs);
  });

  app.get("/api/conversations/:id/messages", async (req, res) => {
    const messages = await storage.getMessages(parseInt(req.params.id));
    res.json(messages);
  });

  // 2. 이메일 데이터 가져오기 (RAG 데이터 생성 포함)
  app.post("/api/import", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, message: "파일 없음" });

    try {
      const rawData = JSON.parse(req.file.buffer.toString());
      const messages = Array.isArray(rawData) ? rawData : (rawData.messages || []);
      
      const emailsToInsert = messages.map((msg: any) => ({
        subject: msg.subject || "(제목 없음)",
        sender: typeof msg.from === 'object' ? msg.from.email : (msg.sender || "Unknown"),
        body: msg.body_text || msg.body || "",
        date: msg.date || new Date().toISOString(),
        isProcessed: false 
      }));

      // 1-1. 메일 원본 DB 저장
      const insertedEmails = await storage.insertEmailsAndGetIds(emailsToInsert);
      
      res.json({
        ok: true,
        inserted: insertedEmails.length,
        message: `${insertedEmails.length}개 저장 완료. 백그라운드에서 AI 분석 및 벡터 임베딩이 시작됩니다.`
      });

      // 1-2. 백그라운드 작업: 청킹 & 임베딩
      (async () => {
        for (const email of insertedEmails) {
          try {
            // (1) 분류 (기존 로직)
            const cls = await classifyEmail(email.subject, email.body, email.sender);
            await storage.updateEmailClassification(email.id, cls.classification, cls.confidence);

            // (2) 청킹 및 임베딩 생성 (RAG 핵심)
            // 제목과 발신자 정보도 포함하여 검색 품질 향상
            const fullContent = `Subject: ${email.subject}\nSender: ${email.sender}\nDate: ${email.date}\n\n${email.body}`;
            const textChunks = chunkString(fullContent, 500, 100); // 500자 단위 분할, 100자 겹침
            
            const chunksToSave = [];
            for (const text of textChunks) {
              const vector = await generateEmbedding(text);
              if (vector.length > 0) {
                chunksToSave.push({
                  mailId: email.id,
                  subject: email.subject,
                  content: text,
                  embedding: vector
                });
              }
            }
            
            if (chunksToSave.length > 0) {
              await storage.saveRagChunks(chunksToSave);
            }
            console.log(`[RAG] Email ${email.id}: Saved ${chunksToSave.length} vector chunks.`);
          } catch (e) {
            console.error(`Error processing email ${email.id}:`, e);
          }
        }
      })();

    } catch (error: any) {
      if (!res.headersSent) res.status(500).json({ ok: false, message: error.message });
    }
  });

  // 3. AI 챗봇 대화 API (RAG 적용)
  app.post("/api/ai/chat", async (req, res) => {
    try {
      const { message, conversationId } = aiChatRequestSchema.parse(req.body);

      // (1) 사용자 질문 임베딩
      const queryVector = await generateEmbedding(message);

      // (2) 벡터 DB 검색 (상위 3개, 유사도 0.3 이상)
      const relevantChunks = await storage.searchRagChunks(queryVector, 3);
      
      console.log(`[RAG] 질문("${message}")에 대해 ${relevantChunks.length}개의 관련 청크를 찾았습니다.`);

      // (3) 검색된 청크 + 질문을 LLM에게 전달
      const response = await chatWithEmailContext(message, relevantChunks);

      // (4) 대화 저장
      let convId = conversationId;
      if (!convId) {
        const conv = await storage.createConversation({ title: message.substring(0, 20) });
        convId = conv.id;
      }
      await storage.addMessage({ conversationId: convId, role: "user", content: message });
      await storage.addMessage({ conversationId: convId, role: "assistant", content: response });

      res.json({ response, conversationId: convId });

    } catch (error) {
      console.error("Chat Error:", error);
      res.status(500).json({ error: "AI 서버 응답 중 오류가 발생했습니다." });
    }
  });

  // 4. 일반 키워드 검색 API
  app.post("/api/search", async (req, res) => {
    try {
      const { message, topK } = chatRequestSchema.parse(req.body);
      const results = await storage.searchEmails(message, topK);
      const answer = `검색어 "${message}" 결과:\n${results.map(r => `- ${r.subject}`).join('\n')}`;
      res.json({ answer, citations: results, debug: { topK, hitsCount: results.length } });
    } catch (error) {
      res.status(500).json({ error: "검색 중 오류가 발생했습니다." });
    }
  });

  app.get("/api/settings/storage", async (_req, res) => {
    res.json({
      mode: "postgres",
      info: "PostgreSQL + pgvector 모드 작동 중",
      needsRestart: false
    });
  });

  const httpServer = createServer(app);
  return httpServer;
}