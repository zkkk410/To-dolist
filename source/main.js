/* 便签待办 · Electron 主进程（省内存版）
   职责：开窗口、读写同目录 data.json、系统通知、窗口置顶、
         「单卡钉桌面」胶囊小窗（半透明+鼠标穿透，只压桌面不挡窗口）、
         托盘与全局快捷键、
         提醒引擎（常驻主进程，窗口销毁后仍可提醒）、
         后台模式（隐藏窗口即销毁渲染进程，只留主进程） */
const { app, BrowserWindow, ipcMain, Notification, shell, Menu, Tray, nativeImage, globalShortcut, screen, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
// Isolated development previews never read or write the user's real task list.
if (process.env.PT_PREVIEW_DIR) {
  fs.mkdirSync(path.join(process.env.PT_PREVIEW_DIR, 'profile'), {recursive:true});
  app.setPath('userData', path.join(process.env.PT_PREVIEW_DIR, 'profile'));
}

let win = null;
let tray = null;
let dataDir = "";
let writeTimer = null;
let pending = null;
let mouseThrough = true;
let positionLocked = false;
let capOpacity = 0.85;       // 桌面胶囊的透明度
let topMost = false;         // 主窗口是否置顶
let lastState = null;        // 最近一次保存的数据（提醒引擎的扫描对象）
let remindTimer = null;
let bgTimer = null;          // 延迟销毁窗口的计时器
let quitting = false;        // 真正退出（托盘退出 / app.quit）
let destroying = false;      // 程序性销毁窗口，不当作“转后台”
const capsules = new Map();  // cardId -> { win, rect }  钉在桌面上的单卡胶囊小窗
const HOTKEY_PIN = "CommandOrControl+Alt+X";
const HOTKEY_SHOW = "CommandOrControl+Alt+S";

/* ---------- 省内存：纯 UI 不需要 GPU 合成，禁掉 GPU 进程（省约 90MB） ---------- */
/* 需要硬件加速时设 PT_GPU=1 */
if (process.env.PT_GPU === "0") {
  try {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-gpu");
  } catch (e) {}
}
/* 兼容模式：受限环境（远程桌面、虚拟机、扁平化沙箱）里运行时可设 PT_SAFE=1 */
if (process.env.PT_SAFE === "1") {
  try {
    app.commandLine.appendSwitch("no-sandbox");
    app.commandLine.appendSwitch("in-process-gpu");
    app.commandLine.appendSwitch("disable-software-rasterizer");
  } catch (e) {}
}

/* ---------- 数据文件位置：优先 exe 同目录（便携版），不可写则退回用户数据目录 ---------- */
function resolveDataDir() {
  const candidates = [];
  if (process.env.PT_PREVIEW_DIR) candidates.push(process.env.PT_PREVIEW_DIR);
  if (process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(process.env.PORTABLE_EXECUTABLE_DIR);
  if (app.isPackaged) candidates.push(path.dirname(app.getPath("exe")));
  candidates.push(path.resolve(__dirname, ".."));       // 开发时：项目根目录
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (e) { /* 试下一个 */ }
  }
  return app.getPath("userData");
}
const dataFile = () => path.join(dataDir, "data.json");

function readData() {
  try { return JSON.parse(fs.readFileSync(dataFile(), "utf8")); }
  catch (e) { return null; }
}

/* 原子写入：先写 .tmp 再改名，避免断电/崩溃写坏数据 */
function flush() {
  if (!pending) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = dataFile() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(pending, null, 2), "utf8");
    fs.renameSync(tmp, dataFile());
  } catch (e) {
    console.error("[data.json 写入失败]", e.message);
  }
  pending = null;
}
function scheduleWrite(obj) {
  pending = obj;
  lastState = obj;                       // 提醒引擎扫描最新数据
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 250);
}

