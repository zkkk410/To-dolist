/* 预加载脚本：把安全的接口暴露给页面（页面里通过 window.api 使用） */
const { contextBridge, ipcRenderer } = require("electron");

const boot = ipcRenderer.sendSync("state:load");

contextBridge.exposeInMainWorld("api", {
  editCapsule: (id, action, value) => ipcRenderer.send('capsule:edit', id, action, value),
  resizeCapsule: (id, phase, edge) => ipcRenderer.send('capsule:resize', id, phase, edge),
  isDesktop: true,
  reportPinRegion: (id, rect) => ipcRenderer.send('capsule:pin-region', id, rect),
  updatePointer: (id) => ipcRenderer.send('capsule:pointer', id),
  capsuleControl: (id, action) => ipcRenderer.send('capsule:control', id, action),
  bootData: boot.data,          // data.json 内容（不存在则为 null）
  dataPath: boot.path,          // data.json 完整路径
  existed: !!boot.existed,      // 是否已有数据文件
  topMost: !!boot.topMost,
  flagPatch: boot.flagPatch || {},   // 主进程运行中的提醒标记（防重复提醒）
  saveState: (obj) => ipcRenderer.send("state:save", obj),
  notify: (payload) => ipcRenderer.send("notify", payload),
  revealData: () => ipcRenderer.send("data:reveal"),
  setAlwaysOnTop: (v) => ipcRenderer.invoke("win:top", v),
  hideWindow: () => ipcRenderer.invoke("win:hide"),
  showWindow: () => ipcRenderer.invoke("win:show"),
  /* 单卡钉桌面：切换某张便签的桌面胶囊小窗 */
  toggleCapsulePin: (cardId, rect, title) => ipcRenderer.invoke("capsule:toggle", cardId, rect, title),
  moveCapsule: (cardId, rect) => ipcRenderer.send("capsule:move", cardId, rect),
  /* 胶囊窗口专用：把自身内容高度报给主进程（窗口高度跟随内容） */
  reportCapsuleSize: (cardId, height) => ipcRenderer.send("capsule:size", cardId, height),
  onTopState: (cb) => ipcRenderer.on("top:state", (e, st) => cb(st)),
  onRemind: (cb) => ipcRenderer.on("remind:fired", (e, p) => cb(p)),
  /* 主进程直接改了数据（托盘新建/导入/钉桌面等）→ 推完整 data 给主窗口同步 */
  onExternalData: (cb) => ipcRenderer.on("data:external", (e, obj) => cb(obj)),
  /* 主进程让主窗口执行某个 UI 动作（如 "archive" 打开归档面板） */
  onUIAction: (cb) => ipcRenderer.on("ui:action", (e, a) => cb(a)),
  /* 胶囊窗口专用：主进程推送的最新数据 / 全部取消钉住的通知 */
  onCapsuleData: (cb) => ipcRenderer.on("capsule:data", (e, obj) => cb(obj)),
  onCapsuleUnpinnedAll: (cb) => ipcRenderer.on("capsule:unpinned-all", () => cb())
});
