import { 
  emails, 
  importLogs,
  type Email, 
  type InsertEmail,
  type ImportLog,
  type InsertImportLog,
  type SearchResult,
  type Stats,
  users,
  type User,
  type InsertUser,
  conversations,
  type Conversation,
  type InsertConversation,
  messages,
  type Message,
  type InsertMessage,
  calendarEvents,
  type CalendarEvent,
  type InsertCalendarEvent,
  appSettings
} from "@shared/schema";
import { db } from "./db";
import { eq, or, ilike, desc, sql } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  getEmailsCount(): Promise<number>;
  getLastImport(): Promise<ImportLog | undefined>;
  getStats(): Promise<Stats>;
  
  insertEmail(email: InsertEmail): Promise<Email>;
  insertEmails(emails: InsertEmail[]): Promise<number>;
  insertEmailsAndGetIds(emails: InsertEmail[]): Promise<Email[]>;
  getEmailById(id: number): Promise<Email | undefined>;
  getAllEmails(limit?: number): Promise<Email[]>;
  getUnprocessedEmails(): Promise<Email[]>;
  updateEmailClassification(id: number, classification: string, confidence: string): Promise<void>;
  markEmailProcessed(id: number): Promise<void>;
  
  searchEmails(query: string, topK: number): Promise<SearchResult[]>;
  
  logImport(log: InsertImportLog): Promise<ImportLog>;
  
  createConversation(conv: InsertConversation): Promise<Conversation>;
  getConversation(id: number): Promise<Conversation | undefined>;
  getConversations(): Promise<Conversation[]>;
  
  addMessage(msg: InsertMessage): Promise<Message>;
  getMessages(conversationId: number): Promise<Message[]>;
  
  addCalendarEvent(event: InsertCalendarEvent): Promise<CalendarEvent>;
  getCalendarEvents(): Promise<CalendarEvent[]>;
  getCalendarEventsByEmailId(emailId: number): Promise<CalendarEvent[]>;
  
  getAppSetting(key: string): Promise<string | null>;
  setAppSetting(key: string, value: string): Promise<void>;
}

function tokenize(query: string): string[] {
  return (query || "").trim().split(/\s+/).filter(t => t.length > 0);
}