/* ---------- 时间格式化（主进程用） ---------- */
const pad2 = n => String(n).padStart(2, "0");
function fmtDT(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtLeft(ms) {
  if (ms <= 0) return "已到期";
  const h = Math.floor(ms / 3.6e6), m = Math.floor(ms % 3.6e6 / 6e4);
  return h > 0 ? `还剩 ${h}小时${m}分` : `还剩 ${m} 分钟`;
}

/* ---------- 提醒引擎（主进程常驻：进入窗口立即提醒 -> 每小时一次 -> 到期再提醒） ---------- */
function startReminderEngine() {
  if (remindTimer) return;
  remindTimer = setInterval(scanReminders, 15000);
  if (process.env.PT_DEBUG) console.log("[提醒引擎] 已启动（15s 巡检，主进程常驻）");
}
function buildFlagPatch() {
  /* 运行中的最新提醒标记，供新窗口启动时合并，避免重复提醒 */
  const patch = {};
  if (!lastState || !Array.isArray(lastState.papers)) return patch;
  lastState.papers.forEach(p => (p.items || []).forEach(it => {
    if (it.deadline) patch[it.id] = { lastRemind: it.lastRemind || 0, inWindow: !!it.inWindow, dueReminded: !!it.dueReminded };
  }));
  return patch;
}
function scanReminders() {
  if (!lastState || !Array.isArray(lastState.papers)) return;
  const now = Date.now();
  let mutated = false;
  lastState.papers.forEach(paper => {
    (paper.items || []).forEach(item => {
      if (item.done || !item.deadline) return;
      const deadline = item.deadline;
      const winH = item.remindBeforeHours ?? 2;
      const winStart = deadline - winH * 3.6e6;
      const left = deadline - now;

      const fire = (headline, isDue) => {
        const body = `${headline} · 截止 ${fmtDT(deadline)}（来自「${paper.title}」）`;
        if (Notification.isSupported()) {
          try { new Notification({ title: `${isDue ? "已到期" : "待办提醒"}：${item.text}`, body, timeoutType: "never" }).show(); }
          catch (e) {}
        }
        /* 窗口活着就同步到页面（弹卡片 + 蜂鸣），页面会自己落盘 */
        if (win && !win.isDestroyed()) {
          win.webContents.send("remind:fired", {
            id: item.id, text: item.text, card: paper.title,
            headline, isDue, deadline, left,
            lastRemind: item.lastRemind || 0, inWindow: !!item.inWindow, dueReminded: !!item.dueReminded
          });
        }
        if (process.env.PT_DEBUG) console.log("[提醒]", headline, item.text);
      };

      if (now >= deadline && !item.dueReminded) {
        item.dueReminded = true; mutated = true;
        fire("🔴 已到期！", true);
      } else if (now >= winStart && now < deadline) {
        if (!item.inWindow || now - (item.lastRemind || 0) >= 3.6e6 - 60000) {
          item.inWindow = true; item.lastRemind = now; mutated = true;
          fire(`⏰ ${fmtLeft(left)}`, false);
        }
      }
    });
  });
  if (mutated) {
    /* 页面不在时由主进程自己落盘；页面在时会再收到同步事件后保存，两者内容一致 */
    scheduleWrite(lastState);
  }
}

/* ---------- 单卡钉桌面：每张便签一个独立的胶囊小窗 ---------- */
/* 小窗半透明、鼠标可穿透（双击直接落到桌面图标）、不置顶 —— 只压桌面，不挡其他窗口。
   放置策略：统一贴到屏幕右侧边缘、自上而下堆叠。
   为什么不放在便签原位：胶囊必须"非置顶"才不挡别的窗口，而便签本身在主窗口里，
   放在原位就一定被主窗口盖住 → 看起来像没钉上。贴右侧桌面边缘才真的看得见。 */
const CAP_MARGIN = 16, CAP_TOP = 64, CAP_GAP = 12;
function capsuleSlotRect(index, width, height) {
  const base = (win && !win.isDestroyed()) ? win.getBounds() : null;
  const disp = base ? screen.getDisplayMatching(base) : screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const w = Math.max(200, Math.min(Math.round(width || 280), Math.round(wa.width * 0.5)));
  const maxH = Math.round(wa.height * 0.72);
  const h = Math.max(110, Math.min(Math.round(height || 200), maxH));
  const x = wa.x + wa.width - w - CAP_MARGIN;
  let y = wa.y + CAP_TOP + index * (h + CAP_GAP);
  if (y + h > wa.y + wa.height - CAP_MARGIN) {          /* 堆不下就贴着底部对齐，避免跑出屏幕 */
    y = Math.max(wa.y + CAP_TOP, wa.y + wa.height - h - CAP_MARGIN);
  }
  return { x, y, width: w, height: h };
}
function openCapsule(cardId, rect, title) {
  closeCapsule(cardId);
  const r = rect || {};
  const cw = new BrowserWindow({
    x: r.x != null ? r.x : 90,
    y: r.y != null ? r.y : 110,
    width: Math.max(200, Math.round(r.width || 280)),
    height: Math.max(110, Math.round(r.height || 200)),
    frame: false,
    transparent: true,
    resizable: !paperPinned(cardId),
    minWidth: 220,
    minHeight: 110,
    focusable: !paperPinned(cardId),
    movable: !paperPinned(cardId),
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: title || "便签",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  cw.loadFile(path.join(__dirname, "renderer", "capsule.html"), { query: { capsule: cardId } });
  if (process.env.PT_DEBUG) {
    cw.webContents.on("did-fail-load", (e, code, desc) => console.log("[capsule] 加载失败", code, desc));
    cw.webContents.on("console-message", (e, level, msg) => { if (level >= 2) console.log("[capsule]", msg); });
  }
  let revealed = false;
  const reveal = () => {
    if (cw.isDestroyed() || revealed) return;
    revealed = true;
    try {
      applyCapsuleControls(cardId);
      cw.setAlwaysOnTop(topMost);
      cw.showInactive();
      if (process.env.PT_DEBUG) {
        const b = cw.getBounds();
        console.log(`[胶囊] 已钉: ${title || cardId} @ ${b.x},${b.y} ${b.width}x${b.height} visible=${cw.isVisible()} opacity=${cw.getOpacity()} top=${cw.isAlwaysOnTop()}`);
      }
    } catch (e) {
      console.error('[胶囊显示失败]', cardId, e);
      cw.showInactive();
    }
  };
  cw.once("ready-to-show", reveal);
  cw.webContents.once("did-finish-load", () => {
    reveal();
    if (process.argv.includes('--diagnose-capsules')) {
      setTimeout(async () => {
        try {
          const dom = await cw.webContents.executeJavaScript(`JSON.stringify({text:document.body.innerText,rect:document.getElementById('capsule').getBoundingClientRect().toJSON()})`);
          const shot = await cw.webContents.capturePage();
          fs.writeFileSync(path.join(dataDir, 'capsule-' + cardId + '.png'), shot.toPNG());
          fs.appendFileSync(path.join(dataDir, 'capsule-diagnostics.log'), JSON.stringify({id:cardId,visible:cw.isVisible(),bounds:cw.getBounds(),opacity:cw.getOpacity(),dom}) + '\n');
        } catch (err) { console.error('[胶囊诊断失败]', err); }
      }, 1500);
    }
  });
  cw.webContents.on('did-fail-load', (event, code, description) => {
    console.error('[胶囊页面加载失败]', code, description);
    notifySimple('胶囊加载失败', description);
  });
  cw.on("resize",()=>{const c=capsules.get(cardId);if(c)syncPinHandle(c,cardId);});
  cw.on("move",()=>{const c=capsules.get(cardId);if(c)syncPinHandle(c,cardId);});
  cw.on("moved", () => {
    const paper = lastState?.papers?.find(p => p.id === cardId);
    if (paper && !paperPinned(cardId)) {
      const b = cw.getBounds(); paper.desktopX = b.x; paper.desktopY = b.y;
      scheduleWrite(lastState);
    }
  });
  cw.on('will-resize', (event, bounds) => {
    if (paperPinned(cardId)) { event.preventDefault(); return; }
    saveManualBounds(cardId, bounds);
  });
  cw.webContents.on("context-menu", () => { if (!paperPinned(cardId)) buildDesktopMenu(cardId).popup({window: cw}); });
  cw.on("closed", () => {
    const cur = capsules.get(cardId);
    if (cur && cur.win === cw) capsules.delete(cardId);
    updateTrayMenu();
  });
  capsules.set(cardId, { win: cw, rect: r });
  updateTrayMenu();
  return true;
}
function closeCapsule(cardId) {
  const c = capsules.get(cardId);
  if (!c) return false;
  capsules.delete(cardId);
  if(c.pinHandle && !c.pinHandle.isDestroyed())c.pinHandle.destroy();
  try { if (c.win && !c.win.isDestroyed()) c.win.destroy(); } catch (e) {}
  updateTrayMenu();
  return true;
}
function closeAllCapsules() {
  for (const id of [...capsules.keys()]) closeCapsule(id);
}
/* 托盘 / Ctrl+Alt+X：取消全部桌面胶囊（唯一的批量出口，胶囊本身鼠标穿透点不到） */
function unpinAllCapsules() {
  closeAllCapsules();
  if (lastState && Array.isArray(lastState.papers)) {
    lastState.papers.forEach(p => { p.pinnedToDesktop = false; });
  }
  commitExternal();
}
/* 每次保存后对账：该开的开、该关的关（便签被删/取消钉住），
   并统一按"右侧边缘堆叠"重新排布（尺寸变化也在这里跟随） */
function reconcileCapsules(obj, broadcast = true) {
  if (!obj || !Array.isArray(obj.papers)) return;
  const want = [];
  obj.papers.forEach(p => { if (p.pinnedToDesktop) want.push([p.id, p]); });
  const keep = new Set(want.map(x => x[0]));
  for (const id of [...capsules.keys()]) {
    if (!keep.has(id)) closeCapsule(id);
  }
  want.forEach(([id, p], idx) => {
    const rect = paperRect(p, idx);
    if (!Number.isFinite(p.desktopY)) {
      const wa = screen.getDisplayMatching(rect).workArea;
      const before = want.slice(0, idx).reduce((sum, entry) => sum + paperRect(entry[1], 0).height + CAP_GAP, 0);
      rect.y = Math.max(wa.y, Math.min(wa.y + CAP_TOP + before, wa.y + wa.height - rect.height - CAP_MARGIN));
    }
    const cur = capsules.get(id);
    if (!cur) { openCapsule(id, rect, p.title); return; }
    const cw = cur.win;
    if (!cw || cw.isDestroyed()) return;
    applyCapsuleControls(id);
    try {
      const b = cw.getBounds();
      if (b.x !== rect.x || b.y !== rect.y || b.width !== rect.width || b.height !== rect.height) {
        cw.setBounds(rect);
        syncPinHandle(cur,id);
      }
    } catch (e) {}
  });
  if (!broadcast) return;
  capsules.forEach(c => {
    if (c.win && !c.win.isDestroyed()) {
      try { c.win.webContents.send("capsule:data", obj); } catch (e) {}
    }
  });
}
function setCapsuleOpacity(v) {
  capOpacity = v;
  (lastState?.papers || []).forEach(p=>{p.desktopOpacity=v;});
  saveDesktopSettings();
  commitExternal();
}

/* ---------- 主窗口置顶 ---------- */
function setTopMost(on) {
  topMost = !!on;
  capsules.forEach(c => c.win.setAlwaysOnTop(topMost));
  saveDesktopSettings();
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(topMost);
  updateTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send("top:state", { topMost });
  return { topMost };
}

/* ---------- 托盘 ---------- */
function trayIcon() {
  const cands = [
    path.join(__dirname, "build", "icon.png"),
    path.join(process.resourcesPath || "", "app", "build", "icon.png")
  ];
  for (const p of cands) {
    try { if (p && fs.existsSync(p)) { const img = nativeImage.createFromPath(p); if (!img.isEmpty()) return img; } } catch (e) {}
  }
  return nativeImage.createEmpty();
}
/* 主进程直接改数据后的统一收尾：落盘 + 胶囊对账 + 主窗口同步 + 刷新托盘 */
function commitExternal() {
  scheduleWrite(lastState);
  reconcileCapsules(lastState);
  if (win && !win.isDestroyed()) { try { win.webContents.send("data:external", lastState); } catch (e) {} }
  updateTrayMenu();
}
function notifySimple(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body, timeoutType: "default" }).show(); } catch (e) {}
}
/* 首次运行（无 data.json）时生成演示数据：2 张便签，全部钉到桌面，
   让用户双击 exe 后桌面上立刻就有胶囊，而不是一片空白 */
