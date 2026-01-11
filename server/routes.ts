import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage.ts";
import multer from "multer";
import { 
  chatRequestSchema, 
  aiChatRequestSchema,
  eventExtractionRequestSchema,
  type ChatResponse, 
  type ImportResult, 
  type SearchResult,
  type AiChatResponse,
  type EventExtractionResponse
} from "../shared/schema.ts";
import { ZodError } from "zod";
import { chatWithOllama, extractEventsFromEmail, checkOllamaConnection, classifyEmail } from "./ollama.ts";
import { parsePSTFromBuffer } from "./pst-parser.ts";

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

function parseEmailsFromJson(content: string): Array<{
  subject: string;
  sender: string;
  date: string;
  body: string;
  importance?: string;
  label?: string;
}> {
  try {
    const data = JSON.parse(content);
    const emails = Array.isArray(data) ? data : (data.emails || []);
    
    return emails.map((email: Record<string, unknown>) => ({
      subject: String(email.subject || email.Subject || ""),
      sender: String(email.sender || email.from || email.From || ""),
      date: String(email.date || email.Date || email.sent_date || ""),
      body: String(email.body || email.content || email.text || email.Body || ""),
      importance: email.importance ? String(email.importance) : undefined,
      label: email.label ? String(email.label) : undefined,
    }));
  } catch {
    return [];
  }
}

