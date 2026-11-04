/**
 * In-browser QR decoding for UPI codes: uploaded images and live camera frames. Nothing leaves
 * the device. This returns the raw QR text; lib/upi.ts decides whether it is a payable payload.
 *
 * Why this is more than `new BrowserQRCodeReader().decodeFromImageUrl()`:
 *  - zxing-js 0.21 ports ZXing 3.3's finder-pattern search, which only runs the diagonal
 *    cross-check for PURE_BARCODE input. Without it, data modules that happen to look like a
 *    finder pattern are accepted as corners and sharp, clean QR codes fail with
 *    "Dimensions could be not found" / FormatException. ZXing 3.4+ always runs that check; we
 *    enable it the same way (patchFinder) and keep the stock behaviour as a fallback attempt.
 *  - TRY_HARDER, a quiet-zone pad (tightly cropped screenshots), several scales (thumbnails and
 *    12 MP photos), quarter turns, inverted (light-on-dark) codes and the GlobalHistogram
 *    binarizer are each worth a retry on a still image (stillImagePlan). Camera frames cycle
 *    through similar passes plus a 2x centre zoom, one per frame (CAMERA_CYCLE).
 *  - The platform BarcodeDetector (Android / macOS / ChromeOS Chrome) is tried first when present.
 *  - The camera loop never dies on an unexpected per-frame error (zxing-browser's loop stops and
 *    releases the stream, leaving a black "Scanning…" box), and getUserMedia falls back to
 *    `{ video: true }` when a desktop webcam rejects the preferred constraints.
 *
 * Measured in Chrome on a corpus of GPay / PhonePe / Paytm / BHIM / BharatPe / bank merchant
 * payloads x 16 image variants: 448/448 decoded (zxing-browser defaults: 314/448).
 */
import type { DecodeHintType, LuminanceSource, QRCodeReader } from "@zxing/library";

export const MAX_QR_IMAGE_BYTES = 20 * 1024 * 1024;

export const QR_NOT_FOUND_MESSAGE =
  "No readable QR code was found in that image. Crop closer to the QR or use a sharper, well-lit picture — or paste the QR text / enter the UPI ID instead.";

type Zxing = typeof import("@zxing/library");

interface Engine {
  zx: Zxing;
  reader: QRCodeReader;
  hard: Map<DecodeHintType, unknown>;
  pure: Map<DecodeHintType, unknown>;
}

/** One zxing decode attempt over a prepared luminance buffer. */
export interface Attempt {
  /** ZXing 3.4 diagonal finder-pattern check (see header). */
  diagonal: boolean;
  global?: boolean;
  pure?: boolean;
}

/** One rendering of the source image: long side in px, optional inversion / quarter turns. */
export interface Step {
  size: number;
  invert?: boolean;
  /** Turning the image changes zxing's row-scan order, which sidesteps most false corners. */
  rotate?: 0 | 90 | 180 | 270;
  /** Quiet-zone pad (default on). Off once, because the pad also shifts the binarizer's 8 px blocks. */
  pad?: boolean;
  attempts: Attempt[];
}

let forceDiagonalCheck = false;
let enginePromise: Promise<Engine> | null = null;

interface FinderProto {
  handlePossibleCenter(stateCount: Int32Array, i: number, j: number, pureBarcode: boolean): boolean;
  __zebDiagonal?: true;
}

function patchFinder(finder: { prototype: unknown }): void {
  const proto = finder.prototype as FinderProto;
  if (proto.__zebDiagonal) return;
  const original = proto.handlePossibleCenter;
  // If a future zxing version changes shape, keep its stock behaviour rather than break decoding.
  if (typeof original !== "function" || original.length < 4) return;
  proto.handlePossibleCenter = function (this: unknown, stateCount: Int32Array, i: number, j: number, pureBarcode: boolean) {
    return original.call(this, stateCount, i, j, pureBarcode || forceDiagonalCheck);
  };
  proto.__zebDiagonal = true;
}

