import { lunaRequest, type LunaRequestHandle, type LunaResponse } from './luna';

// Keeps the TV from its screensaver (and the sleep that follows it) while
// something the viewer waits on runs without remote input: a satellite scan,
// or satellite TV, whose broadcast picture the TV does not count as media
// playback. As LG's Channel Tuning app does it, the app registers for
// screensaver requests and turns each one down.

const POWER = 'luna://com.webos.service.tvpower/power';
const CLIENT = __APP_ID__;

const holders = new Set<string>();
let subscription: LunaRequestHandle | null = null;

interface ScreenSaverRequest extends LunaResponse {
  timestamp?: unknown;
}

function update(): void {
  if (holders.size && !subscription) {
    subscription = lunaRequest<ScreenSaverRequest>(POWER, {
      method: 'registerScreenSaverRequest',
      parameters: { clientName: CLIENT },
      subscribe: true,
      onSuccess: (request) => {
        if (request.timestamp === undefined) return;
        lunaRequest(POWER, {
          method: 'responseScreenSaverRequest',
          parameters: { clientName: CLIENT, timestamp: request.timestamp, ack: false },
        });
      },
    });
  } else if (!holders.size && subscription) {
    subscription.cancel();
    subscription = null;
  }
}

export const KeepAwake = {
  hold(reason: string): void {
    holders.add(reason);
    update();
  },
  release(reason: string): void {
    holders.delete(reason);
    update();
  },
};
