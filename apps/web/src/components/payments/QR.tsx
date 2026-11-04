"use client";

import React, { useRef } from "react";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/providers/ToastProvider";

/** Renders `value` as a QR. Downloads are generated from the same payload, never screenshots. */
export function QRRenderer({
  value,
  size = 232,
  label,
  caption,
  dimmed,
  className,
  downloadName,
  downloadTitle,
  downloadOnly,
}: {
  value: string;
  size?: number;
  /** Accessible description of what the QR contains. */
  label: string;
  /** Visible caption under the QR (e.g. "Preview QR — cannot receive real ZEC"). */
  caption?: React.ReactNode;
  dimmed?: boolean;
  className?: string;
  downloadName?: string;
  /** Title printed above the QR in the downloaded PNG. */
  downloadTitle?: string;
  /** Render only the download button (QR shown elsewhere). */
  downloadOnly?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toast = useToast();

  const download = () => {
    const qr = canvasRef.current;
    if (!qr) return;
    const pad = 48;
    const titleH = downloadTitle ? 56 : 0;
    const footH = 44;
    const out = document.createElement("canvas");
    out.width = qr.width + pad * 2;
    out.height = qr.height + pad * 2 + titleH + footH;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#FBFAF6";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = "#111719";
    ctx.textAlign = "center";
    if (downloadTitle) {
      ctx.font = "600 26px system-ui, sans-serif";
      ctx.fillText(downloadTitle, out.width / 2, pad + 22);
    }
    ctx.drawImage(qr, pad, pad + titleH);
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillStyle = "#535D61";
    ctx.fillText("Zeb Scan", out.width / 2, out.height - pad / 2 - 6);
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = `${downloadName ?? "zeb-scan-qr"}.png`;
    a.click();
    toast("QR downloaded as PNG");
  };

  return (
    <figure className={cn("flex flex-col items-center", className)}>
      {!downloadOnly && (<div
        className={cn("relative rounded-panel border border-border bg-[#FBFAF6] p-3 transition-opacity", dimmed && "opacity-25 grayscale")}
        style={{ width: "min(100%, " + (size + 26) + "px)" }}
      >
        <QRCodeSVG value={value} size={size} level="M" marginSize={0} bgColor="#FBFAF6" fgColor="#111719" title={label} role="img" aria-label={label} className="h-auto w-full" />
      </div>)}
      {caption && !downloadOnly && <figcaption className="mt-2 text-center text-micro font-medium text-accent">{caption}</figcaption>}
      {downloadName && (
        <>
          <QRCodeCanvas ref={canvasRef} value={value} size={720} level="M" marginSize={0} bgColor="#FBFAF6" fgColor="#111719" className="hidden" aria-hidden />
          <Button variant="secondary" size="sm" className={cn("no-print", !downloadOnly && "mt-3")} onClick={download}>
            <Download aria-hidden className="h-4 w-4" />
            Download PNG
          </Button>
        </>
      )}
    </figure>
  );
}
