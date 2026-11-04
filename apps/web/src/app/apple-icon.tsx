import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#E6B84B", alignItems: "center", justifyContent: "center" }}>
        <svg width="180" height="180" viewBox="0 0 32 32">
          <g fill="none" stroke="#111719" strokeWidth="2" strokeLinecap="square">
            <path d="M5 10V5h5" />
            <path d="M22 5h5v5" />
            <path d="M5 22v5h5" />
          </g>
          <path d="M10.5 10.5h11L10.5 21.5h11" fill="none" stroke="#111719" strokeWidth="3.2" strokeLinecap="square" />
          <rect x="23.5" y="23.5" width="3.5" height="3.5" fill="#111719" />
        </svg>
      </div>
    ),
    size,
  );
}