function seedDefaultData() {
  const uid = () => Math.random().toString(16).slice(2).padEnd(12, "0") + Date.now().toString(16).slice(-6);
  const mk = (text) => ({ id: uid(), text, done: false, order: 0, deadline: null,
    remindBeforeHours: 2, lastRemind: 0, inWindow: false, dueReminded: false });
  const p1 = {
    id: uid(), type: "todo", title: "工作计划", color: "#e8864a", x: 70, y: 90, width: 280, height: 340,
    isVisible: true, alwaysOnTop: false, isCollapsed: false, textZoom: 1,
    pinnedToDesktop: true, capsuleSide: "right",
    items: [mk("整理项目资料"), mk("完成本周工作总结")], content: ""
  };
  const p2 = {
    id: uid(), type: "todo", title: "个人", color: "#5a9e6f", x: 420, y: 150, width: 280, height: 340,
    isVisible: true, alwaysOnTop: false, isCollapsed: false, textZoom: 1,
    pinnedToDesktop: true, capsuleSide: "right",
    items: [mk("阅读 20 分钟")], content: ""
  };
  const data = { app: "PaperTodoRemind", version: "1.0.0", savedAt: new Date().toISOString(), papers: [p1, p2], settings: {} };
  scheduleWrite(data);
  return data;
}
/* 有便签但一张都没钉（例如从旧版升级）→ 默认全部钉到桌面，
   否则用户双击后桌面上什么都没有，会误以为没启动、再去双击 */
