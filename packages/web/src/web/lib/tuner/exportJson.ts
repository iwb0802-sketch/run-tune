/**
 * exportJson.ts
 * 세션 데이터를 JSON 파일로 내보내기/불러오기
 */

import { TuningSession } from "@/hooks/useTuningSession";

export function exportSessionToJson(session: TuningSession) {
  const json = JSON.stringify(session, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${session.name.replace(/[^a-zA-Z0-9가-힣]/g, "_")}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importSessionFromJson(): Promise<TuningSession | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string) as TuningSession;
          if (data.id && data.name && data.measurements) {
            resolve(data);
          } else {
            alert("올바른 조율 데이터 파일이 아닙니다.");
            resolve(null);
          }
        } catch {
          alert("파일을 읽을 수 없습니다.");
          resolve(null);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });
}
