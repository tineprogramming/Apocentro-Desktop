import { app, dialog, clipboard } from 'electron';
import os from 'node:os';
import { isObject } from 'lodash';

import { reallyJsonStringify } from '../util/reallyJsonStringify';
import { Errors } from '../types/Errors';
import { redactAll } from '../util/privacy';
import { logCrash } from './crash/log_crash';
import { sleepFor } from '../session/utils/Promise';

// TODO: use localised strings
const quitText = 'Quit';
const copyErrorAndQuitText = 'Copy error and quit';

function handleError(prefix: string, error: Error): void {
  const formattedError = Errors.toString(error);
  if (console._error) {
    console._error(`${prefix}:`, formattedError);
  }
  console.error(`${prefix}:`, formattedError);

  if (app.isReady()) {
    // title field is not shown on macOS, so we don't use it
    const buttonIndex = dialog.showMessageBoxSync({
      buttons: [quitText, copyErrorAndQuitText],
      defaultId: 0,
      detail: redactAll(formattedError),
      message: prefix,
      noLink: true,
      type: 'error',
    });

    if (buttonIndex === 1) {
      clipboard.writeText(
        `${prefix}\n\n${redactAll(formattedError)}\n\n` +
          `App Version: ${app.getVersion()}\n` +
          `OS: ${os.platform()}`
      );
    }
  } else {
    dialog.showErrorBox(prefix, formattedError);
  }

  // allow 1s for graceful exit, then kill the app.
  // eslint-disable-next-line more/no-then
  void Promise.any([() => sleepFor(1000), app.quit()])
    .then(() => app.exit(1))
    .catch(e => {
      console.error('app.quit failed', e.message);
      app.exit(1);
    });
}

function _getError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const errorString = reallyJsonStringify(reason);
  return new Error(`Promise rejected with a non-error: ${errorString}`);
}

/**
 * Apocentro: is this a non-fatal mDNS/LAN-discovery socket error?
 *
 * macOS keeps its own `mDNSResponder` bound to UDP 5353, so our LAN-discovery bind can throw
 * `EADDRINUSE` there; Wi-Fi changes can likewise throw `EADDRNOTAVAIL` when an interface IP
 * disappears. These surface asynchronously from the dgram socket (outside the Bonjour error
 * callback), so without this they reach the generic handler and kill the app with an "Unhandled
 * Error" dialog at startup. LAN discovery is optional — everything else (messaging, calls over the
 * internet) works fine without it, so log and keep running.
 */
function isNonFatalMdnsError(reason: unknown): boolean {
  if (!isObject(reason)) {
    return false;
  }
  const code = 'code' in reason ? String((reason as { code?: unknown }).code) : '';
  const message = 'message' in reason ? String((reason as { message?: unknown }).message) : '';
  const isBindFailure =
    code === 'EADDRINUSE' || code === 'EADDRNOTAVAIL' || /EADDRINUSE|EADDRNOTAVAIL/.test(message);
  // Only the mDNS port (5353) — a bind failure on any other port is a real problem we must not hide.
  return isBindFailure && /:5353\b/.test(message);
}

export const addHandler = (): void => {
  // Note: we could maybe add a handler for when the renderer process died here?
  // (but also ignore the valid death like on restart/quit)
  process.on('uncaughtException', (reason: unknown) => {
    try {
      if (isObject(reason) && 'message' in reason && reason.message === 'write EPIPE') {
        return;
      }

      if (isNonFatalMdnsError(reason)) {
        console.error('[ApocentroLan] ignoring non-fatal mDNS socket error:', reason);
        return;
      }

      logCrash('main', { reason: 'uncaughtException', error: reason });

      handleError('Unhandled Error', _getError(reason));
    } catch (e) {
      // ignore (do not log as it just loops the error)
    }
  });

  process.on('unhandledRejection', (reason: unknown) => {
    try {
      if (isNonFatalMdnsError(reason)) {
        console.error('[ApocentroLan] ignoring non-fatal mDNS socket rejection:', reason);
        return;
      }

      logCrash('main', { reason: 'unhandledRejection', error: reason });

      handleError('Unhandled Promise Rejection', _getError(reason));
    } catch (e) {
      // ignore (do not log as it just loops the error)
    }
  });
};