function ensurePinnedDefault(obj) {
  if (!obj || !Array.isArray(obj.papers)) return;
  obj.papers.forEach(p => { if (p.pinnedToDesktop == null) p.pinnedToDesktop = true; });
}
/* 托盘：新建一张空便签，并打开编辑器让用户填写条目 */
function newPaperFromTray() {
  const COLORS = ["#e8864a", "#5a9e6f", "#6b8cc7", "#b48ec7", "#d98a43", "#c96f6f"];
  const uid = () => Math.random().toString(16).slice(2).padEnd(12, "0") + Date.now().toString(16).slice(-6);
  if (!lastState || typeof lastState !== "object") {
    lastState = { app: "PaperTodoRemind", version: "1.0.0", savedAt: new Date().toISOString(), papers: [], settings: {} };
  }
  if (!Array.isArray(lastState.papers)) lastState.papers = [];
  const n = lastState.papers.length;
  lastState.papers.push({
    id: uid(), type: "todo", title: `待办${n % 9 + 1}`, color: COLORS[n % COLORS.length],
    x: 70 + (n % 4) * 310, y: 100 + Math.floor(n / 4) * 140,
    width: 280, height: 340, isVisible: true, alwaysOnTop: false, isCollapsed: false, textZoom: 1,
    pinnedToDesktop: true, capsuleSide: "right", items: [], content: ""   /* 新建即钉到桌面 */
  });
  commitExternal();
  showMainWindow();   /* 打开编辑器让用户填写条目 */
}
/* 托盘：切换某张便签的钉桌面状态（有则取消、无则创建） */
function togglePinFromTray(cardId) {
  if (!lastState || !Array.isArray(lastState.papers)) return;
  const p = lastState.papers.find(x => x.id === cardId);
  if (!p) return;
  if (capsules.has(cardId)) {
    closeCapsule(cardId);
    p.pinnedToDesktop = false;
  } else {
    openCapsule(cardId, null, p.title);
    p.pinnedToDesktop = true;
  }
  commitExternal();
}
/* 托盘：查看归档（打开编辑器并转到归档面板） */
function viewArchiveFromTray() { buildDesktopMenu().popup(); }
/* 托盘：导出数据到用户选定的位置 */
function exportDataFromTray() {
  flush();
  dialog.showSaveDialog({
    title: "导出数据",
    defaultPath: "便签待办-备份.json",
    filters: [{ name: "JSON", extensions: ["json"] }]
  }).then(res => {
    if (res.canceled || !res.filePath) return;
    try {
      const src = readData() || lastState;
      fs.writeFileSync(res.filePath, JSON.stringify(src, null, 2), "utf8");
      notifySimple("导出成功", res.filePath);
    } catch (e) { console.error("导出失败", e.message); }
  }).catch(() => {});
}
/* 托盘：从用户选定的文件导入数据 */
function importDataFromTray() {
  dialog.showOpenDialog({
    title: "导入数据",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"]
  }).then(res => {
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return;
    try {
      const raw = JSON.parse(fs.readFileSync(res.filePaths[0], "utf8"));
      if (!raw || !Array.isArray(raw.papers)) { notifySimple("导入失败", "不是本应用的 data.json（缺少 papers 字段）"); return; }
      lastState = raw;
      commitExternal();
      notifySimple("导入成功", `共 ${raw.papers.length} 张便签`);
    } catch (e) { notifySimple("导入失败", e.message); }
  }).catch(() => {});
}

