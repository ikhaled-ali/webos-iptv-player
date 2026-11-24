import type { Action } from '../types';

// In a right-to-left UI the layout is mirrored, so the remote's Left/Right
// keys arrive as reading-order actions: 'left' means "toward the start" and
// 'right' "toward the end", wherever those sit on screen. Components that move
// by index then need no RTL code; only geometry and the parts that stay
// left-to-right (spatial search, the guide timeline, seeking) turn an action
// back into a screen side with `screenSide`.
export function isRtl(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
}

export function readingOrderAction(screenAction: Action): Action {
  if (!isRtl()) return screenAction;
  if (screenAction === 'left') return 'right';
  if (screenAction === 'right') return 'left';
  return screenAction;
}

// The same swap is its own inverse.
export const screenSide = readingOrderAction;

// A `dir="ltr"` island inside a right-to-left UI (the seek bar row) lays out
// left-to-right, so its keys are screen sides again.
export function actionWithin(el: Element | null, action: Action): Action {
  return isRtl() && el?.closest('[dir="ltr"]') ? screenSide(action) : action;
}
