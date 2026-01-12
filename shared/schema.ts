import { pgTable, text, serial, integer, timestamp, vector, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// 1. 이메일 원본 테이블
export const emails = pgTable("emails", {
  id: serial("id").primaryKey(),
  subject: text("subject").notNull().default(""),
  sender: text("sender").notNull().default(""),
  date: text("date").notNull().default(""),
  body: text("body").notNull().default(""),
  importance: text("importance"),
  label: text("label"),
  classification: text("classification"),
  classificationConfidence: text("classification_confidence"),
  isProcessed: boolean("is_processed").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// 2. [신규] RAG 검색용 청크 테이블 (pgvector 사용)
export const ragChunks = pgTable("rag_chunks", {
  id: serial("id").primaryKey(),
  mailId: integer("mail_id").references(() => emails.id), // 원본 메일 ID 연결
  subject: text("subject"), // 검색 결과 표시용 제목
  content: text("content").notNull(), // 청크 내용 (Snippet)
  // [핵심] 768차원 벡터 (nomic-embed-text 모델 기준)
  embedding: vector("embedding", { dimensions: 768 }), 
  createdAt: timestamp("created_at").defaultNow(),
});

export const importLogs = pgTable("import_logs", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  emailsImported: integer("emails_imported").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull().default("새 대화"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const calendarEvents = pgTable("calendar_events", {
  id: serial("id").primaryKey(),
  emailId: integer("email_id"),
  title: text("title").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date"),
  location: text("location"),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const appSettings = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// --- Zod Schemas ---

export const insertEmailSchema = createInsertSchema(emails).omit({ id: true, createdAt: true });
export type InsertEmail = z.infer<typeof insertEmailSchema>;
export type Email = typeof emails.$inferSelect;

// [신규] 청크 입력 스키마
export const insertRagChunkSchema = createInsertSchema(ragChunks).omit({ id: true, createdAt: true });
export type InsertRagChunk = z.infer<typeof insertRagChunkSchema>;

// [신규] 검색 결과 인터페이스
export interface RagSearchResult {
  id: number;
  mailId: number;
  subject: string;
  content: string; // snippet
  score: number;
}

export const insertImportLogSchema = createInsertSchema(importLogs).omit({ id: true, createdAt: true });
export type InsertImportLog = z.infer<typeof insertImportLogSchema>;
export type ImportLog = typeof importLogs.$inferSelect;

export const insertUserSchema = createInsertSchema(users).pick({ username: true, password: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const insertConversationSchema = createInsertSchema(conversations).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Conversation = typeof conversations.$inferSelect;

export const insertMessageSchema = createInsertSchema(messages).omit({ id: true, createdAt: true });
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;

export const insertCalendarEventSchema = createInsertSchema(calendarEvents).omit({ id: true, createdAt: true });
export type InsertCalendarEvent = z.infer<typeof insertCalendarEventSchema>;
export type CalendarEvent = typeof calendarEvents.$inferSelect;

export const insertAppSettingsSchema = createInsertSchema(appSettings).omit({ id: true, updatedAt: true });
export type InsertAppSettings = z.infer<typeof insertAppSettingsSchema>;
export type AppSettings = typeof appSettings.$inferSelect;

export const searchResultSchema = z.object({
  mailId: z.string(),
  subject: z.string(),
  score: z.number(),
  sender: z.string().nullable(),
  date: z.string().nullable(),
  body: z.string(),
  attachments: z.array(z.string()).optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const statsSchema = z.object({
  mode: z.string(),
  emailsCount: z.number(),
  lastImport: z.string().nullable(),
});
export type Stats = z.infer<typeof statsSchema>;

export const chatRequestSchema = z.object({
  message: z.string().min(1, "검색어를 입력해주세요"),
  topK: z.number().min(1).max(50).default(10),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const aiChatRequestSchema = z.object({
  message: z.string().min(1),
  conversationId: z.number().optional(),
});
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

export const extractedEventSchema = z.object({
  title: z.string(),
  startDate: z.string(),
  endDate: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
});
export type ExtractedEvent = z.infer<typeof extractedEventSchema>;