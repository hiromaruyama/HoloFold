import type { SourceBox } from "../../shared/schema";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read that image."));
    img.src = src;
  });
}

/** Downscale an uploaded photo to a JPEG data URL (long edge ≤ maxEdge). */
export async function fileToJpeg(file: File, maxEdge = 1568, quality = 0.86): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const s = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Crop a step's diagram out of its source page (with a little padding). */
export async function cropSource(src: string, box: SourceBox, pad = 0.015): Promise<string> {
  const img = await loadImage(src);
  const x0 = Math.max(0, box.x - pad);
  const y0 = Math.max(0, box.y - pad);
  const x1 = Math.min(1, box.x + box.w + pad);
  const y1 = Math.min(1, box.y + box.h + pad);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const sw = Math.max(8, (x1 - x0) * W);
  const sh = Math.max(8, (y1 - y0) * H);
  const s = Math.min(1, 640 / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * s);
  c.height = Math.round(sh * s);
  c.getContext("2d")!.drawImage(img, x0 * W, y0 * H, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

/**
 * @param focus points (video pixels) of what matters in the frame. The capture is cropped
 *   around them, with room for the hands, so small paper isn't lost in a wide shot.
 */
export function captureFrame(video: HTMLVideoElement, maxEdge = 1024, focus?: { x: number; y: number }[] | null): string | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;
  if (focus && focus.length >= 3) {
    const xs = focus.map((p) => p.x);
    const ys = focus.map((p) => p.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const side = Math.max((x1 - x0) * 1.9, (y1 - y0) * 1.9, Math.min(vw, vh) * 0.45);
    sw = Math.min(vw, side);
    sh = Math.min(vh, side);
    sx = Math.min(vw - sw, Math.max(0, (x0 + x1) / 2 - sw / 2));
    sy = Math.min(vh - sh, Math.max(0, (y0 + y1) / 2 - sh / 2));
  }
  const s = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * s);
  c.height = Math.round(sh * s);
  c.getContext("2d")!.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82);
}

export function splitDataUrl(dataUrl: string): { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" } {
  const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(dataUrl);
  const mediaType = (m?.[1] ?? "image/jpeg") as "image/jpeg";
  return { data: m?.[2] ?? dataUrl, mediaType };
}
