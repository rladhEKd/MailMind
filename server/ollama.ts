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

export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const cleanText = text.replace(/\n/g, " ");
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nomic-embed-text",
        prompt: cleanText,
      }),
    });
    if (!response.ok) throw new Error(`Embedding API error: ${response.status}`);
    const data = await response.json();
    return data.embedding; 
  } catch (error) {
    console.error("Embedding generation error:", error);
    return [];
  }
}

export async function chatWithOllama(
  messages: OllamaMessage[],
  model: string = "llama3" 
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
          temperature: 0.2, // 0.0은 너무 경직되어 문서를 놓칠 수 있어 약간 높임
          num_predict: 500,
        }
      }),
    });
    if (!response.ok) throw new Error(`Ollama API error: ${response.status}`);
    const data: OllamaResponse = await response.json();
    return data.message.content;
  } catch (error) {
    console.error("Ollama chat error:", error);
    throw new Error("AI 서버에 연결할 수 없습니다.");
  }
}

// [핵심 수정] 심플하고 강력한 RAG 프롬프트
export async function chatWithEmailContext(
  userQuestion: string,
  retrievedChunks: RagSearchResult[]
): Promise<string> {
  
  // 자료 포맷팅: 가독성 최우선
  const contextText = retrievedChunks.map((chunk, index) => 
    `문서번호: ${index + 1}
메일ID: ${chunk.mailId}
제목: ${chunk.subject}
내용: ${chunk.content.replace(/\n/g, " ")}`
  ).join("\n\n----------------\n\n");

  // 복잡한 역할극 대신 직관적인 지시 사용
  const SYSTEM_PROMPT = `
당신은 한국어로 대답하는 AI 비서입니다.
아래 제공되는 [메일 목록]을 읽고 사용자의 질문에 답변하세요.

[규칙]
1. 반드시 **한국어**로 답변하세요. 영어는 사용하지 마세요.
2. 질문과 관련된 내용이 메일 목록에 있다면 그 내용을 요약해서 알려주세요.
3. 질문과 관련된 내용이 전혀 없다면 "관련 정보를 찾을 수 없습니다."라고 말하세요.
4. 답변 끝에는 반드시 "(출처: 메일ID 숫자)"를 적어주세요.
`;

  // [중요] 한국어 강제화를 위해 User 메시지 마지막에 지시사항 추가
  const userMessageContent = `
[메일 목록]
${contextText || "표시할 메일이 없습니다."}

[질문]
"${userQuestion}"

[답변 작성 요령]
- 위 [메일 목록]의 모든 내용을 꼼꼼히 확인하세요.
- 질문의 핵심 단어(예: 진수식, 시운전, 용접, 회의)가 포함된 메일을 찾으세요.
- 답변은 반드시 한국어로 작성하세요.
`;

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessageContent }
  ];

  return chatWithOllama(messages);
}

// ... (나머지 checkOllamaConnection, classifyEmail 등은 기존 유지) ...
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
  const systemPrompt = `Classify into: reference, reply_needed, urgent_reply, meeting. Return JSON only.`;
  const userPrompt = `Subject: ${subject}\nBody: ${body.substring(0, 500)}`;
  try {
    const response = await chatWithOllama([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { classification: "reference", confidence: "low" };
  } catch {
    return { classification: "reference", confidence: "low" };
  }
}