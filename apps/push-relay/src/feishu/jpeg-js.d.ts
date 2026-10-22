declare module "jpeg-js/lib/decoder.js" {
  export default function decode(
    data: Uint8Array,
    options: { useTArray: true; formatAsRGBA: boolean; maxResolutionInMP?: number; maxMemoryUsageInMB?: number },
  ): { width: number; height: number; data: Uint8Array };
}
