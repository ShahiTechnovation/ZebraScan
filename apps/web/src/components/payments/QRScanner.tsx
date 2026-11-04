"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, ImageUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Blocks";
import { classifyCameraError, startQrCamera, type CameraProblem, type QrCameraSession } from "@/lib/qr-decode";

// Upload / paste decoding lives with the camera decoder in lib/qr-decode (same zxing set-up).
export { decodeQrFromFile } from "@/lib/qr-decode";

type CamState = "idle" | "starting" | "scanning" | CameraProblem;

/** Live camera QR scanning with explicit permission UX and clean stop on unmount. */
export function CameraScanner({ onResult, onUseFallback }: { onResult: (text: string) => void; onUseFallback: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<QrCameraSession | null>(null);
  /** Bumped by every start/stop/unmount, so a camera that finishes opening late is closed, not leaked. */
  const runRef = useRef(0);
  const onResultRef = useRef(onResult);
  const [state, setState] = useState<CamState>("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const stop = useCallback(() => {
    runRef.current++;
    sessionRef.current?.stop();
    sessionRef.current = null;
    setState((s) => (s === "scanning" || s === "starting" ? "idle" : s));
  }, []);

  useEffect(() => stop, [stop]);

  const start = async () => {
    if (typeof window === "undefined") return;
    const video = videoRef.current;
    if (!window.isSecureContext) {
      setMessage(window.location.origin);
      setState("insecure");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !video) {
      setState("unavailable");
      return;
    }
    const run = ++runRef.current;
    sessionRef.current?.stop();
    sessionRef.current = null;
    setMessage("");
    setState("starting");
    try {
      const session = await startQrCamera(video, {
        onResult: (text) => {
          if (runRef.current !== run) return;
          sessionRef.current = null; // the session already stopped the camera
          setState("idle");
          onResultRef.current(text);
        },
        onError: (e) => {
          if (runRef.current !== run) return;
          sessionRef.current = null;
          setMessage((e as Error)?.message ?? "");
          setState(classifyCameraError(e));
        },
      });
      if (runRef.current !== run) {
        session.stop(); // stopped or unmounted while the camera was opening
        return;
      }
      sessionRef.current = session;
      setState("scanning");
    } catch (e) {
      if (runRef.current !== run) return;
      const problem = classifyCameraError(e, window.isSecureContext);
      setMessage(problem === "insecure" ? window.location.origin : (e as Error)?.message || "Unknown camera error");
      setState(problem);
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
            {state === "denied" || state === "busy" || state === "error" ? "Try camera again" : "Open camera"}
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
        {state === "scanning" && <p className="text-label text-foreground-secondary">Scanning… hold the QR steady inside the frame, about 15–30 cm from the camera.</p>}
        {state === "denied" && (
          <Callout tone="warning" title="Camera permission denied">
            Allow camera access in your browser settings (the camera icon in the address bar), or upload a QR image, paste QR data, or enter the UPI ID manually.
          </Callout>
        )}
        {state === "unavailable" && (
          <Callout tone="warning" title="No camera available">
            This device has no usable camera. Upload a screenshot of the QR, paste its data, or enter the UPI ID manually.
          </Callout>
        )}
        {state === "busy" && (
          <Callout tone="warning" title="Camera is busy">
            Another app (Zoom, Teams, the Camera app…) may be using the camera, or it stopped unexpectedly. Close that app and try again, or upload a screenshot of the QR.
          </Callout>
        )}
        {state === "insecure" && (
          <Callout tone="warning" title="Camera needs a secure connection">
            This page is open at {message || "an insecure address"}. Browsers only allow the camera on HTTPS or http://localhost, so it can&apos;t be used here. Upload a photo or screenshot of the QR, paste its text, or enter the UPI ID instead — those all work on this address.
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