function loadEngine(): Promise<Engine> {
  enginePromise ??= (async () => {
    const [zx, finder] = await Promise.all([import("@zxing/library"), import("@zxing/library/esm/core/qrcode/detector/FinderPatternFinder")]);
    patchFinder(finder.default);
    const formats = [zx.BarcodeFormat.QR_CODE];
    const hard = new Map<DecodeHintType, unknown>([
      [zx.DecodeHintType.TRY_HARDER, true],
      [zx.DecodeHintType.POSSIBLE_FORMATS, formats],
    ]);
    const pure = new Map<DecodeHintType, unknown>([
      [zx.DecodeHintType.PURE_BARCODE, true],
      [zx.DecodeHintType.POSSIBLE_FORMATS, formats],
    ]);
    return { zx, reader: new zx.QRCodeReader(), hard, pure };
  })().catch((e) => {
    enginePromise = null; // allow a retry after e.g. a chunk-load failure
    throw e;
  });
  return enginePromise;
}

function tryDecode(engine: Engine, lum: Uint8ClampedArray, w: number, h: number, a: Attempt): string | null {
  const { zx } = engine;
  forceDiagonalCheck = a.diagonal;
  try {
    const source: LuminanceSource = new zx.RGBLuminanceSource(lum, w, h);
    const binarizer = a.global ? new zx.GlobalHistogramBinarizer(source) : new zx.HybridBinarizer(source);
    const text = engine.reader.decode(new zx.BinaryBitmap(binarizer), a.pure ? engine.pure : engine.hard).getText();
    return text || null;
  } catch {
    // NotFound / Checksum / Format, and the occasional internal error on odd frames: keep going.
    return null;
  } finally {
    forceDiagonalCheck = false;
  }
}

/* ------------------------------------------------------------------ native BarcodeDetector */