function overPinButton(point,b,rect={x:7,y:3.5,width:22,height:22},zoom=1) {
  return point.x>=b.x+rect.x*zoom && point.x<b.x+(rect.x+rect.width)*zoom &&
    point.y>=b.y+rect.y*zoom && point.y<b.y+(rect.y+rect.height)*zoom;
}
function syncPinHandle(c,id){
  if(!paperPinned(id)){
    if(c.pinHandle && !c.pinHandle.isDestroyed())c.pinHandle.destroy();
    c.pinHandle=null;return;
  }
  const r=c.pinRect || {x:7,y:3.5,width:22,height:22},b=c.win.getContentBounds(),z=c.win.webContents.getZoomFactor();
  const rect={x:Math.round(b.x+r.x*z),y:Math.round(b.y+r.y*z),width:Math.max(1,Math.round(r.width*z)),height:Math.max(1,Math.round(r.height*z))};
  if(!c.pinHandle || c.pinHandle.isDestroyed()){
    const handle=new BrowserWindow({...rect,parent:c.win,frame:false,transparent:true,hasShadow:false,
      resizable:false,movable:false,skipTaskbar:true,show:false,focusable:true,minimizable:false,maximizable:false,
      backgroundColor:'#00000000',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
    c.pinHandle=handle;
    handle.once('ready-to-show',()=>{if(!handle.isDestroyed())handle.showInactive();});
    handle.loadFile(path.join(__dirname,'renderer','pin-handle.html'),{query:{capsule:id}});
  }else{
    const old=c.pinHandle.getBounds();
    if(Object.keys(rect).some(k=>old[k]!==rect[k]))c.pinHandle.setBounds(rect);
  }
}
function updatePinHitTest(c,id){
  if(c.win.isDestroyed())return;
  const pinned=paperPinned(id);
  if(c.focusable!==!pinned){c.win.setFocusable(!pinned);c.focusable=!pinned;}
  if(c.ignoring!==pinned){c.win.setIgnoreMouseEvents(pinned,{forward:true});c.ignoring=pinned;}
  syncPinHandle(c,id);
}
function paperPinned(id) {
  return lastState?.papers?.find(p=>p.id===id)?.desktopPinned ?? mouseThrough;
}
function applyCapsuleControls(id) {
  const c=capsules.get(id),p=lastState?.papers?.find(p=>p.id===id);
  if(!c || !p || c.win.isDestroyed()) return;
  const pinned=paperPinned(id),w=c.win;
  const opacity=pinned ? (Number.isFinite(p.desktopOpacity)?p.desktopOpacity:capOpacity) : 1;
  if(c.opacity!==opacity){w.setOpacity(opacity);c.opacity=opacity;}
  if(c.pinned!==pinned){
    w.setMovable(!pinned);
    w.setResizable(!pinned);
    c.pinned=pinned;
  }
  updatePinHitTest(c,id);
}
ipcMain.on('capsule:pin-region',(e,id,rect)=>{
  const c=capsules.get(id);
  if(!c || c.win.webContents!==e.sender || !rect)return;
  if(!['x','y','width','height'].every(k=>Number.isFinite(rect[k])))return;
  if(rect.x<0 || rect.y<0 || rect.x>120 || rect.y>120 || rect.width<=0 || rect.width>96 || rect.height<=0 || rect.height>96)return;
  c.pinRect={x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  updatePinHitTest(c,id);
});
ipcMain.on('capsule:pointer',(e,id)=>{
  const c=capsules.get(id);if(c && c.win.webContents===e.sender)updatePinHitTest(c,id);
});
ipcMain.on('capsule:control',(e,id,action)=>{
  const c=capsules.get(id),p=lastState?.papers?.find(p=>p.id===id);
  if(!c || !p)return;
  const fromHandle=c.pinHandle && !c.pinHandle.isDestroyed() && c.pinHandle.webContents===e.sender;
  if(c.win.webContents!==e.sender && !(fromHandle && action==='pin'))return;
  if(action==='pin')p.desktopPinned=!paperPinned(id);
  else if(action==='close' && !paperPinned(id))p.pinnedToDesktop=false;
  else return;
  commitExternal();
});
function saveDesktopSettings() {
  if (!lastState) return;
  lastState.settings = {...lastState.settings, desktopMouseThrough: mouseThrough,
    desktopPositionLocked: positionLocked, desktopOpacity: capOpacity, desktopTopMost: topMost};
  scheduleWrite(lastState);
}
function setInteraction(through) {
  mouseThrough = through;
  (lastState?.papers || []).forEach(p=>{p.desktopPinned=through;});
  capsules.forEach(({win: w}, id) => {
    applyCapsuleControls(id);
    if (w.isMinimized()) w.restore();
    w.showInactive();
  });
  saveDesktopSettings();
  commitExternal();
}
function saveManualBounds(cardId, bounds) {
  const p = lastState?.papers?.find(p=>p.id===cardId);
  if (!p) return;
  Object.assign(p, {desktopX:bounds.x, desktopY:bounds.y, desktopWidth:bounds.width,
    desktopHeight:bounds.height, desktopManualSize:true});
  scheduleWrite(lastState);
}
const resizeGestures = new Map();
ipcMain.on('capsule:resize', (e, id, phase, edge) => {
  const c=capsules.get(id);
  if (!c || c.win.webContents!==e.sender) return;
  if (phase==='end') { resizeGestures.delete(id); c.win.webContents.send('capsule:data',lastState); return; }
  if (paperPinned(id)) { resizeGestures.delete(id); return; }
  if (phase==='start' && /^(n|s|e|w|ne|nw|se|sw)$/.test(edge)) {
    resizeGestures.set(id,{bounds:c.win.getBounds(),point:screen.getCursorScreenPoint(),edge}); return;
  }
  const g=resizeGestures.get(id); if(!g || phase!=='move') return;
  const point=screen.getCursorScreenPoint(), dx=point.x-g.point.x,dy=point.y-g.point.y;
  const b={...g.bounds}, wa=screen.getDisplayMatching(b).workArea;
  if(g.edge.includes('e')) b.width=Math.max(220,Math.min(wa.width,g.bounds.width+dx));
  if(g.edge.includes('s')) b.height=Math.max(140,Math.min(wa.height,g.bounds.height+dy));
  if(g.edge.includes('w')) {b.width=Math.max(220,Math.min(wa.width,g.bounds.width-dx));b.x=g.bounds.x+g.bounds.width-b.width;}
  if(g.edge.includes('n')) {b.height=Math.max(140,Math.min(wa.height,g.bounds.height-dy));b.y=g.bounds.y+g.bounds.height-b.height;}
  saveManualBounds(id,b); c.win.setBounds(b);
});
function paperRect(p, index) {
  const r = capsuleSlotRect(index, p.pinW, p.desktopHeight || p.pinH);
  if (p.desktopManualSize) {
    const wa = screen.getDisplayMatching({x:p.desktopX || r.x,y:p.desktopY || r.y,width:r.width,height:r.height}).workArea;
    r.width = Math.max(220, Math.min(p.desktopWidth || r.width, wa.width));
    r.height = Math.max(140, Math.min(p.desktopHeight || r.height, wa.height));
  }
  if (Number.isFinite(p.desktopX) && Number.isFinite(p.desktopY)) {
    const wa = screen.getDisplayMatching({x:p.desktopX,y:p.desktopY,width:r.width,height:r.height}).workArea;
    r.x = Math.max(wa.x, Math.min(p.desktopX, wa.x + wa.width - r.width));
    r.y = Math.max(wa.y, Math.min(p.desktopY, wa.y + wa.height - r.height));
  }
  return r;
}
async function deletePaper(cardId) {
  const paper=lastState?.papers?.find(p=>p.id===cardId);
  if(!paper)return;
  const result=await dialog.showMessageBox({type:'warning',title:'删除胶囊',
    message:`删除「${paper.title || '未命名'}」？`,detail:'此胶囊中的待办和归档将一并删除。仅想暂时隐藏请点击右上角 ×。',
    buttons:['取消','删除胶囊'],defaultId:0,cancelId:0,noLink:true});
  if(result.response!==1)return;
  lastState.papers=lastState.papers.filter(p=>p.id!==cardId);
  commitExternal();
}
function buildDesktopMenu(cardId) {
  const papers = lastState?.papers || [];
  const active = papers.flatMap(p => p.items || []).filter(i => !i.done);
  const archive = papers.flatMap(p => (p.items || []).filter(i => i.done).map(i => ({
    label: p.title + ' · ' + i.text, submenu: [{label:'恢复到待办', click:() => {
      i.done=false; delete i.archivedAt; commitExternal();
    }}]
  })));
  const paper = papers.find(p => p.id === cardId);
  const menu = [
    {label:'重新显示全部胶囊',click:restoreCapsules},
    {label:'＋ 新建待办胶囊',click:newPaperFromTray},
    {label:'编辑胶囊',accelerator:HOTKEY_SHOW,click:()=>setInteraction(false)},
    ...(!cardId ? [{label:'胶囊透明度',submenu:[1,.85,.65,.45,.25].map(v=>({label:'不透明度 '+Math.round(v*100)+'%',type:'radio',checked:Math.abs(capOpacity-v)<.01,click:()=>setCapsuleOpacity(v)}))}] : []),
    {label:'胶囊置顶',type:'checkbox',checked:topMost,click:()=>setTopMost(!topMost)},
    {type:'separator'},
    {label:'归档（'+archive.length+'）',submenu:archive.length?archive:[{label:'暂无归档',enabled:false}]},
    {label:'显示在桌面',submenu:papers.length?papers.map(p=>({label:p.title || '未命名',type:'checkbox',checked:!!p.pinnedToDesktop,click:()=>togglePinFromTray(p.id)})):[{label:'暂无胶囊',enabled:false}]},
    {label:'删除胶囊',enabled:papers.length>0,submenu:papers.map(p=>({label:p.title || '未命名',click:()=>deletePaper(p.id)}))},
    {label:'重新排列胶囊',click:()=>{papers.forEach(p=>{delete p.desktopX;delete p.desktopY;});commitExternal();}},
    {type:'separator'},
    {label:'导出数据…',click:exportDataFromTray},
    {label:'导入数据…',click:importDataFromTray},
    {label:'打开 data.json 所在位置',click:()=>shell.showItemInFolder(dataFile())},
    {label:'桌面通知'+(Notification.isSupported()?'可用':'不可用')+' · 待办 '+active.length+' · 定时 '+active.filter(i=>i.deadline).length,enabled:false},
    {type:'separator'},
    {label:'退出（提醒同时停止）',click:()=>{quitting=true;flush();app.quit();}}
  ];
  if(paper) menu.unshift({label:'删除此胶囊…',click:()=>deletePaper(paper.id)},{label:'恢复自动高度',click:()=>{
    paper.desktopManualSize=false; delete paper.desktopWidth;
    commitExternal();
  }},{label:'隐藏此胶囊',click:()=>togglePinFromTray(paper.id)},{type:'separator'});
  return Menu.buildFromTemplate(menu);
}
function updateTrayMenu() { if(tray) tray.setContextMenu(buildDesktopMenu()); }
function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip("便签待办 · 右键菜单操作，Ctrl+Alt+T 切换鼠标穿透");
    /* 单击不响应（避免误触弹大窗口）；双击才打开编辑器 */
    tray.on("double-click", () => showMainWindow());
    updateTrayMenu();
  } catch (e) { console.error("托盘创建失败（不影响使用）", e.message); tray = null; }
}

/* ---------- 窗口生命周期：隐藏即转后台（延迟销毁渲染进程，只留主进程） ---------- */
function restoreCapsules() {
  (lastState?.papers || []).forEach(p => { p.pinnedToDesktop = true; });
  commitExternal();
  capsules.forEach(({win:w}) => {
    if (w.isMinimized()) w.restore();
    w.setAlwaysOnTop(topMost);
    w.showInactive();
  });
}
function showMainWindow() { restoreCapsules(); setInteraction(false); }
function enterBackground() { setInteraction(true); }
function toggleWindow() { setInteraction(!mouseThrough); }

/* ---------- IPC ---------- */
ipcMain.on("state:load", (e) => {
  e.returnValue = {
    data: lastState || readData(), path: dataFile(), existed: fs.existsSync(dataFile()),
    topMost, flagPatch: buildFlagPatch()
  };
});
ipcMain.on("state:save", (e, obj) => {
  if (obj && typeof obj === "object") { scheduleWrite(obj); reconcileCapsules(obj); }
});
ipcMain.on("notify", (e, payload) => {
  try {
    const { title = "待办提醒", body = "" } = payload || {};
    if (Notification.isSupported()) new Notification({ title, body, timeoutType: "never" }).show();
  } catch (err) { console.error("通知失败", err.message); }
});
ipcMain.on("data:reveal", () => { try { shell.showItemInFolder(dataFile()); } catch (e) {} });
ipcMain.handle("win:top", (e, v) => setTopMost(v));
ipcMain.handle("win:hide", () => { enterBackground(); return true; });
ipcMain.handle("win:show", () => { toggleWindow(); return true; });
/* 单卡钉桌面：有则取消、无则创建；位置按"右侧边缘堆叠"计算，返回最新状态供页面同步 */
ipcMain.handle("capsule:toggle", (e, cardId, rect, title) => {
  if (!cardId) return { pinned: false };
  if (capsules.has(cardId)) { closeCapsule(cardId); return { pinned: false }; }
  const idx = capsules.size;      /* 追加到堆叠末尾，避免落在便签原位被主窗口盖住 */
  const slot = capsuleSlotRect(idx, (rect && rect.width) || 280, (rect && rect.height) || 200);
  openCapsule(cardId, slot, title);
  return { pinned: true };
});
ipcMain.on("capsule:move", (e, cardId, rect) => {
  /* 兼容旧调用：位置由"右侧堆叠"统一决定，这里只接受尺寸变化 */
  const c = capsules.get(cardId);
  if (c && c.win && !c.win.isDestroyed() && rect) {
    c.rect = { ...(c.rect || {}), width: rect.width, height: rect.height };
  }
});
/* 胶囊窗口自己量出内容高度后上报 → 窗口高度跟随内容，避免条目被裁掉 */
ipcMain.on("capsule:size", (e, cardId, height) => {
  const c = capsules.get(cardId);
  if (!c || !c.win || c.win.isDestroyed() || !height) return;
  if (c.win.webContents !== e.sender) return;
  const p = lastState?.papers?.find(p => p.id === cardId);
  if (!p || p.desktopManualSize || !Number.isFinite(height)) return;
  p.desktopHeight = Math.max(110, Math.min(height, screen.getPrimaryDisplay().workArea.height * .72));
  const b = c.win.getBounds();
  if (b.height !== Math.round(p.desktopHeight)) {
    c.win.setBounds({...b,height:Math.round(p.desktopHeight)});
    // Resize only; do not rebuild every capsule's DOM during a layout measurement.
    // Updating other windows here used to re-enter the renderer measurement loop.
    reconcileCapsules(lastState, false);
  }

});

/* ---------- 启动 ---------- */
function registerHotkeys() {
  const bind = (acc, fn) => { try { globalShortcut.register(acc, fn); } catch (e) { console.error("快捷键注册失败", acc, e.message); } };
  bind("CommandOrControl+Alt+T", () => setInteraction(!mouseThrough));
  bind(HOTKEY_PIN, () => unpinAllCapsules());   /* Ctrl+Alt+X：取消全部桌面胶囊 */
  bind(HOTKEY_SHOW, () => showMainWindow());    /* Ctrl+Alt+S：打开编辑器 */
}

if (process.env.PT_SELFTEST === "1" || process.argv.includes("selftest")) {
  /* 自检：不开窗口，把结果写到 dataDir/_selftest.json */
  app.whenReady().then(() => {
    dataDir = resolveDataDir();
    const report = { ok: true, exe: process.execPath, dataDir, dataFile: dataFile(), existed: fs.existsSync(dataFile()) };
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "_selftest.json"), JSON.stringify(report, null, 2), "utf8");
    } catch (e) { report.ok = false; report.error = e.message; }
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    /* 已在运行：不再弹大窗口，只提示用户看托盘（避免"双击没反应→再双击→弹出大窗口"） */
    restoreCapsules();
  });
  app.whenReady().then(() => {
    dataDir = resolveDataDir();
    /* 首次运行（无 data.json）→ 生成演示便签并全部钉到桌面，让用户双击即见胶囊 */
    lastState = readData() || seedDefaultData();
    const settings = lastState.settings || {};
    mouseThrough = settings.desktopMouseThrough !== false;
    positionLocked = false;
    lastState.settings = {...settings, desktopPositionLocked:false};
    scheduleWrite(lastState);
    if (settings.desktopLayoutVersion !== 2) {
      positionLocked = false;
      mouseThrough = false;
      lastState.settings = {...settings, desktopLayoutVersion:2, desktopPositionLocked:false, desktopMouseThrough:false};
      scheduleWrite(lastState);
    }
    capOpacity = Number.isFinite(settings.desktopOpacity) ? Math.max(.25,Math.min(1,settings.desktopOpacity)) : .85;
    topMost = !!settings.desktopTopMost;
    ensurePinnedDefault(lastState); /* 有便签但全未钉 → 默认全钉到桌面 */
    console.log("[便签待办] data.json ->", dataFile());
    try { app.setAppUserModelId("com.papertodo.remind"); } catch (e) {}
    createTray();                    /* 无主窗口启动：托盘是唯一控制入口 */
    registerHotkeys();
    startReminderEngine();           /* 主进程常驻：窗口销毁也提醒 */
    reconcileCapsules(lastState);    /* 恢复（首次则新建）桌面胶囊 */
    /* 测试/调试用：加 --open-editor 直接打开编辑器（跳过托盘），正常使用不需要 */
    if (process.argv.includes("--open-editor")) showMainWindow();
    app.on("activate", () => showMainWindow());
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
}

app.on("before-quit", () => { quitting = true; flush(); });
app.on("window-all-closed", () => {
  /* 后台模式：窗口销毁后主进程继续驻留（提醒不断）。
     只有真正退出、或托盘不可用（没有恢复入口）时才结束进程 */
  if (quitting || !tray) { flush(); app.quit(); }
});

ipcMain.on('capsule:edit', (e, cardId, action, value) => {
  const c = capsules.get(cardId);
  if (!c || c.win.webContents !== e.sender) return;
  const p = lastState?.papers?.find(p => p.id === cardId);
  if (!p || paperPinned(cardId)) return;
  if (action === 'title' && typeof value === 'string' && value.trim()) p.title=value.trim().slice(0,120);
  const addText=typeof value==='string'?value:value?.text;
  if (action === 'add' && typeof addText === 'string' && addText.trim()) {
    p.items ||= [];
    p.items.push({id:require('crypto').randomUUID(),text:addText.trim(),done:false,order:p.items.length,
      deadline:Number.isFinite(value?.deadline)?value.deadline:null,remindBeforeHours:Number.isFinite(value?.hours)?Math.max(0,Math.min(168,value.hours)):2,lastRemind:0,inWindow:false,dueReminded:false});
  }
  const item = p.items?.find(i=>i.id===value?.id);
  if (item && action === 'done') {item.done=true;item.archivedAt=Date.now();}
  if (item && action === 'text' && typeof value.text === 'string' && value.text.trim()) item.text=value.text.trim();
  if (item && action === 'deadline' && (value.deadline===null || Number.isFinite(value.deadline))) {
    item.deadline=value.deadline; item.remindBeforeHours=Math.max(0,Math.min(168,Number(value.hours)||0));
    item.lastRemind=0;item.inWindow=false;item.dueReminded=false;
  }
  commitExternal();
});
