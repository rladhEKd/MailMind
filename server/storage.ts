import { 
  emails, 
  ragChunks,
  users, 
  conversations, 
  messages, 
  importLogs,
  calendarEvents,
  appSettings,
  type Email, 
  type InsertEmail, 
  type InsertRagChunk,
  type User, 
  type InsertUser, 
  type Conversation, 
  type InsertConversation,
  type Message, 
  type InsertMessage,
  type CalendarEvent,
  type InsertCalendarEvent,
  type ImportLog,
  type InsertImportLog,
  type Stats,
  type SearchResult,
  type RagSearchResult,
  type AppSettings
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, sql, cosineDistance, gt, like, or } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  insertEmailsAndGetIds(emails: InsertEmail[]): Promise<Email[]>;
  getEmailById(id: number): Promise<Email | undefined>;
  getAllEmails(limit?: number): Promise<Email[]>;
  updateEmailClassification(id: number, classification: string, confidence: string): Promise<void>;
  
  saveRagChunks(chunks: InsertRagChunk[]): Promise<void>;
  searchRagChunks(queryEmbedding: number[], topK: number): Promise<RagSearchResult[]>;
  
  searchEmails(query: string, topK: number): Promise<SearchResult[]>;
  createConversation(conv: InsertConversation): Promise<Conversation>;
  addMessage(msg: InsertMessage): Promise<Message>;
  getMessages(conversationId: number): Promise<Message[]>;
  getConversations(): Promise<Conversation[]>;
  getStats(): Promise<Stats>;
  getLastImport(): Promise<ImportLog | undefined>;
  logImport(log: InsertImportLog): Promise<ImportLog>;
  addCalendarEvent(event: InsertCalendarEvent): Promise<CalendarEvent>;
  getCalendarEvents(): Promise<CalendarEvent[]>;
  getCalendarEventsByEmailId(emailId: number): Promise<CalendarEvent[]>;
  getAppSetting(key: string): Promise<string | null>;
  setAppSetting(key: string, value: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }
  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }
  async createUser(user: InsertUser): Promise<User> {
    const [newUser] = await db.insert(users).values(user).returning();
    return newUser;
  }

  async insertEmailsAndGetIds(emailsToInsert: InsertEmail[]): Promise<Email[]> {
    if (emailsToInsert.length === 0) return [];
    const inserted = await db.insert(emails).values(emailsToInsert).returning();
    return inserted;
  }

  async getEmailById(id: number): Promise<Email | undefined> {
    const [email] = await db.select().from(emails).where(eq(emails.id, id));
    return email;
  }

  async getAllEmails(limit: number = 100): Promise<Email[]> {
    return await db.select().from(emails).orderBy(desc(emails.createdAt)).limit(limit);
  }

  async updateEmailClassification(id: number, classification: string, confidence: string): Promise<void> {
    await db.update(emails)
      .set({ classification, classificationConfidence: confidence, isProcessed: true })
      .where(eq(emails.id, id));
  }

  async saveRagChunks(chunks: InsertRagChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await db.insert(ragChunks).values(chunks);
  }

  // [수정 완료] r: any, i: number 로 모든 타입 명시
  async searchRagChunks(queryEmbedding: number[], topK: number = 3): Promise<RagSearchResult[]> {
    const similarity = sql<number>`1 - (${cosineDistance(ragChunks.embedding, queryEmbedding)})`;
    
    // 임계값 0.25
    const SIMILARITY_THRESHOLD = 0.25;

    const results = await db
      .select({
        id: ragChunks.id,
        mailId: ragChunks.mailId,
        subject: ragChunks.subject,
        content: ragChunks.content,
        score: similarity,
      })
      .from(ragChunks)
      .where(gt(similarity, SIMILARITY_THRESHOLD))
      .orderBy(desc(similarity))
      .limit(topK);

    // [디버깅 로그] 타입 에러 해결됨
    if (results.length > 0) {
      console.log("🔍 [RAG 검색 결과 Top 3 제목]:");
      results.slice(0, 3).forEach((r: any, i: number) => console.log(`   ${i+1}. [${r.score.toFixed(2)}] ${r.subject}`));
    } else {
      console.log("⚠️ [RAG] 검색된 문서가 없습니다. (유사도 낮음)");
    }

    return results.map((r: any) => ({
      id: r.id,
      mailId: r.mailId || 0,
      subject: r.subject || "",
      content: r.content,
      score: r.score
    }));
  }

  async searchEmails(query: string, topK: number): Promise<SearchResult[]> {
    const searchPattern = `%${query}%`;
    const results = await db.select().from(emails).where(
      or(like(emails.subject, searchPattern), like(emails.body, searchPattern))
    ).limit(topK);
    
    return results.map((email: any) => ({
        mailId: String(email.id),
        subject: email.subject,
        score: 1,
        sender: email.sender,
        date: email.date,
        body: email.body || "",
        attachments: []
    }));
  }

  async createConversation(conv: InsertConversation): Promise<Conversation> {
    const [c] = await db.insert(conversations).values(conv).returning();
    return c;
  }
  async addMessage(msg: InsertMessage): Promise<Message> {
    const [m] = await db.insert(messages).values(msg).returning();
    await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, msg.conversationId));
    return m;
  }
  async getMessages(conversationId: number): Promise<Message[]> {
    return await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.createdAt);
  }
  async getConversations(): Promise<Conversation[]> {
    return await db.select().from(conversations).orderBy(desc(conversations.updatedAt));
  }

  async getStats(): Promise<Stats> {
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(emails);
    const lastImport = await db.select().from(importLogs).orderBy(desc(importLogs.createdAt)).limit(1);
    
    return {
      mode: "PostgreSQL (pgvector)",
      emailsCount: Number(countResult[0]?.count ?? 0),
      lastImport: lastImport[0]?.createdAt?.toISOString() ?? null,
    };
  }

  async getLastImport(): Promise<ImportLog | undefined> {
    const [log] = await db.select().from(importLogs).orderBy(desc(importLogs.createdAt)).limit(1);
    return log || undefined;
  }
  async logImport(log: InsertImportLog): Promise<ImportLog> {
    const [inserted] = await db.insert(importLogs).values(log).returning();
    return inserted;
  }

  async addCalendarEvent(event: InsertCalendarEvent): Promise<CalendarEvent> {
    const [inserted] = await db.insert(calendarEvents).values(event).returning();
    return inserted;
  }
  async getCalendarEvents(): Promise<CalendarEvent[]> {
    return await db.select().from(calendarEvents).orderBy(desc(calendarEvents.createdAt));
  }
  async getCalendarEventsByEmailId(emailId: number): Promise<CalendarEvent[]> {
    return await db.select().from(calendarEvents).where(eq(calendarEvents.emailId, emailId)).orderBy(desc(calendarEvents.createdAt));
  }

  async getAppSetting(key: string): Promise<string | null> {
    const [setting] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    return setting?.value ?? null;
  }
  async setAppSetting(key: string, value: string): Promise<void> {
    const existing = await this.getAppSetting(key);
    if (existing !== null) {
      await db.update(appSettings).set({ value, updatedAt: new Date() }).where(eq(appSettings.key, key));
    } else {
      await db.insert(appSettings).values({ key, value });
    }
  }
}

export const storage = new DatabaseStorage();