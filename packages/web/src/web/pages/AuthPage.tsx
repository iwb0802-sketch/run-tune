import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Music4, Loader2 } from "lucide-react";

type Mode = "login" | "signup" | "reset";

export default function AuthPage() {
  const { signIn, signUp, resetPassword } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      if (mode === "reset") {
        const { error } = await resetPassword(email);
        if (error) setMessage({ text: error.message, type: "error" });
        else setMessage({ text: "비밀번호 재설정 이메일을 전송했습니다.", type: "success" });
      } else if (mode === "signup") {
        const { error } = await signUp(email, password);
        if (error) setMessage({ text: error.message, type: "error" });
        else setMessage({ text: "가입 확인 이메일을 전송했습니다.", type: "success" });
      } else {
        const { error } = await signIn(email, password);
        if (error) setMessage({ text: "이메일 또는 비밀번호가 올바르지 않습니다.", type: "error" });
      }
    } catch {
      setMessage({ text: "오류가 발생했습니다. 다시 시도해 주세요.", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const title = mode === "login" ? "로그인" : mode === "signup" ? "회원가입" : "비밀번호 재설정";
  const cta = mode === "login" ? "로그인" : mode === "signup" ? "가입하기" : "재설정 이메일 전송";

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-soft via-background to-background px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-primary text-primary-foreground rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-lg shadow-primary/25">
            <Music4 className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">피아노 조율 시험용</h1>
          <p className="text-sm text-muted-foreground mt-1">Piano Tuning Scope</p>
        </div>

        <Card className="shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle>{title}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">이메일</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="example@email.com"
                />
              </div>

              {mode !== "reset" && (
                <div className="space-y-1.5">
                  <Label htmlFor="password">비밀번호</Label>
                  <Input
                    id="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="비밀번호 입력"
                  />
                </div>
              )}

              {message && (
                <Alert variant={message.type === "error" ? "destructive" : "default"}>
                  <AlertDescription>{message.text}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" disabled={loading} className="w-full" size="lg">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : cta}
              </Button>
            </form>

            <div className="mt-4 space-y-2 text-center text-sm">
              {mode === "login" && (
                <>
                  <button
                    onClick={() => setMode("signup")}
                    className="text-primary hover:underline block w-full"
                  >
                    계정이 없으신가요? 회원가입
                  </button>
                  <button
                    onClick={() => setMode("reset")}
                    className="text-muted-foreground hover:underline block w-full"
                  >
                    비밀번호를 잊으셨나요?
                  </button>
                </>
              )}
              {mode !== "login" && (
                <button
                  onClick={() => setMode("login")}
                  className="text-primary hover:underline"
                >
                  로그인으로 돌아가기
                </button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
