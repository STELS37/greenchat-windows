// Cross-browser QR decoder. Chromium's BarcodeDetector is fast when present, while jsQR keeps the
// camera scanner working in Firefox, Safari and Android WebViews that expose getUserMedia but not the
// experimental detector API. The compatibility decoder is loaded only on first use, so the 140 KB
// implementation never inflates GreenChat's initial route bundle.

type BarcodeResult = { rawValue?: string };
type BarcodeDetectorLike = { detect(source: unknown): Promise<BarcodeResult[]> };
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
type JsQrDecoder = typeof import("../vendor/jsqr.js").default;
let jsQrPromise: Promise<JsQrDecoder> | null = null;
const loadJsQr = (): Promise<JsQrDecoder> => {
  jsQrPromise ??= import("../vendor/jsqr.js").then((module) => module.default);
  return jsQrPromise;
};

export interface QrFrameDecoder {
  decode(video: HTMLVideoElement): Promise<string | null>;
}

function detectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

export function createQrFrameDecoder(doc: Pick<Document, "createElement"> = document): QrFrameDecoder {
  const Detector = detectorCtor();
  const detector = Detector ? new Detector({ formats: ["qr_code"] }) : null;
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;

  const decodePixels = async (video: HTMLVideoElement): Promise<string | null> => {
    const sourceWidth = Math.floor(video.videoWidth || 0);
    const sourceHeight = Math.floor(video.videoHeight || 0);
    if (sourceWidth < 2 || sourceHeight < 2) return null;
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(2, Math.round(sourceWidth * scale));
    const height = Math.max(2, Math.round(sourceHeight * scale));
    canvas ??= doc.createElement("canvas");
    if (!context) context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const jsQr = await loadJsQr();
    return jsQr(image.data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
  };

  return {
    async decode(video) {
      if (detector) {
        try {
          const rows = await detector.detect(video);
          const value = rows.find((row) => typeof row.rawValue === "string" && row.rawValue.length > 0)?.rawValue;
          if (value) return value;
        } catch {
          // A partial WebView implementation can expose BarcodeDetector but fail at runtime. The pixel
          // decoder below is the compatibility path, not an error.
        }
      }
      try {
        return await decodePixels(video);
      } catch {
        // Video can be between frames while a camera switches; the caller retries on its normal tick.
        return null;
      }
    },
  };
}
