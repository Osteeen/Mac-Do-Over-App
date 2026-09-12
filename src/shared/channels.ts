/** Every IPC channel the app uses. Renderers may only call what is listed here; main validates the sender. */
export const CH = {
  permissionsStatus: 'permissions:status',
  permissionsOpen: 'permissions:open',
  overlaySetInteractive: 'overlay:set-interactive',
  overlayHide: 'overlay:hide',
  edgeActivated: 'edge:activated',
  appInfo: 'app:info',

  // Mac Do Over. Argument and result shapes are in types.ts.
  /** () => StripSnapshot */
  stripSnapshot: 'strip:snapshot',
  /** (snapshotId: string, reference: string) => FindPreview */
  findPreview: 'find:preview',
  /** (snapshotId: string, reference: string) => FindResult */
  findSend: 'find:send',
  /** (snapshotId: string, candidateId: string) => ApprovalSheet */
  approvalOpen: 'approval:open',
  /** (request: RestoreRequest) => RestoreResult */
  restoreApprove: 'restore:approve',
} as const;
export type Channel = typeof CH[keyof typeof CH];

/** A single captured frame. Lives only in main, only in memory, only for 60 seconds. */
export interface Frame { ts: number; w: number; h: number; jpeg: ArrayBuffer; masked: boolean }
export interface CaptureStats { frames: number; bytes: number; fps: number; oldestTs: number; newestTs: number }
export type PermissionPane = 'ScreenCapture' | 'Accessibility' | 'ListenEvent';
export interface PermissionStatus { screen: string; accessibility: boolean; inputMonitoring: 'unknown' | 'flowing' | 'silent' }