function generateSampleEmails(): Array<{
  subject: string;
  sender: string;
  date: string;
  body: string;
}> {
  return [
    {
      subject: "Project status update",
      sender: "kim@example.com",
      date: "2025-01-05 09:30:00",
      body: "Please review the latest project status and confirm next steps.",
    },
    {
      subject: "Meeting schedule 안내",
      sender: "park@example.com",
      date: "2025-01-06 14:00:00",
      body: "회의 일정과 장소를 공유합니다. 참석 여부를 회신해 주세요.",
    },
    {
      subject: "Estimate request",
      sender: "lee@example.com",
      date: "2025-01-04 11:15:00",
      body: "견적 요청드립니다. 가능한 빠른 회신 부탁드립니다.",
    },
  ];
}
export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  app.get("/api/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getStats();
      res.json(stats);
    } catch (error) {
      console.error("Stats error:", error);
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  app.post("/api/import", upload.single("file"), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      let emailsToImport: Array<{
        subject: string;
        sender: string;
        date: string;
        body: string;
        importance?: string;
        label?: string;
      }> = [];
      let filename = "sample_data";

      if (file) {
        filename = file.originalname;
        const ext = filename.toLowerCase().split(".").pop();

        if (ext === "json") {
          const content = file.buffer.toString("utf-8");
          emailsToImport = parseEmailsFromJson(content);
        } else if (ext === "pst") {
          const parseResult = parsePSTFromBuffer(file.buffer, filename);
          if (parseResult.errors.length > 0 && parseResult.emails.length === 0) {
            res.status(400).json({
              ok: false,
              inserted: 0,
              message: `PST ?뚯씪 ?뚯떛 ?ㅻ쪟: ${parseResult.errors.join(", ")}`,
            });
            return;
          }
          emailsToImport = parseResult.emails;
        } else {
          res.status(400).json({
            ok: false,
            inserted: 0,
            message: "吏?먮릺吏 ?딅뒗 ?뚯씪 ?뺤떇?낅땲?? JSON ?먮뒗 PST ?뚯씪???ъ슜??二쇱꽭??",
          });
          return;
        }
      } else {
        emailsToImport = generateSampleEmails();
        filename = "sample_demo_data";
      }

      if (emailsToImport.length === 0) {
        res.status(400).json({
          ok: false,
          inserted: 0,
          message: "?뚯씪?먯꽌 ?대찓?쇱쓣 李얠쓣 ???놁뒿?덈떎.",
        });
        return;
      }

      // ?뵩 hasAttachment 紐낆떆?곸쑝濡?二쇱엯 (JSON/PST 怨듯넻)
      const emailsWithAttachment = emailsToImport.map(email => ({
        ...email,
        hasAttachment: "false" as const, // 泥⑤??뚯씪 硫뷀? ?놁쑝硫?湲곕낯 false
      }));
      const insertedEmails = await storage.insertEmailsAndGetIds(emailsWithAttachment);

      const insertedCount = insertedEmails.length;

      await storage.logImport({
        filename,
        emailsImported: insertedCount,
      });

      let classifiedCount = 0;
      let eventsExtractedCount = 0;
      let skippedCount = 0;

      const ollamaConnected = await checkOllamaConnection();

      if (ollamaConnected) {
        for (const email of insertedEmails) {
          try {
            // 1截뤴깵 遺꾨쪟 ?쒕룄
            const classification = await classifyEmail(
              email.subject,
              email.body,
              email.sender
            );

            // 2截뤴깵 遺꾨쪟 寃곌낵 媛??(?듭떖)
            if (!classification?.classification) {
              console.warn(
                `[SKIP] Invalid classification for email ${email.id}`,
                classification
              );
              skippedCount++;
              continue;
            }

            // 3截뤴깵 遺꾨쪟 ???
            await storage.updateEmailClassification(
              email.id,
              classification.classification,
              classification.confidence
            );
            classifiedCount++;

            // 4截뤴깵 ?쇱젙 異붿텧
            const events = await extractEventsFromEmail(
              email.subject,
              email.body,
              email.date
            );

            for (const event of events) {
              await storage.addCalendarEvent({
                emailId: email.id,
                title: event.title,
                startDate: event.startDate,
                endDate: event.endDate || null,
                location: event.location || null,
                description: event.description || null,
              });
              eventsExtractedCount++;
            }

            // 5截뤴깵 ?ш린源뚯? ?깃났??寃쎌슦?먮쭔 processed 泥섎━
            await storage.markEmailProcessed(email.id);

          } catch (err) {
            console.error(`Error processing email ${email.id}:`, err);
            skippedCount++;
          }
        }
      }

      res.json({
        ok: true,
        inserted: insertedCount,
        classified: classifiedCount,
        skipped: skippedCount,
        eventsExtracted: eventsExtractedCount,
        message: ollamaConnected
          ? `${insertedCount}媛쒖쓽 ?대찓?쇱쓣 媛?몄솕?듬땲?? ${classifiedCount}媛?遺꾨쪟, ${skippedCount}媛?嫄대꼫?, ${eventsExtractedCount}媛??쇱젙 異붿텧 ?꾨즺.`
          : `${insertedCount}媛쒖쓽 ?대찓?쇱쓣 媛?몄솕?듬땲?? AI ?쒕쾭 誘몄뿰寃곕줈 ?먮룞 遺꾨쪟/?쇱젙 異붿텧??嫄대꼫?곗뼱議뚯뒿?덈떎.`,
      });
    } catch (error) {
      console.error("Import error:", error);
      res.status(500).json({
        ok: false,
        inserted: 0,
        message: error instanceof Error ? error.message : "媛?몄삤湲?以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎.",
      });
    }
  });


  app.post("/api/search", async (req: Request, res: Response) => {
    try {
      const validationResult = chatRequestSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        const errors = validationResult.error.errors.map(e => e.message).join(", ");
        res.status(400).json({ error: errors || "?섎せ???붿껌?낅땲??" });
        return;
      }

      const { message, topK } = validationResult.data;
      const citations: SearchResult[] = await storage.searchEmails(message.trim(), topK);

      const topSubjects = citations
        .slice(0, 10)
        .map(c => `- ${c.subject} (?먯닔=${c.score.toFixed(1)}, ID=${c.mailId})`)
        .join("\n");

      const answer = `寃?됱뼱: ${message}\n\nTop 寃곌낵:\n${topSubjects || "- (寃곌낵 ?놁쓬)"}`;

      const response: ChatResponse = {
        answer,
        citations,
        debug: {
          topK,
          hitsCount: citations.length,
        },
      };

      res.json(response);
    } catch (error) {
      console.error("Search error:", error);
      if (error instanceof ZodError) {
        res.status(400).json({ error: "?섎せ???붿껌 ?뺤떇?낅땲??" });
        return;
      }
      res.status(500).json({ error: "寃??以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.get("/api/ping", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      hint: "POST /api/import to import emails, /api/stats for stats, POST /api/search for search"
    });
  });

  app.get("/api/ollama/status", async (_req: Request, res: Response) => {
    try {
      const connected = await checkOllamaConnection();
      res.json({ connected, baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434" });
    } catch {
      res.json({ connected: false, baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434" });
    }
  });

  app.get("/api/conversations", async (_req: Request, res: Response) => {
    try {
      const conversations = await storage.getConversations();
      res.json(conversations);
    } catch (error) {
      console.error("Get conversations error:", error);
      res.status(500).json({ error: "???紐⑸줉??媛?몄삤??以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.get("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const emailId = parseInt(req.params.id);
      if (isNaN(emailId)) {
        res.status(400).json({ error: "?섎せ???대찓??ID?낅땲??" });
        return;
      }
      const email = await storage.getEmailById(emailId);
      if (!email) {
        res.status(404).json({ error: "?대찓?쇱쓣 李얠쓣 ???놁뒿?덈떎." });
        return;
      }
      res.json(email);
    } catch (error) {
      console.error("Get email error:", error);
      res.status(500).json({ error: "?대찓?쇱쓣 媛?몄삤??以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.get("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const conversationId = parseInt(req.params.id);
      if (isNaN(conversationId)) {
        res.status(400).json({ error: "?섎せ?????ID?낅땲??" });
        return;
      }
      const messages = await storage.getMessages(conversationId);
      res.json(messages);
    } catch (error) {
      console.error("Get messages error:", error);
      res.status(500).json({ error: "硫붿떆吏瑜?媛?몄삤??以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.post("/api/ai/chat", async (req: Request, res: Response) => {
    try {
      const validationResult = aiChatRequestSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        const errors = validationResult.error.errors.map(e => e.message).join(", ");
        res.status(400).json({ error: errors || "?섎せ???붿껌?낅땲??" });
        return;
      }

      const { message, conversationId } = validationResult.data;
      
      let convId = conversationId;
      if (!convId) {
        const newConv = await storage.createConversation({ title: message.slice(0, 50) });
        convId = newConv.id;
      }

      await storage.addMessage({
        conversationId: convId,
        role: "user",
        content: message,
      });

      const relevantEmails = await storage.searchEmails(message, 5);
      
      let emailContext = "";
      if (relevantEmails.length > 0) {
        const emailContextItems = relevantEmails.map((e, i) => 
          `[?대찓??${i + 1}]\n?쒕ぉ: ${e.subject}\n諛쒖떊?? ${e.sender}\n?좎쭨: ${e.date}\n?댁슜: ${e.body.substring(0, 300)}...`
        );
        emailContext = `\n\n李멸퀬??愿???대찓?쇰뱾:\n${emailContextItems.join("\n\n")}`;
      }

      const previousMessages = await storage.getMessages(convId);
      const ollamaMessages = previousMessages.map(m => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));

      const systemPrompt = `?뱀떊? ?대찓??愿由ъ? ?쇱젙 ?뺣━瑜??꾩?二쇰뒗 AI 鍮꾩꽌?낅땲?? 
?ъ슜?먭? ?낅줈?쒗븳 ?대찓???곗씠?곕? 湲곕컲?쇰줈 吏덈Ц???듬??댁＜?몄슂.
?쒓뎅?대줈 移쒖젅?섍쾶 ?묐떟?댁＜?몄슂.${emailContext}`;

      const aiResponse = await chatWithOllama([
        { role: "system", content: systemPrompt },
        ...ollamaMessages,
      ]);

      await storage.addMessage({
        conversationId: convId,
        role: "assistant",
        content: aiResponse,
      });

      const response: AiChatResponse = {
        response: aiResponse,
        conversationId: convId,
      };

      res.json(response);
    } catch (error) {
      console.error("AI chat error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "AI 梨꾪똿 以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.post("/api/events/extract", async (req: Request, res: Response) => {
    try {
      const validationResult = eventExtractionRequestSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        const errors = validationResult.error.errors.map(e => e.message).join(", ");
        res.status(400).json({ error: errors || "?섎せ???붿껌?낅땲??" });
        return;
      }

      const { emailId } = validationResult.data;
      const email = await storage.getEmailById(emailId);
      
      if (!email) {
        res.status(404).json({ error: "?대찓?쇱쓣 李얠쓣 ???놁뒿?덈떎." });
        return;
      }

      const extractedEvents = await extractEventsFromEmail(
        email.subject,
        email.body,
        email.date
      );

      for (const event of extractedEvents) {
        await storage.addCalendarEvent({
          emailId: email.id,
          title: event.title,
          startDate: event.startDate,
          endDate: event.endDate || null,
          location: event.location || null,
          description: event.description || null,
        });
      }

      const response: EventExtractionResponse = {
        events: extractedEvents,
        emailId,
      };

      res.json(response);
    } catch (error) {
      console.error("Event extraction error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "?쇱젙 異붿텧 以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.get("/api/events", async (_req: Request, res: Response) => {
    try {
      const events = await storage.getCalendarEvents();
      res.json(events);
    } catch (error) {
      console.error("Get events error:", error);
      res.status(500).json({ error: "?쇱젙??媛?몄삤??以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.get("/api/emails", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const classification = req.query.classification as string | undefined;
      
      let allEmails = await storage.getAllEmails(limit);
      
      if (classification && classification !== "all") {
        allEmails = allEmails.filter(e => e.classification === classification);
      }
      
      res.json(allEmails);
    } catch (error) {
      console.error("Get emails error:", error);
      res.status(500).json({ error: "?대찓??紐⑸줉??媛?몄삤??以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.post("/api/emails/:id/update", async (req: Request, res: Response) => {
    try {
      const emailId = parseInt(req.params.id);
      if (isNaN(emailId)) {
        res.status(400).json({ error: "?˜ëª»???´ë©”??ID?…ë‹ˆ??" });
        return;
      }

      const { classification, importance, label } = req.body as {
        classification?: string | null;
        importance?: string | null;
        label?: string | null;
      };

      const isValidField = (value: unknown) =>
        value === null || value === undefined || typeof value === "string";

      if (!isValidField(classification) || !isValidField(importance) || !isValidField(label)) {
        res.status(400).json({ error: "?˜ëª»???”ì²­?…ë‹ˆ??" });
        return;
      }

      if (
        classification === undefined &&
        importance === undefined &&
        label === undefined
      ) {
        res.status(400).json({ error: "?˜ëª»???”ì²­?…ë‹ˆ??" });
        return;
      }

      const updates: {
        classification?: string | null;
        classificationConfidence?: string | null;
        importance?: string | null;
        label?: string | null;
      } = {};

      if (classification !== undefined) {
        updates.classification = classification;
        updates.classificationConfidence = classification ? "manual" : null;
      }
      if (importance !== undefined) {
        updates.importance = importance;
      }
      if (label !== undefined) {
        updates.label = label;
      }

      await storage.updateEmailMetadata(emailId, updates);
      const email = await storage.getEmailById(emailId);

      res.json(email);
    } catch (error) {
      console.error("Update email error:", error);
      res.status(500).json({ error: "?´ë©”?¼ì„ ?—?? ì‹ ??ì¤??¤ë¥˜ê°€ ë°œìƒ?ˆìŠµ?ˆë‹¤." });
    }
  });
  app.post("/api/emails/:id/classify", async (req: Request, res: Response) => {
    try {
      const ollamaConnected = await checkOllamaConnection();
      if (!ollamaConnected) {
        res.status(503).json({ error: "AI ?쒕쾭???곌껐?????놁뒿?덈떎." });
        return;
      }

      const emailId = parseInt(req.params.id);
      if (isNaN(emailId)) {
        res.status(400).json({ error: "?섎せ???대찓??ID?낅땲??" });
        return;
      }

      const email = await storage.getEmailById(emailId);
      if (!email) {
        res.status(404).json({ error: "?대찓?쇱쓣 李얠쓣 ???놁뒿?덈떎." });
        return;
      }

      // ?뵏 ?대? 遺꾨쪟??寃쎌슦 ?щ텇瑜?諛⑹?
      if (email.classification && email.classification.trim() !== "") {
        res.json({
          success: true,
          classification: email.classification,
          confidence: email.classificationConfidence || "medium",
          skipped: true,
          message: "?대? 遺꾨쪟???대찓?쇱엯?덈떎.",
        });
        return;
      }

      const classification = await classifyEmail(
        email.subject,
        email.body,
        email.sender
      );

      // ??遺꾨쪟 寃곌낵 ?좏슚??媛??
      if (!classification?.classification) {
        res.status(500).json({
          error: "遺꾨쪟 寃곌낵媛 ?좏슚?섏? ?딆뒿?덈떎.",
        });
        return;
      }

      await storage.updateEmailClassification(
        emailId,
        classification.classification,
        classification.confidence
      );

      // ???④굔 遺꾨쪟 ?깃났 ?쒖뿉留?processed 泥섎━
      await storage.markEmailProcessed(emailId);

      res.json({
        success: true,
        classification: classification.classification,
        confidence: classification.confidence,
      });
    } catch (error) {
      console.error("Classification error:", error);
      res.status(500).json({
        error: error instanceof Error
          ? error.message
          : "遺꾨쪟 以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎.",
      });
    }
  });

  app.post("/api/emails/classify-all", async (_req: Request, res: Response) => {
    try {
      const ollamaConnected = await checkOllamaConnection();
      if (!ollamaConnected) {
        res.status(503).json({ error: "AI ?쒕쾭???곌껐?????놁뒿?덈떎." });
        return;
      }

      const unprocessedEmails = await storage.getUnprocessedEmails();

      let classified = 0;
      let skipped = 0;
      let failed = 0;

      for (const email of unprocessedEmails) {
        try {
          // ?뵏 ?대? 遺꾨쪟??硫붿씪 ??skip 泥섎━
          if (email.classification && email.classification.trim() !== "") {
            await storage.markEmailProcessed(email.id);
            skipped++;
            continue;
          }

          const classification = await classifyEmail(
            email.subject,
            email.body,
            email.sender
          );

          // ??遺꾨쪟 寃곌낵 媛??
          if (!classification?.classification) {
            console.warn(
              `[SKIP] Email ${email.id} classification invalid`,
              classification
            );
            failed++;
            continue;
          }

          await storage.updateEmailClassification(
            email.id,
            classification.classification,
            classification.confidence
          );

          await storage.markEmailProcessed(email.id);
          classified++;

        } catch (error) {
          console.error(`Failed to classify email ${email.id}:`, error);
          failed++;
        }
      }

      res.json({
        success: true,
        total: unprocessedEmails.length,
        classified,   // ?덈줈 遺꾨쪟??硫붿씪
        skipped,      // ?대? 遺꾨쪟?섏뼱 ?덉뿀??硫붿씪
        failed,
      });
    } catch (error) {
      console.error("Batch classification error:", error);
      res.status(500).json({ error: "?쇨큵 遺꾨쪟 以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.get("/api/settings/storage", async (_req: Request, res: Response) => {
    try {
      const savedSettings = await storage.getAppSetting("storage_config");
      let config = { mode: "postgresql", dataDir: "" };
      
      if (savedSettings) {
        try {
          config = JSON.parse(savedSettings);
        } catch {}
      }
      
      const currentMode = process.env.STORAGE_MODE || "postgresql";
      const currentDataDir = process.env.DATA_DIR || "";
      
      res.json({ 
        mode: currentMode,
        dataDir: currentDataDir,
        savedMode: config.mode,
        savedDataDir: config.dataDir,
        info: currentMode === "local" && currentDataDir
          ? `Local storage in use (${currentDataDir})`
          : "PostgreSQL database in use",
        needsRestart: config.mode !== currentMode || config.dataDir !== currentDataDir
      });
    } catch (error) {
      console.error("Get storage settings error:", error);
      res.status(500).json({ error: "?ㅼ젙??媛?몄삤??以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.post("/api/settings/storage", async (req: Request, res: Response) => {
    try {
      const { mode, dataDir } = req.body;
      
      if (!mode || (mode !== "local" && mode !== "postgresql")) {
        res.status(400).json({ error: "?좏슚?섏? ?딆? ??μ냼 紐⑤뱶?낅땲??" });
        return;
      }
      
      if (mode === "local" && !dataDir) {
        res.status(400).json({ error: "濡쒖뺄 紐⑤뱶?먮뒗 ?곗씠???대뜑 寃쎈줈媛 ?꾩슂?⑸땲??" });
        return;
      }

      const config = JSON.stringify({ mode, dataDir: dataDir || "" });
      await storage.setAppSetting("storage_config", config);
      
      res.json({ 
        success: true, 
        message: "?ㅼ젙????λ릺?덉뒿?덈떎. 蹂寃??ы빆???곸슜?섎젮硫??좏뵆由ъ??댁뀡???ъ떆?묓븯?몄슂.",
        savedMode: mode,
        savedDataDir: dataDir
      });
    } catch (error) {
      console.error("Save storage settings error:", error);
      res.status(500).json({ error: "?ㅼ젙 ???以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  app.post("/api/process/unprocessed", async (_req: Request, res: Response) => {
    try {
      const ollamaConnected = await checkOllamaConnection();
      if (!ollamaConnected) {
        res.status(503).json({ error: "AI ?쒕쾭???곌껐?????놁뒿?덈떎." });
        return;
      }

      const unprocessed = await storage.getUnprocessedEmails();

      let processedCount = 0;
      let skippedCount = 0;
      let eventsCount = 0;

      for (const email of unprocessed) {
        try {
          // ?뵏 ?대? 遺꾨쪟??硫붿씪? ?ъ쿂由?湲덉?
          if (email.classification && email.classification.trim() !== "") {
            await storage.markEmailProcessed(email.id);
            skippedCount++;
            continue;
          }

          // 1截뤴깵 遺꾨쪟 ?쒕룄
          const classification = await classifyEmail(
            email.subject,
            email.body,
            email.sender
          );

          // 2截뤴깵 遺꾨쪟 寃곌낵 ?좏슚??媛??
          if (
            !classification ||
            !classification.classification ||
            classification.classification.trim() === ""
          ) {
            console.warn(
              `[SKIP] Invalid classification for email ${email.id}`,
              classification
            );
            skippedCount++;
            continue;
          }

          // 3截뤴깵 遺꾨쪟 ???
          await storage.updateEmailClassification(
            email.id,
            classification.classification,
            classification.confidence
          );

          // 4截뤴깵 ?쇱젙 異붿텧
          const events = await extractEventsFromEmail(
            email.subject,
            email.body,
            email.date
          );

          for (const event of events) {
            await storage.addCalendarEvent({
              emailId: email.id,
              title: event.title,
              startDate: event.startDate,
              endDate: event.endDate || null,
              location: event.location || null,
              description: event.description || null,
            });
            eventsCount++;
          }

          // 5截뤴깵 ?ш린源뚯? ?깃났??寃쎌슦留?processed 泥섎━
          await storage.markEmailProcessed(email.id);
          processedCount++;

        } catch (err) {
          console.error(`Error processing email ${email.id}:`, err);
          skippedCount++;
        }
      }

      res.json({
        success: true,
        total: unprocessed.length,
        processed: processedCount,
        skipped: skippedCount,
        eventsExtracted: eventsCount,
        message: `泥섎━ ?꾨즺: ${processedCount}媛??깃났, ${skippedCount}媛?嫄대꼫?, ?쇱젙 ${eventsCount}媛?異붿텧`,
      });
    } catch (error) {
      console.error("Process unprocessed error:", error);
      res.status(500).json({ error: "泥섎━ 以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎." });
    }
  });

  return httpServer;
}





