import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, getPublicConfig } from '../api.js';
import type { PublicConfigResponse } from '../../../core/api.js';
import { subscribeEvents } from '../ws.js';

/**
 * What {@link useConfig} exposes to the header and the dialogs.
 */
export interface ConfigStream {
  /** The configuration, or null before the first load. */
  config: PublicConfigResponse | null;
  /** Message from the last failed load, or null. */
  error: string | null;
  /** Re-reads the configuration from the server. */
  reload: () => void;
}

/**
 * Loads the public configuration and keeps it current: the server pushes a
 * config frame on the shared event stream whenever a workspace is added or
 * removed, and a re-read closes the gap the stream could not push over.
 *
 * @returns The configuration and a manual reload.
 */
export function useConfig(): ConfigStream {
  const [config, setConfig] = useState<PublicConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(false);

  const reload = useCallback(() => {
    getPublicConfig()
      .then((next) => {
        setConfig(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  useEffect(reload, [reload]);

  useEffect(() => {
    return subscribeEvents({
      onConnected: (connected) => {
        if (!connected) return;
        // The server replays a board per workspace on connect but no config
        // frame, so a workspace added or removed while the socket was down is
        // only learned by asking.
        if (opened.current) reload();
        opened.current = true;
      },
      onFrame: (frame) => {
        if (frame.type !== 'config') return;
        setConfig(frame.config);
      },
    });
  }, [reload]);

  return { config, error, reload };
}
