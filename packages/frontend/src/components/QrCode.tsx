import React, { useMemo } from "react";

import { encodeQrCode } from "@/utils/qrcode";

const QUIET_ZONE = 4;

interface QrCodeProps {
  value: string;
  size?: number;
  title?: string;
}

// Always dark on light, also in dark themes: scanners need the standard contrast and quiet zone.
const QrCode: React.FC<QrCodeProps> = props => {
  const { modules } = useMemo(() => encodeQrCode(props.value), [props.value]);
  const width = modules.length + QUIET_ZONE * 2;
  const path = modules
    .map((row, y) => row.map((dark, x) => (dark ? `M${x + QUIET_ZONE},${y + QUIET_ZONE}h1v1h-1z` : "")).join(""))
    .join("");
  return (
    <svg
      role="img"
      aria-label={props.title}
      viewBox={`0 0 ${width} ${width}`}
      width={props.size ?? 200}
      height={props.size ?? 200}
      shapeRendering="crispEdges"
    >
      <rect width={width} height={width} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
};

export default QrCode;
