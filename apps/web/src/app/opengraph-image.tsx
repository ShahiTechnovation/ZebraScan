import { ImageResponse } from "next/og";

export const alt = "Zeb Scan — Pay in ZEC. They get INR.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#F4F2EB",
          padding: "72px 80px",
          color: "#111719",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="72" height="72" viewBox="0 0 32 32">
            <rect width="32" height="32" rx="7" fill="#E6B84B" />
            <g fill="none" stroke="#111719" strokeWidth="2" strokeLinecap="square">
              <path d="M5 10V5h5" />
              <path d="M22 5h5v5" />
              <path d="M5 22v5h5" />
            </g>
            <path d="M10.5 10.5h11L10.5 21.5h11" fill="none" stroke="#111719" strokeWidth="3.2" strokeLinecap="square" />
            <rect x="23.5" y="23.5" width="3.5" height="3.5" fill="#111719" />
          </svg>
          <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>Zeb Scan</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 88, fontWeight: 700, letterSpacing: -3, lineHeight: 1 }}>Pay in ZEC. They get INR.</div>
          <div style={{ fontSize: 30, color: "#535D61", maxWidth: 900 }}>
            Scan & Pay, merchant QR terminal and payment links — Zcash payments connected to local INR settlement experiences.
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 22, color: "#76571C" }}>Demo frontend · no live funds</div>
      </div>
    ),
    size,
  );
}
