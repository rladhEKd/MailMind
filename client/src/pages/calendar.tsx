import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { 
  Calendar as CalendarIcon, 
  MapPin, 
  Clock,
  FileText,
  Mail,
  User,
  Loader2,
  AlertCircle,
  Trash2
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CalendarEvent } from "@shared/schema";
import * as XLSX from "xlsx";
import { renderAsync } from "docx-preview";

type AttachmentItem = {
  id: number;
  filename: string;
  originalName?: string | null;
  size?: number;
  mime?: string | null;
  downloadUrl: string;
  previewUrl: string;
};

type EmailDetail = {
  id: number;
  subject: string;
  sender: string;
  date: string;
  body: string;
  attachments?: AttachmentItem[];
};

function EventCard({ event, onClick }: { event: CalendarEvent; onClick: () => void }) {
  return (
    <Card className="hover-elevate cursor-pointer" onClick={onClick}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg truncate" data-testid={`event-title-${event.id}`}>
              {event.title}
            </h3>
            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                <span>{event.startDate}</span>
                {event.endDate && <span>~ {event.endDate}</span>}
              </span>
              {event.location && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  <span>{event.location}</span>
                </span>
              )}
            </div>
            {event.description && (
              <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
                {event.description}
              </p>
            )}
          </div>
          {event.emailId && (
            <Badge variant="outline" className="shrink-0">
              <FileText className="h-3 w-3 mr-1" />
              이메일 #{event.emailId}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function CalendarPage() {
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [resetting, setResetting] = useState(false);
  const [previewing, setPreviewing] = useState<AttachmentItem | null>(null);
  const [xlsxHtml, setXlsxHtml] = useState<string>("");
  const [docxBuffer, setDocxBuffer] = useState<ArrayBuffer | null>(null);
  const [previewError, setPreviewError] = useState<string>("");
  const docxContainerRef = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();

  const previewKind = useMemo(() => {
    if (!previewing) return null;
    const name = (previewing.originalName || previewing.filename || "").toLowerCase();
    const ext = name.split(".").pop() || "";
    const mime = (previewing.mime || "").toLowerCase();

    if (mime.includes("pdf") || ext === "pdf") return "pdf";
    if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
    if (mime.includes("spreadsheet") || ["xlsx", "xls"].includes(ext)) return "xlsx";
    if (mime.includes("word") || ext === "docx") return "docx";
    if (mime.startsWith("text/") || ["txt", "csv"].includes(ext)) return "text";
    return "other";
  }, [previewing]);

  // DOCX 렌더
  useEffect(() => {
    (async () => {
      if (!previewing) return;
      if (previewKind !== "docx") return;
      if (!docxBuffer) return;
      if (!docxContainerRef.current) return;

      try {
        docxContainerRef.current.innerHTML = "";
        await renderAsync(docxBuffer, docxContainerRef.current, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          renderHeaders: true,
        });
      } catch (e: any) {
        setPreviewError(e?.message ?? "DOCX 미리보기 중 오류가 발생했습니다.");
      }
    })();
  }, [previewKind, docxBuffer, previewing]);

  const openPreview = async (a: AttachmentItem) => {
    setPreviewError("");
    setXlsxHtml("");
    setDocxBuffer(null);
    setPreviewing(a);

    // XLSX는 HTML로 변환
    try {
      const kindName = (a.originalName || a.filename || "").toLowerCase();
      const ext = kindName.split(".").pop() || "";
      const mime2 = (a.mime || "").toLowerCase();
      const isXlsx = mime2.includes("spreadsheet") || ["xlsx", "xls"].includes(ext);
      const isDocx = mime2.includes("word") || ext === "docx";

      if (isXlsx) {
        const res = await fetch(a.previewUrl);
        if (!res.ok) throw new Error("XLSX 파일을 불러오지 못했습니다.");
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const first = wb.SheetNames[0];
        const ws = wb.Sheets[first];
        const html = XLSX.utils.sheet_to_html(ws, { id: "sheet-preview" });
        setXlsxHtml(html);
      }

      if (isDocx) {
        const res = await fetch(a.previewUrl);
        if (!res.ok) throw new Error("DOCX 파일을 불러오지 못했습니다.");
        const buf = await res.arrayBuffer();
        setDocxBuffer(buf);
      }
    } catch (e: any) {
      setPreviewError(e?.message ?? "미리보기 준비 중 오류가 발생했습니다.");
    }
  };
  
  const { data: events, isLoading } = useQuery<CalendarEvent[]>({
    queryKey: ["/api/events"],
  });

  const { data: email, isLoading: isEmailLoading } = useQuery<EmailDetail>({
    queryKey: ["/api/conversations", selectedEvent?.emailId],
    enabled: !!selectedEvent?.emailId,
  });

  const handleResetEvents = async () => {
    const ok = window.confirm(
      "정말로 '일정'을 모두 초기화할까요?\n이 작업은 되돌릴 수 없습니다."
    );
    if (!ok) return;

    setResetting(true);
    try {
      const res = await fetch("/api/events/reset", { method: "POST" });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        alert("초기화 실패: " + (data?.error ?? "unknown error"));
        return;
      }

      setSelectedEvent(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/events"] });

      alert("일정이 초기화되었습니다.");
    } catch (e: any) {
      alert("초기화 실패: " + (e?.message ?? "network error"));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-primary p-2">
                <CalendarIcon className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight">일정</h1>
                <p className="text-xs text-muted-foreground">이메일에서 추출된 일정 목록</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetEvents}
                disabled={resetting || isLoading || (events?.length ?? 0) === 0}
                className="gap-1"
                title="일정 테이블의 모든 데이터를 삭제합니다"
              >
                {resetting ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    초기화 중...
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3 w-3" />
                    일정 초기화
                  </>
                )}
              </Button>

              {events && (
                <Badge variant="outline" className="gap-1">
                  <CalendarIcon className="h-3 w-3" />
                  {events.length}개 일정
                </Badge>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="h-6 w-3/4 mb-2" />
                  <Skeleton className="h-4 w-1/2 mb-4" />
                  <Skeleton className="h-12 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : events?.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <div className="rounded-full bg-muted p-4 mb-4">
                <CalendarIcon className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="font-semibold mb-2">일정이 없습니다</h3>
              <p className="text-sm text-muted-foreground text-center max-w-md">
                이메일 검색 결과에서 "일정 추출" 버튼을 눌러 이메일의 일정을 추출해보세요.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4" data-testid="events-list">
            {events?.map(event => (
              <EventCard 
                key={event.id} 
                event={event} 
                onClick={() => setSelectedEvent(event)}
              />
            ))}
          </div>
        )}

        <Dialog open={!!selectedEvent} onOpenChange={(open) => !open && setSelectedEvent(null)}>
          <DialogContent className="max-w-4xl max-h-[95vh] flex flex-col">
            <DialogHeader className="flex-shrink-0">
              <DialogTitle>{selectedEvent?.title}</DialogTitle>
            </DialogHeader>
            
            <div className="flex-1 overflow-y-auto pr-2">
              {selectedEvent && (
                <div className="space-y-4">
                  <div className="grid gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">일정:</span>
                      <span>{selectedEvent.startDate}</span>
                      {selectedEvent.endDate && <span>~ {selectedEvent.endDate}</span>}
                    </div>
                    
                    {selectedEvent.location && (
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">장소:</span>
                        <span>{selectedEvent.location}</span>
                      </div>
                    )}
                    
                    {selectedEvent.description && (
                      <div className="flex items-start gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground mt-0.5" />
                        <div className="flex-1">
                          <span className="font-medium">상세 내용:</span>
                          <p className="mt-1 text-muted-foreground">{selectedEvent.description}</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {isEmailLoading && (
                    <div className="border-t pt-4">
                      <div className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="text-sm text-muted-foreground">원본 이메일 로딩 중...</span>
                      </div>
                    </div>
                  )}

                  {!isEmailLoading && email && (
                    <div className="border-t pt-4">
                      <h3 className="font-semibold mb-3 flex items-center gap-2">
                        <Mail className="h-4 w-4" />
                        원본 이메일
                      </h3>
                      <div className="space-y-3">
                        <div>
                          <span className="text-sm font-medium">제목:</span>
                          <p className="text-sm text-muted-foreground mt-1">{email.subject}</p>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <User className="h-3 w-3 text-muted-foreground" />
                          <span className="font-medium">발신자:</span>
                          <span className="text-muted-foreground">{email.sender}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          <span className="font-medium">날짜:</span>
                          <span className="text-muted-foreground">{email.date}</span>
                        </div>
                        <div>
                          <span className="text-sm font-medium">내용:</span>
                          <div className="mt-2 p-4 bg-muted rounded-md">
                            <p className="text-sm whitespace-pre-wrap">{email.body}</p>
                          </div>
                        </div>

                        {Array.isArray(email.attachments) && email.attachments.length > 0 && (
                          <div>
                            <span className="text-sm font-medium">첨부파일:</span>
                            <div className="mt-2 space-y-2">
                              {email.attachments.map((a) => (
                                <div
                                  key={a.id}
                                  className="flex items-center justify-between gap-3 p-3 rounded-md border bg-background"
                                >
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium truncate">
                                      {a.originalName || a.filename}
                                    </p>
                                    <p className="text-xs text-muted-foreground truncate">
                                      {a.mime || ""}
                                      {typeof a.size === "number" ? ` · ${Math.round(a.size / 1024)} KB` : ""}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Button size="sm" variant="secondary" onClick={() => openPreview(a)}>
                                      보기
                                    </Button>
                                    <Button asChild size="sm" variant="outline">
                                      <a href={a.downloadUrl} target="_blank" rel="noreferrer">
                                        다운로드
                                      </a>
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {!isEmailLoading && !email && selectedEvent?.emailId && (
                    <div className="border-t pt-4">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <AlertCircle className="h-4 w-4" />
                        <span>원본 이메일을 찾을 수 없습니다.</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* 첨부파일 미리보기 */}
        <Dialog open={!!previewing} onOpenChange={(open) => !open && setPreviewing(null)}>
          <DialogContent className="max-w-6xl h-[90vh] flex flex-col">
            <DialogHeader className="flex-shrink-0">
              <DialogTitle>{previewing ? (previewing.originalName || previewing.filename) : "첨부파일"}</DialogTitle>
            </DialogHeader>

            <div className="flex items-center justify-between gap-2 pb-2">
              <div className="text-xs text-muted-foreground truncate">
                {previewing?.mime || ""}
                {typeof previewing?.size === "number" ? ` · ${Math.round((previewing.size || 0) / 1024)} KB` : ""}
              </div>
              <div className="flex items-center gap-2">
                {previewing && (
                  <Button asChild size="sm" variant="outline">
                    <a href={previewing.downloadUrl} target="_blank" rel="noreferrer">
                      다운로드
                    </a>
                  </Button>
                )}
                {previewing && (
                  <Button asChild size="sm" variant="secondary">
                    <a href={previewing.previewUrl} target="_blank" rel="noreferrer">
                      새 탭에서 열기
                    </a>
                  </Button>
                )}
              </div>
            </div>

            {previewError && (
              <div className="text-sm text-destructive border rounded-md p-3">
                {previewError}
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-auto rounded-md border bg-background">
              {!previewing ? null : previewKind === "image" ? (
                <div className="p-3 flex justify-center">
                  <img src={previewing.previewUrl} className="max-h-[75vh] max-w-full object-contain" />
                </div>
              ) : previewKind === "xlsx" ? (
                <div className="p-3 overflow-auto" dangerouslySetInnerHTML={{ __html: xlsxHtml || "" }} />
              ) : previewKind === "docx" ? (
                <div className="p-3">
                  <div ref={docxContainerRef} />
                </div>
              ) : (
                <iframe
                  title="attachment-preview"
                  src={previewing.previewUrl}
                  className="w-full h-full"
                />
              )}
            </div>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}
