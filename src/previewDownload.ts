/** Optional byte identity for a registry's approved rendition. */
export type PreviewIntegrity = { sha256: string; sizeBytes: number };
export const DEFAULT_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;

/** No credentials or redirects; bounded streaming and cancellation before parsing. */
export async function downloadPreview(
  url: string, signal: AbortSignal, maxBytes = DEFAULT_PREVIEW_MAX_BYTES, integrity?: PreviewIntegrity,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid preview byte limit");
  if (integrity && (!/^[a-f0-9]{64}$/.test(integrity.sha256) ||
    !Number.isSafeInteger(integrity.sizeBytes) || integrity.sizeBytes < 1 || integrity.sizeBytes > maxBytes))
    throw new Error("Invalid preview identity");
  const response = await fetch(url, { signal, credentials: "omit", redirect: "error" });
  if (!response.ok || !response.body) throw new Error("Model download unavailable");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Model is too large");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes || (integrity && size > integrity.sizeBytes)) throw new Error("Model exceeds expected size");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (integrity) {
    if (size !== integrity.sizeBytes) throw new Error("Model size mismatch");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== integrity.sha256) throw new Error("Model hash mismatch");
  }
  return bytes.buffer;
}