interface NativeDetector {
  detect(source: CanvasImageSource | ImageBitmap): Promise<Array<{ rawValue: string }>>;
}
interface NativeDetectorCtor {
  new (opts: { formats: string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

let nativePromise: Promise<NativeDetector | null> | null = null;

function nativeDetector(): Promise<NativeDetector | null> {
  nativePromise ??= (async () => {
    const Ctor = (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
    if (typeof Ctor !== "function") return null;
    try {
      const formats = (await Ctor.getSupportedFormats?.()) ?? [];
      return formats.includes("qr_code") ? new Ctor({ formats: ["qr_code"] }) : null;
    } catch {
      return null;
    }
  })();
  return nativePromise;
}

/** Prefer a UPI payload when an image holds several codes. */
function pickText(values: string[]): string | null {
  const texts = values.map((v) => v?.trim()).filter((v): v is string => !!v);
  return texts.find((t) => /^upi:/i.test(t)) ?? texts[0] ?? null;
}

async function nativeDetect(source: CanvasImageSource | ImageBitmap): Promise<string | null> {
  const d = await nativeDetector();
  if (!d) return null;
  try {
    return pickText((await d.detect(source)).map((r) => r.rawValue));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ rendering */

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser can't read images (no canvas support).");
  return ctx;
}

/**
 * Draws the source scaled so its long side is `step.size`, on a pad (white, or black for the
 * inverted pass so it turns white after inversion), and returns ITU-R luminance (zxing-browser's
 * formula). Transparent pixels composite onto the pad colour.
 */
function renderStep(source: CanvasImageSource, w: number, h: number, step: Pick<Step, "size" | "invert" | "rotate"> & { crop?: number }, canvas: HTMLCanvasElement, pad = true) {
  // Optional centred crop (camera "zoom"): a small, dense QR gets more pixels per module.
  const crop = step.crop ?? 1;
  const sw = w * crop;
  const sh = h * crop;
  const sx = (w - sw) / 2;
  const sy = (h - sh) / 2;
  const s = step.size / Math.max(sw, sh);
  const dw = Math.max(1, Math.round(sw * s));
  const dh = Math.max(1, Math.round(sh * s));
  const p = pad ? Math.max(8, Math.round(Math.max(dw, dh) * 0.04)) : 0;
  const rot = step.rotate ?? 0;
  const turned = rot === 90 || rot === 270;
  const W = (turned ? dh : dw) + p * 2;
  const H = (turned ? dw : dh) + p * 2;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = context2d(canvas);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = step.invert ? "#000000" : "#ffffff"; // also the backdrop for transparent PNGs
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (rot) {
    ctx.translate(W / 2, H / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(source, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    ctx.drawImage(source, sx, sy, sw, sh, p, p, dw, dh);
  }
  return { lum: luminance(ctx.getImageData(0, 0, W, H).data, !!step.invert), w: W, h: H };
}

function luminance(rgba: Uint8ClampedArray, invert: boolean): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length >> 2);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const g = (306 * rgba[i]! + 601 * rgba[i + 1]! + 117 * rgba[i + 2]! + 0x200) >> 10;
    out[j] = invert ? 255 - g : g;
  }
  return out;
}

/* ------------------------------------------------------------------ still images */

const DIAG: Attempt = { diagonal: true };
const STOCK: Attempt = { diagonal: false };
const PURE: Attempt = { diagonal: true, pure: true };
const GLOBAL: Attempt = { diagonal: true, global: true };

/** Ordered rendering plan for a still image of w×h pixels (most likely to succeed first). */
export function stillImagePlan(w: number, h: number): Step[] {
  const L = Math.max(w, h, 1);
  const primary = Math.min(L, 1600);
  const turn = Math.min(primary, 1000);
  const steps: Step[] = [
    { size: primary, attempts: [DIAG, STOCK, PURE, GLOBAL] },
    { size: primary, invert: true, attempts: [DIAG, STOCK, PURE] },
    { size: primary, pad: false, attempts: [DIAG, STOCK, GLOBAL] },
    { size: turn, rotate: 90, attempts: [DIAG, STOCK, GLOBAL] },
  ];
  // Other scales shift module edges against zxing's sampling grid; tiny images get upscaled.
  const sizes: number[] = [];
  const add = (s: number) => {
    const v = Math.round(s);
    if (v >= 200 && [primary, ...sizes].every((x) => Math.abs(x - v) > x * 0.12)) sizes.push(v);
  };
  if (L < 1000) add(Math.min(1200, L * (L < 300 ? 2 : 1.5)));
  if (L < 600) add(900);
  for (const s of [1100, 800, 560, 400]) if (s < primary) add(s);
  for (const s of sizes) steps.push({ size: s, attempts: [DIAG, STOCK, GLOBAL] }, { size: s, invert: true, attempts: [DIAG, STOCK] });
  steps.push({ size: turn, rotate: 180, attempts: [DIAG, GLOBAL] }, { size: turn, rotate: 270, invert: true, attempts: [DIAG] }, { size: turn, rotate: 90, invert: true, attempts: [DIAG] });
  if (L > 1600) steps.push({ size: Math.min(L, 2800), attempts: [DIAG] });
  return steps;
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** Decode a QR from an already-loaded image source. Returns null when nothing readable is found. */
export async function decodeStillImage(source: CanvasImageSource | ImageBitmap, w: number, h: number, trace?: (step: string) => void): Promise<string | null> {
  const native = await nativeDetect(source);
  if (native) {
    trace?.("native");
    return native;
  }
  const engine = await loadEngine();
  const canvas = document.createElement("canvas");
  for (const step of stillImagePlan(w, h)) {
    const r = renderStep(source, w, h, step, canvas, step.pad !== false);
    for (const a of step.attempts) {
      const text = tryDecode(engine, r.lum, r.w, r.h, a);
      if (text) {
        trace?.(`${step.size}${step.invert ? "/inv" : ""}${step.rotate ? `/r${step.rotate}` : ""}${step.pad === false ? "/nopad" : ""}:${a.diagonal ? "diag" : "stock"}${a.pure ? "+pure" : ""}${a.global ? "+global" : ""}`);
        canvas.width = canvas.height = 0;
        return text;
      }
    }
    await yieldToUi(); // keep the "Reading QR…" spinner alive between passes
  }
  canvas.width = canvas.height = 0;
  return null;
}

interface LoadedImage {
  source: CanvasImageSource | ImageBitmap;
  w: number;
  h: number;
  close(): void;
}

async function loadImage(file: Blob): Promise<LoadedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const b = await createImageBitmap(file);
      return { source: b, w: b.width, h: b.height, close: () => b.close() };
    } catch {
      // fall through to <img>, which some browsers decode more formats with (e.g. HEIC on Safari)
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("unreadable-image");
  }
  return { source: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

const IMAGE_EXT = /\.(png|jpe?g|jfif|webp|gif|bmp|avif|heic|heif)$/i;

/** Decode a QR from an uploaded or pasted image. Returns the raw text or throws a user-facing Error. */
export async function decodeQrFromFile(file: Blob & { name?: string }): Promise<string> {
  const type = (file.type || "").toLowerCase();
  const name = file.name ?? "";
  // Some systems hand over images with an empty MIME type; let the decoder decide in that case.
  if (type ? !type.startsWith("image/") : name !== "" && !IMAGE_EXT.test(name)) throw new Error("Choose an image file (PNG, JPG or WebP).");
  if (file.size === 0) throw new Error("That image file is empty.");
  if (file.size > MAX_QR_IMAGE_BYTES) throw new Error("Image is too large (max 20 MB). Crop or screenshot the QR and try again.");
  let img: LoadedImage;
  try {
    img = await loadImage(file);
  } catch {
    const heic = /hei[cf]/.test(type) || /\.hei[cf]$/i.test(name);
    throw new Error(heic ? "This browser can't open HEIC photos. Take a screenshot of the QR (PNG/JPG) and upload that instead." : "That image couldn't be opened. Use a PNG, JPG or WebP picture of the QR.");
  }
  try {
    if (!img.w || !img.h) throw new Error(QR_NOT_FOUND_MESSAGE);
    const text = await decodeStillImage(img.source, img.w, img.h);
    if (!text) throw new Error(QR_NOT_FOUND_MESSAGE);
    return text;
  } finally {
    img.close();
  }
}

/* ------------------------------------------------------------------ camera */

/** Constraints tried first: rear camera when there is one, 720p for dense merchant QRs. */
export const PREFERRED_CAMERA: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
};
export const FALLBACK_CAMERA: MediaStreamConstraints = { audio: false, video: true };

/** Errors after which a plain `{ video: true }` request is worth one more try. */
const RETRY_WITH_ANY_CAMERA = new Set(["OverconstrainedError", "ConstraintNotSatisfiedError", "NotReadableError", "TrackStartError", "AbortError", "NotFoundError", "DevicesNotFoundError", "TypeError"]);

export function errorName(e: unknown): string {
  return (e as { name?: string } | null)?.name ?? "";
}

/** getUserMedia with a fallback: desktop webcams can reject the preferred constraints. */
export async function openCameraStream(media: Pick<MediaDevices, "getUserMedia">): Promise<MediaStream> {
  try {
    return await media.getUserMedia(PREFERRED_CAMERA);
  } catch (e) {
    if (!RETRY_WITH_ANY_CAMERA.has(errorName(e))) throw e;
    return await media.getUserMedia(FALLBACK_CAMERA);
  }
}

export type CameraProblem = "denied" | "unavailable" | "busy" | "insecure" | "error";

export function classifyCameraError(e: unknown, secureContext = true): CameraProblem {
  switch (errorName(e)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "denied";
    case "SecurityError":
      return secureContext ? "denied" : "insecure";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "unavailable";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    default:
      return "error";
  }
}

/** Per-frame strategies; frames differ slightly, so cycling covers more cases cheaply. */
const CAMERA_CYCLE: Array<{ a: Attempt; invert?: boolean; rotate?: Step["rotate"]; crop?: number }> = [
  { a: DIAG },
  { a: STOCK },
  { a: DIAG, rotate: 90 },
  { a: DIAG, crop: 0.5 },
  { a: GLOBAL },
  { a: DIAG, invert: true },
  { a: DIAG, crop: 0.5, rotate: 90 },
  { a: DIAG, rotate: 180 },
  { a: DIAG, invert: true, rotate: 90 },
];
const MAX_FRAME_SIDE = 1280;

export interface FrameDecoder {
  decode(video: HTMLVideoElement, tick: number): Promise<string | null>;
  dispose(): void;
}

export async function createFrameDecoder(): Promise<FrameDecoder> {
  const [engine, native] = await Promise.all([loadEngine(), nativeDetector()]);
  let canvas: HTMLCanvasElement | null = document.createElement("canvas");
  let zxingTick = 0;
  return {
    async decode(video, tick) {
      if (!canvas || !video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
      if (native) {
        try {
          const text = pickText((await native.detect(video)).map((r) => r.rawValue));
          if (text) return text;
        } catch {
          // fall back to zxing below
        }
        if (tick % 2 === 0) return null; // native is fast and robust; zxing every other frame
      }
      if (!canvas) return null; // disposed while the native detector was running
      // Re-measured every frame: phones rotate and webcams renegotiate resolution mid-stream.
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const c = CAMERA_CYCLE[zxingTick++ % CAMERA_CYCLE.length]!;
      const r = renderStep(video, vw, vh, { size: Math.min(Math.max(vw, vh), MAX_FRAME_SIDE), invert: c.invert, rotate: c.rotate, crop: c.crop }, canvas, false);
      return tryDecode(engine, r.lum, r.w, r.h, c.a);
    },
    dispose() {
      if (canvas) canvas.width = canvas.height = 0;
      canvas = null;
    },
  };
}

function waitForFrames(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => video.readyState >= 2 && video.videoWidth > 0;
    if (ready()) return resolve();
    const done = (ok: boolean) => {
      clearInterval(poll);
      clearTimeout(timer);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("playing", check);
      if (ok) resolve();
      else reject(Object.assign(new Error("The camera started but sent no video. Try again, or upload a screenshot of the QR."), { name: "CameraNoFrames" }));
    };
    const check = () => ready() && done(true);
    const poll = setInterval(check, 100);
    const timer = setTimeout(() => done(ready()), timeoutMs);
    video.addEventListener("loadeddata", check);
    video.addEventListener("playing", check);
  });
}

export interface QrCameraSession {
  stop(): void;
}

export interface QrCameraOptions {
  onResult(text: string): void;
  /** Camera died mid-scan (unplugged, taken by another app, permission revoked). */
  onError?(e: unknown): void;
  intervalMs?: number;
}

/**
 * Opens the camera into `video` and scans until a QR is read, then stops the camera and calls
 * onResult once. The first decode runs after this resolves, so callers can store the session
 * before any callback fires. Unexpected per-frame errors never end the scan loop.
 */
export async function startQrCamera(video: HTMLVideoElement, opts: QrCameraOptions): Promise<QrCameraSession> {
  if (typeof window !== "undefined" && !window.isSecureContext) throw Object.assign(new Error("Camera needs HTTPS or localhost"), { name: "SecurityError" });
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("No camera API in this browser"), { name: "NotFoundError" });
  const stream = await openCameraStream(navigator.mediaDevices);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let decoder: FrameDecoder | null = null;
  const track = stream.getVideoTracks()[0];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    track?.removeEventListener("ended", onEnded);
    stream.getTracks().forEach((t) => t.stop());
    if (video.srcObject === stream) video.srcObject = null;
    decoder?.dispose();
  };
  const onEnded = () => {
    if (stopped) return;
    stop();
    opts.onError?.(Object.assign(new Error("The camera stopped sending video."), { name: "NotReadableError" }));
  };
  track?.addEventListener("ended", onEnded);
  try {
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "true");
    video.srcObject = stream;
    // Muted inline playback needs no gesture; if play() is interrupted, frames still arrive.
    await video.play().catch(() => undefined);
    await waitForFrames(video, 6000);
    decoder = await createFrameDecoder();
  } catch (e) {
    stop();
    throw e;
  }
  let tick = 0;
  const loop = async () => {
    if (stopped || !decoder) return;
    let text: string | null = null;
    try {
      text = await decoder.decode(video, tick++);
    } catch {
      text = null;
    }
    if (stopped) return;
    if (text) {
      stop();
      opts.onResult(text);
      return;
    }
    timer = setTimeout(loop, opts.intervalMs ?? 120);
  };
  timer = setTimeout(loop, 0);
  return { stop };
}
