// Preview loads these eagerly; the TV loads them only for a manual player switch.
import Hls from 'hls.js';
import mpegts from 'mpegts.js';

(window as unknown as Record<string, unknown>).__Hls = Hls;
(window as unknown as Record<string, unknown>).__mpegts = mpegts;
