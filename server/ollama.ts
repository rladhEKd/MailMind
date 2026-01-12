import type { ExtractedEvent } from "@shared/schema";
import { type RagSearchResult } from "@shared/schema";

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

// [신규] 텍스트 임베딩 생성 함수 (nomic-embed-text 사용)
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    // 줄바꿈을 공백으로 치환하여 임베딩 품질 향상
    const cleanText = text.replace(/\n/g, " ");
    
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nomic-embed-text", // 사용자 요청 모델
        prompt: cleanText,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data = await response.json();
    return data.embedding; // vector array 반환
  } catch (error) {
    console.error("Embedding generation error:", error);
    return [];
  }
}

export async function chatWithOllama(
  messages: OllamaMessage[],
  model: string = "llama3" // 기본 대화 모델
): Promise<string> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature: 0.1, // RAG의 정확성을 위해 온도를 낮춤
        }
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

// [핵심 수정] RAG 프롬프트가 적용된 대화 함수
export async function chatWithEmailContext(
  userQuestion: string,
  retrievedChunks: RagSearchResult[]
): Promise<string> {
  
  // 1. 참고자료 텍스트 포맷팅 (요청하신 구조대로)
  const contextText = retrievedChunks.map((chunk, index) => `
${index + 1}.
id: chunk-${chunk.id}
mailId: ${chunk.mailId}
subject: ${chunk.subject}
score: ${chunk.score.toFixed(2)}
snippet: "${chunk.content.replace(/"/g, "'")}"
`).join("\n");

  // 2. 시스템 프롬프트 (요청하신 내용 그대로 적용)
  const SYSTEM_PROMPT = `
당신은 이메일 기반 지식 검색 시스템(RAG)의 응답 생성기입니다.
아래의 규칙을 반드시 따르십시오.

[역할]
- 당신은 사용자의 질문에 대해, 제공된 "참고자료"에 근거하여 답변합니다.
- 참고자료는 벡터 검색과 MMR을 통해 선별된 신뢰 가능한 정보입니다.

[핵심 원칙 – 반드시 지킬 것]
1. 참고자료에 명시적으로 포함된 정보만 사용하여 답변하십시오.
2. 참고자료에 질문과 관련된 정보가 없거나, 근거가 불충분하면
   반드시 다음 문장으로만 답변하십시오:
   "관련 정보가 없습니다. 참고자료에 해당 정보가 없습니다."
3. 절대로 추측, 일반 상식, 외부 지식을 사용하지 마십시오.
4. 참고자료에 없는 내용을 보완하거나 확대 해석하지 마십시오.

[참고자료 사용 규칙]
- 각 참고자료에는 다음 메타 정보가 포함됩니다:
  - id: 청크 ID
  - mailId: 원본 이메일 ID
  - subject: 이메일 제목
  - score: 질문과의 유사도 점수
  - snippet: 이메일에서 발췌된 내용
- 답변에서 특정 사실을 언급할 경우,
  해당 사실이 어떤 참고자료(id 또는 mailId)에 근거했는지
  자연스럽게 드러나도록 작성하십시오.
  (예: “mailId=12의 이메일에 따르면 …”)

[출처 표기 지침]
- 직접적인 인용은 필요하지 않지만,
  “어느 이메일에서 나온 정보인지”는 명확히 알 수 있어야 합니다.
- 여러 참고자료를 종합한 경우,
  “여러 이메일을 종합하면 …”과 같이 표현하십시오.

[언어 및 형식]
- 답변은 반드시 한국어로 작성하십시오.
- 간결하되, 의미가 모호해지지 않도록 명확히 설명하십시오.
- 목록이나 단계가 필요한 경우에만 bullet point를 사용하십시오.

[대화 맥락]
- 이전 대화 히스토리는 참고용일 뿐이며,
  현재 질문에 직접적으로 관련되지 않으면 사용하지 마십시오.
- 최종적으로 답변해야 할 질문은
  가장 마지막 user 메시지입니다.

[중요]
- 당신의 목표는 “그럴듯한 답변”이 아니라
  “근거가 있는 답변 또는 명확한 거절”입니다.
`;

  // 3. 메시지 구조 생성
  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { 
      role: "system", 
      content: `[참고자료]\n${contextText || "참고할 만한 자료가 없습니다."}` 
    },
    { role: "user", content: userQuestion }
  ];

  return chatWithOllama(messages);
}

export async function checkOllamaConnection(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function classifyEmail(
  subject: string,
  body: string,
  sender: string
): Promise<{ classification: string; confidence: string }> {
  const systemPrompt = `당신은 이메일 분류 전문가입니다. 다음 카테고리 중 하나로 분류하세요:
- reference: 단순 참조
- reply_needed: 회신 필요
- urgent_reply: 긴급 회신
- meeting: 회의
JSON 응답 예시: {"classification": "meeting", "confidence": "high"}`;

  const userPrompt = `발신자: ${sender}\n제목: ${subject}\n내용: ${body.substring(0, 500)}`;

  try {
    const response = await chatWithOllama([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { classification: "reference", confidence: "low" };
  } catch (error) {
    return { classification: "reference", confidence: "low" };
  }
}