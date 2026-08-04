export interface JsQrOptions {
  inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst";
}

export interface JsQrResult {
  data: string;
}

declare function jsQr(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: JsQrOptions,
): JsQrResult | null;

export default jsQr;
