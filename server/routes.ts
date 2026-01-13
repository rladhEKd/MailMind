import type { Express, Request, Response } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import {
  chatRequestSchema,
  aiChatRequestSchema,
  eventExtractionRequestSchema,
  type ChatResponse,
  type ImportResult,
  type SearchResult,
  type AiChatResponse,
  type EventExtractionResponse,
} from "@shared/schema";
import { ZodError } from "zod";
import {
  chatWithOllama,
  extractEventsFromEmail,
  checkOllamaConnection,
  classifyEmail,
} from "./ollama";
import { parsePSTFromBuffer } from "./pst-parser";
import * as fs from "fs";
import * as path from "path";
import mime from "mime-types";
import xlsx from "xlsx";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function getDataDirFromStorage(): string {
  const maybe = (storage as any)?.getDataDir?.();
  if (typeof maybe === "string" && maybe.trim()) return maybe;
  return "./data";
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ----------------------------
// ✅ Attachment text extraction (pdf/xlsx/docx)
// ----------------------------
function sanitizeExtractedText(input: string): string {
  if (!input) return "";
  let t = input;
  t = t.replace(/\u0000/g, " ");
  // 검열 블록류 -> [REDACTED]
  t = t.replace(/[█■▇▆▅▄▃▂▁]+/g, "[REDACTED]");
  t = t.replace(/[ \t\f\v]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function looksMostlyBlank(text: string): boolean {
  const t = (text || "").replace(/\s+/g, "").trim();
  return t.length < 30;
}

async function extractPdfText(absPath: string): Promise<string> {
  try {
    const pdfParse = (await import("pdf-parse")).default as any;
    const buf = fs.readFileSync(absPath);
    const data = await pdfParse(buf);
    const text = typeof data?.text === "string" ? data.text : "";
    return sanitizeExtractedText(text);
  } catch {
    return "";
  }
}

function extractXlsxText(absPath: string): string {
  try {
    const wb = xlsx.readFile(absPath, { cellText: false, cellDates: true });
    const chunks: string[] = [];
    for (const sheetName of wb.SheetNames || []) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) continue;
      const csv = xlsx.utils.sheet_to_csv(sheet, { blankrows: false });
      const cleaned = sanitizeExtractedText(csv);
      if (cleaned) chunks.push(`[Sheet] ${sheetName}\n${cleaned}`);
    }
    return chunks.join("\n\n");
  } catch {
    return "";
  }
}

async function extractDocxText(absPath: string): Promise<string> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: absPath });
    const text = typeof result?.value === "string" ? result.value : "";
    return sanitizeExtractedText(text);
  } catch {
    return "";
  }
}

async function extractTextFromAttachment(absPath: string, mimeType?: string | null, nameForType?: string) {
  const ext = (path.extname(nameForType || absPath) || "").toLowerCase();
  const mt = (mimeType || "").toLowerCase();

  const isPdf = ext === ".pdf" || mt.includes("pdf");
  const isXlsx = ext === ".xlsx" || ext === ".xls" || mt.includes("spreadsheet") || mt.includes("excel");
  const isDocx = ext === ".docx" || mt.includes("word");

  if (isPdf) {
    const t = await extractPdfText(absPath);
    // 여기서 OCR까지 얹고 싶으면(스캔본) 추가 가능.
    return t;
  }
  if (isXlsx) return extractXlsxText(absPath);
  if (isDocx) return await extractDocxText(absPath);
  return "";
}

