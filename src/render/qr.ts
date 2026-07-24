import QRCode from "qrcode";
import { termCaps, visibleWidth } from "./theme.js";

export interface QrRender {
  ok: boolean;
  lines: string[];
  reason?: "no-unicode" | "too-narrow" | "generation-failed";
}

// The QR is generated LOCALLY from the validated payment URI — the server's
// public CDN qr_url is never fetched. Decodability is proven in tests.
export async function renderQr(uri: string): Promise<QrRender> {
  const caps = termCaps();
  if (!caps.unicode) return { ok: false, lines: [], reason: "no-unicode" };
  try {
    const rendered = await QRCode.toString(uri, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "M",
      margin: 2
    });
    const lines = rendered.replace(/\n+$/, "").split("\n");
    // qrcode's terminal output is dense with ANSI escapes — measure what the
    // user sees, not the raw string, or every QR reads as "too wide".
    const width = Math.max(...lines.map((l) => visibleWidth(l)));
    if (width > caps.columns) return { ok: false, lines: [], reason: "too-narrow" };
    return { ok: true, lines };
  } catch {
    return { ok: false, lines: [], reason: "generation-failed" };
  }
}

export async function qrMatrixForTest(uri: string): Promise<boolean[][]> {
  const qr = QRCode.create(uri, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const rows: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) {
      row.push(qr.modules.get(y, x) === 1);
    }
    rows.push(row);
  }
  return rows;
}
