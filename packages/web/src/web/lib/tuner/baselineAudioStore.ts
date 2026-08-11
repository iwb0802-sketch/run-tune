const DB_NAME = "run-tune-baseline-audio";
const STORE_NAME = "recordings";
const DB_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("이 브라우저에서는 오디오 저장소를 사용할 수 없습니다."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("오디오 저장소를 열 수 없습니다."));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function saveBaselineAudio(id: string, blob: Blob): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const request = transaction.objectStore(STORE_NAME).put(blob, id);
      request.onerror = () => reject(request.error ?? new Error("오디오를 저장할 수 없습니다."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("오디오 저장 중 오류가 발생했습니다."));
    });
  } finally {
    db.close();
  }
}

export async function getBaselineAudio(id: string): Promise<Blob | null> {
  const db = await openDatabase();
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(id);
      request.onerror = () => reject(request.error ?? new Error("오디오를 읽을 수 없습니다."));
      request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
    });
  } finally {
    db.close();
  }
}

export async function deleteBaselineAudio(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      ids.forEach((id) => store.delete(id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("오디오를 삭제할 수 없습니다."));
    });
  } finally {
    db.close();
  }
}