// ----------------------------
// Local (non-LLM) event extraction fallback
// ----------------------------
function extractEventsLocally(subject: string, body: string, fallbackDate?: string) {
  const text = `${subject}\n${body}`;

  const iso = text.match(
    /(20\d{2})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})(?:\s*(\d{1,2}):(\d{2}))?/
  );
  if (iso) {
    const y = iso[1];
    const m = iso[2].padStart(2, "0");
    const d = iso[3].padStart(2, "0");
    const hh = (iso[4] ?? "09").padStart(2, "0");
    const mm = (iso[5] ?? "00").padStart(2, "0");
    return [
      {
        title: subject || "(제목 없음)",
        startDate: `${y}-${m}-${d} ${hh}:${mm}`,
        endDate: null,
        location: null,
        description: body?.slice(0, 2000) || null,
      },
    ];
  }

  const kor = text.match(
    /(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*(오전|오후))?(?:\s*(\d{1,2})\s*시)?(?:\s*(\d{1,2})\s*분)?/
  );
  if (kor) {
    const y = kor[1];
    const m = kor[2].padStart(2, "0");
    const d = kor[3].padStart(2, "0");
    let hour = kor[5] ? parseInt(kor[5], 10) : 9;
    const minute = kor[6] ? parseInt(kor[6], 10) : 0;
    if (kor[4] === "오후" && hour < 12) hour += 12;
    if (kor[4] === "오전" && hour === 12) hour = 0;
    const hh = String(hour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    return [
      {
        title: subject || "(제목 없음)",
        startDate: `${y}-${m}-${d} ${hh}:${mm}`,
        endDate: null,
        location: null,
        description: body?.slice(0, 2000) || null,
      },
    ];
  }

  const md = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*(\d{1,2}):(\d{2}))?/);
  if (md) {
    const yearMatch = (fallbackDate || "").match(/(20\d{2})/);
    const y = yearMatch ? yearMatch[1] : String(new Date().getFullYear());
    const m = md[1].padStart(2, "0");
    const d = md[2].padStart(2, "0");
    const hh = (md[3] ?? "09").padStart(2, "0");
    const mm = (md[4] ?? "00").padStart(2, "0");
    return [
      {
        title: subject || "(제목 없음)",
        startDate: `${y}-${m}-${d} ${hh}:${mm}`,
        endDate: null,
        location: null,
        description: body?.slice(0, 2000) || null,
      },
    ];
  }

  return [];
}

// ----------------------------
// JSON normalize helpers
// ----------------------------
function normalizeSender(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;

  if (typeof v === "object") {
    const anyV = v as any;
    const name = typeof anyV.name === "string" ? anyV.name : "";
    const email = typeof anyV.email === "string" ? anyV.email : "";
    if (name && email) return `${name} <${email}>`;
    if (email) return email;
    if (name) return name;

    if (typeof anyV.address === "string") return anyV.address;
  }

  return String(v);
}

