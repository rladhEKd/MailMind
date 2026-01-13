import { PSTFile, PSTFolder, PSTMessage } from "pst-extractor";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as iconv from "iconv-lite";
import { htmlToText } from "html-to-text";

export interface ParsedEmail {
  subject: string;
  sender: string;
  date: string;
  body: string;
  importance?: string;
  label?: string;
  attachments?: ParsedAttachment[];
}

export interface ParsedAttachment {
  originalName: string;
  storedName: string;
  relPath: string; // attachmentsDir 기준 상대경로
  size: number;
  mime?: string;
}

export interface PSTParseResult {
  emails: ParsedEmail[];
  totalCount: number;
  errorCount: number;
  errors: string[];
}

export interface PSTParseOptions {
  /** true면 첨부파일을 attachmentsDir 아래에 저장 */
  saveAttachments?: boolean;
  /** 첨부파일 저장 루트. 예: <DATA_DIR>/attachments */
  attachmentsDir?: string;
}

function safeBasename(name: string): string {
  // Windows/Unix 공통으로 위험한 문자 제거
  const trimmed = (name || "").trim() || "attachment";
  return trimmed
    .replace(/[\\/]/g, "_")
    .replace(/[:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001F]/g, "")
    .slice(0, 180);
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeNodeInputStreamToFile(stream: any, outPath: string) {
  // pst-extractor의 PSTNodeInputStream은 Node.js stream이 아니라 readBlock/readCompletely 방식
  const fd = fs.openSync(outPath, "w");
  try {
    const buf = Buffer.alloc(8176);
    while (true) {
      const n = stream.readBlock(buf);
      if (!n || n <= 0) break;
      fs.writeSync(fd, buf.subarray(0, n));
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function decodeText(text: string | null | undefined): string {
  if (!text) return "";

  try {
    // 이미 정상적인 UTF-8 텍스트인지 확인
    if (!/[\uFFFD\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) {
      return text;
    }

    let buffer: Buffer;

    // 깨진 문자/바이트가 섞인 경우 latin1로 원본 바이트 복원 시도
    if (text.includes(" ") || /[\x80-\xFF]/.test(text)) {
      buffer = Buffer.from(text, "latin1");
    } else {
      buffer = Buffer.from(text, "utf-8");
    }

    // UTF-8 시도
    const utf8Text = buffer.toString("utf-8");
    if (!utf8Text.includes(" ") && !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(utf8Text)) {
      return utf8Text;
    }

    // CP949 시도
    try {
      const cp949Text = iconv.decode(buffer, "cp949");
      if (!cp949Text.includes(" ")) return cp949Text;
    } catch {}

    // EUC-KR 시도
    try {
      const eucKrText = iconv.decode(buffer, "euc-kr");
      if (!eucKrText.includes(" ")) return eucKrText;
    } catch {}

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
    case 2:
      return "high";
    case 0:
      return "low";
    default:
      return "normal";
  }
}

/** 텍스트가 HTML 원문(태그/META/DOCTYPE 등)처럼 보이는지 대충 판별 */
function looksLikeHtml(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.startsWith("<!DOCTYPE")) return true;
  if (/<(html|head|meta|body|span|font|div|p|br|table)\b/i.test(t)) return true;
  if (/Converted from text\/rtf/i.test(t)) return true;
  return false;
}

function htmlToPlainText(html: string): string {
  try {
    return htmlToText(html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "style", format: "skip" },
        { selector: "script", format: "skip" },
      ],
    }).trim();
  } catch {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

/**
 * 본문 앞에 붙는 "Stage/From/To/Reply Required/Date..." 같은 헤더 블록 제거
 * - 중요한 포인트: "맨 앞부분"에 붙은 경우만 제거 (본문 중간의 From: 은 건드리지 않음)
 */
function stripInjectedHeaderBlock(text: string): string {
  if (!text) return "";

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  // 앞부분 빈 줄 스킵
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;

  // 헤더 키 패턴
  const headerKeys = [
    /^stage\s*:/i,
    /^from\s*:/i,
    /^to\s*:/i,
    /^cc\s*:/i,
    /^bcc\s*:/i,
    /^reply\s*required\s*:/i,
    /^date\s*:/i,
    /^sent\s*:/i,
    /^subject\s*:/i,
  ];

  // start 이후 15줄까지 검사
  let idx = start;
  let headerLineCount = 0;
  let consumed = 0;

  for (; idx < Math.min(lines.length, start + 15); idx++) {
    const t = lines[idx].trim();

    if (t === "") {
      consumed++;
      break;
    }

    if (headerKeys.some((re) => re.test(t))) {
      headerLineCount++;
      consumed++;
      continue;
    }

    break;
  }

  if (headerLineCount >= 3) {
    const rest = lines.slice(start + consumed);
    while (rest.length && rest[0].trim() === "") rest.shift();
    return rest.join("\n").trim();
  }

  return normalized.trim();
}

/** 본문 텍스트 후처리 */
function normalizeBody(text: string): string {
  if (!text) return "";

  let t = text;

  // 1) 헤더블록 제거
  t = stripInjectedHeaderBlock(t);

  // 2) 줄 끝 공백 제거
  t = t
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");

  // 3) 너무 많은 빈 줄 정리
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

/**
 * 메일 본문 추출:
 * - 마지막에 normalizeBody()로 "내용만" 남도록 정리
 */
function extractBody(email: PSTMessage): string {
  const bodyRaw = decodeText(email.body);
  const htmlRaw = decodeText(email.bodyHTML);

  let result = "";

  if (bodyRaw && bodyRaw.trim().length > 0 && !looksLikeHtml(bodyRaw)) {
    result = bodyRaw.trim();
    return normalizeBody(result);
  }

  if (bodyRaw && bodyRaw.trim().length > 0 && looksLikeHtml(bodyRaw)) {
    const converted = htmlToPlainText(bodyRaw);
    if (converted) {
      result = converted;
      return normalizeBody(result);
    }
  }

  if (htmlRaw && htmlRaw.trim().length > 0) {
    const converted = htmlToPlainText(htmlRaw);
    if (converted) {
      result = converted;
      return normalizeBody(result);
    }
  }

  result = (bodyRaw || htmlRaw || "").trim();
  return normalizeBody(result);
}

/**
 * 본문 맨 앞에 섞인 헤더 블록(Stage/From/To...)에서 From 값을 뽑기
 * - 한 줄에 "Stage: ... From: xxx To: yyy ..." 형태도 지원
 */
function extractSenderFromInjectedBodyBlock(rawText: string): string {
  if (!rawText) return "";

  const text = rawText.replace(/\r\n/g, "\n").trim();

  // 1) 라인 시작형: "From: xxx"
  const m1 = text.match(/(?:^|\n)\s*From:\s*([^\n]+)/i);
  if (m1?.[1]) return m1[1].trim();

  // 2) 한 줄 결합형: "Stage: ... From: xxx To: yyy Reply Required: ..."
  const m2 = text.match(/From:\s*(.+?)(?=\s+To:|\s+Cc:|\s+Bcc:|\s+Reply\s*Required:|\s+Date:|\n|$)/i);
  if (m2?.[1]) return m2[1].trim();

  // 3) Sender: 도 지원
  const m3 = text.match(/(?:^|\n)\s*Sender:\s*([^\n]+)/i);
  if (m3?.[1]) return m3[1].trim();

  return "";
}

/**
 * 발신자(sender) 추출:
 * 1) PSTMessage sender 관련 필드
 * 2) (있으면) transportMessageHeaders 등에서 From:
 * 3) 그래도 없으면 "본문에 섞인 Stage/From/To 블록"에서 From: 파싱  ✅ (여기가 핵심)
 */
function extractSender(email: PSTMessage): string {
  const e = email as any;

  const direct =
    decodeText(e.senderEmailAddress) ||
    decodeText(e.senderName) ||
    decodeText(e.sentRepresentingEmailAddress) ||
    decodeText(e.sentRepresentingName) ||
    decodeText(e.senderSmtpAddress) ||
    decodeText(e.sentRepresentingSmtpAddress) ||
    "";

  if (direct.trim()) return direct.trim();

  // 헤더류 필드들 (라이브러리/버전에 따라 이름이 달라질 수 있어서 최대한 넓게)
  const headerCandidates = [
    e.transportMessageHeaders,
    e.internetMessageHeaders,
    e.messageHeaders,
    e.headers,
    e.header,
  ];

  for (const hc of headerCandidates) {
    const headers = decodeText(hc) || "";
    if (!headers) continue;

    const fromLine =
      headers.match(/^From:\s*(.+)$/im)?.[1]?.trim() ||
      headers.match(/^Sender:\s*(.+)$/im)?.[1]?.trim() ||
      "";

    if (fromLine) return fromLine;
  }

  // ✅ 마지막 fallback: body/bodyHTML에서 Stage/From/To 블록 파싱
  const bodyRaw = decodeText(email.body);
  const htmlRaw = decodeText(email.bodyHTML);

  // body가 HTML이면 plain으로 바꾼 뒤 파싱
  const bodyForParse =
    bodyRaw && looksLikeHtml(bodyRaw) ? htmlToPlainText(bodyRaw) : bodyRaw;

  const htmlForParse = htmlRaw ? htmlToPlainText(htmlRaw) : "";

  const from1 = extractSenderFromInjectedBodyBlock(bodyForParse || "");
  if (from1) return from1;

  const from2 = extractSenderFromInjectedBodyBlock(htmlForParse || "");
  if (from2) return from2;

  return "";
}

function extractAttachments(
  email: PSTMessage,
  opts: PSTParseOptions,
  errors: string[],
  emailKey: string
): ParsedAttachment[] {
  if (!opts.saveAttachments || !opts.attachmentsDir) return [];

  try {
    ensureDir(opts.attachmentsDir);
  } catch (e) {
    errors.push(`Failed to create attachments dir: ${e instanceof Error ? e.message : 'Unknown error'}`);
    return [];
  }

  const out: ParsedAttachment[] = [];
  const count = (email as any).numberOfAttachments ?? 0;
  if (!count || count <= 0) return out;

  // 임시로 _pst/<emailKey>/... 에 저장 → routes.ts에서 email_id 기준 폴더로 이동
  const relDir = path.join('_pst', emailKey);
  const absDir = path.join(opts.attachmentsDir, relDir);
  ensureDir(absDir);

  for (let i = 0; i < count; i++) {
    try {
      const att: any = (email as any).getAttachment(i);
      const originalNameRaw = decodeText(att?.longFilename) || decodeText(att?.filename) || `attachment_${i}`;
      const originalName = safeBasename(originalNameRaw);

      const mime = decodeText(att?.mimeTag) || undefined;
      const size = Number(att?.filesize ?? att?.size ?? 0) || 0;

      // 중복 파일명 방지
      const storedName = `${String(i).padStart(3, '0')}-${Date.now()}-${originalName}`;
      const relPath = path.join(relDir, storedName);
      const absPath = path.join(opts.attachmentsDir, relPath);

      const stream = att?.fileInputStream;
      if (!stream) {
        errors.push(`Attachment has no fileInputStream (emailKey=${emailKey}, index=${i}, name=${originalNameRaw})`);
        continue;
      }

      // 파일 저장
      writeNodeInputStreamToFile(stream, absPath);

      out.push({
        originalName: originalNameRaw || originalName,
        storedName,
        relPath,
        size: size || (fs.existsSync(absPath) ? fs.statSync(absPath).size : 0),
        mime,
      });
    } catch (err) {
      errors.push(`Error extracting attachment (emailKey=${emailKey}, idx=${i}): ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  return out;
}

function processFolder(folder: PSTFolder, emails: ParsedEmail[], errors: string[], opts: PSTParseOptions): void {
  try {
    if (folder.hasSubfolders) {
      const subFolders = folder.getSubFolders();
      for (const subFolder of subFolders) {
        processFolder(subFolder, emails, errors, opts);
      }
    }

    if (folder.contentCount > 0) {
      let email: PSTMessage | null = folder.getNextChild();
      while (email !== null) {
        try {
          // 이메일 순서를 보장하기 위한 키 (routes에서 index로도 매핑하지만, 첨부 저장 경로에 필요)
          const emailKey = `${emails.length + 1}_${Date.now()}`;

          const attachments = extractAttachments(email, opts, errors, emailKey);
          const parsed: ParsedEmail = {
            subject: decodeText(email.subject) || "(제목 없음)",
            sender: extractSender(email), // ✅ sender 강화
            date: formatDate(email.messageDeliveryTime || email.clientSubmitTime),
            body: extractBody(email), // ✅ 본문은 내용만
            importance: getImportance(email.importance),
            label: decodeText(folder.displayName) || undefined,
            attachments,
          };
          emails.push(parsed);
        } catch (err) {
          errors.push(`Error parsing email: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
        email = folder.getNextChild();
      }
    }
  } catch (err) {
    errors.push(
      `Error processing folder ${folder.displayName}: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

export function parsePSTFile(filePath: string, opts: PSTParseOptions = {}): PSTParseResult {
  const emails: ParsedEmail[] = [];
  const errors: string[] = [];

  try {
    const pstFile = new PSTFile(filePath);
    const rootFolder = pstFile.getRootFolder();
    processFolder(rootFolder, emails, errors, opts);
  } catch (err) {
    errors.push(`Failed to open PST file: ${err instanceof Error ? err.message : "Unknown error"}`);
  }

  return {
    emails,
    totalCount: emails.length,
    errorCount: errors.length,
    errors,
  };
}

export function parsePSTFromBuffer(buffer: Buffer, filename: string, opts: PSTParseOptions = {}): PSTParseResult {
  const tempDir = os.tmpdir();
  const tempPath = path.join(tempDir, `pst_${Date.now()}_${filename}`);

  try {
    fs.writeFileSync(tempPath, buffer);
    const result = parsePSTFile(tempPath, opts);
    return result;
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // ignore
    }
  }
}
