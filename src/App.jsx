import { useState, useRef, useEffect, useCallback } from "react";

/* ═══════════════════════════════════════════════
   DESIGN TOKENS
═══════════════════════════════════════════════ */
const C = {
  cream:"#FAF6F1", paper:"#F3EDE3", latte:"#E8D9C5",
  caramel:"#C9965A", espresso:"#2C1810", mocha:"#6B3D2E",
  night:"#1A1F3A", nightAcc:"#5B6EE1", nightSoft:"#2D3460",
  g100:"#F3F4F6", g200:"#E5E7EB", g300:"#D1D5DB",
  g400:"#9CA3AF", g500:"#6B7280", g600:"#4B5563",
  red:"#DC2626", redBg:"#FEF2F2", redLight:"#FCA5A5",
  green:"#059669", greenBg:"#ECFDF5", greenLight:"#6EE7B7",
  amber:"#D97706", amberBg:"#FFFBEB", amberLight:"#FCD34D",
  blue:"#2563EB", blueBg:"#EFF6FF",
};
const SERIF = "'Georgia','Hiragino Mincho ProN',serif";
const SANS  = "'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif";
const TIMECLOCK_URL = "https://attendance.moneyforward.com/my_page";

/* ═══════════════════════════════════════════════
   TIME / SHIFT HELPERS
   OP and CL are sentinel strings prepended to
   every time-select dropdown.
═══════════════════════════════════════════════ */
function genTimes(fromH, toH) {
  const out = [];
  for (let h = fromH; h <= toH; h++)
    for (let m = 0; m < 60; m += 30) {
      if (h === toH && m > 0) break;
      out.push(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`);
    }
  return out;
}
const DAY_TIMES   = ["OP", "CL", ...genTimes(9, 21)];
const NIGHT_TIMES = ["OP", "CL", ...genTimes(16, 22)];

function isSentinel(v) { return v === "OP" || v === "CL"; }

// Returns colour metadata for a time value (OP/CL/HH:MM)
function timeColor(v) {
  if (v === "OP") return { color: C.amber,    bg: C.amberBg, label: "OP" };
  if (v === "CL") return { color: C.blue,     bg: C.blueBg,  label: "CL" };
  return                 { color: C.nightAcc, bg: "#EEF0FF", label: v    };
}

// Display label for a shift entry {start,end}
function shiftLabel(e) {
  if (!e) return "—";
  // Always show start〜end. If start is OP/CL and end is also same sentinel, just show start.
  // If end is different (time or different sentinel), show both.
  if (isSentinel(e.start) && e.start === e.end) return e.start;
  if (isSentinel(e.start)) return `${e.start} 〜 ${e.end}`;
  return `${e.start} 〜 ${e.end}`;
}

function defaultEntry(session) {
  // Default: OP start, CL end (full day), sensible defaults
  return session === "night"
    ? { start: "OP", end: "CL" }
    : { start: "OP", end: "CL" };
}

/* ═══════════════════════════════════════════════
   INITIAL DATA
═══════════════════════════════════════════════ */
// pin:null → triggers first-time setup on first login
// 初期スタッフなし — 管理者が設定画面で追加する
const INIT_STAFF = [];
const SECRET_QUESTIONS = [
  "小学校の名前は？",
  "好きな食べ物は？",
  "生まれた町の名前は？",
  "初めて飼ったペットの名前は？",
  "お気に入りのスポーツは？",
  "好きな花の名前は？",
  "子供の頃のあだ名は？",
];
const HUE = [150, 220, 35, 350, 270, 185, 80, 20];
const sColor = i => `hsl(${HUE[i % HUE.length]},52%,42%)`;
const sBg    = i => `hsl(${HUE[i % HUE.length]},52%,92%)`;

/* ═══════════════════════════════════════════════
   DATE HELPERS
═══════════════════════════════════════════════ */
const daysIn  = (y,m) => new Date(y, m+1, 0).getDate();
const firstOf = (y,m) => new Date(y, m, 1).getDay();
const jpW = d => ["日","月","火","水","木","金","土"][d];
const mkDs = (y,m,d) => `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const fmtDs = ds => { const [,mm,dd] = ds.split("-"); return `${parseInt(mm)}月${parseInt(dd)}日`; };
const nowTime = () => new Date().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"});
const todayStr = () => { const d = new Date(); return mkDs(d.getFullYear(), d.getMonth(), d.getDate()); };

/* ═══════════════════════════════════════════════
   FIREBASE REALTIME DATABASE — 全端末リアルタイム同期
   ログイン不要・URLを送るだけで全員共有
═══════════════════════════════════════════════ */

const FB_URL = "https://cafe-shift-default-rtdb.asia-southeast1.firebasedatabase.app";

// テストモード: true=テスト用DB、false=本番DB
let _testMode = (typeof sessionStorage !== "undefined" && sessionStorage.getItem("cafeTestMode") === "1");
function fbPath(key) {
  return `${FB_URL}/${_testMode ? "cafeshift_test" : "cafeshift"}/${key}.json`;
}

// Firebase REST API でデータを読み書き
async function fbRead(key) {
  try {
    const res = await fetch(fbPath(key));
    if (!res.ok) return undefined;
    const data = await res.json();
    return data === null ? undefined : data;
  } catch { return undefined; }
}

async function fbWrite(key, value) {
  try {
    await fetch(fbPath(key), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value)
    });
  } catch(e) { console.warn("fb write failed", key, e); }
}

// Server-Sent Events でリアルタイム変更を受信
const _setters = {};
const _lastVal = {};

function fbListen(key, cb) {
  // EventSource (SSE) でリアルタイム受信 + フォールバックポーリング
  try {
    const es = new EventSource(fbPath(key));
    es.addEventListener("put", (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d && d.data !== undefined && d.data !== null) {
          const serialized = JSON.stringify(d.data);
          if (serialized !== _lastVal[key]) {
            _lastVal[key] = serialized;
            cb(d.data);
          }
        }
      } catch {}
    });
    es.onerror = () => {
      // SSEが切れたらポーリングにフォールバック
      try { es.close(); } catch {}
    };
    return es;
  } catch { return null; }
}

// フォールバック: 3秒ごとにポーリング（SSEが使えない環境向け）
setInterval(async () => {
  for (const key of Object.keys(_lastVal)) {
    try {
      const res = await fetch(fbPath(key));
      if (!res.ok) continue;
      const data = await res.json();
      if (data === null) continue;
      const serialized = JSON.stringify(data);
      if (serialized !== _lastVal[key]) {
        _lastVal[key] = serialized;
        if (_setterMap && _setterMap[key]) _setterMap[key].forEach(fn => fn(data));
        // 通知データ更新時：新着通知をブラウザ通知として表示
        if (key === "notifs" && Array.isArray(data)) {
          const uid = window._cafeCurrentUserId;
          if (uid !== undefined) {
            data.filter(n => String(n.to)===String(uid) && !n.read && !_shownNotifIds.has(n.id))
              .forEach(n => { _shownNotifIds.add(n.id); showBrowserNotif("☕ Café Shift", n.text||"新しい通知があります"); });
          }
        }
      }
    } catch {}
  }
}, 3000);
const _setterMap = {};

function usePersist(key, initial) {
  const [val, setVal] = useState(initial);

  useEffect(() => {
    // 初回読み込み
    fbRead(key).then(loaded => {
      if (loaded !== undefined) {
        _lastVal[key] = JSON.stringify(loaded);
        setVal(loaded);
      }
    });

    // SSEリスナー登録
    const handler = (fresh) => { if (fresh !== null && fresh !== undefined) setVal(fresh); };
    const es = fbListen(key, handler);

    // ポーリングフォールバック用にも登録
    if (!_setterMap[key]) _setterMap[key] = [];
    _setterMap[key].push(handler);

    return () => {
      if (es) es.close();
      _setterMap[key] = (_setterMap[key]||[]).filter(fn => fn !== handler);
    };
  }, [key]);

  const setAndSave = useCallback((updater) => {
    setVal(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      _lastVal[key] = JSON.stringify(next);
      fbWrite(key, next);
      return next;
    });
  }, [key]);

  return [val, setAndSave];
}

