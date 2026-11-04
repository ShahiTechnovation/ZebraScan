"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, ImageUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Blocks";

type CamState = "idle" | "starting" | "scanning" | "denied" | "unavailable" | "insecure" | "error";

interface Controls {
  stop: () => void;
}

/** Live camera QR scanning with explicit permission UX and clean stop on unmount. */
export function CameraScanner({ onResult, onUseFallback }: { onResult: (text: string) => void; onUseFallback: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<Controls | null>(null);
  const [state, setState] = useState<CamState>("idle");
  const [message, setMessage] = useState<string>("");

  const stop = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    const v = videoRef.current;
    const stream = v?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (v) v.srcObject = null;
    setState((s) => (s === "scanning" || s === "starting" ? "idle" : s));
  }, []);

  useEffect(() => stop, [stop]);

  const start = async () => {
    if (typeof window === "undefined") return;
    if (!window.isSecureContext) {
      setState("insecure");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("unavailable");
      return;
    }
    setState("starting");
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 250 });
      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } }, audio: false },
        videoRef.current!,
        (result) => {
          if (result) {
            const text = result.getText();
            controlsRef.current?.stop();
            controlsRef.current = null;
            setState("idle");
            onResult(text);
          }
        },
      );
      controlsRef.current = controls;
      setState("scanning");
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") setState("denied");
      else if (name === "NotFoundError" || name === "OverconstrainedError") setState("unavailable");
      else {
        setState("error");
        setMessage((e as Error)?.message ?? "Unknown camera error");
      }
    }
  };

  const active = state === "scanning" || state === "starting";

  return (
    <div className="space-y-3">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-panel border border-border bg-[#0A1012]">
        <video ref={videoRef} className={active ? "h-full w-full object-cover" : "hidden"} muted playsInline aria-label="Camera preview" />
        {active && (
          <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-[62%] aspect-square">
              {["left-0 top-0 border-l-2 border-t-2", "right-0 top-0 border-r-2 border-t-2", "left-0 bottom-0 border-l-2 border-b-2", "right-0 bottom-0 border-r-2 border-b-2"].map((c) => (
                <span key={c} className={`absolute h-7 w-7 border-[#E6B84B] ${c}`} />
              ))}
            </div>
          </div>
        )}
        {!active && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-[#F0F1ED]">
            <Camera aria-hidden className="h-8 w-8 text-[#91A0A5]" />
            <p className="max-w-xs text-[13px] text-[#91A0A5]">Point your camera at a UPI QR. Zeb Scan reads the code locally in your browser.</p>
          </div>
        )}
        {state === "starting" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-[13px] text-white">
            <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> Requesting camera…
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {!active ? (
          <Button onClick={start}>
            <Camera aria-hidden className="h-4 w-4" />
            {state === "denied" ? "Try camera again" : "Open camera"}
          </Button>
        ) : (
          <Button variant="secondary" onClick={stop}>
            <CameraOff aria-hidden className="h-4 w-4" />
            Stop camera
          </Button>
        )}
        <Button variant="ghost" onClick={onUseFallback}>
          <ImageUp aria-hidden className="h-4 w-4" />
          Upload or paste instead
        </Button>
      </div>

      <div aria-live="polite">
        {state === "scanning" && <p className="text-label text-foreground-secondary">Scanning… hold the QR steady inside the frame.</p>}
        {state === "denied" && (
          <Callout tone="warning" title="Camera permission denied">
            Allow camera access in your browser settings, or upload a QR image, paste QR data, or enter the UPI ID manually.
          </Callout>
        )}
        {state === "unavailable" && (
          <Callout tone="warning" title="No camera available">
            This device has no usable camera. Upload a screenshot of the QR, paste its data, or enter the UPI ID manually.
          </Callout>
        )}
        {state === "insecure" && (
          <Callout tone="warning" title="Camera needs a secure connection">
            Browsers only allow camera access on HTTPS (or localhost). Use upload, paste or manual entry instead.
          </Callout>
        )}
        {state === "error" && (
          <Callout tone="danger" title="Camera error">
            {message}. Try upload, paste or manual entry.
          </Callout>
        )}
      </div>
    </div>
  );
}

/** Decode a QR from an uploaded image file. Returns the raw text or throws. */
export async function decodeQrFromFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file (PNG, JPG or WebP).");
  if (file.size > 8 * 1024 * 1024) throw new Error("Image is too large (max 8 MB).");
  const { BrowserQRCodeReader } = await import("@zxing/browser");
  const url = URL.createObjectURL(file);
  try {
    const reader = new BrowserQRCodeReader();
    const result = await reader.decodeFromImageUrl(url);
    return result.getText();
  } catch {
    throw new Error("No readable QR code was found in that image. Try a sharper, well-lit image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
