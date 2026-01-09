import { PSTFile, PSTFolder, PSTMessage } from 'pst-extractor';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as iconv from 'iconv-lite';

export interface ParsedEmail {
  subject: string;
  sender: string;
  date: string;
  body: string;
  importance?: string;
  label?: string;
}

export interface PSTParseResult {
  emails: ParsedEmail[];
  totalCount: number;
  errorCount: number;
  errors: string[];
}

function decodeText(text: string | null | undefined): string {
  if (!text) return "";
  
  try {
    // 이미 정상적인 UTF-8 텍스트인지 확인
    if (!/[\uFFFD\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) {
      return text;
    }

    // Buffer로 변환하여 다양한 인코딩 시도
    let buffer: Buffer;
    
    // text가 이미 Buffer처럼 바이트 배열인 경우
    if (text.includes('�') || /[\x80-\xFF]/.test(text)) {
      // latin1으로 읽어서 원본 바이트로 복원
      buffer = Buffer.from(text, 'latin1');
    } else {
      buffer = Buffer.from(text, 'utf-8');
    }

    // UTF-8 시도
    const utf8Text = buffer.toString('utf-8');
    if (!utf8Text.includes('�') && !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(utf8Text)) {
      return utf8Text;
    }

    // CP949 시도 (한글 Windows 기본 인코딩)
    try {
      const cp949Text = iconv.decode(buffer, 'cp949');
      if (!cp949Text.includes('�')) {
        return cp949Text;
      }
    } catch {}

    // EUC-KR 시도
    try {
      const eucKrText = iconv.decode(buffer, 'euc-kr');
      if (!eucKrText.includes('�')) {
        return eucKrText;
      }
    } catch {}

    // 모두 실패하면 원본 반환
    return text;
  } catch {
    return text || "";
  }
}

function formatDate(date: Date | null): string {
  if (!date) return "";
  try {
    return date.toISOString();
  } catch {
    return "";
  }
}

function getImportance(importance: number): string {
  switch (importance) {
    case 2: return "high";
    case 0: return "low";
    default: return "normal";
  }
}

function processFolder(folder: PSTFolder, emails: ParsedEmail[], errors: string[]): void {
  try {
    if (folder.hasSubfolders) {
      const subFolders = folder.getSubFolders();
      for (const subFolder of subFolders) {
        processFolder(subFolder, emails, errors);
      }
    }

    if (folder.contentCount > 0) {
      let email: PSTMessage | null = folder.getNextChild();
      while (email !== null) {
        try {
          const parsed: ParsedEmail = {
            subject: decodeText(email.subject) || "(제목 없음)",
            sender: decodeText(email.senderEmailAddress || email.senderName) || "",
            date: formatDate(email.messageDeliveryTime || email.clientSubmitTime),
            body: decodeText(email.body || email.bodyHTML) || "",
            importance: getImportance(email.importance),
            label: decodeText(folder.displayName) || undefined,
          };
          emails.push(parsed);
        } catch (err) {
          errors.push(`Error parsing email: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
        email = folder.getNextChild();
      }
    }
  } catch (err) {
    errors.push(`Error processing folder ${folder.displayName}: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

export function parsePSTFile(filePath: string): PSTParseResult {
  const emails: ParsedEmail[] = [];
  const errors: string[] = [];

  try {
    const pstFile = new PSTFile(filePath);
    const rootFolder = pstFile.getRootFolder();
    processFolder(rootFolder, emails, errors);
  } catch (err) {
    errors.push(`Failed to open PST file: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  return {
    emails,
    totalCount: emails.length,
    errorCount: errors.length,
    errors,
  };
}

export function parsePSTFromBuffer(buffer: Buffer, filename: string): PSTParseResult {
  const tempDir = os.tmpdir();
  const tempPath = path.join(tempDir, `pst_${Date.now()}_${filename}`);
  
  try {
    fs.writeFileSync(tempPath, buffer);
    const result = parsePSTFile(tempPath);
    return result;
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
    }
  }
}
