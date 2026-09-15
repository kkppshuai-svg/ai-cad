export function isProcessTimeoutError(error) {
  return /\bcodex\b.*timed out after \d+ms/i.test(String(error?.message || error || ""));
}

export async function runWithTimeoutRetry(invoke) {
  try {
    return await invoke({ attempt: 0, fastRetry: false });
  } catch (error) {
    if (!isProcessTimeoutError(error)) throw error;
  }

  try {
    return await invoke({ attempt: 1, fastRetry: true });
  } catch (error) {
    if (!isProcessTimeoutError(error)) throw error;
    throw new Error("AI 建模请求超时，请缩小修改范围后重试；当前装配和版本未发生改变。", { cause: error });
  }
}
