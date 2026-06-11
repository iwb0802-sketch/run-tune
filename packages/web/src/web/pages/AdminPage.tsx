import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";

interface UserInfo {
  user_id: string;
  email?: string;
  role: "free" | "pro" | "admin";
  created_at?: string;
}

const ROLES = ["free", "pro", "admin"] as const;
const ROLE_LABEL = { free: "무료", pro: "Pro", admin: "관리자" } as const;

function roleBadgeVariant(role: UserInfo["role"]) {
  if (role === "admin") return "default" as const;
  if (role === "pro") return "secondary" as const;
  return "outline" as const;
}

export default function AdminPage({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  const fetchUsers = async () => {
    setLoading(true);
    const { data } = await (supabase.rpc as any)("get_users_with_roles");
    if (data) setUsers(data as UserInfo[]);
    setLoading(false);
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const updateRole = async (userId: string, newRole: UserInfo["role"]) => {
    setUpdating(userId);
    await supabase
      .from("user_roles")
      .upsert({ user_id: userId, role: newRole }, { onConflict: "user_id" });
    setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, role: newRole } : u)));
    setUpdating(null);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>관리자 대시보드</DialogTitle>
          <DialogDescription>사용자 권한 관리</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              불러오는 중...
            </div>
          ) : users.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              등록된 사용자가 없습니다.
            </div>
          ) : (
            <div className="space-y-2">
              {users.map((user) => (
                <div
                  key={user.user_id}
                  className="flex items-center justify-between p-3 bg-muted/50 rounded-xl border border-border"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {user.email || user.user_id}
                    </div>
                    <div className="mt-1">
                      <Badge variant={roleBadgeVariant(user.role)}>
                        {ROLE_LABEL[user.role]}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-3">
                    {ROLES.map((r) => (
                      <Button
                        key={r}
                        size="sm"
                        variant={user.role === r ? "default" : "outline"}
                        onClick={() => updateRole(user.user_id, r)}
                        disabled={user.role === r || updating === user.user_id}
                        className="text-xs h-7 px-2.5"
                      >
                        {ROLE_LABEL[r]}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="px-5 py-3 border-t sm:justify-start">
          <Button variant="ghost" size="sm" onClick={fetchUsers}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            새로고침
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
