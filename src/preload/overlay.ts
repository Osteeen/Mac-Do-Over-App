import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('overlay', {
  setInteractive: (on: boolean) => ipcRenderer.invoke('overlay:set-interactive', !!on),
  hide: () => ipcRenderer.invoke('overlay:hide'),
  appInfo: () => ipcRenderer.invoke('app:info'),
});
// Mac Do Over. Shapes are in src/shared/types.ts. Main validates every argument again.
contextBridge.exposeInMainWorld('macDoOver', {
  snapshot: () => ipcRenderer.invoke('strip:snapshot'),
  findPreview: (snapshotId: string, reference: string) => ipcRenderer.invoke('find:preview', String(snapshotId), String(reference)),
  findSend: (snapshotId: string, reference: string) => ipcRenderer.invoke('find:send', String(snapshotId), String(reference)),
  openApproval: (snapshotId: string, candidateId: string) => ipcRenderer.invoke('approval:open', String(snapshotId), String(candidateId)),
  restore: (candidateId: string, token: string, mode: 'original' | 'recovered') =>
    ipcRenderer.invoke('restore:approve', { candidateId: String(candidateId), token: String(token), mode: mode === 'recovered' ? 'recovered' : 'original' }),
});
