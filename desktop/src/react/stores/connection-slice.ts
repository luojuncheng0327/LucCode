import type { ServerConnection, ServerConnectionRegistry } from '../services/server-connection';
import { LOCAL_CONNECTION_ID, refreshLocalServerConnection, upsertServerConnection } from '../services/server-connection';

export interface ConnectionSlice {
  serverPort: string | null;
  serverToken: string | null;
  serverConnections: ServerConnectionRegistry;
  activeServerConnectionId: string | null;
  activeServerConnection: ServerConnection | null;
  connected: boolean;
  statusKey: string;
  statusVars: Record<string, string | number>;
  /** Bridge dot: at least one platform connected */
  bridgeDotConnected: boolean;
  wsState: 'connected' | 'reconnecting' | 'disconnected';
  wsReconnectAttempt: number;
  setServerPort: (port: string | number | null) => void;
  setServerToken: (token: string | null) => void;
  setActiveServerConnection: (connection: ServerConnection | null) => void;
  setLocalServerConnection: (port: string | number | null, token: string | null) => void;
  upsertServerConnection: (connection: ServerConnection) => void;
  selectServerConnection: (connectionId: string) => void;
  setConnected: (connected: boolean) => void;
}

export const createConnectionSlice = (
  set: (partial: Partial<ConnectionSlice>) => void,
  get?: () => Pick<ConnectionSlice, 'serverPort' | 'serverToken' | 'serverConnections' | 'activeServerConnectionId' | 'activeServerConnection'>,
): ConnectionSlice => ({
  serverPort: null,
  serverToken: null,
  serverConnections: {},
  activeServerConnectionId: null,
  activeServerConnection: null,
  connected: false,
  statusKey: 'status.connecting',
  statusVars: {},
  bridgeDotConnected: false,
  wsState: 'disconnected',
  wsReconnectAttempt: 0,
  setServerPort: (port) => {
    const serverPort = port === null || port === undefined ? null : String(port);
    const serverToken = get?.().serverToken ?? null;
    const existingConnection = get?.().serverConnections?.[LOCAL_CONNECTION_ID]
      ?? get?.().activeServerConnection;
    const activeServerConnection = refreshLocalServerConnection({
      existingConnection,
      serverPort,
      serverToken,
    });
    set({
      serverPort,
      ...(activeServerConnection
        ? {
            serverConnections: upsertServerConnection(get?.().serverConnections, activeServerConnection),
            activeServerConnectionId: activeServerConnection.connectionId,
            activeServerConnection,
          }
        : {
            activeServerConnectionId: null,
            activeServerConnection: null,
          }),
    });
  },
  setServerToken: (token) => {
    const serverPort = get?.().serverPort ?? null;
    const existingConnection = get?.().serverConnections?.[LOCAL_CONNECTION_ID]
      ?? get?.().activeServerConnection;
    const activeServerConnection = refreshLocalServerConnection({
      existingConnection,
      serverPort,
      serverToken: token,
    });
    set({
      serverToken: token,
      ...(activeServerConnection
        ? {
            serverConnections: upsertServerConnection(get?.().serverConnections, activeServerConnection),
            activeServerConnectionId: activeServerConnection.connectionId,
            activeServerConnection,
          }
        : {
            activeServerConnectionId: null,
            activeServerConnection: null,
          }),
    });
  },
  setActiveServerConnection: (connection) => set(connection
    ? {
        serverConnections: upsertServerConnection(get?.().serverConnections, connection),
        activeServerConnectionId: connection.connectionId,
        activeServerConnection: connection,
      }
    : {
        activeServerConnectionId: null,
        activeServerConnection: null,
      }),
  setLocalServerConnection: (port, token) => {
    const serverPort = port === null || port === undefined ? null : String(port);
    const existingConnection = get?.().serverConnections?.[LOCAL_CONNECTION_ID]
      ?? get?.().activeServerConnection;
    const activeServerConnection = refreshLocalServerConnection({
      existingConnection,
      serverPort,
      serverToken: token,
    });
    set({
      serverPort,
      serverToken: token,
      ...(activeServerConnection
        ? {
            serverConnections: upsertServerConnection(get?.().serverConnections, activeServerConnection),
            activeServerConnectionId: activeServerConnection.connectionId,
            activeServerConnection,
          }
        : {
            activeServerConnectionId: null,
            activeServerConnection: null,
          }),
    });
  },
  upsertServerConnection: (connection) => set({
    serverConnections: upsertServerConnection(get?.().serverConnections, connection),
  }),
  selectServerConnection: (connectionId) => {
    const connection = get?.().serverConnections?.[connectionId];
    if (!connection) throw new Error(`server connection not found: ${connectionId}`);
    set({
      activeServerConnectionId: connectionId,
      activeServerConnection: connection,
    });
  },
  setConnected: (connected) => set({ connected }),
});
