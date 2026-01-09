import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Calendar as CalendarIcon, 
  MapPin, 
  Clock,
  FileText,
  Mail,
  User,
  Loader2,
  AlertCircle
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CalendarEvent, Conversation } from "@shared/schema";

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
  
  const { data: events, isLoading } = useQuery<CalendarEvent[]>({
    queryKey: ["/api/events"],
  });

  const { data: email, isLoading: isEmailLoading } = useQuery<Conversation>({
    queryKey: ["/api/conversations", selectedEvent?.emailId],
    enabled: !!selectedEvent?.emailId,
  });

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
            {events && (
              <Badge variant="outline" className="gap-1">
                <CalendarIcon className="h-3 w-3" />
                {events.length}개 일정
              </Badge>
            )}
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
      </main>
    </div>
  );
}
