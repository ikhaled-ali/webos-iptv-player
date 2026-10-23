export interface QualityOption {
  index: number;
  width: number;
  height: number;
  bitrate: number;
  frameRate: number;
  available?: boolean;
}

export interface QualityState {
  options: QualityOption[];
  selected: number;
  loading: boolean;
  player?: string;
}

export function qualityLabel(option: QualityOption): string {
  const parts: string[] = [];
  if (option.height > 0) parts.push(`${option.height}p`);
  if (option.frameRate > 0) parts.push(`${Math.round(option.frameRate)} fps`);
  if (option.bitrate > 0) parts.push(`${(option.bitrate / 1000000).toFixed(1)} Mbps`);
  return parts.join(' · ');
}

export function matchingQuality(options: QualityOption[], choice: QualityOption | null): number {
  if (!choice) return -1;
  return options.find(option => option.width === choice.width && option.height === choice.height
    && option.bitrate === choice.bitrate && option.frameRate === choice.frameRate)?.index ?? -1;
}
