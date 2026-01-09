import type { ExtractedEvent } from "@shared/schema";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaResponse {
  model: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
}

export async function chatWithOllama(
  messages: OllamaMessage[],
  model: string = "llama3.2"
): Promise<string> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data: OllamaResponse = await response.json();
    return data.message.content;
  } catch (error) {
    console.error("Ollama chat error:", error);
    throw new Error("AI 서버에 연결할 수 없습니다. Ollama가 실행 중인지 확인해주세요.");
  }
}

export async function extractEventsFromEmail(
  emailSubject: string,
  emailBody: string,
  emailDate: string
): Promise<ExtractedEvent[]> {
  const systemPrompt = `당신은 이메일에서 일정/이벤트 정보를 추출하는 전문가입니다.
이메일 내용을 분석하여 모든 일정 정보를 정확하게 추출해주세요.

중요 규칙:
1. 제목(title)은 반드시 구체적으로 작성 (이메일 제목이나 본문에서 찾기)
2. 날짜(startDate)가 없으면 해당 일정은 제외
3. 날짜 형식은 반드시 "YYYY-MM-DD HH:mm" 또는 "YYYY-MM-DD"
4. 여러 개의 일정이 있으면 모두 추출
5. 빈 문자열 사용 금지 - 정보가 없으면 null 사용

반드시 다음 JSON 배열 형식으로만 응답하세요:
[
  {
    "title": "구체적인 일정 제목 (필수)",
    "startDate": "YYYY-MM-DD HH:mm (필수)",
    "endDate": "YYYY-MM-DD HH:mm (선택)",
    "location": "장소 (선택, 없으면 null)",
    "description": "추가 설명 (선택, 없으면 null)"
  }
]

일정이 없거나 날짜 정보가 없으면 빈 배열 []을 반환하세요.`;

  const userPrompt = `다음 이메일에서 모든 일정 정보를 추출해주세요:

이메일 제목: ${emailSubject}

이메일 본문:
${emailBody}

참고 - 이메일 수신 날짜: ${emailDate}`;

  try {
    const response = await chatWithOllama(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      "llama3.2"
    );

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return [];
    }

    const events = JSON.parse(jsonMatch[0]);
    
    // 유효성 검사: title과 startDate가 비어있거나 없는 이벤트 필터링
    const validEvents = Array.isArray(events) 
      ? events.filter(e => 
          e.title && 
          e.title.trim() !== '' && 
          e.startDate && 
          e.startDate.trim() !== ''
        )
      : [];
    
    return validEvents;
  } catch (error) {
    console.error("Event extraction error:", error);
    return [];
  }
}

export async function checkOllamaConnection(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function getAvailableModels(): Promise<string[]> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.models?.map((m: { name: string }) => m.name) || [];
  } catch {
    return [];
  }
}

export type EmailClassification = "reference" | "reply_needed" | "urgent_reply" | "meeting";

export interface ClassificationResult {
  classification: EmailClassification;
  confidence: string;
}

export async function classifyEmail(
  subject: string,
  body: string,
  sender: string
): Promise<ClassificationResult> {
  const systemPrompt = `당신은 이메일 분류 전문가입니다. 이메일을 다음 카테고리 중 하나로 분류하세요:
- reference: 단순 참조 (정보 공유, 공지사항, 회신이 필요 없는 이메일)
- reply_needed: 회신 필요 (답장이나 검토가 필요한 일반적인 이메일)
- urgent_reply: 긴급 회신 (빠른 답장이 필요하거나 마감이 임박한 이메일)
- meeting: 회의 (회의 일정, 참석 요청, 미팅 관련 이메일)

반드시 다음 JSON 형식으로만 응답하세요:
{"classification": "카테고리", "confidence": "high/medium/low"}`;

  const userPrompt = `다음 이메일을 분류해주세요:
발신자: ${sender}
제목: ${subject}
내용: ${body.substring(0, 500)}`;

  try {
    const response = await chatWithOllama([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        classification: result.classification || "reference",
        confidence: result.confidence || "medium",
      };
    }
    return { classification: "reference", confidence: "low" };
  } catch (error) {
    console.error("Classification error:", error);
    return { classification: "reference", confidence: "low" };
  }
}

export async function chatWithEmailContext(
  message: string,
  emailContext: Array<{ subject: string; body: string; sender: string; date: string }>
): Promise<string> {
  const contextText = emailContext
    .map((e, i) => `[이메일 ${i + 1}]\n제목: ${e.subject}\n발신자: ${e.sender}\n날짜: ${e.date}\n내용: ${e.body.substring(0, 300)}...`)
    .join("\n\n");

  const systemPrompt = `당신은 이메일 관리와 일정 정리를 도와주는 AI 비서입니다. 
사용자가 업로드한 이메일 데이터를 기반으로 질문에 답변해주세요.
아래는 관련 이메일 내용입니다:

${contextText}

이 정보를 바탕으로 사용자의 질문에 친절하게 답변해주세요.`;

  return chatWithOllama([
    { role: "system", content: systemPrompt },
    { role: "user", content: message },
  ]);
}