function scoreText(text: string, tokens: string[]): number {
  if (!text || tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    const regex = new RegExp(token.toLowerCase(), 'gi');
    const matches = lower.match(regex);
    if (matches) {
      score += matches.length;
    }
  }
  return score;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getEmailsCount(): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)::int` }).from(emails);
    return result[0]?.count ?? 0;
  }

  async getLastImport(): Promise<ImportLog | undefined> {
    const [log] = await db
      .select()
      .from(importLogs)
      .orderBy(desc(importLogs.createdAt))
      .limit(1);
    return log || undefined;
  }

  async getStats(): Promise<Stats> {
    const count = await this.getEmailsCount();
    const lastImport = await this.getLastImport();
    
    return {
      mode: "PostgreSQL",
      emailsCount: count,
      lastImport: lastImport?.createdAt?.toISOString() ?? null,
    };
  }

  async insertEmail(email: InsertEmail): Promise<Email> {
    const [inserted] = await db.insert(emails).values(email).returning();
    return inserted;
  }

  async insertEmails(emailsToInsert: InsertEmail[]): Promise<number> {
    if (emailsToInsert.length === 0) return 0;
    
    const batchSize = 100;
    let inserted = 0;
    
    await db.transaction(async (tx) => {
      for (let i = 0; i < emailsToInsert.length; i += batchSize) {
        const batch = emailsToInsert.slice(i, i + batchSize);
        await tx.insert(emails).values(batch);
        inserted += batch.length;
      }
    });
    
    return inserted;
  }

  async searchEmails(query: string, topK: number): Promise<SearchResult[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const searchPattern = `%${query}%`;
    
    const results = await db
      .select()
      .from(emails)
      .where(
        or(
          ilike(emails.subject, searchPattern),
          ilike(emails.body, searchPattern),
          ilike(emails.sender, searchPattern),
          ilike(emails.date, searchPattern)
        )
      )
      .limit(100);

    const scored: SearchResult[] = results.map(email => {
      const textToScore = `${email.subject} ${email.body}`;
      const score = scoreText(textToScore, tokens);
      
      return {
        mailId: String(email.id),
        subject: email.subject || "(제목 없음)",
        score,
        sender: email.sender || null,
        date: email.date || null,
        body: email.body || "",
        attachments: [],
      };
    }).filter(r => r.score > 0);

    scored.sort((a, b) => b.score - a.score);
    
    return scored.slice(0, Math.max(1, topK));
  }

  async logImport(log: InsertImportLog): Promise<ImportLog> {
    const [inserted] = await db.insert(importLogs).values(log).returning();
    return inserted;
  }

  async getEmailById(id: number): Promise<Email | undefined> {
    const [email] = await db.select().from(emails).where(eq(emails.id, id));
    return email || undefined;
  }

  async createConversation(conv: InsertConversation): Promise<Conversation> {
    const [inserted] = await db.insert(conversations).values(conv).returning();
    return inserted;
  }

  async getConversation(id: number): Promise<Conversation | undefined> {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    return conv || undefined;
  }

  async getConversations(): Promise<Conversation[]> {
    return await db.select().from(conversations).orderBy(desc(conversations.updatedAt));
  }

  async addMessage(msg: InsertMessage): Promise<Message> {
    const [inserted] = await db.insert(messages).values(msg).returning();
    await db.update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, msg.conversationId));
    return inserted;
  }

  async getMessages(conversationId: number): Promise<Message[]> {
    return await db.select().from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt);
  }

  async addCalendarEvent(event: InsertCalendarEvent): Promise<CalendarEvent> {
    const [inserted] = await db.insert(calendarEvents).values(event).returning();
    return inserted;
  }

  async getCalendarEvents(): Promise<CalendarEvent[]> {
    return await db.select().from(calendarEvents).orderBy(desc(calendarEvents.createdAt));
  }

  async getCalendarEventsByEmailId(emailId: number): Promise<CalendarEvent[]> {
    return await db.select().from(calendarEvents)
      .where(eq(calendarEvents.emailId, emailId))
      .orderBy(desc(calendarEvents.createdAt));
  }

  async insertEmailsAndGetIds(emailsToInsert: InsertEmail[]): Promise<Email[]> {
    if (emailsToInsert.length === 0) return [];
    
    const batchSize = 100;
    const allInserted: Email[] = [];
    
    await db.transaction(async (tx) => {
      for (let i = 0; i < emailsToInsert.length; i += batchSize) {
        const batch = emailsToInsert.slice(i, i + batchSize);
        const inserted = await tx.insert(emails).values(batch).returning();
        allInserted.push(...inserted);
      }
    });
    
    return allInserted;
  }

  async getAllEmails(limit: number = 1000): Promise<Email[]> {
    return await db.select().from(emails).orderBy(desc(emails.createdAt)).limit(limit);
  }

  async getUnprocessedEmails(): Promise<Email[]> {
    return await db.select().from(emails)
      .where(eq(emails.isProcessed, "false"))
      .orderBy(emails.createdAt);
  }

  async updateEmailClassification(id: number, classification: string, confidence: string): Promise<void> {
    await db.update(emails)
      .set({ classification, classificationConfidence: confidence })
      .where(eq(emails.id, id));
  }

  async markEmailProcessed(id: number): Promise<void> {
    await db.update(emails)
      .set({ isProcessed: "true" })
      .where(eq(emails.id, id));
  }

  async getAppSetting(key: string): Promise<string | null> {
    const [setting] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    return setting?.value ?? null;
  }

  async setAppSetting(key: string, value: string): Promise<void> {
    const existing = await this.getAppSetting(key);
    if (existing !== null) {
      await db.update(appSettings)
        .set({ value, updatedAt: new Date() })
        .where(eq(appSettings.key, key));
    } else {
      await db.insert(appSettings).values({ key, value });
    }
  }
}

import { LocalSQLiteStorage } from "./local-storage";

const DATA_DIR = process.env.DATA_DIR || "";
const STORAGE_MODE = process.env.STORAGE_MODE || "postgresql";

function createStorage(): IStorage {
  if (STORAGE_MODE === "local" && DATA_DIR) {
    console.log(`Using local SQLite storage at: ${DATA_DIR}`);
    return new LocalSQLiteStorage(DATA_DIR);
  }
  console.log("Using PostgreSQL database storage");
  return new DatabaseStorage();
}

let storageInstance: IStorage = createStorage();

export function setStorage(newStorage: IStorage) {
  storageInstance = newStorage;
}

export const storage = new Proxy({} as IStorage, {
  get(target, prop) {
    return (storageInstance as any)[prop];
  }
});
