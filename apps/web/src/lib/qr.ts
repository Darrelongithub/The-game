// src/lib/qr.ts — a QR code for the host page.
//
// The encoder is the MIT-licensed one vendored inside `qrcode-terminal`
// (the same encoder the server prints to the terminal), copied into
// `src/lib/qrcode/` so the browser can draw the join code with no network
// call and no extra dependency.
import QRCode from "./qrcode/index.js";

export interface QrMatrix {
  /** module count per side */
  size: number;
  /** modules[row][col] — true means a dark module */
  modules: boolean[][];
}

/** Encode a string as a QR matrix. Returns null when the text is too long. */
export function qrMatrix(text: string): QrMatrix | null {
  try {
    const qr = new QRCode(-1, 0 /* error correction level L */);
    qr.addData(text);
    qr.make();
    const modules = qr.modules as boolean[][];
    return { size: qr.getModuleCount(), modules };
  } catch {
    return null;
  }
}

/** An SVG path for a QR matrix — one path, no per-module DOM nodes. */
export function qrSvgPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.modules[row]?.[col]) parts.push(`M${col} ${row}h1v1h-1z`);
    }
  }
  return parts.join("");
}
