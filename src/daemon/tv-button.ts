/**
 * What the TV remote button does when pressed. It is an activation path of
 * its own — pressing a physical button IS the intent — so conversation mode
 * is NOT an input: /conversacion resets to off at every boot, and that used
 * to turn the button into a silent no-op (audit, "botón TV"). Without a chat
 * (nobody has talked yet) there is nowhere to open the session; without a
 * live wake listener there is no audio to feed it: the chat notice says so
 * instead of staying silent, and with no chat at all the log line is all
 * there is.
 */
export type TvButtonAction = 'open-session' | 'need-mic' | 'no-chat' | 'already-open';

export function tvButtonAction(opts: {
  hasChat: boolean;
  hasListener: boolean;
  sessionOpen: boolean;
}): TvButtonAction {
  if (!opts.hasChat) return 'no-chat';
  if (opts.sessionOpen) return 'already-open';
  if (!opts.hasListener) return 'need-mic';
  return 'open-session';
}
