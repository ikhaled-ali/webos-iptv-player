import type { AudioOption, SubtitleOption } from '../../types';
import type { MseEngine, PipelineStreamInfo } from './engine';
import type { QualityOption } from '../../utils/playback-quality';

interface ShakaAudioTrack {
  active: boolean;
  channelsCount: number | null;
  codecs: string | null;
  label: string | null;
  language: string;
  primary: boolean;
}

interface ShakaTextTrack {
  active: boolean;
  forced: boolean;
  label: string | null;
  language: string;
  primary: boolean;
}

interface ShakaVariantTrack {
  id?: number;
  width?: number | null;
  height?: number | null;
  bandwidth?: number;
  audioId?: number | null;
  language?: string;
  active: boolean;
  audioCodec: string | null;
  channelsCount: number | null;
  frameRate: number | null;
  hdr: string | null;
  videoCodec: string | null;
  spatialAudio?: boolean;
}

export interface ShakaPlayerLike {
  getAudioTracks(): ShakaAudioTrack[];
  getTextTracks(): ShakaTextTrack[];
  getVariantTracks(): ShakaVariantTrack[];
  selectAudioTrack(track: ShakaAudioTrack): void;
  selectTextTrack(track?: ShakaTextTrack | null): void;
  selectVariantTrack?(track: ShakaVariantTrack, clearBuffer?: boolean, safeMargin?: number): void;
  configure?(config: Record<string, unknown>): boolean | void;
  destroy(): void | Promise<void>;
}

export function createShakaEngine(player: ShakaPlayerLike): MseEngine {
  const qualityTracks = () => {
    if (!player.selectVariantTrack || !player.configure) return [];
    const tracks = player.getVariantTracks();
    const active = tracks.find(track => track.active);
    return tracks.filter(track => (track.height ?? 0) > 0 && (!active
      || (active.audioId != null ? track.audioId === active.audioId
        : track.language === active.language && track.audioCodec === active.audioCodec)));
  };
  return {
    qualityOptions(): QualityOption[] {
      return qualityTracks().map(track => ({
        index: track.id ?? player.getVariantTracks().indexOf(track),
        width: track.width || 0, height: track.height || 0,
        bitrate: track.bandwidth || 0, frameRate: track.frameRate || 0,
      }));
    },
    selectQuality(index: number): boolean {
      if (!player.configure || !player.selectVariantTrack) return false;
      const tracks = player.getVariantTracks();
      const track = qualityTracks().find(item => (item.id ?? tracks.indexOf(item)) === index);
      if (index !== -1 && !track) return false;
      if (player.configure({ abr: { enabled: index === -1 } }) === false) return false;
      if (track) player.selectVariantTrack(track, true, 0);
      return true;
    },
    audioOptions(): AudioOption[] {
      return player.getAudioTracks().map((track, index) => ({
        index,
        name: track.label || '',
        lang: track.language || '',
        isDefault: track.primary,
        active: track.active,
      }));
    },
    setAudioTrack(index: number): boolean {
      const tracks = player.getAudioTracks();
      if (index < 0 || index >= tracks.length) return false;
      if (!tracks[index].active) player.selectAudioTrack(tracks[index]);
      return true;
    },
    subtitleOptions(): SubtitleOption[] {
      return player.getTextTracks().map((track, index) => ({
        index,
        name: track.label || '',
        lang: track.language || '',
        isDefault: track.primary,
        isForced: track.forced,
        active: track.active,
      }));
    },
    setSubtitleTrack(index: number): boolean {
      const tracks = player.getTextTracks();
      if (index < 0) {
        if (tracks.some(track => track.active)) player.selectTextTrack();
        return true;
      }
      if (index >= tracks.length) return false;
      if (!tracks[index].active) player.selectTextTrack(tracks[index]);
      return true;
    },
    streamInfo(): PipelineStreamInfo | null {
      const active = player.getVariantTracks().find(track => track.active);
      if (!active) return null;
      return {
        videoCodec: active.videoCodec || '',
        audioCodec: active.audioCodec || '',
        videoRange: active.hdr || '',
        frameRate: active.frameRate || 0,
        audioChannels: active.channelsCount ? String(active.channelsCount) : '',
        audioAtmos: active.spatialAudio === true && active.audioCodec?.trim().toLowerCase().split('.')[0] === 'ec-3',
      };
    },
    destroy(): void | Promise<void> {
      return player.destroy();
    },
  };
}