function normalizeBody(email: any): string {
  const candidates = [
    email.body,
    email.content,
    email.text,
    email.Body,
    email.body_text,
    email.bodyText,
    email.body_html,
    email.bodyHtml,
    email.html,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return "";
}

function normalizeDate(email: any): string {
  const d = email.date ?? email.Date ?? email.sent_date ?? email.sentDate ?? email.datetime;
  return typeof d === "string" ? d : d ? String(d) : "";
}

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

    const emailsRaw: any[] =
      Array.isArray(data)
        ? data
        : Array.isArray((data as any).emails)
          ? (data as any).emails
          : Array.isArray((data as any).messages)
            ? (data as any).messages
            : [];

    return emailsRaw.map((email: any) => {
      const subject = String(email.subject ?? email.Subject ?? "");
      const sender = normalizeSender(email.sender ?? email.from ?? email.From);
      const date = normalizeDate(email);
      const body = normalizeBody(email);

      return {
        subject,
        sender,
        date,
        body,
        importance: email.importance ? String(email.importance) : undefined,
        label: email.label ? String(email.label) : undefined,
      };
    });
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
      subject: "회의 일정 안내",
      sender: "현장PM <pm@shipyard.co.kr>",
      date: "2025-01-06 14:00:00",
      body: "다음 주 화요일(1월 7일) 오후 2시에 정기 회의가 예정되어 있습니다. 회의실 A.",
    },
    {
      subject: "도면 검토 회신 요청",
      sender: "설계팀 <design@shipyard.co.kr>",
      date: "2025-01-05 09:30:00",
      body: "1월 9일 10:00까지 도면 검토 의견 회신 부탁드립니다.",
    },
  ];
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.get("/api/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getStats();
      res.json(stats);
    } catch (error) {
      console.error("Stats error:", error);
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  app.post("/api/import", upload.any(), async (req: Request, res: Response) => {
    try {
      const single = (req as any).file as Express.Multer.File | undefined;
      const many = (req.files as Express.Multer.File[] | undefined) || [];
      const files = many.length > 0 ? many : single ? [single] : [];

      let emailsToImport: Array<{
        subject: string;
        sender: string;
        date: string;
        body: string;
        importance?: string;
        label?: string;
      }> = [];

      let filename = "sample_data";
      const filenames: string[] = [];
      const warnings: string[] = [];

      if (files.length > 0) {
        for (const file of files) {
          const original = file.originalname || "upload";
          filenames.push(original);
          const ext = original.toLowerCase().split(".").pop();

          if (ext === "json") {
            const content = file.buffer.toString("utf-8");
            const parsed = parseEmailsFromJson(content);

            if (parsed.length === 0) {
              warnings.push(`JSON에서 이메일을 찾지 못함: ${original} (emails/messages 구조 확인 필요)`);
              continue;
            }

            for (const e of parsed) if (!e.label) e.label = original;
            emailsToImport = emailsToImport.concat(parsed);
          } else if (ext === "pst") {
            const dataDir = getDataDirFromStorage();
            const attachmentsRoot = path.join(dataDir, "attachments");
            ensureDir(attachmentsRoot);

            const parseResult = parsePSTFromBuffer(file.buffer, original, {
              saveAttachments: true,
              attachmentsDir: attachmentsRoot,
            });

            if (parseResult.errors?.length) {
              warnings.push(`PST 파싱 경고(${original}): ${parseResult.errors.join(", ")}`);
            }

            if (!parseResult.emails || parseResult.emails.length === 0) {
              warnings.push(`PST에서 이메일을 찾지 못함: ${original}`);
              continue;
            }

            const normalized = (parseResult.emails || []).map((e: any) => ({
              subject: String(e.subject || ""),
              sender: normalizeSender(e.sender || ""),
              date: String(e.date || ""),
              body: String(e.body || ""),
              importance: e.importance ? String(e.importance) : undefined,
              label: e.label ? String(e.label) : original,
              // ⚠️ 로컬에서만 쓰는 임시 필드
              _attachments: Array.isArray(e.attachments) ? e.attachments : [],
            }));

            emailsToImport = emailsToImport.concat(normalized);
          } else if (ext === "mbox") {
            warnings.push(`MBOX 미지원: ${original}`);
            continue;
          } else {
            warnings.push(`지원되지 않는 파일 형식(${original}) - JSON/PST만 허용`);
            continue;
          }
        }

        filename = filenames.join(", ");
      } else {
        emailsToImport = generateSampleEmails();
        filename = "sample_demo_data";
      }

      if (emailsToImport.length === 0) {
        res.status(400).json({
          ok: false,
          inserted: 0,
          message:
            warnings.length > 0
              ? `파일에서 이메일을 찾을 수 없습니다.\n- ${warnings.join("\n- ")}`
              : "파일에서 이메일을 찾을 수 없습니다.",
        } satisfies ImportResult);
        return;
      }

      const insertedEmails = await storage.insertEmailsAndGetIds(emailsToImport as any);
      const insertedCount = insertedEmails.length;

      // ----------------------------
      // ✅ Attachments: _pst/... -> email_<id>/... 로 이동 + 텍스트 추출 + DB 저장
      // ----------------------------
      try {
        const dataDir = getDataDirFromStorage();
        const attachmentsRoot = path.join(dataDir, "attachments");
        ensureDir(attachmentsRoot);

        for (let i = 0; i < insertedEmails.length; i++) {
          const inserted = insertedEmails[i];
          const originalItem: any = (emailsToImport as any)[i];
          const tempAtts: any[] = Array.isArray(originalItem?._attachments) ? originalItem._attachments : [];
          if (tempAtts.length === 0) continue;

          const emailFolderRel = path.join("email_" + inserted.id);
          const emailFolderAbs = path.join(attachmentsRoot, emailFolderRel);
          ensureDir(emailFolderAbs);

          const movedForDb: any[] = [];

          for (const a of tempAtts) {
            const relPath: string = String(a.relPath || "");
            if (!relPath) continue;

            const srcAbs = path.join(attachmentsRoot, relPath);
            if (!fs.existsSync(srcAbs)) continue;

            const storedName = String(a.storedName || path.basename(relPath));
            const destRel = path.join(emailFolderRel, storedName);
            const destAbs = path.join(attachmentsRoot, destRel);

            try {
              fs.renameSync(srcAbs, destAbs);
            } catch {
              fs.copyFileSync(srcAbs, destAbs);
              try { fs.unlinkSync(srcAbs); } catch {}
            }

            const stat = fs.existsSync(destAbs) ? fs.statSync(destAbs) : null;

            // ✅ 텍스트 추출 (pdf/xlsx/docx)
            const extracted = await extractTextFromAttachment(destAbs, a.mime ?? null, a.originalName ?? storedName);
            let extractedText = extracted || null;

            // 너무 길면 자름(검색/LLM 안정)
            if (extractedText && extractedText.length > 200_000) {
              extractedText = extractedText.slice(0, 200_000);
            }

            movedForDb.push({
              filename: storedName,
              relPath: destRel,
              size: Number(a.size ?? stat?.size ?? 0) || 0,
              mime: a.mime ?? null,
              originalName: a.originalName ?? null,
              extractedText, // ✅ DB 저장
            });
          }

          if (movedForDb.length > 0) {
            await storage.addEmailAttachments(inserted.id, movedForDb);
          }
        }
      } catch (e: any) {
        console.error("Attachment post-process failed:", e);
        warnings.push(`첨부파일 저장/연결/텍스트추출 중 오류: ${e?.message ?? "unknown"}`);
      }

      await storage.logImport({
        filename,
        emailsImported: insertedCount,
      });

      const ollamaConnected = await checkOllamaConnection();
      let classifiedCount = 0;
      let eventsExtractedCount = 0;

      for (const email of insertedEmails) {
        try {
          if (ollamaConnected) {
            const classification = await classifyEmail(email.subject, email.body, email.sender);
            await storage.updateEmailClassification(
              email.id,
              classification.classification,
              classification.confidence
            );
            classifiedCount++;
          }

          const events = ollamaConnected
            ? await extractEventsFromEmail(email.subject, email.body, email.date)
            : extractEventsLocally(email.subject, email.body, email.date);

          for (const event of events) {
            await storage.addCalendarEvent({
              emailId: email.id,
              title: (event as any).title,
              startDate: (event as any).startDate,
              endDate: (event as any).endDate || null,
              location: (event as any).location || null,
              description: (event as any).description || null,
            });
            eventsExtractedCount++;
          }

          await storage.markEmailProcessed(email.id);
        } catch (err) {
          console.error(`Error processing email ${email.id}:`, err);
        }
      }

      const messageLines: string[] = [];
      if (ollamaConnected) {
        messageLines.push(
          `${insertedCount}개의 이메일을 가져왔습니다. ${classifiedCount}개 분류, ${eventsExtractedCount}개 일정 추출 완료.`
        );
      } else {
        messageLines.push(
          `${insertedCount}개의 이메일을 가져왔습니다. AI 미연결로 분류는 건너뛰었지만, ${eventsExtractedCount}개 일정(간이 추출)을 생성했습니다.`
        );
      }
      if (warnings.length > 0) {
        messageLines.push(`경고:\n- ${warnings.join("\n- ")}`);
      }

      res.json({
        ok: true,
        inserted: insertedCount,
        message: messageLines.join("\n"),
      } satisfies ImportResult);
    } catch (error) {
      console.error("Import error:", error);
      res.status(500).json({
        ok: false,
        inserted: 0,
        message: error instanceof Error ? error.message : "가져오기 중 오류가 발생했습니다.",
      } satisfies ImportResult);
    }
  });

  app.post("/api/search", async (req: Request, res: Response) => {
    try {
      const validationResult = chatRequestSchema.safeParse(req.body);

      if (!validationResult.success) {
        const errors = validationResult.error.errors.map((e) => e.message).join(", ");
        res.status(400).json({ error: errors || "잘못된 요청입니다." });
        return;
      }

      const { message, topK } = validationResult.data;
      const citations: SearchResult[] = await storage.searchEmails(message.trim(), topK);

      const topSubjects = citations
        .slice(0, 10)
        .map((c) => `- ${c.subject} (점수=${c.score.toFixed(1)}, ID=${c.mailId})`)
        .join("\n");

      const answer = `검색어: ${message}\n\nTop 결과:\n${topSubjects || "- (결과 없음)"}`;

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
        res.status(400).json({ error: "잘못된 요청 형식입니다." });
        return;
      }
      res.status(500).json({ error: "검색 중 오류가 발생했습니다." });
    }
  });

  app.get("/api/ping", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      hint: "POST /api/import로 이메일 가져오기, /api/stats로 통계 확인, POST /api/search로 검색",
    });
  });

  app.get("/api/ollama/status", async (_req: Request, res: Response) => {
    try {
      const connected = await checkOllamaConnection();
      res.json({
        connected,
        baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
      });
    } catch {
      res.json({
        connected: false,
        baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
      });
    }
  });

  app.get("/api/conversations", async (_req: Request, res: Response) => {
    try {
      const conversations = await storage.getConversations();
      res.json(conversations);
    } catch (error) {
      console.error("Get conversations error:", error);
      res.status(500).json({ error: "대화 목록을 가져오는 중 오류가 발생했습니다." });
    }
  });

  // ✅ (주의) 라우트 이름은 유지했지만 실제로는 이메일 상세 조회임
  app.get("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const emailId = parseInt(req.params.id);
      if (isNaN(emailId)) {
        res.status(400).json({ error: "잘못된 이메일 ID입니다." });
        return;
      }
      const email = await storage.getEmailById(emailId);
      if (!email) {
        res.status(404).json({ error: "이메일을 찾을 수 없습니다." });
        return;
      }
      const atts = await storage.getEmailAttachments(emailId);
      const attachments = atts.map((a: any) => ({
        id: a.id,
        filename: a.filename,
        originalName: a.originalName,
        size: a.size,
        mime: a.mime,
        extractedTextPreview: a.extractedText ? String(a.extractedText).slice(0, 300) : null, // ✅ 확인용
        downloadUrl: `/api/attachments/${a.id}`,
        previewUrl: `/api/attachments/${a.id}?inline=1`,
      }));

      res.json({ ...email, attachments });
    } catch (error) {
      console.error("Get email error:", error);
      res.status(500).json({ error: "이메일을 가져오는 중 오류가 발생했습니다." });
    }
  });

  // 첨부파일 다운로드
  app.get("/api/attachments/:id", async (req: Request, res: Response) => {
    try {
      const attId = parseInt(req.params.id);
      if (isNaN(attId)) {
        res.status(400).json({ error: "잘못된 첨부파일 ID입니다." });
        return;
      }

      const inline = req.query.inline === "1";

      const att = await storage.getEmailAttachmentById(attId);
      if (!att) {
        res.status(404).json({ error: "첨부파일을 찾을 수 없습니다." });
        return;
      }

      const dataDir = getDataDirFromStorage();
      const attachmentsRoot = path.join(dataDir, "attachments");
      const absPath = path.join(attachmentsRoot, (att as any).relPath);

      if (!fs.existsSync(absPath)) {
        res.status(404).json({ error: "첨부파일이 디스크에 존재하지 않습니다." });
        return;
      }

      const nameForMime = ((att as any).originalName || (att as any).filename || "").toString();
      const contentType = (((att as any).mime || mime.lookup(nameForMime) || "application/octet-stream") as string).toString();
      res.setHeader("Content-Type", contentType);
      res.setHeader("X-Content-Type-Options", "nosniff");

      const downloadName = ((att as any).originalName || (att as any).filename || "attachment").toString();
      res.setHeader(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(downloadName)}`
      );

      res.sendFile(path.resolve(absPath));
    } catch (error) {
      console.error("Download attachment error:", error);
      res.status(500).json({ error: "첨부파일 다운로드 중 오류가 발생했습니다." });
    }
  });

  app.get("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const conversationId = parseInt(req.params.id);
      if (isNaN(conversationId)) {
        res.status(400).json({ error: "잘못된 대화 ID입니다." });
        return;
      }
      const messages = await storage.getMessages(conversationId);
      res.json(messages);
    } catch (error) {
      console.error("Get messages error:", error);
      res.status(500).json({ error: "메시지를 가져오는 중 오류가 발생했습니다." });
    }
  });

  app.post("/api/ai/chat", async (req: Request, res: Response) => {
    try {
      const validationResult = aiChatRequestSchema.safeParse(req.body);

      if (!validationResult.success) {
        const errors = validationResult.error.errors.map((e) => e.message).join(", ");
        res.status(400).json({ error: errors || "잘못된 요청입니다." });
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

      // ✅ 검색 결과(메일 + 첨부 추출 텍스트 포함) 기반 컨텍스트 구성
      const relevantEmails = await storage.searchEmails(message, 5);

      let emailContext = "";
      if (relevantEmails.length > 0) {
        const emailContextItems: string[] = [];

        for (let i = 0; i < relevantEmails.length; i++) {
          const e = relevantEmails[i];
          const emailIdNum = parseInt(e.mailId, 10);
          let attSnippet = "";

          if (!Number.isNaN(emailIdNum)) {
            const atts = await storage.getEmailAttachments(emailIdNum);
            // extracted_text가 긴 경우가 많아서 앞부분만 컨텍스트에 포함
            const snippets = (atts as any[])
              .map((a) => {
                const name = a.originalName || a.filename || "(첨부)";
                const t = a.extractedText ? String(a.extractedText) : "";
                if (!t.trim()) return null;
                return `- ${name}: ${t.slice(0, 600)}`;
              })
              .filter(Boolean);

            if (snippets.length > 0) {
              attSnippet = `\n첨부 텍스트(일부):\n${snippets.join("\n")}`;
            }
          }

          emailContextItems.push(
            `[이메일 ${i + 1}]\n제목: ${e.subject}\n발신자: ${e.sender}\n날짜: ${e.date}\n내용: ${String(e.body || "").slice(0, 500)}${attSnippet}\n`
          );
        }

        emailContext = `\n\n참고할 관련 이메일/첨부 내용:\n${emailContextItems.join("\n")}`;
      }

      const previousMessages = await storage.getMessages(convId);
      const ollamaMessages = previousMessages.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));

      const systemPrompt = `당신은 이메일 관리와 일정 정리를 도와주는 AI 비서입니다.
사용자가 업로드한 이메일 데이터(메일 본문 + 첨부파일에서 추출된 텍스트)를 기반으로 질문에 답변해주세요.
첨부에서 검열된 정보(검은 박스/블록)는 민감정보로 보고 '[REDACTED]'로만 취급하세요.
한국어로 친절하게 응답해주세요.${emailContext}`;

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
      res.status(500).json({
        error: error instanceof Error ? error.message : "AI 채팅 중 오류가 발생했습니다.",
      });
    }
  });

  app.post("/api/events/extract", async (req: Request, res: Response) => {
    try {
      const validationResult = eventExtractionRequestSchema.safeParse(req.body);

      if (!validationResult.success) {
        const errors = validationResult.error.errors.map((e) => e.message).join(", ");
        res.status(400).json({ error: errors || "잘못된 요청입니다." });
        return;
      }

      const { emailId } = validationResult.data;
      const email = await storage.getEmailById(emailId);

      if (!email) {
        res.status(404).json({ error: "이메일을 찾을 수 없습니다." });
        return;
      }

      const extractedEvents = await extractEventsFromEmail(email.subject, email.body, email.date);

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
      res.status(500).json({
        error: error instanceof Error ? error.message : "일정 추출 중 오류가 발생했습니다.",
      });
    }
  });

  app.get("/api/events", async (_req: Request, res: Response) => {
    try {
      const events = await storage.getCalendarEvents();
      res.json(events);
    } catch (error) {
      console.error("Get events error:", error);
      res.status(500).json({ error: "일정을 가져오는 중 오류가 발생했습니다." });
    }
  });

  app.post("/api/events/reset", async (_req: Request, res: Response) => {
    try {
      const deleted = await storage.clearCalendarEvents();
      res.json({ ok: true, deleted });
    } catch (error) {
      console.error("Reset events error:", error);
      res.status(500).json({ ok: false, error: "일정 초기화 중 오류가 발생했습니다." });
    }
  });

  return httpServer;
}