/* ═══════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════ */
export default function App() {
  // ── Viewport lock: prevent pinch-zoom and fix layout ──
  useEffect(() => {
    // Force correct viewport meta (overrides any parent iframe settings)
    let vp = document.querySelector('meta[name="viewport"]');
    if (!vp) { vp = document.createElement("meta"); vp.name = "viewport"; document.head.appendChild(vp); }
    vp.content = "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no";
    const addMeta=(n,c)=>{if(!document.querySelector(`meta[name="${n}"]`)){const m=document.createElement("meta");m.name=n;m.content=c;document.head.appendChild(m);}};
    addMeta("apple-mobile-web-app-capable","yes");
    addMeta("apple-mobile-web-app-status-bar-style","black-translucent");
    addMeta("apple-mobile-web-app-title","Café Shift");
    addMeta("mobile-web-app-capable","yes");
    addMeta("theme-color","#2C1810");

    // Global CSS reset to prevent layout drift
    const style = document.createElement("style");
    style.id = "cafe-shift-global";
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; }
      html, body {
        margin: 0; padding: 0;
        width: 100%; height: 100%;
        overflow-x: hidden;
        -webkit-text-size-adjust: 100%;
        touch-action: manipulation;
      }
      #root { width: 100%; min-height: 100vh; }
      button, input, select, textarea {
        font-size: 16px; /* prevents iOS zoom on focus */
        -webkit-appearance: none;
      }
      button { cursor: pointer; }
    `;
    if (!document.getElementById("cafe-shift-global")) document.head.appendChild(style);
    return () => {}; // keep styles on unmount (app lifetime)
  }, []);

  const [appReady, setAppReady] = useState(false);
  const now = new Date();
  // All state is shared across all devices via Firebase Realtime Database
  const [staff,      setStaff]      = usePersist("staff",      INIT_STAFF);
  const [nightDays,  setNightDays]  = usePersist("nightDays",  {});
  const [deadlines,  setDeadlines]  = usePersist("deadlines",  {});
  const [extensions, setExtensions] = usePersist("extensions", {});
  const [shifts,     setShifts]     = usePersist("shifts",     {});
  const [confirmed,  setConfirmed]  = usePersist("confirmed",  {});
  const [messages,   setMessages]   = usePersist("messages",   []);
  const [helpReqs,   setHelpReqs]   = usePersist("helpReqs",   []);
  const [notifs,     setNotifs]     = usePersist("notifs",     []);
  // absences: [{id, staffId, name, dateStr, session, reason, status:"pending"|"approved"|"rejected"}]
  const [absences,   setAbsences]   = usePersist("absences",   []);
  const [changeReqs, setChangeReqs] = usePersist("changeReqs", []);
  // extReqs: manager→staff extension requests
  // {id, staffId, name, dateStr, session, reqEnd, status:"pending"|"accepted"|"countered"|"confirmed"|"rejected", counterEnd, note}
  const [extReqs,    setExtReqs]    = usePersist("extReqs",    []);
  // subReqs: staff peer substitute requests
  // {id, fromStaffId, fromName, dateStr, session, reason, status:"open"|"accepted"|"rejected", acceptedBy, acceptedByName}
  const [subReqs,    setSubReqs]    = usePersist("subReqs",    []);
  const [year,       setYear]       = usePersist("year",       now.getFullYear());
  const [month,      setMonth]      = usePersist("month",      now.getMonth()+1 < 12 ? now.getMonth()+1 : 0);

  // view & user are session-only (not persisted — intentional: re-login on reload)
  const [view, setView]           = useState("login");
  const [user, setUser]           = useState(null);
  const [setupSummary, setSetupSummary] = useState(null); // {pin,question,answer} — shown once after first setup
  // テストモード: sessionStorageで保持（ログアウトしても消えない）
  const [testMode, setTestMode] = useState(_testMode);
  useEffect(() => {
    sessionStorage.setItem("cafeTestMode", testMode ? "1" : "0");
    _testMode = testMode;
  }, [testMode]);
  const monthKey = `${year}-${String(month+1).padStart(2,"0")}`;

  // Mark app as ready after initial load (≈1s for storage reads)
  useEffect(() => {
    const t = setTimeout(() => setAppReady(true), 1200);
    return () => clearTimeout(t);
  }, []);

  function prevM() { if(month===0){setYear(y=>y-1);setMonth(11);}else setMonth(m=>m-1); }
  function nextM() { if(month===11){setYear(y=>y+1);setMonth(0);}else setMonth(m=>m+1); }

  function loginDone(u) {
    // ブラウザ通知の許可リクエスト
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().then(perm => {
        if (perm === "granted") showBrowserNotif("☕ Café Shift", "通知が有効になりました！");
      });
    }
    if (u.__selfRegister) {
      // Brand new user self-registration: add to staff list then setup
      const newId = staff.length > 0 ? Math.max(...staff.map(s=>s.id)) + 1 : 1;
      const newStaff = {id:newId, name:u.name, pin:u.__setupPIN,
        recoveryQuestion:u.__setupQ, recoveryAnswer:u.__setupA, recoveryCode:null};
      setStaff(prev=>[...prev, newStaff]);
      const clean = {id:newId, name:u.name, role:"staff"};
      setUser(clean);
      setSetupSummary({ pin:u.__setupPIN, question:u.__setupQ, answer:u.__setupA });
      setView("setupDone");
      return;
    }
    if (u.__setupPIN) {
      // First-time: save PIN + secret question/answer
      setStaff(prev => prev.map(s => s.id===u.id
        ? {...s, pin:u.__setupPIN, recoveryQuestion:u.__setupQ, recoveryAnswer:u.__setupA, recoveryCode:null}
        : s));
      const clean = {...u}; delete clean.__setupPIN; delete clean.__setupQ; delete clean.__setupA;
      setUser(clean);
      // Store summary for the confirmation screen (shown once only)
      setSetupSummary({ pin:u.__setupPIN, question:u.__setupQ, answer:u.__setupA });
      setView("setupDone");
      return;
    }
    if (u.__changePIN) {
      // Self-service PIN change — keep secret Q&A intact
      setStaff(prev => prev.map(s => s.id===u.id ? {...s, pin:u.__changePIN} : s));
      const clean = {...u}; delete clean.__changePIN;
      setUser(clean);
      setView("choose");
      return;
    }
    if (u.__unlockRequest) {
      setMessages(prev=>[...prev,{id:Date.now(),from:u.id,to:0,
        text:`🔓【PIN解除依頼】${u.name} さんがPINを忘れています。管理者による解除をお願いします。`,
        ts:new Date().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}),
        read:false, isUnlockReq:true, staffId:u.id}]);
      setNotifs(prev=>[...prev,{id:Date.now(),to:0,type:"unlock",
        text:`🔓 ${u.name} さんからPIN解除依頼`,
        ts:new Date().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}),read:false}]);
      return;
    }
    setUser(u);
    window._cafeCurrentUserId = u.id;
    if (u.role === "admin") setView("admin");
    else setView("choose");
  }
  function logout() { setUser(null); window._cafeCurrentUserId = undefined; setView("login"); }

  const ctx = {
    staff, setStaff, nightDays, setNightDays,
    deadlines, setDeadlines, extensions, setExtensions,
    shifts, setShifts, confirmed, setConfirmed,
    messages, setMessages, helpReqs, setHelpReqs,
    notifs, setNotifs,
    absences, setAbsences,
    changeReqs, setChangeReqs,
    extReqs, setExtReqs,
    subReqs, setSubReqs,
    year, month, monthKey, prevM, nextM, logout,
    testMode, setTestMode,
  };
  function pushNotif(to, type, text) {
    setNotifs(prev=>[...prev,{id:Date.now()+Math.random(),to,type,text,ts:nowTime(),read:false}]);
  }
  // expose pushNotif via ctx
  ctx.pushNotif = pushNotif;

  if (!appReady) return (
    <div style={{position:"fixed",inset:0,
      background:`linear-gradient(155deg,${C.espresso} 0%,${C.mocha} 55%,#3D200E 100%)`,
      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
      <div style={{fontSize:56}}>☕</div>
      <div style={{fontFamily:SERIF,fontSize:28,color:"#fff",letterSpacing:2}}>Café Shift</div>
      <div style={{color:"rgba(255,255,255,0.6)",fontSize:13,fontFamily:SANS}}>データを読み込み中...</div>
      <div style={{width:48,height:4,borderRadius:4,background:"rgba(255,255,255,0.15)",overflow:"hidden",marginTop:4}}>
        <div style={{width:"60%",height:"100%",background:C.caramel,borderRadius:4,
          animation:"slide 1.2s ease-in-out infinite"}}/>
      </div>
      <style>{`@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(200%)}}`}</style>
    </div>
  );

  if (view === "login")     return <Login staff={staff} onLogin={loginDone} testMode={testMode} setTestMode={setTestMode}/>;
  if (view === "setupDone") return <SetupDoneScreen user={user} summary={setupSummary} onOk={()=>{ setSetupSummary(null); setView("choose"); }} />;
  if (view === "choose")    return <ChooseAction user={user} onShift={()=>setView("staff")} onLogout={logout} testMode={testMode}/>;
  if (view === "staff")     return <StaffApp user={user} ctx={ctx} />;
  if (view === "admin")     return <AdminApp ctx={ctx} />;
}

/* ═══════════════════════════════════════════════
   LOGIN  — steps: select | setup | pin | change | recovery | recoverNew | adminUnlock
═══════════════════════════════════════════════ */
function Login({ staff, onLogin, testMode=false, setTestMode=()=>{} }) {
  const [step,    setStep]   = useState("select");
  const [chosen,  setChosen] = useState(null);
  const [isAdmin, setIsAdmin]= useState(false);
  // Self-registration fields
  const [regFamily, setRegFamily] = useState("");
  const [regGiven,  setRegGiven]  = useState("");
  const [pin,     setPin]    = useState("");
  const [newPin1, setNewPin1]= useState("");
  const [newPin2, setNewPin2]= useState("");
  const [setupQ,  setSetupQ] = useState(SECRET_QUESTIONS[0]);
  const [setupA,  setSetupA] = useState("");
  const [recAns,  setRecAns] = useState("");
  const [unlockReqSent, setUnlockReqSent] = useState(false);
  const [err,     setErr]    = useState("");
  const [target,  setTarget] = useState("pin"); // which 4-digit field is active

  function goSelect()  { setStep("select"); setPin(""); setNewPin1(""); setNewPin2(""); setErr(""); setTarget("pin"); setRegFamily(""); setRegGiven(""); }
  function pickAdmin() { setIsAdmin(true);  setChosen(null); setPin(""); setErr(""); setStep("pin"); setTarget("pin"); }
  function handleRegNameNext() {
    const name = [regFamily.trim(), regGiven.trim()].filter(Boolean).join(" ");
    if (!name) { setErr("お名前を入力してください"); return; }
    setErr("");
    // Go to PIN setup (chosen=null signals self-registration)
    setStep("setup"); setTarget("newPin1"); setNewPin1(""); setNewPin2("");
  }
  function pickStaff(s) {
    setIsAdmin(false); setChosen(s); setPin(""); setErr("");
    setNewPin1(""); setNewPin2("");
    // First time: no PIN set → go to setup
    if (!s.pin) { setStep("setup"); setSetupQ(SECRET_QUESTIONS[0]); setSetupA(""); setTarget("newPin1"); }
    else         { setStep("pin"); setTarget("pin"); }
  }

  function tapDigit(d) {
    const map = { pin:[pin,setPin], newPin1:[newPin1,setNewPin1], newPin2:[newPin2,setNewPin2] };
    const [val, setter] = map[target]||map.pin;
    if (val.length >= 4) return;
    const next = val + d;
    setter(next);
    if (next.length === 4) {
      if (target === "pin") {
        setTimeout(() => attemptLogin(next), 120);
      } else if (target === "newPin1") {
        // Auto-advance to confirmation step
        setTimeout(() => { setTarget("newPin2"); setNewPin2(""); setErr(""); }, 200);
      }
      // newPin2: user taps confirm button (or auto for change/recover flows handled below)
    }
  }
  function tapBack() {
    const map = { pin:setPin, newPin1:setNewPin1, newPin2:setNewPin2 };
    (map[target]||setPin)(v=>v.slice(0,-1)); setErr("");
  }
  function currentVal() { return target==="newPin1"?newPin1:target==="newPin2"?newPin2:pin; }

  function attemptLogin(p) {
    const expected = isAdmin ? "0000" : chosen?.pin;
    if (p===expected) {
      if (isAdmin) onLogin({id:0,name:"管理者",role:"admin"});
      else onLogin({...chosen,role:"staff"});
    } else { setErr("PINが違います"); setPin(""); }
  }

  // ── First-time Setup ──
  function submitSetup() {
    if (newPin1.length < 4) { setErr("4桁のPINを入力してください"); return; }
    if (newPin1 !== newPin2) { setErr("PINが一致しません"); setNewPin2(""); setTarget("newPin2"); return; }
    const ans = setupA.trim();
    if (!ans || !/^[\u3041-\u3096]+$/.test(ans)) { setErr("ひらがなのみで入力してください"); return; }
    if (chosen) {
      // Existing staff first-time setup
      onLogin({ ...chosen, role:"staff", __setupPIN: newPin1, __setupQ: setupQ, __setupA: ans });
    } else {
      // Self-registration: new user
      const name = [regFamily.trim(), regGiven.trim()].filter(Boolean).join(" ");
      onLogin({ name, role:"staff", __setupPIN: newPin1, __setupQ: setupQ, __setupA: ans, __selfRegister: true });
    }
  }

  // ── PIN Change ──
  function startChange() { setNewPin1(""); setNewPin2(""); setErr(""); setStep("change"); setTarget("newPin1"); }
  function submitChange() {
    if (newPin1.length < 4) { setErr("新しいPINを4桁入力してください"); return; }
    if (newPin1 !== newPin2) { setErr("PINが一致しません"); setNewPin2(""); setTarget("newPin2"); return; }
    onLogin({ ...chosen, role:"staff", __changePIN: newPin1 });
  }

  // ── Recovery ──
  function startRecovery() { setStep("recovery"); setRecAns(""); setErr(""); setUnlockReqSent(false); }
  function submitRecovery() {
    const ans = recAns.trim();
    const expected = (chosen?.recoveryAnswer||"").trim();
    if (ans===expected) { setStep("recoverNew"); setNewPin1(""); setNewPin2(""); setErr(""); setTarget("newPin1"); }
    else { setErr("答えが違います"); }
  }
  function submitRecoverNew() {
    if (newPin1.length < 4) { setErr("4桁入力してください"); return; }
    if (newPin1 !== newPin2) { setErr("PINが一致しません"); setNewPin2(""); setTarget("newPin2"); return; }
    onLogin({ ...chosen, role:"staff", __changePIN: newPin1 });
  }
  function sendUnlockRequest() {
    onLogin({ ...chosen, role:"staff", __unlockRequest: true });
    setUnlockReqSent(true);
  }

  // Shared PIN dots + numpad
  const pinDots = (val) => (
    <div style={{display:"flex",justifyContent:"center",gap:14,margin:"14px 0 6px"}}>
      {[0,1,2,3].map(i=>(
        <div key={i} style={{width:16,height:16,borderRadius:"50%",
          background:val.length>i?C.espresso:C.g200,transition:"background 0.15s"}}/>
      ))}
    </div>
  );
  const numpad = (
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginTop:6}}>
      {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d,i)=>(
        <button key={i} onClick={()=>d==="⌫"?tapBack():d!==""?tapDigit(d):null}
          style={{padding:"15px",borderRadius:12,border:`1px solid ${C.latte}`,
            background:d===""?"transparent":d==="⌫"?C.paper:"#fff",
            fontSize:20,fontWeight:600,cursor:d===""?"default":"pointer",
            color:d==="⌫"?C.g500:C.espresso,fontFamily:SANS,
            visibility:d===""?"hidden":"visible"}}>{d}</button>
      ))}
    </div>
  );

  return (
    <div style={{position:"fixed",inset:0,
      background:`linear-gradient(155deg,${C.espresso} 0%,${C.mocha} 55%,#3D200E 100%)`,
      display:"flex",alignItems:"center",justifyContent:"center",
      padding:"16px",fontFamily:SANS,overflowY:"auto"}}>
      <div style={{position:"fixed",top:-60,right:-60,width:280,height:280,borderRadius:"50%",border:"1px solid rgba(201,150,90,0.12)",pointerEvents:"none"}}/>
      <div style={{position:"fixed",bottom:-80,left:-80,width:320,height:320,borderRadius:"50%",border:"1px solid rgba(201,150,90,0.08)",pointerEvents:"none"}}/>

      <div style={{background:"rgba(250,246,241,0.97)",borderRadius:24,padding:"28px 24px",
        width:"100%",maxWidth:400,boxShadow:"0 32px 80px rgba(0,0,0,0.45)",
        maxHeight:"calc(100vh - 32px)",overflowY:"auto",position:"relative",zIndex:1}}>

        {/* ── SELECT ── */}
        {step==="select" && (<>
          <div style={{textAlign:"center",marginBottom:24}}>
            <div style={{fontSize:46,lineHeight:1}}>☕</div>
            <h1 style={{fontFamily:SERIF,fontSize:27,fontWeight:400,color:C.espresso,margin:"8px 0 4px",letterSpacing:2}}>Café Shift</h1>
            <p style={{color:C.g400,fontSize:13,margin:0}}>シフト管理アプリ</p>
          </div>
          <Btn variant="primary" full onClick={pickAdmin} style={{marginBottom:16,justifyContent:"center"}}>🔑 管理者としてログイン</Btn>
          <Divider label="スタッフ"/>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:12}}>
            {staff.map((s,i)=>(
              <button key={s.id} onClick={()=>pickStaff(s)}
                style={{display:"flex",alignItems:"center",gap:12,padding:"11px 16px",borderRadius:12,
                  border:`1px solid ${C.latte}`,background:C.cream,cursor:"pointer",fontFamily:SANS,color:C.espresso,fontSize:14,fontWeight:500}}>
                <Avatar name={s.name} idx={i} size={32}/>
                <span style={{flex:1}}>{s.name}</span>
                {!s.pin && <span style={{fontSize:10,color:C.amber,fontFamily:SANS}}>初回設定</span>}
              </button>
            ))}
            {/* 新規登録 */}
            <button onClick={()=>{ setChosen(null); setNewPin1(""); setNewPin2(""); setSetupA(""); setSetupQ(SECRET_QUESTIONS[0]); setErr(""); setTarget("newName"); setStep("register"); }}
              style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"11px 16px",
                borderRadius:12,border:`2px dashed ${C.caramel}`,background:"transparent",
                cursor:"pointer",fontFamily:SANS,color:C.caramel,fontSize:14,fontWeight:600}}>
              ＋ 新規登録
            </button>
          </div>
        </>)}

        {/* ── FIRST-TIME SETUP ── */}
        {step==="setup" && (<>
          <button onClick={goSelect} style={backBtn}>← 戻る</button>
          <div style={{textAlign:"center",marginBottom:16}}>
            {chosen
              ? <Avatar name={chosen.name} idx={staff.findIndex(s=>s.id===chosen.id)} size={52}/>
              : <div style={{fontSize:48,lineHeight:1}}>🔐</div>}
            <div style={{fontFamily:SERIF,fontSize:19,color:C.espresso,marginTop:8}}>
              {chosen ? chosen.name : [regFamily,regGiven].filter(Boolean).join(" ")}
            </div>
            <div style={{color:C.g400,fontSize:12,marginTop:2}}>PINと秘密の質問を登録してください</div>
          </div>

          {/* Step 1: new PIN — auto-advances on 4 digits */}
          {target==="newPin1" && (<>
            <div style={{textAlign:"center",fontSize:13,color:C.g500,fontFamily:SANS}}>
              新しいPINを入力（4桁）
            </div>
            {pinDots(newPin1)}
            {err && <ErrMsg>{err}</ErrMsg>}
            {numpad}
            <div style={{textAlign:"center",fontSize:11,color:C.g400,fontFamily:SANS,marginTop:8}}>
              4桁入力すると自動で次へ進みます
            </div>
          </>)}

          {/* Step 2: confirm PIN — with back button + live mismatch */}
          {target==="newPin2" && (<>
            <div style={{textAlign:"center",fontSize:13,color:C.g500,fontFamily:SANS}}>
              もう一度入力して確認
            </div>
            <div style={{textAlign:"center",fontSize:11,color:C.g400,fontFamily:SANS,marginTop:2}}>
              最初に入力したPINと同じ番号を入れてください
            </div>
            {pinDots(newPin2)}
            {newPin2.length===4 && newPin2!==newPin1
              ? <ErrMsg>PINが一致しません ✕</ErrMsg>
              : newPin2.length===4 && newPin2===newPin1
                ? <div style={{textAlign:"center",color:C.green,fontSize:13,fontFamily:SANS,margin:"4px 0"}}>✓ 一致しています</div>
                : err ? <ErrMsg>{err}</ErrMsg> : null
            }
            {numpad}
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>{setTarget("newPin1");setNewPin1("");setNewPin2("");setErr("");}}
                style={{flex:1,padding:"12px",border:`1px solid ${C.latte}`,borderRadius:11,
                  background:"#fff",color:C.g500,fontSize:13,cursor:"pointer",fontFamily:SANS}}>
                ← 入力し直す
              </button>
              <Btn variant="primary" onClick={()=>{
                if(newPin2.length<4){setErr("4桁入力してください");return;}
                if(newPin1!==newPin2){setErr("PINが一致しません");setNewPin2("");return;}
                setTarget("setupQ");setErr("");
              }} style={{flex:2,justifyContent:"center"}}>確定 →</Btn>
            </div>
          </>)}

          {/* Step 3: secret question & answer */}
          {target==="setupQ" && (<>
            <div style={{fontSize:13,fontWeight:700,color:C.espresso,fontFamily:SANS,marginBottom:8}}>秘密の質問を選択</div>
            {SECRET_QUESTIONS.map(q=>(
              <button key={q} onClick={()=>setSetupQ(q)} style={{
                display:"block",width:"100%",padding:"10px 14px",borderRadius:10,marginBottom:6,
                border:`1.5px solid ${setupQ===q?C.caramel:C.latte}`,
                background:setupQ===q?`${C.caramel}15`:"#fff",
                fontFamily:SANS,fontSize:13,color:setupQ===q?C.mocha:C.g600,
                textAlign:"left",cursor:"pointer",fontWeight:setupQ===q?700:400,
              }}>{q}</button>
            ))}
            <div style={{marginTop:10}}>
              <div style={{fontSize:12,color:C.g500,fontFamily:SANS,marginBottom:6}}>答え（ひらがなのみ）</div>
              <input style={{...inputSt,width:"100%",boxSizing:"border-box"}}
                placeholder="例：さくら"
                value={setupA} onChange={e=>setSetupA(e.target.value)}/>
            </div>
            {err && <ErrMsg>{err}</ErrMsg>}
            <Btn variant="primary" full onClick={submitSetup} style={{marginTop:12,justifyContent:"center"}}>
              設定を完了する
            </Btn>
          </>)}
        </>)}

        {/* ── NEW USER REGISTRATION ── */}
        {step==="register" && (<>
          <button onClick={goSelect} style={backBtn}>← 戻る</button>
          <div style={{textAlign:"center",marginBottom:16}}>
            <div style={{fontSize:36,lineHeight:1,marginBottom:8}}>👋</div>
            <div style={{fontFamily:SERIF,fontSize:20,color:C.espresso,marginBottom:4}}>はじめまして！</div>
            <div style={{color:C.g400,fontSize:13}}>お名前を入力してください</div>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:10}}>
            <div style={{flex:1}}>
              <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginBottom:4}}>姓（苗字）</div>
              <input style={{...inputSt,width:"100%",boxSizing:"border-box",fontSize:16}}
                placeholder="例：田中" autoFocus
                value={regFamily} onChange={e=>setRegFamily(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&document.getElementById("regGivenInput")?.focus()}/>
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginBottom:4}}>名（名前）</div>
              <input id="regGivenInput" style={{...inputSt,width:"100%",boxSizing:"border-box",fontSize:16}}
                placeholder="例：葵"
                value={regGiven} onChange={e=>setRegGiven(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&handleRegNameNext()}/>
            </div>
          </div>
          {(regFamily||regGiven)&&(
            <div style={{fontSize:13,color:C.g500,fontFamily:SANS,marginBottom:8}}>
              表示名：<strong style={{color:C.espresso}}>{[regFamily,regGiven].filter(Boolean).join(" ")}</strong>
            </div>
          )}
          {err && <ErrMsg>{err}</ErrMsg>}
          <Btn variant="primary" full onClick={handleRegNameNext}
            disabled={!regFamily.trim()&&!regGiven.trim()}
            style={{justifyContent:"center",marginTop:4}}>
            次へ →
          </Btn>
        </>)}

        {/* ── PIN ENTRY ── */}
        {step==="pin" && (<>
          <button onClick={goSelect} style={backBtn}>← 戻る</button>
          <div style={{textAlign:"center",marginBottom:4}}>
            {!isAdmin&&chosen&&<Avatar name={chosen.name} idx={staff.findIndex(s=>s.id===chosen.id)} size={50}/>}
            <div style={{fontFamily:SERIF,fontSize:20,color:C.espresso,marginTop:isAdmin?0:8,marginBottom:4}}>{isAdmin?"管理者":chosen?.name}</div>
            <div style={{color:C.g400,fontSize:13}}>PINを入力してください</div>
          </div>
          {pinDots(pin)}
          {err && <ErrMsg>{err}</ErrMsg>}
          {numpad}
          {!isAdmin && (<>
            <button onClick={startChange} style={{width:"100%",marginTop:14,padding:"9px",border:"none",background:"none",
              color:C.caramel,fontSize:13,cursor:"pointer",fontFamily:SANS,textDecoration:"underline"}}>
              PINを変更する
            </button>
            <button onClick={startRecovery} style={{width:"100%",marginTop:2,padding:"6px",border:"none",background:"none",
              color:C.g400,fontSize:12,cursor:"pointer",fontFamily:SANS,textDecoration:"underline"}}>
              PINを忘れた場合
            </button>
          </>)}
        </>)}

        {/* ── PIN CHANGE ── */}
        {step==="change" && (<>
          <button onClick={()=>{setStep("pin");setTarget("pin");setPin("");setErr("");}} style={backBtn}>← 戻る</button>
          <div style={{textAlign:"center",marginBottom:8}}>
            <div style={{fontFamily:SERIF,fontSize:18,color:C.espresso}}>PINを変更</div>
            <div style={{color:C.g400,fontSize:13}}>{chosen?.name}</div>
          </div>
          {target==="newPin1" && (<>
            <div style={{textAlign:"center",fontSize:13,color:C.g500,fontFamily:SANS,marginTop:10}}>新しいPINを入力（4桁）</div>
            {pinDots(newPin1)}{err&&<ErrMsg>{err}</ErrMsg>}{numpad}
            <div style={{textAlign:"center",fontSize:11,color:C.g400,fontFamily:SANS,marginTop:8}}>
              4桁入力すると自動で次へ進みます
            </div>
          </>)}
          {target==="newPin2" && (<>
            <div style={{textAlign:"center",fontSize:13,color:C.g500,fontFamily:SANS,marginTop:10}}>もう一度入力して確認</div>
            {pinDots(newPin2)}
            {newPin2.length===4 && newPin2!==newPin1
              ? <ErrMsg>PINが一致しません ✕</ErrMsg>
              : newPin2.length===4 && newPin2===newPin1
                ? <div style={{textAlign:"center",color:C.green,fontSize:13,fontFamily:SANS,margin:"4px 0"}}>✓ 一致しています</div>
                : err?<ErrMsg>{err}</ErrMsg>:null
            }
            {numpad}
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>{setTarget("newPin1");setNewPin1("");setNewPin2("");setErr("");}}
                style={{flex:1,padding:"12px",border:`1px solid ${C.latte}`,borderRadius:11,
                  background:"#fff",color:C.g500,fontSize:13,cursor:"pointer",fontFamily:SANS}}>
                ← 入力し直す
              </button>
              <Btn variant="primary" onClick={submitChange} style={{flex:2,justifyContent:"center"}}>変更を確定</Btn>
            </div>
          </>)}
        </>)}

        {/* ── RECOVERY ── */}
        {step==="recovery" && (<>
          <button onClick={()=>{setStep("pin");setTarget("pin");setErr("");}} style={backBtn}>← 戻る</button>
          <div style={{textAlign:"center",marginBottom:16}}>
            <div style={{fontFamily:SERIF,fontSize:18,color:C.espresso,marginBottom:4}}>PIN リカバリー</div>
            <div style={{fontSize:13,color:C.g500,fontFamily:SANS}}>秘密の質問に答えてください</div>
          </div>
          {chosen?.recoveryQuestion ? (<>
            <div style={{background:C.paper,borderRadius:12,padding:"12px 16px",marginBottom:12,
              fontSize:14,fontWeight:600,color:C.espresso,fontFamily:SANS}}>
              {chosen.recoveryQuestion}
            </div>
            <input style={{...inputSt,width:"100%",boxSizing:"border-box",marginBottom:8}}
              placeholder="ひらがなで答えを入力"
              value={recAns} onChange={e=>setRecAns(e.target.value)}/>
            {err && <ErrMsg>{err}</ErrMsg>}
            <Btn variant="primary" full onClick={submitRecovery} style={{justifyContent:"center"}}>確認</Btn>
            <div style={{marginTop:12,padding:"1px 0",borderTop:`1px solid ${C.latte}`}}/>
            <div style={{fontSize:12,color:C.g400,textAlign:"center",fontFamily:SANS,marginTop:10}}>
              どうしても分からない場合
            </div>
            {!unlockReqSent
              ?<button onClick={sendUnlockRequest} style={{width:"100%",marginTop:6,padding:"10px",
                border:`1px solid ${C.redLight}`,borderRadius:10,background:C.redBg,
                color:C.red,fontSize:13,cursor:"pointer",fontFamily:SANS}}>
                管理者にPIN解除を依頼する
              </button>
              :<div style={{marginTop:8,background:C.greenBg,borderRadius:10,padding:"10px 14px",
                fontSize:12,color:C.green,textAlign:"center",fontFamily:SANS}}>
                ✅ 管理者に解除依頼を送信しました
              </div>
            }
          </>) : (
            <div style={{fontSize:13,color:C.g400,fontFamily:SANS,textAlign:"center",padding:"20px 0"}}>
              秘密の質問が設定されていません。<br/>管理者に問い合わせてください。
            </div>
          )}
        </>)}

        {/* ── RECOVER NEW PIN ── */}
        {step==="recoverNew" && (<>
          <div style={{textAlign:"center",marginBottom:8}}>
            <div style={{fontFamily:SERIF,fontSize:18,color:C.espresso}}>新しいPINを設定</div>
          </div>
          {target==="newPin1" && (<>
            <div style={{textAlign:"center",fontSize:13,color:C.g500,fontFamily:SANS,marginTop:10}}>新しいPINを入力（4桁）</div>
            {pinDots(newPin1)}{err&&<ErrMsg>{err}</ErrMsg>}{numpad}
            <div style={{textAlign:"center",fontSize:11,color:C.g400,fontFamily:SANS,marginTop:8}}>
              4桁入力すると自動で次へ進みます
            </div>
          </>)}
          {target==="newPin2" && (<>
            <div style={{textAlign:"center",fontSize:13,color:C.g500,fontFamily:SANS,marginTop:10}}>もう一度入力して確認</div>
            {pinDots(newPin2)}
            {newPin2.length===4 && newPin2!==newPin1
              ? <ErrMsg>PINが一致しません ✕</ErrMsg>
              : newPin2.length===4 && newPin2===newPin1
                ? <div style={{textAlign:"center",color:C.green,fontSize:13,fontFamily:SANS,margin:"4px 0"}}>✓ 一致しています</div>
                : err?<ErrMsg>{err}</ErrMsg>:null
            }
            {numpad}
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>{setTarget("newPin1");setNewPin1("");setNewPin2("");setErr("");}}
                style={{flex:1,padding:"12px",border:`1px solid ${C.latte}`,borderRadius:11,
                  background:"#fff",color:C.g500,fontSize:13,cursor:"pointer",fontFamily:SANS}}>
                ← 入力し直す
              </button>
              <Btn variant="primary" onClick={submitRecoverNew} style={{flex:2,justifyContent:"center"}}>保存して完了</Btn>
            </div>
          </>)}
        </>)}

      {/* ── テストモード切替（全ステップ共通・常時表示） ── */}
      <div style={{marginTop:16,paddingTop:14,borderTop:`1px solid ${C.latte}`}}>
        <button onClick={()=>setTestMode(!testMode)}
          style={{width:"100%",padding:"11px",borderRadius:10,cursor:"pointer",fontFamily:SANS,
            fontSize:13,fontWeight:700,
            border:`2px solid ${testMode?"#F97316":"#D1D5DB"}`,
            background:testMode?"#FFF7ED":"transparent",
            color:testMode?"#F97316":"#9CA3AF",
            display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          🧪 テストモード
          <span style={{fontSize:11,padding:"2px 8px",borderRadius:10,
            background:testMode?"#F97316":"#E5E7EB",
            color:testMode?"#fff":"#6B7280",fontWeight:700}}>
            {testMode?"ON":"OFF"}
          </span>
        </button>
        {testMode&&(
          <div style={{marginTop:8,padding:"8px 12px",borderRadius:8,background:"#FFF7ED",
            border:"1px solid #FED7AA",fontSize:12,color:"#9A3412",fontFamily:SANS,textAlign:"center"}}>
            ⚠️ テストモード中 — 本番データに影響しません
          </div>
        )}
      </div>

      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SETUP DONE — shown once after first-time PIN setup
═══════════════════════════════════════════════ */
function SetupDoneScreen({ user, summary, onOk }) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div style={{position:"fixed",inset:0,
      background:`linear-gradient(155deg,${C.espresso} 0%,${C.mocha} 55%,#3D200E 100%)`,
      display:"flex",alignItems:"center",justifyContent:"center",
      padding:"16px",fontFamily:SANS}}>
      <div style={{background:"rgba(250,246,241,0.97)",borderRadius:24,padding:"32px 24px",
        width:"100%",maxWidth:400,boxShadow:"0 32px 80px rgba(0,0,0,0.45)"}}>

        {/* Header */}
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{fontSize:44,lineHeight:1}}>✅</div>
          <h2 style={{fontFamily:SERIF,fontSize:22,fontWeight:400,color:C.espresso,
            margin:"12px 0 4px"}}>設定が完了しました</h2>
          <p style={{color:C.g400,fontSize:13,margin:0}}>{user?.name} さん、以下の内容を保管してください</p>
        </div>

        {/* PIN card */}
        <div style={{background:`linear-gradient(135deg,${C.espresso},${C.mocha})`,
          borderRadius:16,padding:"18px 20px",marginBottom:12}}>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.6)",fontFamily:SANS,marginBottom:6}}>
            🔐 あなたのPINコード
          </div>
          <div style={{display:"flex",justifyContent:"center",gap:12,margin:"4px 0 8px"}}>
            {(summary?.pin||"").split("").map((d,i)=>(
              <div key={i} style={{width:44,height:52,borderRadius:10,
                background:"rgba(255,255,255,0.15)",
                display:"flex",alignItems:"center",justifyContent:"center",
                fontFamily:SERIF,fontSize:26,fontWeight:400,color:"#fff"}}>
                {d}
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",textAlign:"center",fontFamily:SANS}}>
            ※ 他の人には絶対に教えないでください
          </div>
        </div>

        {/* Secret Q&A card */}
        <div style={{background:C.paper,borderRadius:14,padding:"16px 18px",marginBottom:20,
          border:`1px solid ${C.latte}`}}>
          <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginBottom:8}}>🔑 秘密の質問と答え</div>
          <div style={{fontWeight:600,fontSize:14,color:C.espresso,fontFamily:SANS,marginBottom:6}}>
            Q. {summary?.question}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:12,color:C.g500,fontFamily:SANS}}>A.</span>
            <span style={{fontWeight:700,fontSize:16,color:C.mocha,fontFamily:SANS,
              letterSpacing:1,borderBottom:`2px dashed ${C.caramel}`,paddingBottom:2}}>
              {summary?.answer}
            </span>
          </div>
          <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginTop:8}}>
            ※ PINを忘れた際にこの答えで本人確認します
          </div>
        </div>

        {/* Warning */}
        <div style={{background:C.amberBg,borderRadius:10,padding:"10px 14px",marginBottom:20,
          border:`1px solid ${C.amberLight}`,fontSize:12,color:C.amber,fontFamily:SANS,lineHeight:1.6}}>
          ⚠️ この画面は<b>初回のみ</b>表示されます。<br/>
          スクリーンショットを撮るか、メモに控えてください。
        </div>

        {/* Confirm checkbox */}
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,cursor:"pointer"}}
          onClick={()=>setConfirmed(v=>!v)}>
          <div style={{width:22,height:22,borderRadius:6,border:`2px solid ${confirmed?C.green:C.g300}`,
            background:confirmed?C.green:"#fff",display:"flex",alignItems:"center",justifyContent:"center",
            flexShrink:0,transition:"all 0.15s"}}>
            {confirmed&&<span style={{color:"#fff",fontSize:14,lineHeight:1}}>✓</span>}
          </div>
          <span style={{fontSize:13,color:C.g600,fontFamily:SANS}}>内容を確認し、保管しました</span>
        </div>

        <button onClick={onOk} disabled={!confirmed}
          style={{width:"100%",padding:"15px",borderRadius:13,border:"none",
            background:confirmed?`linear-gradient(135deg,${C.espresso},${C.mocha})`:`${C.g200}`,
            color:confirmed?"#fff":C.g400,fontSize:15,fontWeight:700,cursor:confirmed?"pointer":"not-allowed",
            fontFamily:SANS,transition:"all 0.2s"}}>
          OK、アプリを使い始める →
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   CHOOSE ACTION  (after staff login)
═══════════════════════════════════════════════ */
function ChooseAction({ user, onShift, onLogout, testMode }) {
  const si = INIT_STAFF.findIndex(s => s.id === user.id); // approximate index for color

  return (
    <div style={{position:"fixed",inset:0,
      background:`linear-gradient(155deg,${C.espresso} 0%,${C.mocha} 55%,#3D200E 100%)`,
      display:"flex",alignItems:"center",justifyContent:"center",padding:"16px",fontFamily:SANS}}>
      <div style={{background:"rgba(250,246,241,0.97)",borderRadius:24,padding:"32px 24px",
        width:"100%",maxWidth:400,boxShadow:"0 32px 80px rgba(0,0,0,0.45)",
        maxHeight:"calc(100vh - 32px)",overflowY:"auto"}}>
        {testMode && (
          <div style={{background:"#FFF7ED",borderRadius:10,padding:"8px 12px",marginBottom:16,
            border:"1px solid #F97316",textAlign:"center",fontSize:12,color:"#F97316",fontFamily:SANS,fontWeight:700}}>
            🧪 テストモード中 — 本番データに影響しません
          </div>
        )}
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontSize:44,lineHeight:1}}>☕</div>
          <div style={{fontFamily:SERIF,fontSize:22,color:C.espresso,marginTop:10}}>{user.name}</div>
          <div style={{color:C.g400,fontSize:13,marginTop:4}}>どちらへ進みますか？</div>
        </div>

        {/* 打刻 */}
        <a href={TIMECLOCK_URL} target="_blank" rel="noopener noreferrer"
          style={{display:"flex",alignItems:"center",gap:14,padding:"18px 20px",borderRadius:16,
            background:`linear-gradient(135deg,${C.night},${C.nightSoft})`,
            color:"#fff",textDecoration:"none",marginBottom:14,
            boxShadow:"0 4px 18px rgba(26,31,58,0.35)"}}>
          <span style={{fontSize:32}}>⏱️</span>
          <div>
            <div style={{fontWeight:700,fontSize:17,fontFamily:SANS}}>打刻する</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.65)",fontFamily:SANS,marginTop:2}}>
              MoneyForward 勤怠へ移動
            </div>
          </div>
          <span style={{marginLeft:"auto",fontSize:20,color:"rgba(255,255,255,0.5)"}}>→</span>
        </a>

        {/* シフト提出 */}
        <button onClick={onShift}
          style={{display:"flex",alignItems:"center",gap:14,padding:"18px 20px",borderRadius:16,
            background:`linear-gradient(135deg,${C.espresso},${C.mocha})`,
            border:"none",color:"#fff",width:"100%",cursor:"pointer",
            boxShadow:"0 4px 18px rgba(44,24,16,0.35)"}}>
          <span style={{fontSize:32}}>📅</span>
          <div style={{textAlign:"left"}}>
            <div style={{fontWeight:700,fontSize:17,fontFamily:SANS}}>シフト提出・確認</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.65)",fontFamily:SANS,marginTop:2}}>
              希望シフトの提出・確定シフト確認
            </div>
          </div>
          <span style={{marginLeft:"auto",fontSize:20,color:"rgba(255,255,255,0.5)"}}>→</span>
        </button>

        <button onClick={onLogout} style={{width:"100%",marginTop:16,padding:"10px",
          border:`1px solid ${C.latte}`,borderRadius:12,background:"transparent",
          color:C.g500,fontSize:13,cursor:"pointer",fontFamily:SANS}}>
          ログアウト
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   STAFF APP
═══════════════════════════════════════════════ */
function StaffApp({ user, ctx }) {
  const [tab, setTab] = useState("calendar");
  const [acceptConfirm,  setAcceptConfirm]  = useState(null); // 代理承認確認
  const [declineConfirm, setDeclineConfirm] = useState(null); // 不可確認
  const { messages, setMessages, helpReqs, monthKey, logout, extReqs, subReqs } = ctx;
  const unread = messages.filter(m => String(m.to)===String(user.id) && !m.read && !m.cancelled).length;
  const myHelps = helpReqs.filter(h => String(h.staffId)===String(user.id) && !h.resolved && h.monthKey===monthKey);
  const reqBadge = (
    (extReqs||[]).filter(e=>String(e.staffId)===String(user.id)&&e.status==="pending").length +
    (subReqs||[]).filter(r=>r.status==="open"&&String(r.fromStaffId)!==String(user.id)&&
      !(r.decliners||[]).map(String).includes(String(user.id))).length
  );
  const si = ctx.staff.findIndex(s => s.id === user.id);

  useEffect(() => {
    if (tab === "chat") setMessages(prev => prev.map(m => m.to===user.id ? {...m,read:true} : m));
  }, [tab]);

  return (
    <>
    <div style={pageStyle}>
      <div style={topBarStyle}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <Avatar name={user.name} idx={si} size={34}/>
          <span style={{fontFamily:SERIF,fontSize:16,color:C.espresso}}>{user.name}</span>
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {[["calendar","📅"],["confirmed","📋"],["request","🔄"],["chat","💬"]].map(([t,ic]) => (
            <button key={t} onClick={()=>setTab(t)} style={{
              ...pillStyle, background:tab===t?`${C.caramel}20`:"transparent",
              border:`1px solid ${tab===t?C.caramel:C.latte}`,
              color:tab===t?C.mocha:C.g500, fontWeight:tab===t?700:400, position:"relative",
            }}>
              {ic}
              {t==="chat"&&unread>0&&(
                <span style={{position:"absolute",top:-4,right:-4,minWidth:14,height:14,
                  background:C.red,color:"#fff",borderRadius:8,fontSize:8,fontWeight:700,
                  display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px",
                  fontFamily:SANS}}>{unread}</span>
              )}
              {t==="request"&&reqBadge>0&&(
                <span style={{position:"absolute",top:-4,right:-4,minWidth:14,height:14,
                  background:"#EF4444",color:"#fff",borderRadius:8,fontSize:8,fontWeight:700,
                  display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px",
                  fontFamily:SANS}}>{reqBadge}</span>
              )}
            </button>
          ))}
          <NotifBell myId={user.id} notifs={ctx.notifs} setNotifs={ctx.setNotifs} onNavigate={setTab}/>
          <button onClick={logout} style={ghostBtn}>退出</button>
        </div>
      </div>

      {myHelps.length>0 && tab!=="chat" && (
        <div style={{margin:"12px 16px 0",padding:"12px 16px",borderRadius:12,
          background:"#FFF7ED",border:"1px solid #FED7AA",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:20}}>🆘</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,color:"#C2410C",fontSize:13,fontFamily:SANS}}>ヘルプ依頼あり</div>
            <div style={{fontSize:12,color:"#9A3412",fontFamily:SANS}}>{myHelps.length}件</div>
          </div>
          <Btn variant="outline" onClick={()=>setTab("chat")}
            style={{fontSize:12,padding:"5px 12px",borderColor:"#FDBA74",color:"#C2410C"}}>確認</Btn>
        </div>
      )}

      {tab==="calendar"  && <StaffCalendar user={user} ctx={ctx}/>}
      {tab==="confirmed" && <ConfirmedView ctx={ctx} staffView userId={user.id}/>}
      {tab==="request"   && <StaffRequestView user={user} ctx={ctx} acceptConfirm={acceptConfirm} setAcceptConfirm={setAcceptConfirm} declineConfirm={declineConfirm} setDeclineConfirm={setDeclineConfirm}/>}
      {tab==="chat"      && <StaffChat user={user} ctx={ctx}/>}
    </div>

    {/* ── 代理承認確認モーダル (StaffApp最上位でrender) ── */}
    {acceptConfirm && (
      <SubAcceptModal
        sr={acceptConfirm}
        user={user}
        ctx={ctx}
        onCancel={()=>setAcceptConfirm(null)}
        onConfirm={()=>{
          // Execute accept logic here (lifted from StaffRequestView)
          const sr=acceptConfirm;
          setAcceptConfirm(null);
          const {subReqs,setSubReqs,confirmed,setConfirmed,monthKey:mk}=ctx;
          setSubReqs(prev=>prev.map(r=>r.id===sr.id?{...r,status:"accepted",acceptedBy:user.id,acceptedByName:user.name}:r));
          setConfirmed(prev=>{
            const c=JSON.parse(JSON.stringify(prev));
            const sess=c[mk]?.[sr.dateStr]?.[sr.session];
            if(sess){
              const filtered=sess.filter(e=>String(e.staffId)!==String(sr.fromStaffId));
              if(!filtered.find(e=>String(e.staffId)===String(user.id))){
                filtered.push({staffId:user.id,name:user.name,start:sr.origEntry?.start||"OP",end:sr.origEntry?.end||"CL"});
              }
              c[mk][sr.dateStr][sr.session]=filtered;
            }
            return c;
          });
          setSubReqs(prev=>prev.map(r=>
            r.id!==sr.id&&r.dateStr===sr.dateStr&&r.session===sr.session&&r.status==="open"
              ?{...r,status:"cancelled"}:r
          ));
          ctx.pushNotif(String(sr.fromStaffId),"subreq",`✅ ${user.name}が${fmtDs(sr.dateStr)}の代理を引き受けました`);
          ctx.pushNotif("0","subreq",`✅ ${user.name}が${fmtDs(sr.dateStr)}の代理→シフト自動更新済み`);
        }}
      />
    )}
    {/* ── 不可確認モーダル ── */}
    {declineConfirm && (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:9999,
        display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
        <div style={{background:"#fff",borderRadius:24,padding:"28px 24px",width:"100%",maxWidth:400,
          boxShadow:"0 24px 80px rgba(0,0,0,0.4)",textAlign:"center"}}>
          <div style={{fontSize:44,lineHeight:1,marginBottom:10}}>🤔</div>
          <div style={{fontFamily:SERIF,fontSize:20,color:C.espresso,marginBottom:8}}>
            本当に不可にしますか？
          </div>
          <div style={{background:C.paper,borderRadius:12,padding:"12px 16px",marginBottom:16}}>
            <div style={{fontSize:14,fontWeight:700,color:C.espresso,fontFamily:SANS}}>
              {fmtDs(declineConfirm.dateStr)}（{declineConfirm.session==="night"?"夜の部":"昼の部"}）
            </div>
            {declineConfirm.origEntry&&(
              <div style={{fontSize:13,color:C.mocha,fontFamily:SANS,marginTop:4}}>
                {declineConfirm.origEntry.start} 〜 {declineConfirm.origEntry.end}
              </div>
            )}
            <div style={{fontSize:12,color:C.g500,fontFamily:SANS,marginTop:4}}>
              欠勤者：{declineConfirm.fromName}
            </div>
          </div>
          <div style={{fontSize:12,color:C.g500,fontFamily:SANS,marginBottom:20,lineHeight:1.6}}>
            不可にすると、この代理依頼は一覧から消えます。
          </div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={()=>setDeclineConfirm(null)}
              style={{flex:1,padding:"13px",borderRadius:12,border:`1px solid ${C.latte}`,
                background:"#fff",color:C.g500,fontSize:14,cursor:"pointer",fontFamily:SANS}}>
              戻る
            </button>
            <button onClick={()=>{
              // Execute decline — call declineSubReq via a ref approach
              // Pass the sr back to StaffRequestView via a callback
              if(declineConfirm.__doDecline) declineConfirm.__doDecline();
              setDeclineConfirm(null);
            }}
              style={{flex:2,padding:"13px",borderRadius:12,border:"none",
                background:`linear-gradient(135deg,${C.red},#EF4444)`,
                color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:SANS}}>
              不可にする
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

/* ─── Staff Calendar & Submission ─── */
function StaffCalendar({ user, ctx }) {
  const { nightDays, shifts, setShifts, confirmed, deadlines, extensions, year, month, monthKey } = ctx;
  const myShifts   = shifts[monthKey]?.[String(user.id)] || {};
  const submitted  = Object.values(myShifts).some(v => v._submitted);
  // 確定済み日を収集
  const myConfirmedDates = Object.entries(confirmed[monthKey]||{}).reduce((acc,[ds,sess])=>{
    const hasDay   = sess.day?.find(e=>String(e.staffId)===String(user.id));
    const hasNight = sess.night?.find(e=>String(e.staffId)===String(user.id));
    if(hasDay)   acc[ds+"_day"]   = hasDay;
    if(hasNight) acc[ds+"_night"] = hasNight;
    return acc;
  },{});
  const confirmedDayCount = new Set(Object.keys(myConfirmedDates).map(k=>k.split("_")[0])).size;
  const hasConfirmed = confirmedDayCount > 0;
  const [draft, setDraft] = useState({});
  const [sel,   setSel]   = useState(null); // {dateStr,session}
  const deadline       = deadlines[monthKey];
  const pastDeadline   = deadline && todayStr() > deadline;
  const hasExtension   = extensions[monthKey]?.[String(user.id)];
  const canSubmit      = !pastDeadline || (pastDeadline && hasExtension);

  useEffect(() => {
    const d = {};
    Object.entries(myShifts).forEach(([k,v]) => { d[k] = {...v}; });
    setDraft(d);
  }, [monthKey]);

  function toggleSession(dateStr, session) {
    if (!canSubmit || (submitted && pastDeadline && !hasExtension)) return;
    setSel(prev => prev?.dateStr===dateStr && prev?.session===session ? null : {dateStr,session});
    setDraft(prev => {
      const cell = {...(prev[dateStr]||{})};
      let next;
      if (cell[session]) {
        delete cell[session];
        if (!cell.day && !cell.night) { const n={...prev}; delete n[dateStr]; next=n; }
        else next={...prev,[dateStr]:cell};
      } else {
        cell[session] = defaultEntry(session);
        next={...prev,[dateStr]:cell};
      }
      // Immediately persist so changes survive reload
      setShifts(sp => ({...sp,[monthKey]:{...sp[monthKey],[String(user.id)]:next}}));
      return next;
    });
  }

  function updateTime(dateStr, session, field, val) {
    setDraft(prev => {
      const entry = {...(prev[dateStr]?.[session]||defaultEntry())};
      entry[field] = val;
      const next = {...prev,[dateStr]:{...prev[dateStr],[session]:entry}};
      setShifts(sp => ({...sp,[monthKey]:{...sp[monthKey],[String(user.id)]:next}}));
      return next;
    });
  }

  function removeDate(dateStr) {
    setDraft(prev => {
      const n={...prev}; delete n[dateStr];
      // Immediately persist to shifts so changes survive page reload
      setShifts(sp => ({...sp,[monthKey]:{...sp[monthKey],[String(user.id)]:n}}));
      return n;
    });
    if (sel?.dateStr === dateStr) setSel(null);
  }

  function submit() {
    const entries = {};
    Object.entries(draft).forEach(([k,v]) => { entries[k] = {...v,_submitted:true,_submittedAt:new Date().toISOString()}; });
    setShifts(prev => ({...prev,[monthKey]:{...prev[monthKey],[String(user.id)]:entries}}));
    setSel(null); alert("✅ シフトを提出しました！");
  }
  function resetSubmit() {
    setShifts(prev => {
      const c = {...prev};
      if (c[monthKey]?.[String(user.id)]) {
        const r = {};
        Object.entries(c[monthKey][String(user.id)]).forEach(([k,v]) => { r[k]={...v,_submitted:false}; });
        c[monthKey] = {...c[monthKey],[String(user.id)]:r};
      }
      return c;
    });
  }

  const days = daysIn(year,month), firstDay = firstOf(year,month);
  const cells = []; for (let i=0;i<firstDay;i++) cells.push(null);
  for (let d=1; d<=days; d++) cells.push({d, dateStr:mkDs(year,month,d)});

  const selEntry = sel && draft[sel.dateStr]?.[sel.session];
  const times    = sel?.session==="night" ? NIGHT_TIMES : DAY_TIMES;

  return (
    <div style={{paddingBottom:80}}>
      <MonthNav year={year} month={month} onPrev={ctx.prevM} onNext={ctx.nextM}/>

      {deadline && (
        <div style={{margin:"0 16px 12px",padding:"10px 14px",borderRadius:10,fontFamily:SANS,fontSize:12,
          background:pastDeadline?(hasExtension?C.amberBg:C.redBg):"#F0FDF4",
          border:`1px solid ${pastDeadline?(hasExtension?C.amberLight:C.redLight):C.greenLight}`,
          color:pastDeadline?(hasExtension?C.amber:C.red):C.green}}>
          {pastDeadline
            ? hasExtension ? "⚠️ 期限延長が許可されています" : "🔒 提出期限（"+fmtDs(deadline)+"）を過ぎています"
            : "📅 提出期限："+fmtDs(deadline)}
        </div>
      )}

      {/* ステータスバナー：提出前/提出済み/確定済み */}
      {!submitted && (
        <div style={{margin:"0 16px 12px",padding:"10px 14px",borderRadius:12,
          background:"#F8F9FA",border:`1px solid ${C.latte}`,
          display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:16}}>📋</span>
          <span style={{flex:1,color:C.g500,fontSize:13,fontFamily:SANS}}>シフト希望を入力して提出してください</span>
        </div>
      )}
      {submitted && !hasConfirmed && (
        <div style={{margin:"0 16px 12px",padding:"11px 16px",borderRadius:12,
          background:C.amberBg,border:`1px solid ${C.amberLight}`,
          display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:18}}>⏳</span>
          <div style={{flex:1}}>
            <div style={{color:C.amber,fontWeight:700,fontSize:13,fontFamily:SANS}}>提出済み（確定待ち）</div>
            <div style={{color:C.amber,fontSize:11,fontFamily:SANS,marginTop:1}}>管理者がシフトを確定するまでお待ちください</div>
          </div>
          {(!pastDeadline || hasExtension) && (
            <Btn variant="outline" onClick={resetSubmit}
              style={{fontSize:11,padding:"4px 10px",borderColor:C.amber,color:C.amber}}>
              ✏️ 修正
            </Btn>
          )}
        </div>
      )}
      {hasConfirmed && (
        <div style={{margin:"0 16px 12px",padding:"11px 16px",borderRadius:12,
          background:C.greenBg,border:`1px solid ${C.greenLight}`,
          display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:18}}>✅</span>
          <div style={{flex:1}}>
            <div style={{color:C.green,fontWeight:700,fontSize:13,fontFamily:SANS}}>確定済み（{confirmedDayCount}日）</div>
            <div style={{color:C.green,fontSize:11,fontFamily:SANS,marginTop:1}}>
              {submitted && !hasConfirmed ? "一部未確定あり" : "シフトが確定しました"}
            </div>
          </div>
          {(!pastDeadline || hasExtension) && submitted && (
            <Btn variant="outline" onClick={resetSubmit}
              style={{fontSize:11,padding:"4px 10px",borderColor:C.green,color:C.green}}>
              ✏️ 修正
            </Btn>
          )}
        </div>
      )}

      {/* Calendar grid */}
      <div style={{padding:"0 14px 12px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3}}>
          {["日","月","火","水","木","金","土"].map(w => (
            <div key={w} style={{textAlign:"center",fontSize:11,fontWeight:600,paddingBottom:4,
              fontFamily:SANS,color:w==="日"?C.red:w==="土"?C.nightAcc:C.g400}}>{w}</div>
          ))}
          {cells.map((cell,i) => {
            if (!cell) return <div key={`e${i}`}/>;
            const {d,dateStr} = cell;
            const hasNight = !!nightDays[dateStr];
            const cv = draft[dateStr]||{};
            const dow = (firstDay+d-1)%7;
            const isSelD = sel?.dateStr===dateStr && sel?.session==="day";
            const isSelN = sel?.dateStr===dateStr && sel?.session==="night";
            const dc = timeColor(cv.day?.start||"");
            const nc = cv.night && timeColor(cv.night?.start||"");
            const locked = submitted && (pastDeadline && !hasExtension);
            // 確定済みかどうかチェック
            const confDay   = myConfirmedDates[dateStr+"_day"];
            const confNight = myConfirmedDates[dateStr+"_night"];
            return (
              <div key={dateStr} style={{display:"flex",flexDirection:"column",gap:2}}>
                <button onClick={() => toggleSession(dateStr,"day")} style={{
                  width:"100%",aspectRatio:"1",borderRadius:8,display:"flex",flexDirection:"column",
                  alignItems:"center",justifyContent:"center",gap:1,
                  background:confDay?C.greenBg:cv.day?dc.bg:"#fff",
                  border:isSelD?`2px solid ${confDay?C.green:dc.color}`:
                    confDay?`2px solid ${C.green}`:
                    cv.day?`1.5px solid ${dc.color}60`:"1px solid #EDE5D8",
                  cursor:locked?"not-allowed":"pointer",fontFamily:SANS,
                  color:dow===0?C.red:dow===6?C.nightAcc:C.espresso,
                }}>
                  <span style={{fontSize:12,fontWeight:(cv.day||confDay)?700:400}}>{d}</span>
                  {confDay && <span style={{fontSize:7,color:C.green,fontWeight:800,lineHeight:1}}>確定</span>}
                  {!confDay && cv.day && <span style={{fontSize:8,color:dc.color,fontWeight:800,lineHeight:1}}>
                    {cv.day.start}
                  </span>}
                </button>
                {hasNight && (
                  <button onClick={()=>!locked&&toggleSession(dateStr,"night")} style={{
                    width:"100%",borderRadius:6,padding:"3px 0",
                    display:"flex",alignItems:"center",justifyContent:"center",gap:2,
                    background:cv.night?`linear-gradient(135deg,${C.night}CC,${C.nightSoft}CC)`:"rgba(91,110,225,0.06)",
                    border:isSelN?`2px solid ${C.nightAcc}`:cv.night?`1.5px solid ${C.nightAcc}60`:"1px dashed #C4C9E8",
                    cursor:locked?"not-allowed":"pointer",fontFamily:SANS,
                    color:cv.night?"#A5B4FC":"#94A3B8",
                  }}>
                    <span style={{fontSize:8}}>🌙</span>
                    <span style={{fontSize:8,fontWeight:cv.night?700:400}}>
                      {cv.night ? (isSentinel(cv.night.start)?cv.night.start:cv.night.start) : "夜"}
                    </span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Time picker panel */}
      {sel && selEntry && (!submitted || (!pastDeadline || hasExtension)) && canSubmit && (
        <TimePickerPanel sel={sel} entry={selEntry} times={times} onUpdate={updateTime}/>
      )}

      {/* Draft list */}
      <div style={{padding:"0 16px"}}>
        <SectionLabel>📋 希望日一覧（{Object.keys(draft).length}日）</SectionLabel>
        {Object.entries(draft).sort(([a],[b])=>a.localeCompare(b)).map(([k,v]) => (
          <DraftDayCard key={k} dateStr={k} v={v}
            onRemove={((!submitted||(!pastDeadline||hasExtension))&&canSubmit)?()=>removeDate(k):null}
            onSelectSess={((!submitted||(!pastDeadline||hasExtension))&&canSubmit)?s=>setSel({dateStr:k,session:s}):null}
            selectedSess={sel?.dateStr===k?sel.session:null}/>
        ))}
        {Object.keys(draft).length===0 && <EmptyMsg>カレンダーで希望日をタップしてください</EmptyMsg>}
      </div>

      {(!submitted || (!pastDeadline||hasExtension)) && canSubmit && Object.keys(draft).length>0 && (
        <div style={{padding:"16px"}}>
          <Btn variant="primary" full onClick={submit} style={{justifyContent:"center",fontSize:15,padding:"15px"}}>
            シフトを提出する →
          </Btn>
        </div>
      )}
    </div>
  );
}

/* ─── Time Picker Panel ─── */
function TimePickerPanel({ sel, entry, times, onUpdate }) {
  const isNight = sel.session === "night";
  return (
    <div style={{margin:"0 16px 14px",borderRadius:16,overflow:"hidden",
      boxShadow:"0 4px 20px rgba(44,24,16,0.12)"}}>
      <div style={{background:isNight?`linear-gradient(135deg,${C.night},${C.nightSoft})`:`linear-gradient(135deg,${C.espresso},${C.mocha})`,
        padding:"13px 18px",display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:20}}>{isNight?"🌙":"☀️"}</span>
        <div>
          <div style={{color:"rgba(255,255,255,0.65)",fontSize:11,fontFamily:SANS}}>{isNight?"夜の部":"昼の部"}</div>
          <div style={{color:"#fff",fontFamily:SERIF,fontSize:17}}>
            {fmtDs(sel.dateStr)}（{jpW(new Date(sel.dateStr).getDay())}）
          </div>
        </div>
      </div>
      <div style={{background:"#fff",padding:"14px 16px",display:"flex",gap:10,alignItems:"flex-end"}}>
        <div style={{flex:1}}>
          <div style={{fontSize:11,color:C.g400,marginBottom:6,fontFamily:SANS}}>開始時間</div>
          <select style={selectSt} value={entry.start}
            onChange={e=>{
              const v=e.target.value;
              onUpdate(sel.dateStr,sel.session,"start",v);
              // If end is now same or before start, auto-advance end
              if(!isSentinel(v)&&!isSentinel(entry.end)&&entry.end<=v){
                const idx=times.indexOf(v);
                const next=times[idx+1];
                if(next&&!isSentinel(next)) onUpdate(sel.dateStr,sel.session,"end",next);
              }
            }}>
            {times.map(t=><option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={{color:C.g400,paddingBottom:12,fontSize:14}}>→</div>
        <div style={{flex:1}}>
          <div style={{fontSize:11,color:C.g400,marginBottom:6,fontFamily:SANS}}>終了時間</div>
          <select style={selectSt} value={entry.end}
            onChange={e=>onUpdate(sel.dateStr,sel.session,"end",e.target.value)}>
            {times.map(t=>{
              // Disable options that are same or before start (for time strings only)
              // Only disable pure time options that are before/equal to a time start
              // Never restrict when start is OP/CL (sentinels can pair with anything)
              const disabled = !isSentinel(entry.start) && !isSentinel(t) && t <= entry.start;
              return <option key={t} value={t} disabled={disabled}
                style={{color:disabled?"#ccc":"inherit"}}>{t}</option>;
            })}
          </select>
        </div>
      </div>
    </div>
  );
}

/* ─── Draft Day Card ─── */
function DraftDayCard({ dateStr, v, onRemove, onSelectSess, selectedSess }) {
  const dow = new Date(dateStr).getDay();
  return (
    <div style={{borderRadius:14,overflow:"hidden",marginBottom:10,
      boxShadow:"0 2px 10px rgba(44,24,16,0.07)",border:`1px solid ${C.latte}`}}>
      <div style={{background:`linear-gradient(135deg,${C.espresso},${C.mocha})`,
        padding:"9px 14px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontFamily:SERIF,fontSize:16,color:"#fff"}}>{fmtDs(dateStr)}</span>
          <span style={{fontSize:11,color:"rgba(255,255,255,0.55)",fontFamily:SANS}}>（{jpW(dow)}）</span>
        </div>
        {onRemove && (
          <button onClick={onRemove} style={{background:"rgba(255,255,255,0.15)",border:"none",
            borderRadius:6,color:"rgba(255,255,255,0.7)",fontSize:11,padding:"3px 8px",
            cursor:"pointer",fontFamily:SANS}}>削除</button>
        )}
      </div>
      <div style={{background:"#fff"}}>
        {["day","night"].filter(s=>v[s]).map((s,i) => {
          const e = v[s];
          const tc = timeColor(e.start||"");
          const isSel = selectedSess === s;
          return (
            <div key={s} onClick={() => onSelectSess?.(s)}
              style={{padding:"11px 14px",display:"flex",alignItems:"center",gap:10,
                background:isSel?(s==="night"?`${C.nightAcc}10`:`${C.caramel}10`):"#fff",
                borderTop:i>0?"1px solid #F3EDE3":"none",cursor:onSelectSess?"pointer":"default"}}>
              <span style={{fontSize:17}}>{s==="night"?"🌙":"☀️"}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:10,color:C.g400,fontFamily:SANS}}>{s==="night"?"夜の部":"昼の部"}</div>
                <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                  {isSentinel(e.start) ? (
                    // OP or CL as start: show badge + end time if different
                    <>
                      <span style={{fontSize:11,fontWeight:700,borderRadius:6,padding:"2px 8px",
                        background:s==="night"?"#1A1F3A":tc.bg,color:s==="night"?"#A5B4FC":tc.color,
                        border:`1px solid ${tc.color}60`,fontFamily:SANS}}>{e.start}</span>
                      {e.end && e.end !== e.start && (
                        <span style={{fontWeight:500,color:C.g500,fontSize:12,fontFamily:SANS}}>
                          〜 {e.end}
                        </span>
                      )}
                    </>
                  ) : (
                    <span style={{fontWeight:600,color:C.espresso,fontSize:13,fontFamily:SANS}}>
                      {e.start} 〜 {e.end}
                    </span>
                  )}
                </div>
              </div>
              {isSel && <span style={{fontSize:11,color:s==="night"?C.nightAcc:C.caramel,fontFamily:SANS}}>編集中</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Staff Chat ─── */
function StaffChat({ user, ctx }) {
  const { messages, setMessages } = ctx;
  const [input, setInput] = useState("");
  const ref = useRef(null);
  function send() {
    if (!input.trim()) return;
    setMessages(prev => [...prev, {id:Date.now(),from:user.id,to:0,text:input.trim(),ts:nowTime(),read:false}]);
    ctx.pushNotif(0,"chat",`💬 ${user.name}：${input.trim().slice(0,28)}${input.trim().length>28?"…":""}`);
    setInput(""); setTimeout(() => ref.current?.scrollTo(0,99999), 50);
  }
  function cancel(id) { setMessages(prev => prev.map(m => m.id===id ? {...m,cancelled:true} : m)); }
  return <ChatPane myId={user.id} toId={0} toName="管理者"
    messages={messages} chatRef={ref} input={input} setInput={setInput} onSend={send} onCancel={cancel}/>;
}

/* ═══════════════════════════════════════════════
   ADMIN APP
═══════════════════════════════════════════════ */
function AdminApp({ ctx }) {
  const [tab, setTab] = useState("overview");
  const { messages, monthKey } = ctx;
  const unread = messages.filter(m => m.to===0 && !m.read && !m.cancelled).length;

  const TABS = [
    {k:"overview",  ic:"📊", label:"提出状況"},
    {k:"build",     ic:"🔧", label:"シフト作成"},
    {k:"confirmed", ic:"📋", label:"確定シフト"},

    {k:"night",     ic:"🌙", label:"夜の部"},
    {k:"deadline",  ic:"⏰", label:"期限・延長"},
    {k:"settings",  ic:"⚙️", label:"設定"},
    {k:"chat",      ic:"💬", label:unread>0?`Chat(${unread})`:"Chat"},
  ];

  const { testMode, setTestMode } = ctx;

  return (
    <div style={pageStyle}>
      {/* テストモードバナー */}
      {testMode && (
        <div style={{background:"#F97316",padding:"8px 16px",
          display:"flex",alignItems:"center",justifyContent:"space-between",
          position:"sticky",top:0,zIndex:20}}>
          <span style={{color:"#fff",fontWeight:700,fontSize:13,fontFamily:SANS}}>
            🧪 テストモード中 — 本番データに影響しません
          </span>
          <button onClick={()=>setTestMode(false)}
            style={{color:"#fff",background:"rgba(255,255,255,0.25)",border:"none",
              borderRadius:8,padding:"4px 10px",fontSize:12,cursor:"pointer",fontFamily:SANS,fontWeight:700}}>
            終了
          </button>
        </div>
      )}
      <div style={topBarStyle}>
        <span style={{fontFamily:SERIF,fontSize:17,color:C.espresso}}>☕ 管理者</span>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <NotifBell myId={0} notifs={ctx.notifs} setNotifs={ctx.setNotifs} onNavigate={setTab} isAdmin/>
          <button onClick={ctx.logout} style={ghostBtn}>退出</button>
        </div>
      </div>
      <div style={{display:"flex",background:"#fff",borderBottom:`1px solid ${C.latte}`,
        position:"sticky",top:52,zIndex:8,overflowX:"auto"}}>
        {TABS.map(t => (
          <button key={t.k} onClick={()=>setTab(t.k)} style={{
            flex:"0 0 auto",padding:"11px 12px",border:"none",background:"none",
            fontFamily:SANS,fontSize:11,cursor:"pointer",whiteSpace:"nowrap",
            color:tab===t.k?C.espresso:C.g400,fontWeight:tab===t.k?700:400,
            borderBottom:`2px solid ${tab===t.k?C.caramel:"transparent"}`,
          }}>
            {t.ic} {t.label}
          </button>
        ))}
      </div>

      {tab==="overview"  && <AdminOverview ctx={ctx}/>}
      {tab==="build"     && <ShiftBuilder ctx={ctx}/>}
      {tab==="confirmed" && <ConfirmedView ctx={ctx} staffView={false}/>}

      {tab==="night"     && <NightSettings ctx={ctx}/>}
      {tab==="deadline"  && <DeadlineSettings ctx={ctx}/>}
      {tab==="settings"  && <AdminSettings ctx={ctx}/>}
      {tab==="chat"      && <AdminChat ctx={ctx}/>}
    </div>
  );
}

/* ─── Admin Overview ─── */
function AdminOverview({ ctx }) {
  const { staff, shifts, confirmed, deadlines, extensions, setExtensions, messages, year, month, monthKey, prevM, nextM } = ctx;
  const subCount = staff.filter(s => { const ms=shifts[monthKey]?.[String(s.id)]||{}; return Object.values(ms).some(v=>v._submitted||v.day||v.night); }).length;
  const confCount = staff.filter(s => {
    const mConf = confirmed[monthKey]||{};
    return Object.values(mConf).some(sess=>
      sess.day?.find(e=>String(e.staffId)===String(s.id)) ||
      sess.night?.find(e=>String(e.staffId)===String(s.id))
    );
  }).length;
  const deadline = deadlines[monthKey];
  const today = todayStr();

  return (
    <div style={{paddingBottom:32}}>
      <MonthNav year={year} month={month} onPrev={prevM} onNext={nextM}/>
      {deadline && (
        <div style={{margin:"0 16px 12px",padding:"10px 14px",borderRadius:10,fontFamily:SANS,fontSize:12,
          background:today>deadline?C.redBg:C.amberBg,
          border:`1px solid ${today>deadline?C.redLight:C.amberLight}`,
          color:today>deadline?C.red:C.amber}}>
          {today>deadline?"🔒 提出期限終了："+fmtDs(deadline):"📅 提出期限："+fmtDs(deadline)}
        </div>
      )}
      <div style={{display:"flex",gap:8,padding:"0 16px 14px"}}>
        {[["総スタッフ",staff.length,C.espresso],["提出済み",subCount,C.amber],["確定済み",confCount,C.green],["未提出",staff.length-subCount,C.red]].map(([l,v,col]) => (
          <div key={l} style={{flex:1,background:"#fff",borderRadius:12,padding:"12px 4px",textAlign:"center",
            boxShadow:"0 2px 8px rgba(44,24,16,0.06)",border:`1px solid ${C.latte}`}}>
            <div style={{fontFamily:SERIF,fontSize:22,color:col}}>{v}</div>
            <div style={{fontSize:10,color:C.g400,fontFamily:SANS,marginTop:2}}>{l}</div>
          </div>
        ))}
      </div>
      {staff.map((s,si) => {
        const ms = shifts[monthKey]?.[String(s.id)]||{};
        const isSub = Object.values(ms).some(v=>v._submitted||v.day||v.night);
        const dc = Object.keys(ms).length;
        const uf = messages.filter(m=>String(m.from)===String(s.id)&&m.to===0&&!m.read&&!m.cancelled).length;
        const hasExt = extensions[monthKey]?.[String(s.id)];
        function grantExt()  { setExtensions(prev=>({...prev,[monthKey]:{...prev[monthKey],[String(s.id)]:true}})); }
        function revokeExt() { setExtensions(prev=>{const c={...prev};if(c[monthKey]){const r={...c[monthKey]};delete r[String(s.id)];c[monthKey]=r;}return c;}); }
        return (
          <div key={s.id} style={{margin:"0 16px 10px",background:"#fff",borderRadius:16,
            boxShadow:"0 2px 8px rgba(44,24,16,0.06)",border:`1px solid ${C.latte}`,overflow:"hidden"}}>
            <div style={{padding:"13px 16px",display:"flex",alignItems:"center",gap:12}}>
              <Avatar name={s.name} idx={si} size={38}/>
              <div style={{flex:1}}>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <span style={{fontWeight:700,fontSize:15,fontFamily:SANS,color:C.espresso}}>{s.name}</span>
                  {uf>0 && <Badge>{uf}件未読</Badge>}
                  {hasExt && <span style={{fontSize:10,background:C.amberBg,color:C.amber,
                    borderRadius:6,padding:"1px 6px",border:`1px solid ${C.amberLight}`,fontFamily:SANS}}>延長許可中</span>}
                </div>
                {(()=>{
                  const mConf=confirmed[monthKey]||{};
                  const confDays=new Set(Object.entries(mConf).filter(([,sess])=>
                    sess.day?.find(e=>String(e.staffId)===String(s.id))||
                    sess.night?.find(e=>String(e.staffId)===String(s.id))
                  ).map(([ds])=>ds));
                  const cd=confDays.size;
                  return(
                    <div style={{display:"flex",gap:6,alignItems:"center",marginTop:2,flexWrap:"wrap"}}>
                      {isSub&&<span style={{fontSize:11,color:C.amber,fontFamily:SANS,fontWeight:600}}>
                        ⏳ 提出済み（{dc}日）
                      </span>}
                      {!isSub&&<span style={{fontSize:11,color:C.g400,fontFamily:SANS}}>⏸ 未提出</span>}
                      {cd>0&&<span style={{fontSize:11,color:C.green,fontFamily:SANS,fontWeight:700}}>
                        ✅ 確定（{cd}日）
                      </span>}
                    </div>
                  );
                })()}
              </div>
            </div>
            {(()=>{
              const mConf=confirmed[monthKey]||{};
              const confEntries=Object.entries(mConf).filter(([,sess])=>
                sess.day?.find(e=>String(e.staffId)===String(s.id))||
                sess.night?.find(e=>String(e.staffId)===String(s.id))
              ).sort(([a],[b])=>a.localeCompare(b));
              return(
                <>
                {dc>0&&(
                  <div style={{padding:"0 16px 6px"}}>
                    <div style={{fontSize:10,color:C.amber,fontFamily:SANS,marginBottom:4,fontWeight:700}}>⏳ 提出済みシフト</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {Object.entries(ms).sort(([a],[b])=>a.localeCompare(b)).flatMap(([k,v])=>{
                        const chips=[];
                        if(v.day){const tc=timeColor(v.day.start||"");chips.push(<Chip key={k+"d"} color={tc.color} bg={tc.bg}>☀️ {k.slice(5)} {shiftLabel(v.day)}</Chip>);}
                        if(v.night)chips.push(<Chip key={k+"n"} color="#A5B4FC" bg="#1A1F3A22">🌙 {k.slice(5)}</Chip>);
                        return chips;
                      })}
                    </div>
                  </div>
                )}
                {confEntries.length>0&&(
                  <div style={{padding:"0 16px 10px"}}>
                    <div style={{fontSize:10,color:C.green,fontFamily:SANS,marginBottom:4,fontWeight:700}}>✅ 確定済みシフト</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {confEntries.flatMap(([ds,sess])=>{
                        const chips=[];
                        const de=sess.day?.find(e=>String(e.staffId)===String(s.id));
                        const ne=sess.night?.find(e=>String(e.staffId)===String(s.id));
                        if(de)chips.push(<Chip key={ds+"cd"} color={C.green} bg={C.greenBg}>☀️ {ds.slice(5)} {shiftLabel(de)}</Chip>);
                        if(ne)chips.push(<Chip key={ds+"cn"} color="#10B981" bg="#ECFDF5">🌙 {ds.slice(5)}</Chip>);
                        return chips;
                      })}
                    </div>
                  </div>
                )}
                </>
              );
            })()}
            {!isSub && deadline && (
              <div style={{padding:"0 16px 12px",display:"flex",gap:8}}>
                {hasExt
                  ? <Btn variant="outline" onClick={revokeExt} style={{fontSize:11,padding:"4px 10px",color:C.red,borderColor:C.redLight}}>延長取消</Btn>
                  : <Btn variant="outline" onClick={grantExt}  style={{fontSize:11,padding:"4px 10px",color:C.amber,borderColor:C.amberLight}}>提出期限を延長許可</Btn>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Shift Builder ─── */
function ShiftBuilder({ ctx }) {
  const { staff, nightDays, shifts, confirmed, setConfirmed, year, month, monthKey, prevM, nextM,
          messages, setMessages, helpReqs, setHelpReqs, extReqs, setExtReqs } = ctx;
  const [mode, setMode] = useState("manual");
  const [filter, setFilter] = useState("wishes"); // all|wishes|confirmed
  const [pending, setPending] = useState({});
  const [aiResult, setAiResult] = useState(null);
  const [loading, setLoading] = useState(false);
  // Extension request modal
  const [extModal, setExtModal] = useState(null); // {dateStr, session, staffId, name, currentEnd}
  const [extEnd, setExtEnd] = useState("17:00");
  const [extNote, setExtNote] = useState("");

  function openExtModal(dateStr, session, entry) {
    setExtModal({dateStr, session, staffId:entry.staffId, name:entry.name, currentEnd:entry.end});
    setExtEnd("17:00"); setExtNote("");
  }
  function sendExtReq() {
    if (!extModal) return;
    const id = Date.now();
    setExtReqs(prev=>[...prev,{id, staffId:extModal.staffId, name:extModal.name,
      dateStr:extModal.dateStr, session:extModal.session,
      reqEnd:extEnd, note:extNote.trim(), status:"pending"}]);
    ctx.pushNotif(String(extModal.staffId),"extreq",
      `⏰ 管理者から${fmtDs(extModal.dateStr)}（${extModal.session==="night"?"夜":"昼"}）〜${extEnd}への延長依頼`);
    setExtModal(null);
  }

  function sendSOS(staffId, dateStr, session) {
    if ((helpReqs||[]).find(h=>String(h.staffId)===String(staffId)&&h.date===dateStr&&h.session===session&&!h.resolved)) return;
    const id=Date.now();
    setHelpReqs(prev=>[...prev,{id,staffId,date:dateStr,session,monthKey,resolved:false}]);
    const txt=`🆘【シフトSOS】${fmtDs(dateStr)}（${session==="night"?"夜の部":"昼の部"}）のシフトに入れますか？`;
    setMessages(prev=>[...prev,{id,from:0,to:staffId,text:txt,ts:nowTime(),read:false,isHelp:true,sosKey:`${String(staffId)}_${dateStr}_${session}`}]);
    ctx.pushNotif(staffId,"sos",txt);
  }

  function cancelSOS(staffId, dateStr, session) {
    // Resolve the helpReq
    setHelpReqs(prev=>prev.map(h=>
      String(h.staffId)===String(staffId)&&h.date===dateStr&&h.session===session&&!h.resolved
        ? {...h,resolved:true} : h
    ));
    // Auto-cancel the corresponding chat message
    const sosKey=`${String(staffId)}_${dateStr}_${session}`;
    setMessages(prev=>prev.map(m=>m.sosKey===sosKey ? {...m,cancelled:true} : m));
    // Remove the notification
    ctx.setNotifs(prev=>prev.filter(n=>!(String(n.to)===String(staffId)&&n.type==="sos")));
  }

  const days = daysIn(year,month);
  const daysArr = []; for (let d=1;d<=days;d++) daysArr.push({d,dateStr:mkDs(year,month,d)});

  function getWishes(dateStr,session) {
    return staff.flatMap(s => {
      const e = shifts[monthKey]?.[String(s.id)]?.[dateStr]?.[session];
      // Accept entries with _submitted=true OR entries that have start data (safety net)
      if (!e) return [];
      if (!e._submitted && !e.start) return [];
      return [{staffId:s.id, name:s.name, start:e.start||"OP", end:e.end||"CL"}];
    });
  }
  const getPending   = (ds,sess) => (pending[ds]||{})[sess]||[];
  const getConfirmed = (ds,sess) => (confirmed[monthKey]||{})[ds]?.[sess]||[];

  function togglePending(dateStr,session,staffId,entry) {
    setPending(prev => {
      const arr = (prev[dateStr]?.[session]||[]);
      const newArr = arr.find(x=>x.staffId===staffId)
        ? arr.filter(x=>x.staffId!==staffId)
        : [...arr, {staffId,...entry}];
      return {...prev,[dateStr]:{...(prev[dateStr]||{}),[session]:newArr}};
    });
  }
  function confirmDay(dateStr) {
    setConfirmed(prev => ({...prev,[monthKey]:{...prev[monthKey],[dateStr]:pending[dateStr]||{}}}));
    // Notify staff confirmed on this day
    const entries = pending[dateStr]||{};
    const ids = new Set([...(entries.day||[]),...(entries.night||[])].map(e=>e.staffId));
    ids.forEach(sid => ctx.pushNotif(String(sid),"confirmed",`✅ ${fmtDs(dateStr)} のシフトが確定しました`));
  }
  function confirmAll() {
    setConfirmed(prev => ({...prev,[monthKey]:{...prev[monthKey],...pending}}));
    // Notify all staff in pending
    const notified = new Set();
    Object.entries(pending).forEach(([dateStr,sessions])=>{
      [...(sessions.day||[]),...(sessions.night||[])].forEach(e=>{
        if(!notified.has(String(e.staffId))){
          ctx.pushNotif(String(e.staffId),"confirmed",`✅ ${year}年${month+1}月のシフトが確定しました`);
          notified.add(String(e.staffId));
        }
      });
    });
  }

  async function generateAI() {
    setLoading(true); setAiResult(null);
    const data = staff.map(s => {
      const ms = shifts[monthKey]?.[String(s.id)]||{};
      const avail = Object.entries(ms).filter(([,v])=>v._submitted).flatMap(([d,v]) => {
        const r=[];
        if(v.day)   r.push(`${d}昼(${shiftLabel(v.day)})`);
        if(v.night) r.push(`${d}夜(${shiftLabel(v.night)})`);
        return r;
      }).join(",");
      return `${s.name}:${avail||"希望なし"}`;
    }).join("\n");
    const monthStr = `${year}-${String(month+1).padStart(2,"0")}`;
    const prompt = [
      `カフェのシフト管理者として、以下の希望をもとに${year}年${month+1}月のシフト表を作成してください。`,
      ``,
      `スタッフの希望:`,
      data,
      ``,
      `ルール: 昼の部は毎日最低1名、希望があるスタッフを優先。`,
      ``,
      `以下のJSON形式のみで返答（説明文不要）:`,
      `{"schedule":[{"date":"${monthStr}-01","day":[{"staffId":1,"name":"スタッフ名","start":"OP","end":"CL"}],"night":[]}],"notes":"補足コメント"}`,
    ].join("\n");
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:2000,
          messages:[{role:"user",content:prompt}]})});
      const d = await r.json();
      if (d.error) throw new Error(d.error.message||"API error");
      const text = d.content.map(c=>c.text||"").join("");
      // Extract JSON - find the outermost {} block
      const start = text.indexOf("{");
      const end   = text.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("No JSON in response");
      const parsed = JSON.parse(text.slice(start, end+1));
      if (!parsed.schedule) throw new Error("Missing schedule field");
      setAiResult(parsed);
      const p={};
      parsed.schedule.forEach(day=>{
        p[day.date]={};
        if(day.day?.length)  p[day.date].day  = day.day;
        if(day.night?.length)p[day.date].night = day.night;
      });
      setPending(p);
    } catch(e) { setAiResult({error:`生成失敗: ${e.message||String(e)}`}); }
    setLoading(false);
  }

  return (
    <div style={{paddingBottom:80}}>
      <MonthNav year={year} month={month} onPrev={prevM} onNext={nextM}/>
      <div style={{padding:"0 16px 12px",display:"flex",gap:8}}>
        {[["manual","✍️ 手動"],["ai","✨ AI自動"]].map(([m,l]) => (
          <button key={m} onClick={()=>setMode(m)} style={{
            flex:1,padding:"9px",borderRadius:10,border:`1.5px solid ${mode===m?C.caramel:C.latte}`,
            background:mode===m?`${C.caramel}15`:"#fff",color:mode===m?C.mocha:C.g500,
            fontWeight:mode===m?700:400,fontSize:13,cursor:"pointer",fontFamily:SANS,
          }}>{l}</button>
        ))}
      </div>
      {mode==="ai" && (
        <div style={{padding:"0 16px 12px"}}>
          <Btn variant="primary" full onClick={generateAI} disabled={loading}
            style={{justifyContent:"center",background:`linear-gradient(135deg,#4F46E5,#7C3AED)`}}>
            {loading?"⏳ 生成中...":"✨ AIでシフト案を生成"}
          </Btn>
          {aiResult?.error && <p style={{color:C.red,fontSize:13,fontFamily:SANS,marginTop:8}}>{aiResult.error}</p>}
          {aiResult?.notes && (
            <div style={{marginTop:8,background:"#F0F0FF",borderRadius:10,padding:"10px 14px",
              fontSize:13,color:"#4338CA",border:"1px solid #C7D2FE",fontFamily:SANS}}>
              💬 {aiResult.notes}
            </div>
          )}
          {Object.keys(pending).length>0 && (
            <div style={{marginTop:10}}>
              <Btn variant="primary" full onClick={confirmAll}
                style={{justifyContent:"center",background:`linear-gradient(135deg,${C.green},#10B981)`}}>
                ✅ AI案をすべて確定
              </Btn>
            </div>
          )}
        </div>
      )}

      {/* Submitted staff summary */}
      {(() => {
        const submittedStaff = staff.filter(s=>Object.values(shifts[monthKey]?.[String(s.id)]||{}).some(v=>v._submitted));
        if (submittedStaff.length === 0) return (
          <div style={{margin:"0 16px 10px",padding:"10px 14px",borderRadius:10,
            background:C.amberBg,border:`1px solid ${C.amberLight}`,fontSize:12,color:C.amber,fontFamily:SANS}}>
            ⚠️ まだ誰もシフトを提出していません。スタッフがシフトを提出してから作成してください。
          </div>
        );
        return (
          <div style={{margin:"0 16px 10px",padding:"10px 14px",borderRadius:10,
            background:C.greenBg,border:`1px solid ${C.greenLight}`,fontSize:12,color:C.green,fontFamily:SANS}}>
            ✅ 提出済み: {submittedStaff.map(s=>s.name).join("、")}（{submittedStaff.length}名）
          </div>
        );
      })()}
      {/* Filter toggle */}
      <div style={{padding:"0 16px 10px",display:"flex",gap:6}}>
        {[["all","全日表示"],["wishes","希望あり"],["confirmed","確定済み"]].map(([v,l])=>(
          <button key={v} onClick={()=>setFilter(v)} style={{
            padding:"5px 10px",borderRadius:8,fontSize:11,cursor:"pointer",fontFamily:SANS,
            border:`1px solid ${filter===v?C.caramel:C.latte}`,
            background:filter===v?`${C.caramel}15`:"#fff",
            color:filter===v?C.mocha:C.g500,fontWeight:filter===v?700:400
          }}>{l}</button>
        ))}
      </div>

      {daysArr.map(({d,dateStr}) => {
        const dow = (firstOf(year,month)+d-1)%7;
        const hasNight = !!nightDays[dateStr];
        const dayWishes = getWishes(dateStr,"day");
        const nightWishes = hasNight ? getWishes(dateStr,"night") : null;
        const dayPend = getPending(dateStr,"day");
        const nightPend = getPending(dateStr,"night");
        const dayConf = getConfirmed(dateStr,"day");
        const nightConf = getConfirmed(dateStr,"night");
        const isConf = dayConf.length>0||(hasNight&&nightConf.length>0);
        const hasWishes = dayWishes.length>0||(nightWishes&&nightWishes.length>0);

        // Filter
        if (filter==="wishes" && !hasWishes && !isConf) return null;
        if (filter==="confirmed" && !isConf) return null;

        return (
          <div key={dateStr} style={{margin:"0 16px 10px",borderRadius:16,overflow:"hidden",
            boxShadow:"0 2px 8px rgba(44,24,16,0.06)",border:`1.5px solid ${isConf?C.greenLight:C.latte}`}}>
            <div style={{background:isConf?`linear-gradient(135deg,${C.green},#10B981)`:`linear-gradient(135deg,${C.espresso},${C.mocha})`,
              padding:"9px 16px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontFamily:SERIF,fontSize:16,color:"#fff"}}>{fmtDs(dateStr)}</span>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.55)",fontFamily:SANS}}>（{jpW(dow)}）</span>
                {isConf && <span style={{fontSize:11,color:"rgba(255,255,255,0.8)",fontFamily:SANS}}>✅ 確定済み</span>}
              </div>
              {mode==="manual" && !isConf && (dayPend.length>0||nightPend.length>0) && (
                <Btn variant="ghost" onClick={()=>confirmDay(dateStr)}
                  style={{fontSize:11,padding:"3px 10px",color:"#fff",borderColor:"rgba(255,255,255,0.4)"}}>確定</Btn>
              )}
            </div>
            <BuilderSession label="☀️ 昼の部" isNight={false}
              wishes={dayWishes} pending={dayPend} confirmed={dayConf}
              isConfirmed={!!dayConf.length} staff={staff}
              onToggle={(sid,e)=>togglePending(dateStr,"day",sid,e)} borderBottom={hasNight}
              dateStr={dateStr} session="day" onSOS={sendSOS} onCancelSOS={cancelSOS} helpReqs={helpReqs}/>
            {hasNight && (
              <BuilderSession label="🌙 夜の部" isNight
                wishes={nightWishes} pending={nightPend} confirmed={nightConf}
                isConfirmed={!!nightConf.length} staff={staff}
                onToggle={(sid,e)=>togglePending(dateStr,"night",sid,e)} borderBottom={false}
                dateStr={dateStr} session="night" onSOS={sendSOS} onCancelSOS={cancelSOS} helpReqs={helpReqs}/>
            )}
            {isConf && (
              <div style={{padding:"8px 16px 12px",background:"#fff",borderTop:`1px solid ${C.latte}`}}>
                {/* ⏰ Extension buttons per confirmed staff */}
                {[...dayConf,...nightConf].map(entry=>(
                  <div key={entry.staffId} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <span style={{fontSize:12,color:C.espresso,fontFamily:SANS,flex:1}}>
                      {entry.name}　{entry.start}〜{entry.end}
                    </span>
                    {!(extReqs||[]).find(e=>String(e.staffId)===String(entry.staffId)&&e.dateStr===dateStr&&e.status==="pending") ? (
                      <button onClick={()=>openExtModal(dateStr,dayConf.includes(entry)?"day":"night",entry)}
                        style={{fontSize:11,padding:"4px 10px",borderRadius:8,border:`1px solid ${C.amberLight}`,
                          background:C.amberBg,color:C.amber,cursor:"pointer",fontFamily:SANS,fontWeight:600,flexShrink:0}}>
                        ⏰ 延長依頼
                      </button>
                    ) : (
                      <span style={{fontSize:10,color:C.amber,fontFamily:SANS,flexShrink:0}}>依頼送信済</span>
                    )}
                  </div>
                ))}
                <Btn variant="outline" onClick={()=>{
                  setPending(prev=>({...prev,[dateStr]:{day:dayConf,night:nightConf}}));
                  setConfirmed(prev=>{const c={...prev};if(c[monthKey]){const r={...c[monthKey]};delete r[dateStr];c[monthKey]=r;}return c;});
                }} style={{fontSize:11,padding:"4px 12px",color:C.amber,borderColor:C.amberLight,marginTop:4}}>
                  ✏️ 再編集
                </Btn>
              </div>
            )}
          </div>
        );
      })}

      {/* ⏰ Extension modal */}
      {extModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:100,
          display:"flex",alignItems:"flex-end",justifyContent:"center"}}
          onClick={e=>{if(e.target===e.currentTarget)setExtModal(null);}}>
          <div style={{background:"#fff",borderRadius:"20px 20px 0 0",padding:"24px 20px 36px",
            width:"100%",maxWidth:480}}>
            <div style={{fontWeight:700,fontSize:16,fontFamily:SANS,color:C.espresso,marginBottom:4}}>
              ⏰ 延長依頼を送る
            </div>
            <div style={{fontSize:13,color:C.g500,fontFamily:SANS,marginBottom:16}}>
              {extModal.name}　{fmtDs(extModal.dateStr)}（{extModal.session==="night"?"夜":"昼"}）
            </div>
            <div style={{background:C.paper,borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,fontFamily:SANS}}>
              現在のシフト：<strong>〜{extModal.currentEnd}</strong>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
              <span style={{fontSize:13,color:C.g600,fontFamily:SANS,flexShrink:0}}>延長後の終了：</span>
              <select style={{...selectSt,flex:1}} value={extEnd} onChange={e=>setExtEnd(e.target.value)}>
                {DAY_TIMES.filter(t=>!isSentinel(t)).map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div style={{marginBottom:16}}>
              <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginBottom:4}}>メモ（任意）</div>
              <input style={{...inputSt,width:"100%",boxSizing:"border-box"}}
                placeholder="例：閉店作業があるため"
                value={extNote} onChange={e=>setExtNote(e.target.value)}/>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setExtModal(null)}
                style={{flex:1,padding:"13px",borderRadius:12,border:`1px solid ${C.latte}`,
                  background:"#fff",color:C.g500,fontSize:14,cursor:"pointer",fontFamily:SANS}}>
                キャンセル
              </button>
              <button onClick={sendExtReq}
                style={{flex:2,padding:"13px",borderRadius:12,border:"none",
                  background:`linear-gradient(135deg,${C.espresso},${C.mocha})`,
                  color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:SANS}}>
                依頼を送る →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BuilderSession({ label, isNight, wishes, pending, confirmed, isConfirmed, staff, onToggle, borderBottom, dateStr, session, onSOS, onCancelSOS, helpReqs }) {
  return (
    <div style={{background:isNight?"#F8F9FF":"#fff",borderBottom:borderBottom?`1px solid ${C.latte}`:"none",padding:"12px 16px"}}>
      <div style={{fontSize:11,fontWeight:700,color:isNight?C.nightAcc:C.amber,fontFamily:SANS,marginBottom:8,display:"flex",alignItems:"center",gap:4}}>
        {label}
        {isConfirmed && <span style={{color:C.green}}> ✅ 確定({confirmed.length}名)</span>}
        {!isConfirmed && <span style={{color:C.g400,fontWeight:400}}>（希望{wishes.length}名・選択{pending.length}名）</span>}
      </div>
      {!isConfirmed && wishes.length===0 && <p style={{fontSize:12,color:C.g400,margin:"0 0 6px",fontFamily:SANS}}>希望なし</p>}
      {!isConfirmed && wishes.map((w) => {
        const tc = timeColor(w.start||"");
        const si = staff.findIndex(s=>s.id===w.staffId);
        const selected = pending.find(x=>x.staffId===w.staffId);
        return (
          <button key={w.staffId} onClick={()=>onToggle(w.staffId,w)} style={{
            display:"flex",alignItems:"center",gap:8,width:"100%",padding:"8px 10px",
            borderRadius:10,marginBottom:4,cursor:"pointer",textAlign:"left",fontFamily:SANS,
            background:selected?(isNight?`${C.nightAcc}15`:`${C.caramel}12`):"#fff",
            border:`1.5px solid ${selected?(isNight?C.nightAcc:C.caramel):C.g200}`,
          }}>
            <Avatar name={w.name} idx={si} size={28}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:600,fontSize:13,color:C.espresso}}>{w.name}</div>
              <div style={{display:"flex",alignItems:"center",gap:4,marginTop:2}}>
                <span style={{fontSize:10,borderRadius:4,padding:"1px 6px",
                  background:isNight?"#1A1F3A":tc.bg,color:isNight?"#A5B4FC":tc.color,
                  border:`1px solid ${tc.color}60`}}>{shiftLabel(w)}</span>
              </div>
            </div>
            <div style={{width:20,height:20,borderRadius:"50%",
              background:selected?(isNight?C.nightAcc:C.caramel):C.g200,
              display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              {selected && <span style={{color:"#fff",fontSize:12}}>✓</span>}
            </div>
          </button>
        );
      })}
      {isConfirmed && confirmed.map((c,i) => {
        const tc = timeColor(c.start||"");
        const si = staff.findIndex(s=>s.id===c.staffId);
        return (
          <div key={c.staffId} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 4px",
            borderBottom:i<confirmed.length-1?`1px solid ${C.g100}`:"none"}}>
            <Avatar name={c.name} idx={si} size={26}/>
            <span style={{fontWeight:600,fontSize:13,color:C.espresso,fontFamily:SANS,flex:1}}>{c.name}</span>
            <span style={{fontSize:10,borderRadius:4,padding:"1px 7px",
              background:isNight?"#1A1F3A":tc.bg,color:isNight?"#A5B4FC":tc.color,
              border:`1px solid ${tc.color}60`,fontFamily:SANS}}>{shiftLabel(c)}</span>
          </div>
        );
      })}
      {/* SOS buttons — toggle: send / cancel */}
      {!isConfirmed && onSOS && wishes.length < 2 && (
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:6}}>
          {staff.filter(s=>!wishes.find(w=>w.staffId===s.id)).map(s=>{
            const sent = (helpReqs||[]).find(h=>String(h.staffId)===String(s.id)&&h.date===dateStr&&h.session===session&&!h.resolved);
            return (
              <div key={s.id} style={{display:"flex",alignItems:"center",gap:3}}>
                <button onClick={()=>sent ? onCancelSOS(s.id,dateStr,session) : onSOS(s.id,dateStr,session)}
                  style={{fontSize:11,fontWeight:600,borderRadius:8,padding:"5px 10px",cursor:"pointer",
                    fontFamily:SANS,border:`1px solid ${sent?"#FCD34D":C.redLight}`,
                    background:sent?"#FEF9C3":C.redBg, color:sent?"#92400E":C.red,
                    transition:"all 0.15s"}}>
                  {sent?`✅ ${s.name} 依頼済`:`🆘 ${s.name}`}
                </button>
                {sent&&(
                  <span style={{fontSize:9,color:C.g400,fontFamily:SANS}}>← 押すと取消</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Confirmed View (staff + admin) ─── */
function ConfirmedView({ ctx, staffView, userId }) {
  const { confirmed, nightDays, staff, year, month, monthKey, prevM, nextM } = ctx;
  const mConf = confirmed[monthKey]||{};
  const days = daysIn(year,month);
  const daysArr = []; for(let d=1;d<=days;d++) daysArr.push({d,dateStr:mkDs(year,month,d)});

  return (
    <div style={{paddingBottom:40}}>
      <MonthNav year={year} month={month} onPrev={prevM} onNext={nextM}/>
      <div style={{margin:"0 16px 10px",padding:"10px 16px",borderRadius:12,
        background:`linear-gradient(135deg,${C.green}18,${C.greenBg})`,
        border:`1px solid ${C.greenLight}`,display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:20}}>✅</span>
        <div style={{flex:1}}>
          <div style={{fontWeight:700,color:C.green,fontFamily:SANS,fontSize:14}}>確定シフト</div>
          <div style={{fontSize:11,color:C.green,fontFamily:SANS,marginTop:1,opacity:0.8}}>
            {staffView?"管理者が確定したシフトです":"スタッフの確定済みシフト一覧"}
          </div>
        </div>
        <div style={{fontFamily:SERIF,fontSize:18,color:C.green,fontWeight:700}}>
          {Object.keys(mConf).length}日
        </div>
      </div>
      {Object.keys(mConf).length===0 && (
        <div style={{padding:"40px 16px",textAlign:"center"}}>
          <div style={{fontSize:40,marginBottom:12}}>📋</div>
          <div style={{fontFamily:SERIF,fontSize:18,color:C.espresso,marginBottom:6}}>確定シフトなし</div>
          <div style={{fontSize:13,color:C.g400,fontFamily:SANS}}>
            {staffView?"管理者がシフトを確定するまでお待ちください":"シフト作成タブで確定してください"}
          </div>
        </div>
      )}
      {daysArr.map(({d,dateStr}) => {
        const dow = (firstOf(year,month)+d-1)%7;
        const dayConf   = mConf[dateStr]?.day||[];
        const nightConf = (nightDays[dateStr]&&mConf[dateStr]?.night)||[];
        if (dayConf.length===0 && nightConf.length===0) return null;
        const myDay   = staffView && dayConf.find(x=>String(x.staffId)===String(userId));
        const myNight = staffView && nightConf.find(x=>String(x.staffId)===String(userId));
        return (
          <div key={dateStr} style={{margin:"0 16px 10px",borderRadius:16,overflow:"hidden",
            boxShadow:"0 2px 8px rgba(44,24,16,0.06)",border:`1.5px solid ${(myDay||myNight)?C.caramel:C.latte}`}}>
            <div style={{
              background:(myDay||myNight)?`linear-gradient(135deg,${C.caramel},${C.mocha})`:`linear-gradient(135deg,${C.espresso},${C.mocha})`,
              padding:"9px 16px",display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontFamily:SERIF,fontSize:16,color:"#fff"}}>{fmtDs(dateStr)}</span>
              <span style={{fontSize:11,color:"rgba(255,255,255,0.55)",fontFamily:SANS}}>（{jpW(dow)}）</span>
              {(myDay||myNight) && <span style={{marginLeft:"auto",fontSize:11,color:"rgba(255,255,255,0.85)",fontFamily:SANS,fontWeight:700}}>← あなたのシフト</span>}
            </div>
            {dayConf.length>0 && (
              <ConfirmedSession label="☀️ 昼の部" entries={dayConf} staff={staff}
                myId={userId} staffView={staffView} borderBottom={nightConf.length>0}
                dateStr={dateStr} session="day" absences={ctx.absences}/>
            )}
            {nightConf.length>0 && (
              <ConfirmedSession label="🌙 夜の部" entries={nightConf} staff={staff}
                myId={userId} staffView={staffView} isNight borderBottom={false}
                dateStr={dateStr} session="night" absences={ctx.absences}/>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ConfirmedSession({ label, entries, staff, myId, staffView, isNight, borderBottom, dateStr, session, absences }) {
  return (
    <div style={{background:isNight?"#F8F9FF":"#fff",borderBottom:borderBottom?`1px solid ${C.latte}`:"none",padding:"12px 16px"}}>
      <div style={{fontSize:11,fontWeight:700,color:isNight?C.nightAcc:C.amber,fontFamily:SANS,marginBottom:8}}>{label}</div>
      {entries.map((e,i) => {
        const tc = timeColor(e.start||"");
        const si = staff.findIndex(s=>s.id===e.staffId);
        const isMe = staffView && String(e.staffId)===String(myId);
        return (
          <div key={e.staffId} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",
            borderBottom:i<entries.length-1?`1px solid ${C.g100}`:"none"}}>
            <Avatar name={e.name} idx={si} size={30}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:isMe?800:600,fontSize:13,color:isMe?C.caramel:C.espresso,fontFamily:SANS}}>
                {e.name}{isMe&&" 👈"}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:5,marginTop:2}}>
                <span style={{fontSize:10,borderRadius:4,padding:"1px 6px",
                  background:isNight?"#1A1F3A":tc.bg,color:isNight?"#A5B4FC":tc.color,
                  border:`1px solid ${tc.color}60`,fontFamily:SANS}}>{shiftLabel(e)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Night Settings ─── */
function NightSettings({ ctx }) {
  const { nightDays, setNightDays, year, month, monthKey, prevM, nextM } = ctx;
  function toggle(ds) { setNightDays(prev=>{if(prev[ds]){const n={...prev};delete n[ds];return n;}return{...prev,[ds]:true};}); }
  const days=daysIn(year,month), firstDay=firstOf(year,month);
  const cells=[]; for(let i=0;i<firstDay;i++)cells.push(null);
  for(let d=1;d<=days;d++)cells.push({d,dateStr:mkDs(year,month,d)});
  return (
    <div style={{paddingBottom:32}}>
      <MonthNav year={year} month={month} onPrev={prevM} onNext={nextM}/>
      <div style={{padding:"0 16px 12px"}}>
        <div style={{background:`linear-gradient(135deg,${C.night},${C.nightSoft})`,borderRadius:14,padding:"14px 16px",marginBottom:14}}>
          <p style={{margin:0,color:"rgba(255,255,255,0.8)",fontSize:13,fontFamily:SANS}}>🌙 夜の部を開放する日をタップしてください</p>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3}}>
          {["日","月","火","水","木","金","土"].map(w=>(
            <div key={w} style={{textAlign:"center",fontSize:11,fontWeight:600,paddingBottom:4,fontFamily:SANS,
              color:w==="日"?C.red:w==="土"?C.nightAcc:C.g400}}>{w}</div>
          ))}
          {cells.map((cell,i)=>{
            if(!cell) return <div key={`e${i}`}/>;
            const{d,dateStr}=cell; const on=!!nightDays[dateStr]; const dow=(firstDay+d-1)%7;
            return(
              <button key={dateStr} onClick={()=>toggle(dateStr)} style={{
                width:"100%",aspectRatio:"1",borderRadius:8,display:"flex",flexDirection:"column",
                alignItems:"center",justifyContent:"center",cursor:"pointer",fontFamily:SANS,
                border:on?`2px solid ${C.nightAcc}`:"1px solid #DDE2F5",
                background:on?`linear-gradient(135deg,${C.night},${C.nightSoft})`:"#fff",
                color:on?"#fff":dow===0?C.red:dow===6?C.nightAcc:C.espresso,
              }}>
                <span style={{fontSize:12,fontWeight:on?700:400}}>{d}</span>
                {on&&<span style={{fontSize:9,lineHeight:1}}>🌙</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{padding:"0 16px"}}>
        <SectionLabel>開放中の日</SectionLabel>
        {Object.keys(nightDays).filter(k=>k.startsWith(monthKey)).length===0
          ? <EmptyMsg>今月は夜の部の開放日がありません</EmptyMsg>
          : Object.keys(nightDays).filter(k=>k.startsWith(monthKey)).sort().map(k=>(
            <div key={k} style={{background:"#fff",borderRadius:12,padding:"11px 14px",marginBottom:8,
              display:"flex",alignItems:"center",gap:10,border:`1px solid ${C.latte}`}}>
              <span style={{fontSize:18}}>🌙</span>
              <div style={{flex:1,fontFamily:SANS}}>
                <div style={{fontWeight:700,color:C.espresso}}>{fmtDs(k)}（{jpW(new Date(k).getDay())}）</div>
                <div style={{fontSize:12,color:C.nightAcc}}>夜の部 開放中</div>
              </div>
              <Btn variant="outline" onClick={()=>toggle(k)} style={{fontSize:11,padding:"4px 10px",color:C.red,borderColor:C.redLight}}>解除</Btn>
            </div>
          ))
        }
      </div>
    </div>
  );
}

/* ─── Deadline & Extension ─── */
function DeadlineSettings({ ctx }) {
  const { deadlines, setDeadlines, extensions, setExtensions, staff, shifts, monthKey, year, month, prevM, nextM } = ctx;
  const deadline = deadlines[monthKey]||"";
  const [input, setInput] = useState(deadline);
  useEffect(()=>setInput(deadlines[monthKey]||""),[monthKey]);
  function save() { if(!input) return; setDeadlines(prev=>({...prev,[monthKey]:input})); }
  function clear() { setDeadlines(prev=>{const c={...prev};delete c[monthKey];return c;}); setInput(""); }
  function grant(id)  { setExtensions(prev=>({...prev,[monthKey]:{...prev[monthKey],[String(id)]:true}})); }
  function revoke(id) { setExtensions(prev=>{const c={...prev};if(c[monthKey]){const r={...c[monthKey]};delete r[String(id)];c[monthKey]=r;}return c;}); }
  const pastDeadline = deadline && todayStr() > deadline;
  const unsub = staff.filter(s=>!Object.values(shifts[monthKey]?.[String(s.id)]||{}).some(v=>v._submitted));
  return (
    <div style={{padding:"0 16px 32px"}}>
      <MonthNav year={year} month={month} onPrev={prevM} onNext={nextM}/>
      <SectionLabel>⏰ 提出期限の設定</SectionLabel>
      <div style={{background:"#fff",borderRadius:14,padding:"16px",marginBottom:16,border:`1px solid ${C.latte}`}}>
        <div style={{fontSize:13,color:C.g500,fontFamily:SANS,marginBottom:8}}>{year}年{month+1}月のシフト提出期限</div>
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          <input type="date" value={input} onChange={e=>setInput(e.target.value)} style={{...inputSt,flex:1}}/>
          <Btn variant="primary" onClick={save}>設定</Btn>
          {deadline&&<Btn variant="outline" onClick={clear} style={{color:C.red,borderColor:C.redLight}}>解除</Btn>}
        </div>
        {deadline&&(
          <div style={{fontSize:12,fontFamily:SANS,color:pastDeadline?C.red:C.green,
            padding:"8px 12px",borderRadius:8,background:pastDeadline?C.redBg:C.greenBg}}>
            {pastDeadline?"🔒 期限終了（"+fmtDs(deadline)+"）":"✅ 期限設定済み："+fmtDs(deadline)}
          </div>
        )}
      </div>
      {unsub.length>0&&(<>
        <SectionLabel>🔓 未提出スタッフへの延長許可</SectionLabel>
        {unsub.map((s,i)=>{
          const si=ctx.staff.findIndex(x=>x.id===s.id);
          const hasExt=extensions[monthKey]?.[s.id];
          return(
            <div key={s.id} style={{background:"#fff",borderRadius:12,padding:"12px 14px",marginBottom:8,
              display:"flex",alignItems:"center",gap:10,border:`1px solid ${C.latte}`}}>
              <Avatar name={s.name} idx={si} size={34}/>
              <span style={{flex:1,fontWeight:600,fontFamily:SANS,color:C.espresso}}>{s.name}</span>
              {hasExt
                ?<Btn variant="outline" onClick={()=>revoke(s.id)} style={{fontSize:11,padding:"5px 10px",color:C.red,borderColor:C.redLight}}>許可取消</Btn>
                :<Btn variant="outline" onClick={()=>grant(s.id)}  style={{fontSize:11,padding:"5px 10px",color:C.amber,borderColor:C.amberLight}}>延長許可</Btn>}
            </div>
          );
        })}
      </>)}
      {unsub.length===0&&<EmptyMsg>全スタッフ提出済みです ✅</EmptyMsg>}
    </div>
  );
}

/* ─── Sub Accept Modal ─── */
function SubAcceptModal({ sr, user, ctx, onCancel, onConfirm }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:9999,
      display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{background:"#fff",borderRadius:24,padding:"32px 24px",width:"100%",maxWidth:400,
        boxShadow:"0 24px 80px rgba(0,0,0,0.4)",textAlign:"center"}}>
        <div style={{fontSize:52,lineHeight:1,marginBottom:12}}>🤝</div>
        <div style={{fontFamily:SERIF,fontSize:22,color:C.espresso,marginBottom:8}}>
          代理を引き受けますか？
        </div>
        <div style={{background:C.paper,borderRadius:14,padding:"16px",marginBottom:16}}>
          <div style={{fontSize:12,color:C.g500,fontFamily:SANS,marginBottom:6}}>シフト詳細</div>
          <div style={{fontWeight:700,fontSize:17,color:C.espresso,fontFamily:SANS}}>
            {fmtDs(sr.dateStr)}（{sr.session==="night"?"夜の部":"昼の部"}）
          </div>
          <div style={{fontSize:15,color:C.mocha,fontFamily:SANS,marginTop:4,fontWeight:600}}>
            {sr.origEntry?.start||"OP"} 〜 {sr.origEntry?.end||"CL"}
          </div>
          <div style={{fontSize:12,color:C.g400,fontFamily:SANS,marginTop:6}}>
            欠勤者：{sr.fromName}
          </div>
        </div>
        <div style={{background:"#F0FDF4",borderRadius:12,padding:"10px 14px",marginBottom:20,
          border:`1px solid ${C.greenLight}`,fontSize:13,color:C.green,fontFamily:SANS}}>
          ✅ 承認すると確定シフトに自動反映されます
        </div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onCancel}
            style={{flex:1,padding:"13px",borderRadius:12,border:`1px solid ${C.latte}`,
              background:"#fff",color:C.g500,fontSize:14,cursor:"pointer",fontFamily:SANS}}>
            キャンセル
          </button>
          <button onClick={onConfirm}
            style={{flex:2,padding:"13px",borderRadius:12,border:"none",
              background:`linear-gradient(135deg,${C.espresso},${C.mocha})`,
              color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:SANS}}>
            承認する ✓
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Staff: 申請 & 受信 ─── */
function StaffRequestView({ user, ctx, acceptConfirm, setAcceptConfirm, declineConfirm, setDeclineConfirm }) {
  const { confirmed, absences, setAbsences, changeReqs, setChangeReqs,
          extReqs, setExtReqs, subReqs, setSubReqs,
          monthKey, year, month, prevM, nextM, staff, setConfirmed } = ctx;
  const myConfirmed = confirmed[monthKey]||{};

  const [type,       setType]       = useState("sub");   // sub | change | extend
  const [selKey,     setSelKey]     = useState("");
  const [reason,     setReason]     = useState("");
  const [newStart,   setNewStart]   = useState("09:00");
  const [newEnd,     setNewEnd]     = useState("15:00");
  const [counterEnd,     setCounterEnd]     = useState("15:00");
  const [sentInfo,    setSentInfo]    = useState(null); // 送信完了バナー
  const [declineInfo, setDeclineInfo] = useState(null); // 不可したシフトの確認バナー
  // acceptConfirm is lifted to StaffApp — received via props

  // My confirmed shifts
  // 代理申請済み（open/allDeclined/absenceSent）のシフトは除外
  const activeSubDates = new Set(
    (subReqs||[])
      .filter(r=>String(r.fromStaffId)===String(user.id)&&["open","allDeclined","absenceSent"].includes(r.status))
      .map(r=>`${r.dateStr}_${r.session}`)
  );
  const myShifts = Object.entries(myConfirmed).flatMap(([dateStr,sessions])=>{
    const rows=[];
    const dow = jpW(new Date(dateStr).getDay());
    const dayE  = sessions.day?.find(e=>String(e.staffId)===String(user.id));
    const nightE= sessions.night?.find(e=>String(e.staffId)===String(user.id));
    if(dayE   && !activeSubDates.has(`${dateStr}_day`))
      rows.push({dateStr,session:"day",
        label:`${fmtDs(dateStr)}（${dow}）昼 ${dayE.start}〜${dayE.end}`});
    if(nightE && !activeSubDates.has(`${dateStr}_night`))
      rows.push({dateStr,session:"night",
        label:`${fmtDs(dateStr)}（${dow}）夜 ${nightE.start}〜${nightE.end}`});
    return rows;
  }).sort((a,b)=>a.dateStr.localeCompare(b.dateStr));

  const selObj = selKey ? JSON.parse(selKey) : null;

  // Incoming extension requests from manager
  const myExtReqs = (extReqs||[]).filter(e=>String(e.staffId)===String(user.id)&&e.status==="pending");
  // Open sub requests from peers (not from me AND not already declined by me)
  const openSubReqs = (subReqs||[]).filter(r=>
    r.status==="open" &&
    String(r.fromStaffId)!==String(user.id) &&
    !(r.decliners||[]).map(String).includes(String(user.id))
  );
  // My own sub requests (to show status)
  const mySubReqs = (subReqs||[]).filter(r=>String(r.fromStaffId)===String(user.id));

  function submitRequest() {
    if(!selKey||!reason.trim()) return;
    const id=Date.now();
    if(type==="sub") {
      if(!selObj) return;
      // Absent: send sub request to ALL other staff (no admin notification)
      const existingConf = myConfirmed[selObj.dateStr]?.[selObj.session]?.find(e=>String(e.staffId)===String(user.id));
      setSubReqs(prev=>[...prev,{id,fromStaffId:user.id,fromName:user.name,
        dateStr:selObj.dateStr,session:selObj.session,reason:reason.trim(),
        origEntry:existingConf?{start:existingConf.start,end:existingConf.end}:{start:"OP",end:"CL"},
        status:"open",acceptedBy:null,acceptedByName:null}]);
      // Notify all other staff
      staff.filter(s=>String(s.id)!==String(user.id)).forEach(s=>{
        ctx.pushNotif(String(s.id),"subreq",`🆘 ${user.name}：${fmtDs(selObj.dateStr)}（${selObj.session==="night"?"夜":"昼"}）代理募集中`);
      });
      // Also notify admin
      ctx.pushNotif("0","subreq",`🆘 ${user.name}が${fmtDs(selObj.dateStr)}（${selObj.session==="night"?"夜":"昼"}）の代理申請を開始しました`);
    } else {
      // Change or extend → goes to admin
      const base={id,staffId:user.id,name:user.name,dateStr:selObj.dateStr,session:selObj.session,
        reason:reason.trim(),status:"pending",requestedAt:new Date().toISOString()};
      setChangeReqs(prev=>[...prev,{...base,newEntry:{start:newStart,end:newEnd},reqType:type}]);
      ctx.pushNotif("0","change",`${type==="extend"?"⏰":"🔄"} ${user.name}：${fmtDs(selObj.dateStr)} ${type==="extend"?"延長":"変更"}申請`);
    }
    const sentLabel = myShifts.find(s=>s.dateStr===selObj?.dateStr&&s.session===selObj?.session)?.label||"";
    setSentInfo({type,dateStr:selObj?.dateStr,session:selObj?.session,label:sentLabel});
    setReason(""); setSelKey("");
  }

  function declineSubReq(sr) {
    const otherStaff = staff.filter(s=>String(s.id)!==String(sr.fromStaffId));
    const newDecliners = [...new Set([...(sr.decliners||[]).map(String), String(user.id)])];
    const allDone = otherStaff.every(s=>newDecliners.includes(String(s.id)));
    setSubReqs(prev=>prev.map(r=>
      r.id===sr.id
        ? {...r, decliners:newDecliners, status:allDone?"allDeclined":"open"}
        : r
    ));
    // 不可した人に確認バナーを表示
    setDeclineInfo({sr, allDone});
    if(allDone) {
      // 欠勤申請者本人に通知（「全員不可」を知らせる）
      ctx.pushNotif(String(sr.fromStaffId),"subreq",`😔 ${fmtDs(sr.dateStr)}（${sr.session==="night"?"夜":"昼"}）全員が不可のため代理が見つかりませんでした`);
    }
  }

  function sendAbsenceToAdmin(sr) {
    const id=Date.now();
    setAbsences(prev=>[...prev,{id,staffId:user.id,name:user.name,
      dateStr:sr.dateStr,session:sr.session,
      reason:sr.reason,status:"pending",requestedAt:new Date().toISOString()}]);
    ctx.pushNotif("0","absence",`🤒 ${user.name}：${fmtDs(sr.dateStr)} 欠勤申請（代理不在）`);
    // Mark sub request as closed
    setSubReqs(prev=>prev.map(r=>r.id===sr.id?{...r,status:"absenceSent"}:r));
  }

  function startAcceptSubReq(sr) {
    // Show confirmation screen first
    setAcceptConfirm(sr);
  }

  function acceptSubReq(sr) {
    setAcceptConfirm(null);
    // Accept the substitute request
    const newStatus = {status:"accepted",acceptedBy:user.id,acceptedByName:user.name};
    setSubReqs(prev=>prev.map(r=>r.id===sr.id ? {...r,...newStatus} : r));
    // Auto-update confirmed shift: remove absentee, add me
    setConfirmed(prev=>{
      const c=JSON.parse(JSON.stringify(prev));
      const sess=c[monthKey]?.[sr.dateStr]?.[sr.session];
      if(sess){
        // Remove original absentee
        const filtered=sess.filter(e=>String(e.staffId)!==String(sr.fromStaffId));
        // Add me if not already there
        if(!filtered.find(e=>String(e.staffId)===String(user.id))){
          filtered.push({staffId:user.id,name:user.name,
            start:sr.origEntry?.start||"OP",end:sr.origEntry?.end||"CL"});
        }
        c[monthKey][sr.dateStr][sr.session]=filtered;
      }
      return c;
    });
    // Delete ALL other open sub requests for the same slot (cancel them)
    setSubReqs(prev=>prev.map(r=>
      r.id!==sr.id && r.dateStr===sr.dateStr && r.session===sr.session && r.status==="open"
        ? {...r,status:"cancelled"} : r
    ));
    // Notify original absentee and admin
    ctx.pushNotif(String(sr.fromStaffId),"subreq",`✅ ${user.name}が${fmtDs(sr.dateStr)}の代理を引き受けました`);
    ctx.pushNotif("0","subreq",`✅ ${user.name}が${fmtDs(sr.dateStr)}の代理→シフト自動更新済み`);
  }

  function acceptExtReq(er) {
    setExtReqs(prev=>prev.map(e=>e.id===er.id?{...e,status:"accepted",confirmedEnd:er.reqEnd}:e));
    ctx.pushNotif("0","extreq",`✅ ${user.name}が${fmtDs(er.dateStr)}延長を承認（〜${er.reqEnd}）`);
  }
  function counterExtReq(er) {
    setExtReqs(prev=>prev.map(e=>e.id===er.id?{...e,status:"countered",counterEnd}:e));
    ctx.pushNotif("0","extreq",`🔄 ${user.name}が${fmtDs(er.dateStr)}延長をカウンター（〜${counterEnd}）`);
  }
  function rejectExtReq(er) {
    setExtReqs(prev=>prev.map(e=>e.id===er.id?{...e,status:"rejected"}:e));
    ctx.pushNotif("0","extreq",`❌ ${user.name}が${fmtDs(er.dateStr)}延長を断りました`);
  }

  const myCh = (changeReqs||[]).filter(r=>String(r.staffId)===String(user.id));
  const sbadge=s=>s==="approved"||s==="accepted"?<span style={SBadge.green}>承認済</span>:s==="rejected"?<span style={SBadge.red}>却下</span>:s==="cancelled"?<span style={SBadge.amber}>取消</span>:<span style={SBadge.amber}>審査中</span>;

  return(
    <div style={{paddingBottom:60}}>
      <MonthNav year={year} month={month} onPrev={prevM} onNext={nextM}/>
      <div style={{padding:"0 16px"}}>

        {/* ── 管理者からの延長依頼 ── */}
        {myExtReqs.length>0&&(<>
          <SectionLabel>⏰ 管理者から延長依頼（{myExtReqs.length}件）</SectionLabel>
          {myExtReqs.map(er=>{
            const curEntry=myConfirmed[er.dateStr]?.[er.session]?.find(e=>String(e.staffId)===String(user.id));
            return(
              <div key={er.id} style={{background:"#fff",borderRadius:14,padding:"14px 16px",marginBottom:12,
                border:`1.5px solid ${C.caramel}`}}>
                <div style={{fontWeight:700,color:C.espresso,fontFamily:SANS,fontSize:14,marginBottom:8}}>
                  📋 {fmtDs(er.dateStr)}（{er.session==="night"?"夜":"昼"}）の延長依頼
                </div>
                <div style={{display:"flex",gap:8,marginBottom:10}}>
                  {curEntry&&<div style={{flex:1,background:C.paper,borderRadius:8,padding:"8px 10px",fontSize:12,fontFamily:SANS}}>
                    <div style={{color:C.g400,fontSize:10,marginBottom:2}}>現在</div>
                    <div style={{fontWeight:600,color:C.espresso}}>{curEntry.start} 〜 {curEntry.end}</div>
                  </div>}
                  <div style={{color:C.caramel,fontSize:18,alignSelf:"center"}}>→</div>
                  <div style={{flex:1,background:C.amberBg,borderRadius:8,padding:"8px 10px",fontSize:12,fontFamily:SANS,border:`1px solid ${C.amberLight}`}}>
                    <div style={{color:C.amber,fontSize:10,marginBottom:2}}>依頼時間</div>
                    <div style={{fontWeight:700,color:C.mocha}}>{curEntry?.start||"OP"} 〜 {er.reqEnd}</div>
                  </div>
                </div>
                {er.note&&<div style={{fontSize:12,color:C.g500,fontFamily:SANS,marginBottom:10}}>📝 {er.note}</div>}
                {/* Counter */}
                <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:10,background:C.paper,
                  borderRadius:8,padding:"8px 10px"}}>
                  <span style={{fontSize:12,color:C.g500,fontFamily:SANS,flexShrink:0}}>カウンター提案：〜</span>
                  <select style={{...selectSt,flex:1,padding:"5px 8px",fontSize:14}} value={counterEnd}
                    onChange={e=>setCounterEnd(e.target.value)}>
                    {DAY_TIMES.filter(t=>!isSentinel(t)).map(t=><option key={t}>{t}</option>)}
                  </select>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <Btn variant="primary" onClick={()=>acceptExtReq(er)}
                    style={{flex:1,justifyContent:"center",fontSize:12,padding:"9px",background:`linear-gradient(135deg,${C.green},#10B981)`}}>
                    ✅ 〜{er.reqEnd}でOK
                  </Btn>
                  <Btn variant="outline" onClick={()=>counterExtReq(er)}
                    style={{flex:1,justifyContent:"center",fontSize:12,padding:"9px",color:C.amber,borderColor:C.amberLight}}>
                    🔄 〜{counterEnd}で提案
                  </Btn>
                  <Btn variant="outline" onClick={()=>rejectExtReq(er)}
                    style={{justifyContent:"center",fontSize:12,padding:"9px",color:C.red,borderColor:C.redLight}}>❌</Btn>
                </div>
              </div>
            );
          })}
        </>)}

        {/* ── 仲間からの代理募集 ── */}
        {openSubReqs.length>0&&(<>
          <SectionLabel>🆘 代理募集 — 助けてください！（{openSubReqs.length}件）</SectionLabel>
          {openSubReqs.map(sr=>(
            <div key={sr.id} style={{background:"#fff",borderRadius:14,padding:"14px 16px",marginBottom:10,
              border:`1.5px solid ${C.redLight}`}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                <span style={{fontSize:22}}>🆘</span>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:C.espresso,fontFamily:SANS,fontSize:14}}>
                    {fmtDs(sr.dateStr)}（{sr.session==="night"?"夜":"昼"}）
                  </div>
                  <div style={{fontSize:12,color:C.g500,fontFamily:SANS}}>
                    {sr.fromName}が代理を探しています
                  </div>
                  {sr.origEntry&&<div style={{fontSize:12,color:C.g400,fontFamily:SANS}}>
                    シフト時間：{sr.origEntry.start} 〜 {sr.origEntry.end}
                  </div>}
                </div>
              </div>
              <div style={{background:C.redBg,borderRadius:8,padding:"6px 10px",marginBottom:10,
                fontSize:11,color:C.red,fontFamily:SANS}}>
                理由：{sr.reason}
              </div>
              <div style={{display:"flex",gap:8}}>
                <Btn variant="primary" onClick={()=>startAcceptSubReq(sr)}
                  style={{flex:2,justifyContent:"center",fontSize:13,padding:"12px",
                    background:`linear-gradient(135deg,${C.espresso},${C.mocha})`}}>
                  代理を引き受ける
                </Btn>
                <button onClick={()=>setDeclineConfirm({...sr, __doDecline:()=>declineSubReq(sr)})}
                  style={{flex:1,padding:"12px",borderRadius:11,cursor:"pointer",
                    fontFamily:SANS,fontSize:13,fontWeight:700,
                    background:C.redBg,color:C.red,border:`2px solid ${C.red}`}}>
                  ✕ 不可
                </button>
              </div>
            </div>
          ))}
        </>)}

        {/* ── 不可確認バナー ── */}
        {declineInfo && (
          <div style={{background:C.redBg,borderRadius:14,padding:"16px",marginBottom:14,
            border:`1px solid ${C.redLight}`,display:"flex",gap:12,alignItems:"flex-start"}}>
            <span style={{fontSize:28}}>✕</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,color:C.red,fontFamily:SANS,fontSize:15,marginBottom:4}}>
                不可にしました
              </div>
              <div style={{fontSize:13,color:C.g600,fontFamily:SANS,marginBottom:4}}>
                {fmtDs(declineInfo.sr.dateStr)}（{declineInfo.sr.session==="night"?"夜":"昼"}）
                {declineInfo.sr.origEntry && ` ${declineInfo.sr.origEntry.start}〜${declineInfo.sr.origEntry.end}`}
              </div>
              {declineInfo.allDone
                ? <div style={{fontSize:12,color:C.red,fontFamily:SANS}}>
                    全員が不可のため、{declineInfo.sr.fromName}さんに通知しました。
                  </div>
                : <div style={{fontSize:12,color:C.g500,fontFamily:SANS}}>
                    他のスタッフに引き続き代理を募集しています。
                  </div>
              }
              <button onClick={()=>setDeclineInfo(null)}
                style={{marginTop:8,fontSize:11,color:C.g400,background:"none",border:"none",
                  cursor:"pointer",fontFamily:SANS,textDecoration:"underline",padding:0}}>
                閉じる
              </button>
            </div>
          </div>
        )}

        {/* ── 送信完了バナー ── */}
        {sentInfo && (
          <div style={{background:"#F0FDF4",borderRadius:14,padding:"16px",marginBottom:14,
            border:`1px solid ${C.greenLight}`,display:"flex",gap:12,alignItems:"flex-start"}}>
            <span style={{fontSize:28}}>✅</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,color:C.green,fontFamily:SANS,fontSize:15,marginBottom:4}}>
                {sentInfo.type==="sub"?"代理を募集しました":"申請を送信しました"}
              </div>
              {sentInfo.label&&(
                <div style={{fontSize:13,color:C.g600,fontFamily:SANS}}>{sentInfo.label}</div>
              )}
              {sentInfo.type==="sub"&&(
                <div style={{fontSize:12,color:C.g500,fontFamily:SANS,marginTop:4}}>
                  他のスタッフに通知しました。誰かが引き受けるとシフトが自動更新されます。
                </div>
              )}
              <button onClick={()=>setSentInfo(null)}
                style={{marginTop:8,fontSize:11,color:C.g400,background:"none",border:"none",
                  cursor:"pointer",fontFamily:SANS,textDecoration:"underline",padding:0}}>
                閉じる
              </button>
            </div>
          </div>
        )}

        {/* ── 申請フォーム ── */}
        <SectionLabel>📝 申請する</SectionLabel>
        <div style={{background:"#fff",borderRadius:14,padding:"16px",marginBottom:16,border:`1px solid ${C.latte}`}}>
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            {[["sub","🆘 欠勤・代理"],["change","🔄 時間変更"],["extend","⏰ 延長"]].map(([v,l])=>(
              <button key={v} onClick={()=>setType(v)} style={{flex:1,padding:"8px 4px",borderRadius:9,cursor:"pointer",
                fontFamily:SANS,fontSize:12,border:`1.5px solid ${type===v?C.caramel:C.latte}`,
                background:type===v?`${C.caramel}15`:"#fff",color:type===v?C.mocha:C.g500,fontWeight:type===v?700:400}}>{l}</button>
            ))}
          </div>
          {type==="sub"&&(
            <div style={{background:C.amberBg,borderRadius:8,padding:"8px 12px",marginBottom:10,
              fontSize:12,color:C.amber,fontFamily:SANS}}>
              ⚠️ 欠勤する代わりに、他のスタッフに代理を自動募集します。誰かが引き受けた時点でシフトが更新されます。
            </div>
          )}
          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginBottom:4}}>対象シフト</div>
            {myShifts.length===0
              ?<p style={{fontSize:12,color:C.g400,fontFamily:SANS}}>確定シフトがありません</p>
              :<select style={selectSt} value={selKey} onChange={e=>setSelKey(e.target.value)}>
                <option value="">選択してください</option>
                {myShifts.map(({dateStr,session,label})=>(
                  <option key={dateStr+session} value={JSON.stringify({dateStr,session})}>{label}</option>
                ))}
              </select>
            }
          </div>
          {(type==="change"||type==="extend")&&selKey&&(()=>{
            const curEntry=myConfirmed[selObj.dateStr]?.[selObj.session]?.find(e=>String(e.staffId)===String(user.id));
            return(<div style={{marginBottom:10}}>
              {curEntry&&<div style={{background:C.paper,borderRadius:8,padding:"8px 10px",marginBottom:8,
                fontSize:12,color:C.g500,fontFamily:SANS}}>現在：{curEntry.start} 〜 {curEntry.end}</div>}
              <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginBottom:4}}>新開始</div>
                  <select style={selectSt} value={newStart} onChange={e=>setNewStart(e.target.value)}>
                    {DAY_TIMES.map(t=><option key={t}>{t}</option>)}
                  </select>
                </div>
                <div style={{color:C.g400,paddingBottom:12}}>→</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginBottom:4}}>新終了</div>
                  <select style={selectSt} value={newEnd} onChange={e=>setNewEnd(e.target.value)}>
                    {DAY_TIMES.filter(t=>!isSentinel(t)&&t>newStart).map(t=><option key={t}>{t}</option>)}
                  </select>
                </div>
              </div>
            </div>);
          })()}
          <div style={{marginBottom:12}}>
            <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginBottom:4}}>
              {type==="sub"?"欠勤理由":"理由"}
            </div>
            <input style={{...inputSt,width:"100%",boxSizing:"border-box"}}
              placeholder={type==="sub"?"例：体調不良のため代理をお願いします":type==="extend"?"例：閉店作業があるため":"例：用事があります"}
              value={reason} onChange={e=>setReason(e.target.value)}/>
          </div>

          <Btn variant="primary" full onClick={submitRequest} disabled={!selKey||!reason.trim()}
            style={{justifyContent:"center"}}>
            {type==="sub"?"代理を募集する":"申請を送信する"}
          </Btn>
        </div>

        {/* ── 自分の代理募集状況 ── */}
        {mySubReqs.length>0&&(<>
          <SectionLabel>🆘 代理募集の状況</SectionLabel>
          {mySubReqs.map(sr=>(
            <div key={sr.id} style={{background:"#fff",borderRadius:12,padding:"11px 14px",marginBottom:8,border:`1px solid ${C.latte}`}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span>🆘</span>
                <span style={{fontWeight:700,fontSize:13,fontFamily:SANS,color:C.espresso,flex:1}}>
                  {fmtDs(sr.dateStr)}（{sr.session==="night"?"夜":"昼"}）代理募集
                </span>
                {sr.status==="accepted"?<span style={SBadge.green}>✅ 代理確定</span>
                  :sr.status==="cancelled"?<span style={SBadge.amber}>取消</span>
                  :sr.status==="allDeclined"?<span style={SBadge.red}>全員不可</span>
                  :sr.status==="absenceSent"?<span style={SBadge.amber}>欠勤申請済</span>
                  :<span style={SBadge.amber}>募集中</span>}
              </div>
              {sr.acceptedByName&&<div style={{fontSize:12,color:C.green,fontFamily:SANS,marginTop:3}}>
                👤 {sr.acceptedByName}が引き受けました
              </div>}
              {sr.status==="allDeclined"&&(
                <div style={{marginTop:8,background:C.redBg,borderRadius:10,padding:"10px 12px",border:`1px solid ${C.redLight}`}}>
                  <div style={{fontSize:13,color:C.red,fontFamily:SANS,marginBottom:8}}>
                    😔 全員が不可でした。
                    管理者に欠勤申請を送りますか？
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <Btn variant="primary" onClick={()=>sendAbsenceToAdmin(sr)}
                      style={{flex:1,justifyContent:"center",fontSize:12,padding:"8px",
                        background:`linear-gradient(135deg,${C.red},#EF4444)`}}>
                      はい、送信する
                    </Btn>
                    <Btn variant="outline" onClick={()=>setSubReqs(prev=>prev.map(r=>r.id===sr.id?{...r,status:"closed"}:r))}
                      style={{flex:1,justifyContent:"center",fontSize:12,padding:"8px",color:C.g500}}>
                      いいえ
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          ))}
        </>)}

        {/* ── 変更・延長申請履歴 ── */}
        {myCh.length>0&&(<>
          <SectionLabel>📋 変更・延長申請の履歴</SectionLabel>
          {myCh.map(r=>(
            <div key={r.id} style={{background:"#fff",borderRadius:12,padding:"11px 14px",marginBottom:8,border:`1px solid ${C.latte}`}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span>{r.reqType==="extend"?"⏰":"🔄"}</span>
                <span style={{fontWeight:700,fontSize:13,fontFamily:SANS,color:C.espresso,flex:1}}>
                  {fmtDs(r.dateStr)} {r.reqType==="extend"?"延長":"変更"}申請</span>
                {sbadge(r.status)}
              </div>
              <div style={{fontSize:12,color:C.g500,fontFamily:SANS,marginTop:3}}>
                {r.newEntry.start}〜{r.newEntry.end}　{r.reason}</div>
            </div>
          ))}
        </>)}
      </div>

    </div>
  );
}

/* ─── Admin: 申請管理 ─── */
function AdminRequestsView({ ctx }) {
  const { staff, absences, setAbsences, changeReqs, setChangeReqs,
          extReqs, setExtReqs, subReqs, setSubReqs,
          confirmed, setConfirmed, monthKey, year, month, prevM, nextM } = ctx;

  const pendingAb  = (absences||[]).filter(a=>a.status==="pending");
  const pendingCh  = (changeReqs||[]).filter(r=>r.status==="pending");
  // extReqs awaiting admin action (accepted/countered/rejected by staff)
  const respondedExt = (extReqs||[]).filter(e=>["accepted","countered","rejected"].includes(e.status));
  const histAll = [...(absences||[]).filter(a=>a.status!=="pending"),
                   ...(changeReqs||[]).filter(r=>r.status!=="pending")]
                  .sort((a,b)=>b.id-a.id);

  function confirmAccepted(er) {
    setConfirmed(prev=>{
      const c=JSON.parse(JSON.stringify(prev));
      const sess=c[monthKey]?.[er.dateStr]?.[er.session];
      if(sess){const idx=sess.findIndex(e=>String(e.staffId)===String(er.staffId));
        if(idx>=0)sess[idx]={...sess[idx],end:er.reqEnd};}
      return c;
    });
    setExtReqs(prev=>prev.map(e=>e.id===er.id?{...e,status:"confirmed"}:e));
    // Sync open sub requests for this staff/date: update origEntry with new end time
    setSubReqs(prev=>prev.map(r=>
      String(r.fromStaffId)===String(er.staffId) &&
      r.dateStr===er.dateStr && r.session===er.session &&
      (r.status==="open"||r.status==="allDeclined")
        ? {...r, origEntry:{...r.origEntry, end:er.reqEnd}}
        : r
    ));
    ctx.pushNotif(String(er.staffId),"confirmed",`✅ ${fmtDs(er.dateStr)}の延長（〜${er.reqEnd}）がシフトに反映されました`);
  }
  function confirmCounter(er) {
    setConfirmed(prev=>{
      const c=JSON.parse(JSON.stringify(prev));
      const sess=c[monthKey]?.[er.dateStr]?.[er.session];
      if(sess){const idx=sess.findIndex(e=>String(e.staffId)===String(er.staffId));
        if(idx>=0)sess[idx]={...sess[idx],end:er.counterEnd};}
      return c;
    });
    setExtReqs(prev=>prev.map(e=>e.id===er.id?{...e,status:"confirmed"}:e));
    // Sync open sub requests
    setSubReqs(prev=>prev.map(r=>
      String(r.fromStaffId)===String(er.staffId) &&
      r.dateStr===er.dateStr && r.session===er.session &&
      (r.status==="open"||r.status==="allDeclined")
        ? {...r, origEntry:{...r.origEntry, end:er.counterEnd}}
        : r
    ));
    ctx.pushNotif(String(er.staffId),"confirmed",`✅ カウンター提案（〜${er.counterEnd}）が確定しました`);
  }
  function rejectExt(er) {
    setExtReqs(prev=>prev.map(e=>e.id===er.id?{...e,status:"confirmed"}:e));
  }
  function approveAbsence(ab) {
    setConfirmed(prev=>{
      const c=JSON.parse(JSON.stringify(prev));
      const sess=c[monthKey]?.[ab.dateStr]?.[ab.session];
      if(sess)c[monthKey][ab.dateStr][ab.session]=sess.filter(e=>String(e.staffId)!==String(ab.staffId));
      return c;
    });
    setAbsences(prev=>prev.map(a=>a.id===ab.id?{...a,status:"approved"}:a));
    ctx.pushNotif(String(ab.staffId),"confirmed",`✅ ${fmtDs(ab.dateStr)} 欠勤が承認されました`);
  }
  function rejectReq(id,staffId,dateStr,isAb) {
    if(isAb) setAbsences(prev=>prev.map(a=>a.id===id?{...a,status:"rejected"}:a));
    else     setChangeReqs(prev=>prev.map(r=>r.id===id?{...r,status:"rejected"}:r));
    ctx.pushNotif(String(staffId),"confirmed",`❌ ${fmtDs(dateStr)} の申請が却下されました`);
  }
  function approveChange(cr) {
    setConfirmed(prev=>{
      const c=JSON.parse(JSON.stringify(prev));
      const sess=c[monthKey]?.[cr.dateStr]?.[cr.session];
      if(sess){const idx=sess.findIndex(e=>String(e.staffId)===String(cr.staffId));
        if(idx>=0)sess[idx]={...sess[idx],start:cr.newEntry.start,end:cr.newEntry.end};}
      return c;
    });
    setChangeReqs(prev=>prev.map(r=>r.id===cr.id?{...r,status:"approved"}:r));
    // Sync open sub requests with updated start/end
    setSubReqs(prev=>prev.map(r=>
      String(r.fromStaffId)===String(cr.staffId) &&
      r.dateStr===cr.dateStr && r.session===cr.session &&
      (r.status==="open"||r.status==="allDeclined")
        ? {...r, origEntry:{start:cr.newEntry.start, end:cr.newEntry.end}}
        : r
    ));
    ctx.pushNotif(String(cr.staffId),"confirmed",`✅ ${fmtDs(cr.dateStr)} ${cr.reqType==="extend"?"延長":"変更"}が承認されました`);
  }

  const sbadge=s=>s==="approved"||s==="accepted"||s==="confirmed"?<span style={SBadge.green}>承認</span>:s==="rejected"?<span style={SBadge.red}>却下</span>:<span style={SBadge.amber}>審査中</span>;
  const hasAnything = pendingAb.length||pendingCh.length||respondedExt.filter(e=>e.status!=="confirmed").length;

  return(
    <div style={{padding:"0 16px 60px"}}>
      <MonthNav year={year} month={month} onPrev={prevM} onNext={nextM}/>

      {/* ── 延長依頼への返答 ── */}
      {respondedExt.filter(e=>e.status!=="confirmed").length>0&&(<>
        <SectionLabel>📬 延長依頼への返答</SectionLabel>
        {respondedExt.filter(e=>e.status!=="confirmed").map(er=>(
          <div key={er.id} style={{background:"#fff",borderRadius:14,padding:"14px 16px",marginBottom:10,
            border:`1.5px solid ${er.status==="accepted"?C.greenLight:er.status==="countered"?C.amberLight:C.redLight}`}}>
            <div style={{fontWeight:700,color:C.espresso,fontFamily:SANS,marginBottom:8}}>
              {er.name}　{fmtDs(er.dateStr)}（{er.session==="night"?"夜":"昼"}）
            </div>
            {er.status==="accepted"&&(
              <div style={{background:C.greenBg,borderRadius:8,padding:"8px 12px",marginBottom:10,
                fontSize:12,color:C.green,fontFamily:SANS}}>✅ 〜{er.reqEnd}まで承認</div>
            )}
            {er.status==="countered"&&(
              <div style={{background:C.amberBg,borderRadius:8,padding:"8px 12px",marginBottom:10,
                fontSize:12,color:C.amber,fontFamily:SANS}}>
                🔄 カウンター：〜{er.counterEnd}（依頼：〜{er.reqEnd}）
              </div>
            )}
            {er.status==="rejected"&&(
              <div style={{background:C.redBg,borderRadius:8,padding:"8px 12px",marginBottom:10,
                fontSize:12,color:C.red,fontFamily:SANS}}>❌ 断られました</div>
            )}
            {er.status==="accepted"&&(
              <Btn variant="primary" onClick={()=>confirmAccepted(er)} full
                style={{justifyContent:"center",fontSize:12,background:`linear-gradient(135deg,${C.green},#10B981)`}}>
                ✅ シフトを〜{er.reqEnd}に確定
              </Btn>
            )}
            {er.status==="countered"&&(
              <div style={{display:"flex",gap:8}}>
                <Btn variant="primary" onClick={()=>confirmCounter(er)}
                  style={{flex:1,justifyContent:"center",fontSize:12,background:`linear-gradient(135deg,${C.green},#10B981)`}}>
                  ✅ 〜{er.counterEnd}で確定
                </Btn>
                <Btn variant="outline" onClick={()=>rejectExt(er)}
                  style={{flex:1,justifyContent:"center",fontSize:12,color:C.red,borderColor:C.redLight}}>
                  ❌ 却下
                </Btn>
              </div>
            )}
            {er.status==="rejected"&&(
              <Btn variant="outline" onClick={()=>rejectExt(er)} full
                style={{justifyContent:"center",fontSize:12,color:C.g400}}>閉じる</Btn>
            )}
          </div>
        ))}
      </>)}

      {/* ── 欠勤申請（管理者への直接申請がある場合のみ） ── */}
      {pendingAb.map(ab=>{
        const si=staff.findIndex(s=>String(s.id)===String(ab.staffId));
        return(
          <div key={ab.id} style={{background:"#fff",borderRadius:14,padding:"14px 16px",marginBottom:10,border:`1.5px solid ${C.redLight}`}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
              <Avatar name={ab.name} idx={si} size={34}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,color:C.espresso,fontFamily:SANS}}>🤒 欠勤申請</div>
                <div style={{fontSize:12,color:C.g500,fontFamily:SANS}}>{ab.name}　{fmtDs(ab.dateStr)}（{ab.session==="night"?"夜":"昼"}）</div>
              </div>
            </div>
            <div style={{background:C.redBg,borderRadius:8,padding:"8px 12px",marginBottom:10,fontSize:12,color:C.red,fontFamily:SANS}}>
              理由：{ab.reason}</div>
            <div style={{display:"flex",gap:8}}>
              <Btn variant="primary" onClick={()=>approveAbsence(ab)}
                style={{flex:1,justifyContent:"center",fontSize:12,padding:"9px",background:`linear-gradient(135deg,${C.green},#10B981)`}}>
                ✅ 承認（シフト削除）</Btn>
              <Btn variant="outline" onClick={()=>rejectReq(ab.id,ab.staffId,ab.dateStr,true)}
                style={{flex:1,justifyContent:"center",fontSize:12,padding:"9px",color:C.red,borderColor:C.redLight}}>
                ❌ 却下</Btn>
            </div>
          </div>
        );
      })}

      {/* ── 変更・延長申請 ── */}
      {pendingCh.map(cr=>{
        const si=staff.findIndex(s=>String(s.id)===String(cr.staffId));
        const curEntry=confirmed[monthKey]?.[cr.dateStr]?.[cr.session]?.find(e=>String(e.staffId)===String(cr.staffId));
        return(
          <div key={cr.id} style={{background:"#fff",borderRadius:14,padding:"14px 16px",marginBottom:10,border:`1.5px solid ${C.nightAcc}60`}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <Avatar name={cr.name} idx={si} size={34}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,color:C.espresso,fontFamily:SANS}}>{cr.reqType==="extend"?"⏰ 延長申請":"🔄 変更申請"}</div>
                <div style={{fontSize:12,color:C.g500,fontFamily:SANS}}>{cr.name}　{fmtDs(cr.dateStr)}（{cr.session==="night"?"夜":"昼"}）</div>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              {curEntry&&<div style={{flex:1,background:C.paper,borderRadius:8,padding:"8px 10px",fontSize:12,fontFamily:SANS}}>
                <div style={{color:C.g400,fontSize:10}}>現在</div>
                <div style={{fontWeight:600}}>{curEntry.start} 〜 {curEntry.end}</div>
              </div>}
              <div style={{color:C.caramel,fontSize:16}}>→</div>
              <div style={{flex:1,background:"#EEF0FF",borderRadius:8,padding:"8px 10px",fontSize:12,fontFamily:SANS}}>
                <div style={{color:C.nightAcc,fontSize:10}}>希望</div>
                <div style={{fontWeight:700}}>{cr.newEntry.start} 〜 {cr.newEntry.end}</div>
              </div>
            </div>
            <div style={{background:C.paper,borderRadius:8,padding:"8px 10px",marginBottom:10,fontSize:12,color:C.g500,fontFamily:SANS}}>
              理由：{cr.reason}</div>
            <div style={{display:"flex",gap:8}}>
              <Btn variant="primary" onClick={()=>approveChange(cr)}
                style={{flex:1,justifyContent:"center",fontSize:12,padding:"9px",background:`linear-gradient(135deg,${C.green},#10B981)`}}>
                ✅ 承認（更新）</Btn>
              <Btn variant="outline" onClick={()=>rejectReq(cr.id,cr.staffId,cr.dateStr,false)}
                style={{flex:1,justifyContent:"center",fontSize:12,padding:"9px",color:C.red,borderColor:C.redLight}}>
                ❌ 却下</Btn>
            </div>
          </div>
        );
      })}

      {!hasAnything&&<EmptyMsg>未処理の申請はありません<br/><span style={{fontSize:12,color:C.g400}}>延長依頼はシフト作成タブの確定済みシフトから送れます</span></EmptyMsg>}

      {histAll.length>0&&(
        <details style={{marginTop:16}}>
          <summary style={{fontSize:13,color:C.g500,fontFamily:SANS,cursor:"pointer",marginBottom:8}}>
            処理済み（{histAll.length}件）
          </summary>
          {histAll.map(item=>(
            <div key={item.id} style={{background:"#fff",borderRadius:10,padding:"10px 12px",marginBottom:6,
              border:`1px solid ${C.latte}`,display:"flex",alignItems:"center",gap:8}}>
              <span>{!item.reqType?"🤒":item.reqType==="extend"?"⏰":"🔄"}</span>
              <div style={{flex:1,fontFamily:SANS}}>
                <span style={{fontSize:13,fontWeight:600}}>{item.name}</span>
                <span style={{fontSize:12,color:C.g500,marginLeft:6}}>{fmtDs(item.dateStr)}</span>
              </div>
              {sbadge(item.status)}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// Badge style constants
const SBadge = {
  green: {display:"inline-block",fontSize:10,borderRadius:6,padding:"1px 7px",
    background:C.greenBg,color:C.green,border:`1px solid ${C.greenLight}`,fontFamily:SANS,fontWeight:700},
  red:   {display:"inline-block",fontSize:10,borderRadius:6,padding:"1px 7px",
    background:C.redBg,color:C.red,border:`1px solid ${C.redLight}`,fontFamily:SANS,fontWeight:700},
  amber: {display:"inline-block",fontSize:10,borderRadius:6,padding:"1px 7px",
    background:C.amberBg,color:C.amber,border:`1px solid ${C.amberLight}`,fontFamily:SANS,fontWeight:700},
};

/* ─── Admin Settings ─── */
function AdminSettings({ ctx }) {
  const { staff, setStaff, messages, setMessages,
          setShifts, setConfirmed, setHelpReqs, setNotifs,
          setAbsences, setChangeReqs, setExtReqs, setSubReqs,
          testMode, setTestMode } = ctx;
  const [newFamily, setNewFamily] = useState(""); // 姓
  const [newGiven,  setNewGiven]  = useState(""); // 名
  const [editId,    setEditId]    = useState(null);
  const [editVal,   setEditVal]   = useState("");
  const [resetConfirm,  setResetConfirm]  = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null); // {id, name} of staff to delete
  const unlockReqs = messages.filter(m=>m.isUnlockReq&&!m.resolved);

  function resolveUnlock(m) {
    setStaff(prev=>prev.map(s=>s.id===m.staffId
      ?{...s,pin:null,recoveryAnswer:null,recoveryQuestion:null}:s));
    setMessages(prev=>prev.map(msg=>msg.id===m.id?{...msg,resolved:true}:msg));
  }
  function addStaff() {
    const family = newFamily.trim();
    const given  = newGiven.trim();
    if (!family && !given) return;
    const name = family && given ? `${family} ${given}` : family || given;
    const id = staff.length > 0 ? Math.max(...staff.map(s=>s.id)) + 1 : 1;
    setStaff(prev=>[...prev,{id,name,pin:null,recoveryAnswer:null,recoveryQuestion:null}]);
    setNewFamily(""); setNewGiven("");
  }
  function resetAllData() {
    // データリセット: staffはそのまま、シフト/チャット等を全消去
    setShifts({});
    setConfirmed({});
    setMessages([]);
    setHelpReqs([]);
    setNotifs([]);
    setAbsences([]);
    setChangeReqs([]);
    setExtReqs([]);
    setSubReqs([]);
    setResetConfirm(false);
  }
  function startEdit(s) { setEditId(s.id); setEditVal(s.name); }
  function saveEdit(id) {
    if (!editVal.trim()) return;
    setStaff(prev=>prev.map(s=>s.id===id?{...s,name:editVal.trim()}:s));
    setEditId(null); setEditVal("");
  }

  return (
    <div style={{padding:"16px 16px 40px"}}>

      {/* PIN unlock requests */}
      {unlockReqs.length>0 && (
        <div style={{marginBottom:18}}>
          <SectionLabel>🔓 PIN解除依頼（{unlockReqs.length}件）</SectionLabel>
          {unlockReqs.map(m=>(
            <div key={m.id} style={{background:C.redBg,borderRadius:14,padding:"14px 16px",marginBottom:8,
              border:`1px solid ${C.redLight}`,display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:24}}>🔓</span>
              <div style={{flex:1,fontFamily:SANS}}>
                <div style={{fontWeight:700,color:C.red,fontSize:14}}>
                  {staff.find(s=>s.id===m.staffId)?.name} さん
                </div>
                <div style={{fontSize:12,color:C.g500,marginTop:2}}>PINを忘れたため解除を依頼しています</div>
              </div>
              <Btn variant="primary" onClick={()=>resolveUnlock(m)}
                style={{fontSize:12,padding:"8px 14px",background:`linear-gradient(135deg,${C.green},#10B981)`}}>
                初期化
              </Btn>
            </div>
          ))}
        </div>
      )}

      <SectionLabel>👥 スタッフ管理</SectionLabel>
      <div style={{background:C.paper,borderRadius:12,padding:"10px 14px",marginBottom:14,
        fontSize:12,color:C.g500,fontFamily:SANS,lineHeight:1.6}}>
        💡 PIN・秘密の質問はスタッフ各自が設定・管理します。<br/>
        管理者には内容は見えません。忘れた場合は「解除依頼」が届きます。
      </div>

      {staff.map((s,i) => (
        <div key={s.id} style={{background:"#fff",borderRadius:12,padding:"12px 14px",marginBottom:8,
          border:`1px solid ${editId===s.id?C.caramel:C.latte}`,transition:"border 0.15s"}}>
          {editId===s.id ? (
            /* 編集モード */
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <Avatar name={s.name} idx={i} size={34}/>
              <input style={{...inputSt,flex:1,fontSize:15}} autoFocus
                value={editVal} onChange={e=>setEditVal(e.target.value)}
                onKeyDown={e=>{ if(e.key==="Enter") saveEdit(s.id); if(e.key==="Escape"){setEditId(null);setEditVal("");} }}/>
              <Btn variant="primary" onClick={()=>saveEdit(s.id)}
                style={{fontSize:12,padding:"7px 12px",flexShrink:0}}>保存</Btn>
              <button onClick={()=>{setEditId(null);setEditVal("");}}
                style={{fontSize:12,color:C.g400,background:"none",border:"none",cursor:"pointer",fontFamily:SANS,flexShrink:0}}>✕</button>
            </div>
          ) : (
            /* 通常表示 */
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <Avatar name={s.name} idx={i} size={34}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:600,fontFamily:SANS,color:C.espresso,fontSize:14}}>{s.name}</div>
                <div style={{fontSize:11,color:s.pin?C.green:C.amber,fontFamily:SANS,marginTop:2}}>
                  {s.pin?"🔐 PIN設定済み":"⚠️ 未設定"}
                </div>
              </div>
              <Btn variant="outline" onClick={()=>startEdit(s)}
                style={{fontSize:11,padding:"5px 10px",flexShrink:0}}>名前変更</Btn>
              <Btn variant="outline" onClick={()=>setDeleteConfirm({id:s.id,name:s.name})}
                style={{fontSize:11,padding:"5px 10px",color:C.red,borderColor:C.redLight,flexShrink:0}}>削除</Btn>
            </div>
          )}
        </div>
      ))}

      {/* 新規スタッフ追加 */}
      <SectionLabel>➕ スタッフを追加</SectionLabel>
      <div style={{background:"#fff",borderRadius:12,padding:"14px",border:`1px solid ${C.latte}`}}>
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          <div style={{flex:1}}>
            <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginBottom:4}}>姓（苗字）</div>
            <input style={{...inputSt,width:"100%",boxSizing:"border-box"}}
              placeholder="例：田中"
              value={newFamily} onChange={e=>setNewFamily(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&document.getElementById("givenInput")?.focus()}/>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:11,color:C.g400,fontFamily:SANS,marginBottom:4}}>名（名前）</div>
            <input id="givenInput" style={{...inputSt,width:"100%",boxSizing:"border-box"}}
              placeholder="例：葵"
              value={newGiven} onChange={e=>setNewGiven(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&addStaff()}/>
          </div>
        </div>
        {(newFamily||newGiven)&&(
          <div style={{fontSize:12,color:C.g500,fontFamily:SANS,marginBottom:8}}>
            表示名：<strong style={{color:C.espresso}}>{[newFamily,newGiven].filter(Boolean).join(" ")}</strong>
          </div>
        )}
        <Btn variant="primary" full onClick={addStaff}
          disabled={!newFamily.trim()&&!newGiven.trim()}
          style={{justifyContent:"center"}}>
          追加する
        </Btn>
      </div>

      {/* ── スタッフ削除確認モーダル ── */}
      {deleteConfirm && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:9999,
          display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{background:"#fff",borderRadius:22,padding:"28px 24px",
            width:"100%",maxWidth:360,boxShadow:"0 20px 60px rgba(0,0,0,0.35)",textAlign:"center"}}>
            <div style={{fontSize:44,marginBottom:10}}>🗑️</div>
            <div style={{fontFamily:SERIF,fontSize:20,color:C.espresso,marginBottom:8}}>
              本当に削除しますか？
            </div>
            <div style={{background:C.paper,borderRadius:12,padding:"12px 16px",marginBottom:12,
              fontSize:15,fontWeight:700,color:C.espresso,fontFamily:SANS}}>
              {deleteConfirm.name}
            </div>
            <div style={{fontSize:12,color:C.g500,fontFamily:SANS,lineHeight:1.7,marginBottom:20}}>
              削除するとこのスタッフはログインできなくなります。<br/>
              シフトデータは残ります。<br/>
              この操作は取り消せません。
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setDeleteConfirm(null)}
                style={{flex:1,padding:"13px",borderRadius:12,
                  border:`1px solid ${C.latte}`,background:"#fff",
                  color:C.g500,fontSize:14,cursor:"pointer",fontFamily:SANS}}>
                キャンセル
              </button>
              <button onClick={()=>{
                setStaff(prev=>prev.filter(x=>x.id!==deleteConfirm.id));
                setDeleteConfirm(null);
              }}
                style={{flex:1,padding:"13px",borderRadius:12,border:"none",
                  background:`linear-gradient(135deg,${C.red},#EF4444)`,
                  color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:SANS}}>
                削除する
              </button>
            </div>
          </div>
        </div>
      )}

      {/* テストモード */}
      <div style={{marginTop:24}}>
        <SectionLabel>🧪 テストモード</SectionLabel>
        <div style={{background:testMode?"#FFF7ED":C.paper,borderRadius:12,padding:"14px 16px",
          border:`1px solid ${testMode?"#F97316":C.latte}`,marginBottom:8}}>
          <div style={{fontSize:13,color:C.g600,fontFamily:SANS,lineHeight:1.7,marginBottom:12}}>
            {testMode
              ? "🟠 テストモード中です。操作は本番データに影響しません。"
              : "本番データに影響せず、機能を試せるテスト環境に切り替えられます。"}
          </div>
          {testMode ? (
            <div style={{display:"flex",gap:8}}>
              <Btn variant="primary" onClick={()=>{
                // テストデータをリセット
                setShifts({}); setConfirmed({}); setMessages([]);
                setHelpReqs([]); setNotifs([]); setAbsences([]);
                setChangeReqs([]); setExtReqs([]); setSubReqs([]);
              }} style={{flex:1,justifyContent:"center",fontSize:12,
                background:"linear-gradient(135deg,#F97316,#EA580C)"}}>
                🗑️ テストデータをリセット
              </Btn>
              <Btn variant="outline" onClick={()=>setTestMode(false)}
                style={{flex:1,justifyContent:"center",fontSize:12,color:"#F97316",borderColor:"#F97316"}}>
                本番に戻る
              </Btn>
            </div>
          ) : (
            <Btn variant="outline" onClick={()=>setTestMode(true)} full
              style={{justifyContent:"center",color:"#F97316",borderColor:"#F97316"}}>
              🧪 テストモードに切り替える
            </Btn>
          )}
        </div>
      </div>

      {/* データリセット */}
      <div style={{marginTop:24}}>
        <SectionLabel>🗑️ データ管理</SectionLabel>
        {!resetConfirm ? (
          <Btn variant="outline" onClick={()=>setResetConfirm(true)}
            style={{color:C.red,borderColor:C.redLight,fontSize:12}}>
            シフト・チャット・通知データをリセット
          </Btn>
        ) : (
          <div style={{background:C.redBg,borderRadius:12,padding:"14px 16px",border:`1px solid ${C.redLight}`}}>
            <div style={{fontWeight:700,color:C.red,fontFamily:SANS,marginBottom:4}}>本当にリセットしますか？</div>
            <div style={{fontSize:12,color:C.g500,fontFamily:SANS,marginBottom:12}}>
              シフト希望・確定シフト・チャット・通知・申請データがすべて消去されます。<br/>
              スタッフ名とPINは保持されます。
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn variant="primary" onClick={resetAllData}
                style={{flex:1,justifyContent:"center",fontSize:12,
                  background:`linear-gradient(135deg,${C.red},#EF4444)`}}>
                リセットする
              </Btn>
              <Btn variant="outline" onClick={()=>setResetConfirm(false)}
                style={{flex:1,justifyContent:"center",fontSize:12}}>
                キャンセル
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Admin Chat ─── */
function AdminChat({ ctx }) {
  const { staff, messages, setMessages } = ctx;
  const [target, setTarget] = useState(null);
  const [input, setInput] = useState("");
  const ref = useRef(null);
  useEffect(()=>{
    if(target!==null){
      setMessages(prev=>prev.map(m=>(m.from===target&&m.to===0)?{...m,read:true}:m));
      setTimeout(()=>ref.current?.scrollTo(0,99999),50);
    }
  },[target,messages.length]);
  function send() {
    if(!input.trim()||target===null) return;
    setMessages(prev=>[...prev,{id:Date.now(),from:0,to:target,text:input.trim(),ts:nowTime(),read:false}]);
    ctx.pushNotif(target,"chat",`💬 管理者：${input.trim().slice(0,28)}${input.trim().length>28?"…":""}`);
    setInput(""); setTimeout(()=>ref.current?.scrollTo(0,99999),50);
  }
  function cancel(id) { setMessages(prev=>prev.map(m=>m.id===id?{...m,cancelled:true}:m)); }
  return (
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 104px)"}}>
      <div style={{display:"flex",gap:6,padding:"10px 14px",overflowX:"auto",
        borderBottom:`1px solid ${C.latte}`,flexShrink:0,background:"#fff"}}>
        {staff.map((s,i)=>{
          const u=messages.filter(m=>String(m.from)===String(s.id)&&m.to===0&&!m.read&&!m.cancelled).length;
          const active=target===s.id;
          return(
            <button key={s.id} onClick={()=>{setTarget(s.id);setMessages(prev=>prev.map(m=>(m.from===s.id&&m.to===0)?{...m,read:true}:m));setTimeout(()=>ref.current?.scrollTo(0,99999),50);}}
              style={{display:"flex",alignItems:"center",gap:6,padding:"7px 12px",borderRadius:20,
                border:`1px solid ${active?C.caramel:C.latte}`,background:active?`${C.caramel}18`:"#fff",
                cursor:"pointer",fontFamily:SANS,fontSize:13,fontWeight:active?700:400,
                color:active?C.mocha:C.g600,whiteSpace:"nowrap",flexShrink:0,position:"relative"}}>
              <Avatar name={s.name} idx={i} size={22}/>
              {s.name}{u>0&&<Badge>{u}</Badge>}
            </button>
          );
        })}
      </div>
      {target!==null
        ?<ChatPane myId={0} toId={target} toName={staff.find(s=>s.id===target)?.name||""}
            messages={messages} chatRef={ref} input={input} setInput={setInput} onSend={send} onCancel={cancel}/>
        :<EmptyMsg style={{paddingTop:60}}>スタッフを選んでチャット開始</EmptyMsg>
      }
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SHARED UI COMPONENTS
═══════════════════════════════════════════════ */
function ChatPane({ myId, toId, toName, messages, chatRef, input, setInput, onSend, onCancel }) {
  const thread = messages.filter(m=>(m.from===myId&&m.to===toId)||(m.from===toId&&m.to===myId));
  return (
    <div style={{display:"flex",flexDirection:"column",flex:1,minHeight:0}}>
      <div style={{padding:"9px 16px",background:C.paper,borderBottom:`1px solid ${C.latte}`,
        fontSize:13,color:C.g500,fontFamily:SANS,flexShrink:0}}>💬 {toName} とのチャット</div>
      <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:"14px 16px",
        display:"flex",flexDirection:"column",gap:10,minHeight:0,background:C.cream}}>
        {thread.length===0 && <EmptyMsg>まだメッセージはありません</EmptyMsg>}
        {thread.map(m=>{
          const isMe = m.from===myId;
          return (
            <div key={m.id} style={{display:"flex",flexDirection:"column",alignItems:isMe?"flex-end":"flex-start"}}>
              <div style={{maxWidth:"78%",fontFamily:SANS,fontSize:14,lineHeight:1.55,wordBreak:"break-word",
                padding:"11px 15px",borderRadius:isMe?"16px 16px 4px 16px":"16px 16px 16px 4px",
                background:m.cancelled?C.g100:isMe?C.espresso:m.isHelp?"#FFF7ED":"#fff",
                color:m.cancelled?C.g400:isMe?"#fff":m.isHelp?"#C2410C":C.espresso,
                border:m.isHelp&&!m.cancelled?"1px solid #FED7AA":"none",
                textDecoration:m.cancelled?"line-through":"none",opacity:m.cancelled?0.6:1}}>
                {m.cancelled?"（送信取消）":m.text}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,marginTop:3}}>
                <span style={{fontSize:10,color:C.g400,fontFamily:SANS}}>{m.ts}</span>
                {isMe&&!m.cancelled&&onCancel&&(
                  <button onClick={()=>onCancel(m.id)} style={{fontSize:10,color:C.g400,background:"none",
                    border:"none",cursor:"pointer",fontFamily:SANS,textDecoration:"underline"}}>取消</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{display:"flex",gap:10,padding:"12px 16px",borderTop:`1px solid ${C.latte}`,
        background:"#fff",flexShrink:0}}>
        <input style={{...inputSt,flex:1}} placeholder="メッセージを入力..."
          value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&onSend()}/>
        <Btn variant="primary" onClick={onSend}>送信</Btn>
      </div>
    </div>
  );
}

function MonthNav({ year, month, onPrev, onNext }) {
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:20,padding:"13px 0 8px"}}>
      <button onClick={onPrev} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:C.caramel}}>‹</button>
      <span style={{fontFamily:SERIF,fontSize:19,color:C.espresso,minWidth:130,textAlign:"center"}}>{year}年 {month+1}月</span>
      <button onClick={onNext} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:C.caramel}}>›</button>
    </div>
  );
}

function Avatar({ name, idx, size=32 }) {
  return (
    <span style={{width:size,height:size,borderRadius:"50%",background:sBg(idx),color:sColor(idx),
      display:"flex",alignItems:"center",justifyContent:"center",
      fontWeight:700,fontSize:size*0.4,flexShrink:0,fontFamily:SANS}}>
      {name[0]}
    </span>
  );
}

function Badge({ children }) {
  return (
    <span style={{background:C.red,color:"#fff",fontSize:9,fontWeight:700,
      borderRadius:10,padding:"1px 5px",fontFamily:SANS,lineHeight:1.4}}>{children}</span>
  );
}

function Chip({ children, color, bg }) {
  return (
    <span style={{fontSize:11,borderRadius:8,padding:"3px 8px",background:bg,color,
      border:`1px solid ${color}44`,fontFamily:SANS}}>{children}</span>
  );
}

function Btn({ variant="primary", children, onClick, full, disabled, style={} }) {
  const base = {display:"flex",alignItems:"center",gap:6,cursor:disabled?"not-allowed":"pointer",
    fontFamily:SANS,borderRadius:11,padding:"10px 18px",fontSize:13,fontWeight:600,
    opacity:disabled?0.6:1,border:"none",transition:"opacity 0.15s",
    ...(full?{width:"100%",justifyContent:"flex-start"}:{})};
  const variants = {
    primary:{background:`linear-gradient(135deg,${C.espresso},${C.mocha})`,color:"#fff"},
    outline:{background:"#fff",border:`1px solid ${C.latte}`,color:C.g600},
    ghost:{background:"none",border:`1px solid ${C.latte}`,color:C.g500,padding:"6px 12px",fontSize:12},
  };
  return <button onClick={onClick} disabled={disabled} style={{...base,...variants[variant],...style}}>{children}</button>;
}

function Divider({ label }) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div style={{flex:1,height:1,background:C.latte}}/>
      <span style={{fontSize:11,color:C.g400,fontFamily:SANS}}>{label}</span>
      <div style={{flex:1,height:1,background:C.latte}}/>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{fontFamily:SANS,fontSize:13,fontWeight:700,color:C.g600,
      marginBottom:10,paddingBottom:6,borderBottom:`1px solid ${C.latte}`}}>{children}</div>
  );
}

function EmptyMsg({ children, style }) {
  return <p style={{textAlign:"center",color:C.g400,fontSize:13,fontFamily:SANS,padding:"24px 0",...style}}>{children}</p>;
}
function ErrMsg({ children }) {
  return <div style={{textAlign:"center",color:C.red,fontSize:13,fontFamily:SANS,margin:"4px 0 2px"}}>{children}</div>;
}
const backBtn = {background:"none",border:"none",color:C.g400,fontSize:13,cursor:"pointer",fontFamily:SANS,marginBottom:14,padding:0,display:"block"};
/* ─── Notification Bell + Panel ─── */
// Notification type → tab mapping (admin tabs | staff tabs)
const NOTIF_NAV = {
  submitted: "overview",
  unlock:    "settings",
  chat:      "chat",
  confirmed: "confirmed",
  sos:       "chat",
  absence:   "requests",
  change:    "requests",
  extreq:    "request",   // staff: extension request from manager
  subreq:    "request",   // staff: sub request from peer
};

function NotifBell({ myId, notifs, setNotifs, onNavigate, isAdmin }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const myNotifs = notifs.filter(n => String(n.to)===String(myId)).sort((a,b)=>b.id-a.id);
  const unread = myNotifs.filter(n=>!n.read).length;

  // Click outside → close panel
  useEffect(() => {
    if (!open) return;
    function handleOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("touchstart", handleOutside);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("touchstart", handleOutside);
    };
  }, [open]);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      // Mark all read when opening
      setNotifs(prev=>prev.map(n=>n.to===myId?{...n,read:true}:n));
    }
  }
  function markAll()  { setNotifs(prev=>prev.map(n=>String(n.to)===String(myId)?{...n,read:true}:n)); }
  function clearAll() { setNotifs(prev=>prev.filter(n=>String(n.to)!==String(myId))); }

  function handleNotifTap(n) {
    // Navigate to relevant tab
    // Admin uses "requests" tab, staff uses "request" tab
    let dest = NOTIF_NAV[n.type];
    if (dest==="request" && isAdmin) dest="requests";
    if (dest && onNavigate) onNavigate(dest);
    setOpen(false);
    // Mark this one read
    setNotifs(prev=>prev.map(x=>x.id===n.id?{...x,read:true}:x));
  }

  const typeIcon = {chat:"💬", sos:"🆘", submitted:"📅", confirmed:"✅", unlock:"🔓"};
  const typeBg   = {chat:"#EEF0FF", sos:C.redBg, submitted:C.greenBg, confirmed:C.amberBg, unlock:"#FFF7ED"};
  const typeColor= {chat:C.nightAcc, sos:C.red, submitted:C.green, confirmed:C.amber, unlock:"#C2410C"};

  return (
    <div ref={wrapRef} style={{position:"relative"}}>
      <button onClick={toggleOpen}
        style={{...pillStyle,background:open?`${C.caramel}20`:"transparent",
          border:`1px solid ${open?C.caramel:C.latte}`,color:open?C.mocha:C.g500,position:"relative"}}>
        🔔{unread>0&&<Badge>{unread}</Badge>}
      </button>
      {open&&(
        <div style={{position:"absolute",right:0,top:"calc(100% + 6px)",width:300,
          background:"#fff",borderRadius:16,boxShadow:"0 8px 32px rgba(44,24,16,0.2)",
          border:`1px solid ${C.latte}`,zIndex:50,overflow:"hidden"}}>
          <div style={{padding:"11px 14px",background:C.paper,display:"flex",alignItems:"center",
            justifyContent:"space-between",borderBottom:`1px solid ${C.latte}`}}>
            <span style={{fontWeight:700,fontSize:13,fontFamily:SANS,color:C.espresso}}>🔔 通知</span>
            <div style={{display:"flex",gap:8}}>
              <button onClick={markAll} style={{fontSize:11,color:C.nightAcc,background:"none",
                border:"none",cursor:"pointer",fontFamily:SANS}}>すべて既読</button>
              <button onClick={clearAll} style={{fontSize:11,color:C.g400,background:"none",
                border:"none",cursor:"pointer",fontFamily:SANS}}>すべて消去</button>
            </div>
          </div>
          <div style={{maxHeight:340,overflowY:"auto"}}>
            {myNotifs.length===0&&<EmptyMsg>通知はありません</EmptyMsg>}
            {myNotifs.map(n=>{
              const dest = NOTIF_NAV[n.type];
              const ic   = typeIcon[n.type]||"🔔";
              const bg   = typeBg[n.type]||"#fff";
              const col  = typeColor[n.type]||C.espresso;
              return (
                <div key={n.id}
                  onClick={()=>handleNotifTap(n)}
                  style={{padding:"11px 14px",borderBottom:`1px solid ${C.latte}`,
                    background:n.read?"#fff":"#FDFAF5",
                    cursor:dest?"pointer":"default",
                    display:"flex",gap:10,alignItems:"flex-start",
                    transition:"background 0.12s"}}>
                  {/* type icon badge */}
                  <div style={{width:30,height:30,borderRadius:"50%",background:bg,
                    color:col,display:"flex",alignItems:"center",justifyContent:"center",
                    fontSize:14,flexShrink:0,marginTop:1}}>{ic}</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontFamily:SANS,color:C.espresso,lineHeight:1.5}}>
                      {n.text}
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:3}}>
                      <span style={{fontSize:10,color:C.g400,fontFamily:SANS}}>{n.ts}</span>
                      {dest&&<span style={{fontSize:10,color:col,fontFamily:SANS,fontWeight:600}}>
                        タップして移動 →
                      </span>}
                    </div>
                  </div>
                  {!n.read&&<div style={{width:7,height:7,borderRadius:"50%",
                    background:C.caramel,flexShrink:0,marginTop:4}}/>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   STYLE CONSTANTS
═══════════════════════════════════════════════ */
const pageStyle = {
  maxWidth:480, width:"100%", margin:"0 auto",
  minHeight:"100vh", background:C.cream,
  fontFamily:SANS, paddingBottom:80,
  overflowX:"hidden", position:"relative",
};
const topBarStyle = {background:"#fff",borderBottom:`1px solid ${C.latte}`,padding:"11px 16px",
  display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:10,
  boxShadow:"0 1px 8px rgba(44,24,16,0.06)"};
const pillStyle = {borderRadius:20,padding:"5px 12px",cursor:"pointer",fontFamily:SANS,fontSize:12,
  display:"flex",alignItems:"center",gap:4};
const ghostBtn = {background:"none",border:`1px solid ${C.latte}`,borderRadius:10,padding:"6px 12px",
  fontSize:12,cursor:"pointer",fontFamily:SANS,color:C.g500};
const selectSt = {width:"100%",padding:"10px 12px",borderRadius:10,border:`1px solid ${C.latte}`,
  fontSize:16,background:"#fff",color:C.espresso,fontFamily:SANS,outline:"none",appearance:"none",
  backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%236B3D2E' d='M6 8L0 0h12z'/%3E%3C/svg%3E")`,
  backgroundRepeat:"no-repeat",backgroundPosition:"right 10px center"};
const inputSt = {padding:"10px 14px",borderRadius:10,border:`1px solid ${C.latte}`,
  fontSize:16,background:"#fff",color:C.espresso,fontFamily:SANS,outline:"none"};
