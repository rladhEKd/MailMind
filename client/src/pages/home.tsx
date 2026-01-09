import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { 
  Search, 
  Upload, 
  Mail, 
  Database, 
  Clock, 
  User, 
  FileText,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ChevronDown,
  ChevronUp,
  X,
  Calendar,
  Sparkles
} from "lucide-react";
import type { Stats, ChatResponse, SearchResult, EventExtractionResponse } from "@shared/schema";

interface ExtendedImportResult {
  ok: boolean;
  inserted: number;
  classified?: number;
  eventsExtracted?: number;
  message?: string;
}

function StatCard({ 
  title, 
  value, 
  description, 
  icon: Icon,
  loading 
}: { 
  title: string; 
  value: string | number; 
  description?: string;
  icon: typeof Mail;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <div className="text-2xl font-bold" data-testid={`stat-${title.toLowerCase().replace(/\s/g, '-')}`}>
            {value}
          </div>
        )}
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

function EmailResultCard({ 
  result, 
  index,
  expanded,
  onToggle,
  onExtract,
  isExtracting,
  onViewFull
}: { 
  result: SearchResult; 
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onExtract: (emailId: number) => void;
  isExtracting: boolean;
  onViewFull: () => void;
}) {
  return (
    <Card 
      className="hover-elevate cursor-pointer transition-shadow duration-200"
      onClick={onToggle}
      data-testid={`email-result-${index}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-lg truncate" data-testid={`email-subject-${index}`}>
                {result.subject || "(제목 없음)"}
              </h3>
              <Badge variant="secondary" className="text-xs shrink-0">
                점수: {result.score.toFixed(1)}
              </Badge>
            </div>
            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
              {result.sender && (
                <span className="flex items-center gap-1">
                  <User className="h-3 w-3" />
                  <span className="truncate max-w-[200px]">{result.sender}</span>
                </span>
              )}
              {result.date && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  <span>{result.date}</span>
                </span>
              )}
            </div>
            {!expanded && result.body && (
              <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
                {result.body}
              </p>
            )}
            {expanded && result.body && (
              <div className="mt-4 p-4 bg-muted rounded-md max-h-64 overflow-y-auto">
                <p className="text-sm whitespace-pre-wrap">{result.body}</p>
              </div>
            )}
            {expanded && (
              <div className="mt-4 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExtract(parseInt(result.mailId));
                  }}
                  disabled={isExtracting}
                  data-testid={`extract-events-${index}`}
                >
                  {isExtracting ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  ) : (
                    <Sparkles className="h-4 w-4 mr-1" />
                  )}
                  일정 추출
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewFull();
                  }}
                >
                  <FileText className="h-4 w-4 mr-1" />
                  전체 보기
                </Button>
              </div>
            )}
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            className="shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            data-testid={`toggle-email-${index}`}
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function UploadDropzone({ 
  onUpload, 
  isUploading,
  progress
}: { 
  onUpload: (file: File) => void;
  isUploading: boolean;
  progress: number;
}) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      onUpload(file);
    }
  }, [onUpload]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUpload(file);
    }
  }, [onUpload]);

  return (
    <Card className="border-dashed">
      <CardContent className="p-8">
        <div
          className={`
            flex flex-col items-center justify-center min-h-[200px] rounded-lg border-2 border-dashed
            transition-colors duration-200 cursor-pointer
            ${isDragging ? 'border-primary bg-primary/5' : 'border-muted'}
            ${isUploading ? 'pointer-events-none opacity-70' : ''}
          `}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => !isUploading && document.getElementById('file-upload')?.click()}
          data-testid="upload-dropzone"
        >
          <input
            id="file-upload"
            type="file"
            accept=".pst,.json,.mbox"
            className="hidden"
            onChange={handleFileChange}
            disabled={isUploading}
          />
          
          {isUploading ? (
            <div className="flex flex-col items-center gap-4 w-full max-w-xs">
              <Loader2 className="h-12 w-12 text-primary animate-spin" />
              <p className="text-sm text-muted-foreground">이메일 가져오는 중...</p>
              <Progress value={progress} className="w-full" />
              <p className="text-xs text-muted-foreground">{progress}%</p>
            </div>
          ) : (
            <>
              <Upload className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-lg font-medium mb-1">
                파일을 드래그하거나 클릭하세요
              </p>
              <p className="text-sm text-muted-foreground">
                PST, JSON, MBOX 파일 지원
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ 
  icon: Icon, 
  title, 
  description 
}: { 
  icon: typeof Mail; 
  title: string; 
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <Icon className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-medium mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-sm">{description}</p>
    </div>
  );
}

export default function Home() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [topK, setTopK] = useState(10);
  const [expandedEmails, setExpandedEmails] = useState<Set<number>>(new Set());
  const [uploadProgress, setUploadProgress] = useState(0);
  const [searchResults, setSearchResults] = useState<ChatResponse | null>(null);
  const [extractingEmails, setExtractingEmails] = useState<Set<number>>(new Set());
  const [selectedEmail, setSelectedEmail] = useState<SearchResult | null>(null);

  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ["/api/stats"],
  });

  const extractMutation = useMutation({
    mutationFn: async (emailId: number) => {
      setExtractingEmails(prev => new Set(prev).add(emailId));
      const res = await apiRequest("POST", "/api/events/extract", { emailId });
      return res.json() as Promise<EventExtractionResponse>;
    },
    onSuccess: (data) => {
      setExtractingEmails(prev => {
        const newSet = new Set(prev);
        newSet.delete(data.emailId);
        return newSet;
      });
      if (data.events.length > 0) {
        toast({
          title: "일정 추출 완료",
          description: `${data.events.length}개의 일정을 추출했습니다.`,
        });
      } else {
        toast({
          title: "일정 없음",
          description: "이 이메일에서 일정을 찾을 수 없습니다.",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
    },
    onError: (error: Error, emailId: number) => {
      setExtractingEmails(prev => {
        const newSet = new Set(prev);
        newSet.delete(emailId);
        return newSet;
      });
      toast({
        title: "일정 추출 실패",
        description: error.message || "일정을 추출하는 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  const searchMutation = useMutation({
    mutationFn: async (data: { message: string; topK: number }) => {
      const res = await apiRequest("POST", "/api/search", data);
      return res.json() as Promise<ChatResponse>;
    },
    onSuccess: (data) => {
      setSearchResults(data);
      setExpandedEmails(new Set());
    },
    onError: (error) => {
      toast({
        title: "검색 실패",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      
      setUploadProgress(10);
      const interval = setInterval(() => {
        setUploadProgress(prev => Math.min(prev + 10, 90));
      }, 200);

      try {
        const res = await fetch("/api/import", {
          method: "POST",
          body: formData,
          credentials: "include",
        });
        
        clearInterval(interval);
        setUploadProgress(100);
        
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || res.statusText);
        }
        
        return res.json() as Promise<ExtendedImportResult>;
      } catch (error) {
        clearInterval(interval);
        throw error;
      }
    },
    onSuccess: (data) => {
      let description = data.message || `${data.inserted}개의 이메일을 가져왔습니다.`;
      if (data.classified && data.classified > 0) {
        description = `${data.inserted}개 이메일 가져오기, ${data.classified}개 분류, ${data.eventsExtracted || 0}개 일정 추출 완료`;
      }
      toast({
        title: "가져오기 완료",
        description,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      setUploadProgress(0);
    },
    onError: (error) => {
      toast({
        title: "가져오기 실패",
        description: error.message,
        variant: "destructive",
      });
      setUploadProgress(0);
    },
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      toast({
        title: "검색어를 입력해주세요",
        variant: "destructive",
      });
      return;
    }
    searchMutation.mutate({ message: searchQuery, topK });
  };

  const toggleEmailExpand = (index: number) => {
    setExpandedEmails(prev => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResults(null);
    setExpandedEmails(new Set());
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-primary p-2">
                <Mail className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight">이메일 검색</h1>
                <p className="text-xs text-muted-foreground">PST/JSON 이메일 검색 도구</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {stats && (
                <Badge variant="outline" className="gap-1">
                  <Database className="h-3 w-3" />
                  {stats.emailsCount.toLocaleString()}개
                </Badge>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid gap-6 md:grid-cols-3 mb-8">
          <StatCard
            title="총 이메일"
            value={stats?.emailsCount.toLocaleString() ?? "0"}
            description="저장된 이메일 수"
            icon={Mail}
            loading={statsLoading}
          />
          <StatCard
            title="저장소 상태"
            value={stats?.mode ?? "확인 중..."}
            description="현재 저장 모드"
            icon={Database}
            loading={statsLoading}
          />
          <StatCard
            title="마지막 업데이트"
            value={stats?.lastImport ?? "없음"}
            description="최근 가져오기"
            icon={Clock}
            loading={statsLoading}
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-2 mb-8">
          <div>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Upload className="h-5 w-5" />
              이메일 가져오기
            </h2>
            <UploadDropzone
              onUpload={(file) => importMutation.mutate(file)}
              isUploading={importMutation.isPending}
              progress={uploadProgress}
            />
          </div>

          <div>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Search className="h-5 w-5" />
              이메일 검색
            </h2>
            <Card>
              <CardContent className="p-6">
                <form onSubmit={handleSearch} className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="search"
                      placeholder="검색어를 입력하세요..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10 pr-10"
                      data-testid="input-search"
                    />
                    {searchQuery && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                        onClick={clearSearch}
                        data-testid="button-clear-search"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <label htmlFor="topK" className="text-sm text-muted-foreground whitespace-nowrap">
                        결과 수:
                      </label>
                      <Input
                        id="topK"
                        type="number"
                        min={1}
                        max={50}
                        value={topK}
                        onChange={(e) => setTopK(parseInt(e.target.value) || 10)}
                        className="w-20"
                        data-testid="input-topk"
                      />
                    </div>
                    <Button 
                      type="submit" 
                      className="flex-1"
                      disabled={searchMutation.isPending || !searchQuery.trim()}
                      data-testid="button-search"
                    >
                      {searchMutation.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          검색 중...
                        </>
                      ) : (
                        <>
                          <Search className="h-4 w-4" />
                          검색
                        </>
                      )}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>

        <section>
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <FileText className="h-5 w-5" />
              검색 결과
            </h2>
            {searchResults && (
              <Badge variant="outline" data-testid="results-count">
                {searchResults.citations.length}개 결과
              </Badge>
            )}
          </div>

          {searchMutation.isPending ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="h-6 w-3/4 mb-2" />
                    <Skeleton className="h-4 w-1/2 mb-4" />
                    <Skeleton className="h-16 w-full" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : searchResults ? (
            searchResults.citations.length > 0 ? (
              <div className="space-y-4" data-testid="search-results">
                {searchResults.citations.map((result, index) => (
                  <EmailResultCard
                    key={`${result.mailId}-${index}`}
                    result={result}
                    index={index}
                    expanded={expandedEmails.has(index)}
                    onToggle={() => toggleEmailExpand(index)}
                    onExtract={(emailId) => extractMutation.mutate(emailId)}
                    isExtracting={extractingEmails.has(parseInt(result.mailId))}
                    onViewFull={() => setSelectedEmail(result)}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={AlertCircle}
                title="검색 결과가 없습니다"
                description="다른 검색어로 다시 시도해보세요."
              />
            )
          ) : (
            <EmptyState
              icon={Search}
              title="이메일을 검색해보세요"
              description="검색어를 입력하면 저장된 이메일에서 관련 내용을 찾아드립니다."
            />
          )}
        </section>
      </main>

      <Dialog open={!!selectedEmail} onOpenChange={(open) => !open && setSelectedEmail(null)}>
        <DialogContent className="max-w-4xl max-h-[95vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>{selectedEmail?.subject || "(제목 없음)"}</DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto pr-2">
            {selectedEmail && (
              <div className="space-y-4">
                <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                  {selectedEmail.sender && (
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4" />
                      <span className="font-medium">발신자:</span>
                      <span>{selectedEmail.sender}</span>
                    </div>
                  )}
                  {selectedEmail.date && (
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      <span className="font-medium">날짜:</span>
                      <span>{selectedEmail.date}</span>
                    </div>
                  )}
                  <Badge variant="secondary">
                    점수: {selectedEmail.score.toFixed(1)}
                  </Badge>
                </div>
                
                <div>
                  <span className="text-sm font-medium">내용:</span>
                  <div className="mt-2 p-4 bg-muted rounded-md">
                    <p className="text-sm whitespace-pre-wrap">{selectedEmail.body}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <footer className="border-t mt-12">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <p className="text-center text-sm text-muted-foreground">
            PST 이메일 검색 도구 - 학생 과제 프로젝트
          </p>
        </div>
      </footer>
    </div>
  );
}
