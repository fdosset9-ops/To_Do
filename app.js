import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

(function () {
  "use strict";

  /* ===================== FIREBASE ===================== */
  var fbApp = initializeApp(firebaseConfig);
  var auth = getAuth(fbApp);
  var db = getFirestore(fbApp);
  var provider = new GoogleAuthProvider();
  provider.addScope("https://www.googleapis.com/auth/calendar.readonly");

  var currentUser = null;
  var accessToken = null; // jeton OAuth Google, en mémoire seulement (expire ~1h)
  var unsubscribeSnapshot = null;

  /* ===================== CONFIG MATRICE ===================== */
  var QUADRANTS = [
    { key:'do',        code:'Q1', name:'Faire',      sub:'urgent\n& important',      important:true,  urgent:true,  color:'--q-do' },
    { key:'plan',      code:'Q2', name:'Planifier',  sub:'important\npas urgent',     important:true,  urgent:false, color:'--q-plan' },
    { key:'delegate',  code:'Q3', name:'Déléguer',   sub:'urgent\npas important',     important:false, urgent:true,  color:'--q-delegate' },
    { key:'eliminate', code:'Q4', name:'Éliminer',   sub:'ni urgent\nni important',   important:false, urgent:false, color:'--q-eliminate' }
  ];
  var GRID_ORDER = ['do','plan','delegate','eliminate'];
  var CIRC = 2 * Math.PI * 88;

  function qByKey(k){ return QUADRANTS.find(function(q){ return q.key===k; }); }
  function qByAxes(important, urgent){ return QUADRANTS.find(function(q){ return q.important===important && q.urgent===urgent; }); }

  /* ===================== STATE ===================== */
  var DEFAULTS = {
    settings: { theme:null, workMin:25, breakMin:5, longBreakMin:15, soundOn:true, sessionsToday:0, lastSessionDate:null },
    tasks: [],
    agenda: { events:[], lastSync:null, error:null }
  };
  var state = JSON.parse(JSON.stringify(DEFAULTS));
  var draft = { important:false, urgent:false };
  var focusMode = false;
  var saveTimer = null;
  var editingTaskId = null;     // tâche en cours de renommage
  var cancelRename = false;     // intention Échap vs validation lors du blur
  var justCompletedId = null;   // déclenche l'animation de complétion une seule fois
  var pendingDelete = null;     // { task, index, timeoutId } pour le toast "Annuler"
  var expandedTaskIds = new Set(); // menus de tâche dépliés (survit aux re-rendus)

  function stateDocRef(uid){ return doc(db, 'users', uid); }

  async function persistState(){
    if(!currentUser) return;
    try{ await setDoc(stateDocRef(currentUser.uid), state); }
    catch(e){ console.error('Écriture Firestore impossible', e); }
  }
  function scheduleSave(){
    if(saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistState, 350);
  }

  function listenToState(uid){
    unsubscribeSnapshot = onSnapshot(stateDocRef(uid), function(snap){
      if(snap.exists()){
        var data = snap.data() || {};
        state = Object.assign({}, DEFAULTS, data);
        state.settings = Object.assign({}, DEFAULTS.settings, data.settings || {});
        state.agenda = Object.assign({}, DEFAULTS.agenda, data.agenda || {});
        if(!state.tasks) state.tasks = [];
        // migration douce : les tâches créées avant l'ajout du tri manuel
        // n'ont pas de champ "order" — on leur en donne un cohérent (plus
        // récent = plus haut), sans perturber celles déjà ordonnées.
        state.tasks.forEach(function(t, i){
          if(typeof t.order !== 'number') t.order = -(t.createdAt || (Date.now() - i));
        });
      } else {
        state = JSON.parse(JSON.stringify(DEFAULTS));
        setDoc(stateDocRef(uid), state);
      }
      tickEnsureDay();
      applyTheme(state.settings.theme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
      document.getElementById('workMinInput').value = state.settings.workMin;
      document.getElementById('breakMinInput').value = state.settings.breakMin;
      document.getElementById('longBreakMinInput').value = state.settings.longBreakMin;
      if(!pomo.running) pomo.remaining = (pomo.mode==='work' ? state.settings.workMin : (pomo.isLongBreak ? state.settings.longBreakMin : state.settings.breakMin)) * 60;
      updateQuadPreview();
      renderAll();
      renderPomodoro();
    }, function(err){ console.error('Lecture Firestore impossible', err); });
  }


  /* ===================== DATE HELPERS ===================== */
  function pad(n){ return String(n).padStart(2,'0'); }
  function toISO(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
  function todayISO(){ return toISO(new Date()); }
  function addDaysISO(n){ var d=new Date(); d.setDate(d.getDate()+n); return toISO(d); }
  function isOverdue(t){ return t.due && !t.done && t.due < todayISO(); }
  function isDueToday(t){ return t.due === todayISO(); }
  function formatDue(iso){
    if(!iso) return '';
    var d = new Date(iso+'T00:00:00');
    if(isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'short' }).replace('.', '');
  }

  /* ===================== TASK CRUD ===================== */
  function activeSiblings(quadrantKey, excludeId){
    return state.tasks.filter(function(t){ return t.quadrant===quadrantKey && !t.done && t.id!==excludeId; });
  }
  function addTask(title, important, urgent, due){
    var q = qByAxes(important, urgent);
    var siblings = activeSiblings(q.key, null);
    var minOrder = siblings.reduce(function(m,s){ return Math.min(m, s.order||0); }, 0);
    var task = {
      id: 'tk_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      title: title.trim(), quadrant: q.key, important: important, urgent: urgent,
      due: due || null, done:false, completedAt:null, createdAt: Date.now(), pomodoroCount:0,
      order: minOrder - 1 // apparaît en tête de son quadrant, comme avant
    };
    state.tasks.unshift(task);
    scheduleSave(); renderAll();
  }
  function moveTask(id, quadrantKey){
    var t = state.tasks.find(function(t){ return t.id===id; });
    var q = qByKey(quadrantKey);
    if(!t || !q) return;
    t.quadrant = q.key; t.important = q.important; t.urgent = q.urgent;
    var siblings = activeSiblings(quadrantKey, id);
    var maxOrder = siblings.reduce(function(m,s){ return Math.max(m, s.order||0); }, -1);
    t.order = maxOrder + 1; // rejoint la fin de la nouvelle liste
    scheduleSave(); renderAll();
  }
  function reorderTask(id, quadrantKey, insertionIndex){
    var t = state.tasks.find(function(t){ return t.id===id; });
    var q = qByKey(quadrantKey);
    if(!t || !q) return;
    t.quadrant = q.key; t.important = q.important; t.urgent = q.urgent;
    var siblings = activeSiblings(quadrantKey, id);
    siblings.sort(function(a,b){ return (a.order||0)-(b.order||0); });
    var idx = Math.max(0, Math.min(insertionIndex, siblings.length));
    siblings.splice(idx, 0, t);
    siblings.forEach(function(s, i){ s.order = i; });
    scheduleSave(); renderAll();
  }
  function toggleDone(id){
    var t = state.tasks.find(function(t){ return t.id===id; });
    if(!t) return;
    t.done = !t.done; t.completedAt = t.done ? Date.now() : null;
    justCompletedId = t.done ? id : null;
    scheduleSave(); renderAll();
  }
  function renameTask(id){
    cancelRename = false;
    editingTaskId = id;
    renderMatrix();
  }
  function commitRename(id, value){
    var t = state.tasks.find(function(t){ return t.id===id; });
    var trimmed = (value||'').trim();
    if(t && trimmed){ t.title = trimmed; scheduleSave(); }
    editingTaskId = null;
    renderAll();
  }
  function deleteTask(id){
    var index = state.tasks.findIndex(function(t){ return t.id===id; });
    if(index === -1) return;
    var task = state.tasks[index];
    state.tasks.splice(index, 1);
    if(pomo.linkedTaskId === id) pomo.linkedTaskId = '';
    if(pendingDelete) clearTimeout(pendingDelete.timeoutId);
    pendingDelete = {
      task: task, index: index,
      timeoutId: setTimeout(function(){ pendingDelete = null; hideToast(); }, 5000)
    };
    scheduleSave(); renderAll();
    showToast('Tâche supprimée — « ' + task.title + ' »');
  }
  function undoDelete(){
    if(!pendingDelete) return;
    clearTimeout(pendingDelete.timeoutId);
    var idx = Math.min(pendingDelete.index, state.tasks.length);
    state.tasks.splice(idx, 0, pendingDelete.task);
    pendingDelete = null;
    hideToast();
    scheduleSave(); renderAll();
  }
  function clearDone(){
    state.tasks = state.tasks.filter(function(t){ return !t.done; });
    scheduleSave(); renderAll();
  }
  function setDue(id, iso){
    var t = state.tasks.find(function(t){ return t.id===id; });
    if(!t) return;
    t.due = iso || null;
    scheduleSave(); renderAll();
  }

  /* ===================== TOAST ===================== */
  function showToast(message){
    var toast = document.getElementById('toast');
    document.getElementById('toastMessage').textContent = message;
    toast.hidden = false;
    void toast.offsetWidth; // force le recalcul de mise en page pour que l'entrée s'anime
    toast.classList.add('visible');
  }
  function hideToast(){
    var toast = document.getElementById('toast');
    toast.classList.remove('visible');
    setTimeout(function(){ if(!pendingDelete) toast.hidden = true; }, 260);
  }

  /* ===================== RENDER: MATRIX ===================== */
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function taskMetaTags(t){
    var tags = '';
    if(t.done){ tags += '<span class="tag done-tag">terminé</span>'; }
    else if(isOverdue(t)){ tags += '<span class="tag overdue">en retard · ' + formatDue(t.due) + '</span>'; }
    else if(isDueToday(t)){ tags += '<span class="tag today">aujourd\'hui</span>'; }
    else if(t.due){ tags += '<span class="tag">' + formatDue(t.due) + '</span>'; }
    if(t.pomodoroCount > 0){ tags += '<span class="tag">' + t.pomodoroCount + ' 🍅</span>'; }
    return tags;
  }
  function moveButtonsHtml(t){
    return QUADRANTS.filter(function(q){ return q.key !== t.quadrant; }).map(function(q){
      return '<button data-action="move-task" data-id="'+t.id+'" data-target="'+q.key+'">→ '+q.name+'</button>';
    }).join('');
  }
  function taskCardHtml(t){
    var isEditing = (t.id === editingTaskId);
    var isExpanded = expandedTaskIds.has(t.id);
    var titleHtml = isEditing
      ? '<input type="text" class="task-title-edit" data-id="'+t.id+'" value="'+escapeHtml(t.title)+'" maxlength="140" />'
      : '<p class="task-title">'+escapeHtml(t.title)+'</p>';
    return (
      '<li class="task'+(t.done?' is-done':'')+(isExpanded?' expanded':'')+'" data-id="'+t.id+'">'+
        '<span class="drag-handle" data-id="'+t.id+'" aria-hidden="true">⠿</span>'+
        '<button class="check" data-action="toggle-done" data-id="'+t.id+'" aria-label="Marquer comme terminé">'+(t.done?'✓':'')+'</button>'+
        '<div class="task-body">'+
          titleHtml+
          '<p class="task-meta">'+taskMetaTags(t)+'</p>'+
          '<div class="task-actions">'+
            '<button data-action="rename-task" data-id="'+t.id+'">renommer</button>'+
            moveButtonsHtml(t)+
            '<button data-action="set-due" data-id="'+t.id+'" data-due="'+todayISO()+'">échéance: aujourd\'hui</button>'+
            '<button data-action="set-due" data-id="'+t.id+'" data-due="">effacer échéance</button>'+
            '<button data-action="link-pomodoro" data-id="'+t.id+'">🍅 lier au pomodoro</button>'+
            '<button class="danger-action" data-action="delete-task" data-id="'+t.id+'">supprimer</button>'+
          '</div>'+
        '</div>'+
        '<button class="task-menu-btn" data-action="toggle-menu" data-id="'+t.id+'" aria-label="Options">⋯</button>'+
      '</li>'
    );
  }
  function renderMatrix(){
    var grid = document.getElementById('matrixGrid');
    grid.innerHTML = GRID_ORDER.map(function(key){
      var q = qByKey(key);
      var tasks = state.tasks.filter(function(t){ return t.quadrant === key; });
      tasks.sort(function(a,b){
        if(a.done !== b.done) return a.done ? 1 : -1;
        if(!a.done) return (a.order||0) - (b.order||0);
        return (b.completedAt||0) - (a.completedAt||0);
      });
      var activeCount = tasks.filter(function(t){ return !t.done; }).length;
      var body = tasks.length ? tasks.map(taskCardHtml).join('') : '<li class="quadrant-empty">aucune tâche ici</li>';
      return (
        '<div class="quadrant" data-quadrant="'+key+'">'+
          '<div class="quadrant-head">'+
            '<span class="q-code" style="background:var('+q.color+')">'+q.code+'</span>'+
            '<span class="q-name">'+q.name+'</span>'+
            '<span class="q-count">'+activeCount+'</span>'+
            '<span class="q-sub">'+q.sub.replace('\n','<br>')+'</span>'+
          '</div>'+
          '<ul class="quadrant-body" data-quadrant="'+key+'">'+body+'</ul>'+
        '</div>'
      );
    }).join('');

    if(editingTaskId){
      var editEl = grid.querySelector('.task-title-edit[data-id="'+editingTaskId+'"]');
      if(editEl){ editEl.focus(); editEl.setSelectionRange(editEl.value.length, editEl.value.length); }
    }
    if(justCompletedId){
      var doneEl = grid.querySelector('.task[data-id="'+justCompletedId+'"]');
      if(doneEl){
        doneEl.classList.add('just-completed');
        doneEl.addEventListener('animationend', function(){ doneEl.classList.remove('just-completed'); }, { once:true });
      }
      justCompletedId = null;
    }
  }
  function renderStats(){
    var bar = document.getElementById('statsBar');
    var today = new Date().toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'long' });
    var doneToday = state.tasks.filter(function(t){
      return t.done && t.completedAt && new Date(t.completedAt).toISOString().slice(0,10) === todayISO();
    }).length;
    var hasDone = state.tasks.some(function(t){ return t.done; });
    var counts = QUADRANTS.map(function(q){ return state.tasks.filter(function(t){ return t.quadrant===q.key && !t.done; }).length; });
    var total = counts.reduce(function(a,b){return a+b;},0) || 1;
    var segs = QUADRANTS.map(function(q,i){
      var pct = (counts[i]/total*100);
      return pct>0 ? '<span style="width:'+pct+'%;background:var('+q.color+')"></span>' : '';
    }).join('');
    bar.innerHTML =
      '<span class="date">'+today.replace('.', '')+' · '+doneToday+' terminée(s) aujourd\'hui</span>'+
      '<span class="stats-right">'+
        '<span class="distbar">'+segs+'</span>'+
        (hasDone ? '<button class="clear-done" data-action="clear-done">vider les terminées</button>' : '')+
      '</span>';
  }
  function updateQuadPreview(){
    var q = qByAxes(draft.important, draft.urgent);
    document.getElementById('quadPreview').innerHTML = 'sera classée dans <strong>'+q.code+' · '+q.name+'</strong>';
  }
  function renderAll(){ renderMatrix(); renderStats(); renderAgenda(); renderPomoTaskSelect(); }

  /* ===================== DRAG & DROP ===================== */
  (function initDrag(){
    var grid = document.getElementById('matrixGrid');
    grid.addEventListener('pointerdown', function(e){
      var handle = e.target.closest('.drag-handle');
      if(!handle) return;
      e.preventDefault();
      var taskId = handle.dataset.id;
      var sourceCard = handle.closest('.task');
      var startX = e.clientX, startY = e.clientY;
      var dragging = false, ghost = null;
      var dropQuadrant = null, dropIndex = null;

      function clearMarkers(){
        document.querySelectorAll('.drop-marker-before,.drop-marker-after').forEach(function(el){
          el.classList.remove('drop-marker-before','drop-marker-after');
        });
      }
      function updateDropTarget(clientX, clientY){
        document.querySelectorAll('.quadrant-body.drag-over').forEach(function(el){ el.classList.remove('drag-over'); });
        clearMarkers();
        var el = document.elementFromPoint(clientX, clientY);
        var body = el && el.closest && el.closest('.quadrant-body');
        if(!body){ dropQuadrant = null; dropIndex = null; return; }
        body.classList.add('drag-over');
        dropQuadrant = body.dataset.quadrant;
        var items = Array.prototype.slice.call(body.querySelectorAll('.task:not(.is-done)'))
          .filter(function(li){ return li.dataset.id !== taskId; });
        var idx = items.length;
        for(var i=0;i<items.length;i++){
          var rect = items[i].getBoundingClientRect();
          if(clientY < rect.top + rect.height/2){ idx = i; break; }
        }
        dropIndex = idx;
        if(items.length){
          if(idx >= items.length){ items[items.length-1].classList.add('drop-marker-after'); }
          else { items[idx].classList.add('drop-marker-before'); }
        }
      }

      function onMove(ev){
        var dx = ev.clientX-startX, dy = ev.clientY-startY;
        if(!dragging && Math.hypot(dx,dy) > 6){
          dragging = true;
          var rect = sourceCard.getBoundingClientRect();
          ghost = sourceCard.cloneNode(true);
          ghost.style.position = 'fixed';
          ghost.style.width = rect.width+'px';
          ghost.style.zIndex = 999;
          ghost.style.pointerEvents = 'none';
          ghost.style.opacity = '0.92';
          ghost.style.transform = 'rotate(-1.5deg)';
          ghost.style.boxShadow = '0 10px 26px rgba(0,0,0,.30)';
          document.body.appendChild(ghost);
          sourceCard.style.opacity = '0.35';
        }
        if(dragging && ghost){
          ghost.style.left = (ev.clientX - ghost.offsetWidth/2) + 'px';
          ghost.style.top = (ev.clientY - 18) + 'px';
          updateDropTarget(ev.clientX, ev.clientY);
        }
      }
      function onUp(ev){
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if(dragging){
          clearMarkers();
          document.querySelectorAll('.quadrant-body.drag-over').forEach(function(b){ b.classList.remove('drag-over'); });
          if(ghost) ghost.remove();
          sourceCard.style.opacity = '';
          if(dropQuadrant) reorderTask(taskId, dropQuadrant, dropIndex==null?0:dropIndex);
        }
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once:true });
    });
  })();

  /* ===================== CONFIRMABLE ACTIONS ===================== */
  function confirmable(btn, fn){
    if(btn.dataset.confirming === '1'){ fn(); return; }
    btn.dataset.confirming = '1';
    var original = btn.textContent;
    btn.textContent = 'confirmer ?';
    btn.classList.add('confirming');
    setTimeout(function(){ btn.dataset.confirming=''; btn.textContent=original; btn.classList.remove('confirming'); }, 2500);
  }

  /* ===================== POMODORO ===================== */
  var pomo = { mode:'work', remaining: 25*60, running:false, intervalId:null, linkedTaskId:'', isLongBreak:false };

  function pomoTotal(){
    if(pomo.mode==='work') return state.settings.workMin*60;
    return (pomo.isLongBreak ? state.settings.longBreakMin : state.settings.breakMin) * 60;
  }
  function formatTime(s){ var m=Math.floor(s/60), sec=s%60; return pad(m)+':'+pad(sec); }
  function renderPomoDial(){
    var frac = pomo.remaining / pomoTotal();
    var offset = CIRC * (1 - Math.max(0,Math.min(1,frac)));
    var progress = document.getElementById('dialProgress');
    progress.style.strokeDasharray = CIRC;
    progress.style.strokeDashoffset = offset;
    progress.classList.toggle('mode-break', pomo.mode==='break');
    document.getElementById('timeDisplay').textContent = formatTime(pomo.remaining);
    document.getElementById('modeDisplay').textContent = pomo.mode==='work' ? 'travail' : (pomo.isLongBreak ? 'pause longue' : 'pause');
    document.getElementById('pomoToggleBtn').textContent = pomo.running ? 'Pause' : (pomo.remaining < pomoTotal() ? 'Reprendre' : 'Démarrer');
  }
  function renderSessionDots(){
    var n = Math.max(state.settings.sessionsToday, 4);
    var html = '';
    for(var i=0;i<n;i++){ html += '<span class="'+(i<state.settings.sessionsToday?'filled':'')+'"></span>'; }
    document.getElementById('sessionDots').innerHTML = html;
  }
  function renderPomoTaskSelect(){
    var sel = document.getElementById('pomoTaskSelect');
    var current = pomo.linkedTaskId;
    var active = state.tasks.filter(function(t){ return !t.done; });
    sel.innerHTML = '<option value="">Session libre — aucune tâche liée</option>' +
      active.map(function(t){ return '<option value="'+t.id+'"'+(t.id===current?' selected':'')+'>'+escapeHtml(t.title)+'</option>'; }).join('');
    sel.value = current;
  }
  function renderSoundBtn(){
    document.getElementById('soundBtn').innerHTML = state.settings.soundOn
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9v6h4l5 5V4L8 9H4z"/><line x1="16" y1="9" x2="21" y2="14"/><line x1="21" y1="9" x2="16" y2="14"/></svg>';
    document.getElementById('soundBtn').classList.toggle('is-active', state.settings.soundOn);
  }
  function renderPomodoro(){ renderPomoDial(); renderSessionDots(); renderPomoTaskSelect(); renderSoundBtn(); }

  function beep(freq, dur){
    try{
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = freq; osc.type = 'sine';
      osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime+0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+dur);
      osc.start(); osc.stop(ctx.currentTime+dur+0.03);
    }catch(e){}
  }
  function notifyIfAllowed(title, body){
    if(!('Notification' in window)) return;
    if(Notification.permission === 'granted'){
      try{ new Notification(title, { body: body, silent:true, icon:'icons/icon-192.png' }); }catch(e){}
    }
  }
  function announceTransition(){
    var enteringBreak = (pomo.mode === 'break');
    if(state.settings.soundOn){
      if(enteringBreak){ beep(880,0.13); setTimeout(function(){ beep(880,0.16); },150); }
      else{ beep(620,0.18); }
    }
    if(enteringBreak){ notifyIfAllowed(pomo.isLongBreak ? 'Pause longue' : 'Pause', 'Session terminée — direction la pause.'); }
    else{ notifyIfAllowed('Au travail', 'La pause est terminée.'); }
  }
  function tickEnsureDay(){
    var t = todayISO();
    if(state.settings.lastSessionDate !== t){ state.settings.lastSessionDate = t; state.settings.sessionsToday = 0; }
  }
  function pomoTick(){
    pomo.remaining--;
    if(pomo.remaining <= 0){
      if(pomo.mode === 'work'){
        tickEnsureDay();
        state.settings.sessionsToday++;
        if(pomo.linkedTaskId){
          var t = state.tasks.find(function(t){ return t.id===pomo.linkedTaskId; });
          if(t) t.pomodoroCount = (t.pomodoroCount||0) + 1;
        }
        pomo.isLongBreak = (state.settings.sessionsToday % 4 === 0);
        pomo.mode = 'break'; pomo.remaining = (pomo.isLongBreak ? state.settings.longBreakMin : state.settings.breakMin) * 60;
        announceTransition();
        scheduleSave(); renderAll();
      } else {
        pomo.mode = 'work'; pomo.remaining = state.settings.workMin*60; pomo.running = false;
        clearInterval(pomo.intervalId);
        announceTransition();
      }
    }
    renderPomoDial(); renderSessionDots();
  }
  function pomoStart(){
    if(pomo.running) return;
    if('Notification' in window && Notification.permission === 'default'){ Notification.requestPermission(); }
    pomo.running = true;
    pomo.intervalId = setInterval(pomoTick, 1000);
    renderPomoDial();
  }
  function pomoPause(){ pomo.running = false; clearInterval(pomo.intervalId); renderPomoDial(); }
  function pomoReset(){
    pomo.running = false; clearInterval(pomo.intervalId);
    pomo.mode = 'work'; pomo.isLongBreak = false; pomo.remaining = state.settings.workMin*60;
    renderPomoDial();
  }

  /* ===================== AGENDA GOOGLE (API directe) ===================== */
  function renderAgenda(){
    var meta = document.getElementById('syncMeta');
    var list = document.getElementById('eventList');
    var ag = state.agenda || {};
    if(ag.lastSync){
      var d = new Date(ag.lastSync);
      meta.textContent = 'Dernière synchronisation : ' + d.toLocaleDateString('fr-FR') + ' à ' + pad(d.getHours())+':'+pad(d.getMinutes());
    } else { meta.textContent = "Pas encore synchronisé."; }
    if(ag.error){ list.innerHTML = '<li class="agenda-error">'+escapeHtml(ag.error)+'</li>'; return; }
    if(!ag.events || !ag.events.length){ list.innerHTML = '<li class="agenda-empty">aucun événement à venir</li>'; return; }
    list.innerHTML = ag.events.map(function(ev, i){
      return (
        '<li class="event-row">'+
          '<span class="event-time">'+escapeHtml(ev.time || formatDue(ev.date))+'</span>'+
          '<span class="event-title">'+escapeHtml(ev.title || 'Sans titre')+'</span>'+
          '<button class="event-import" data-action="import-event" data-index="'+i+'" title="Transformer en tâche" aria-label="Transformer en tâche">+</button>'+
        '</li>'
      );
    }).join('');
  }

  async function ensureAccessToken(){
    if(accessToken) return accessToken;
    var result = await signInWithPopup(auth, provider);
    var credential = GoogleAuthProvider.credentialFromResult(result);
    accessToken = credential && credential.accessToken;
    return accessToken;
  }

  async function syncCalendar(){
    var btn = document.getElementById('syncBtn');
    btn.disabled = true; btn.textContent = 'Synchronisation…';
    try{
      var token = await ensureAccessToken();
      var params = new URLSearchParams({ timeMin: new Date().toISOString(), maxResults: '8', singleEvents: 'true', orderBy: 'startTime' });
      var resp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?'+params.toString(), {
        headers: { Authorization: 'Bearer '+token }
      });
      if(resp.status === 401){
        accessToken = null;
        token = await ensureAccessToken();
        resp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?'+params.toString(), {
          headers: { Authorization: 'Bearer '+token }
        });
      }
      if(!resp.ok) throw new Error('réponse agenda invalide (' + resp.status + ')');
      var data = await resp.json();
      var events = (data.items || []).map(function(ev){
        var start = ev.start || {};
        var dateStr = start.date || (start.dateTime ? start.dateTime.slice(0,10) : '');
        var timeStr = start.dateTime ? new Date(start.dateTime).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }) : '';
        return { title: ev.summary || 'Sans titre', date: dateStr, time: timeStr };
      });
      state.agenda = { events: events, lastSync: Date.now(), error: null };
    }catch(err){
      console.error(err);
      state.agenda = {
        events: (state.agenda && state.agenda.events) || [],
        lastSync: (state.agenda && state.agenda.lastSync) || null,
        error: "Synchronisation impossible. Si la fenêtre Google ne s'est pas ouverte, autorise les popups puis réessaie."
      };
    }
    btn.disabled = false; btn.textContent = 'Synchroniser';
    scheduleSave(); renderAgenda();
  }
  function importEvent(index){
    var ev = state.agenda.events[index];
    if(!ev) return;
    var due = ev.date || todayISO();
    var urgent = due <= addDaysISO(1);
    addTask(ev.title || 'Événement', true, urgent, due);
  }

  /* ===================== THEME / FOCUS ===================== */
  function moonIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>'; }
  function sunIcon(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M4.4 4.4l1.6 1.6M18 18l1.6 1.6M2.5 12h2.3M19.2 12h2.3M4.4 19.6l1.6-1.6M18 6l1.6-1.6"/></svg>'; }
  function applyTheme(theme){
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('themeBtn').innerHTML = theme==='dark' ? sunIcon() : moonIcon();
    document.getElementById('themeBtn').title = theme==='dark' ? 'Passer en thème clair (D)' : 'Passer en thème sombre (D)';
    var meta = document.getElementById('themeColorMeta');
    if(meta) meta.setAttribute('content', theme==='dark' ? '#15171c' : '#f2eee4');
    state.settings.theme = theme;
  }
  function toggleTheme(){
    var cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
    scheduleSave();
  }
  function toggleFocus(){
    focusMode = !focusMode;
    document.getElementById('matrixWrap').classList.toggle('focus-mode', focusMode);
    document.getElementById('focusBtn').classList.toggle('is-active', focusMode);
  }

  /* ===================== AUTH ===================== */
  function showApp(user){
    document.getElementById('authGate').hidden = true;
    document.getElementById('mainContent').hidden = false;
    var badge = document.getElementById('userBadge');
    badge.hidden = false;
    badge.innerHTML = '<span class="user-email">'+escapeHtml(user.email||'')+'</span>'+
      '<button class="btn-secondary" data-action="logout">Déconnexion</button>';
  }
  function showAuthGate(){
    document.getElementById('authGate').hidden = false;
    document.getElementById('mainContent').hidden = true;
    document.getElementById('userBadge').hidden = true;
    if(pomo.intervalId){ clearInterval(pomo.intervalId); pomo.running = false; }
  }
  async function login(){
    document.getElementById('authError').textContent = '';
    try{
      var result = await signInWithPopup(auth, provider);
      var credential = GoogleAuthProvider.credentialFromResult(result);
      accessToken = credential && credential.accessToken;
    }catch(e){
      console.error(e);
      document.getElementById('authError').textContent = "Connexion impossible. Vérifie que les popups sont autorisées, puis réessaie.";
    }
  }
  async function logout(){
    accessToken = null;
    if(unsubscribeSnapshot){ unsubscribeSnapshot(); unsubscribeSnapshot = null; }
    await signOut(auth);
  }

  onAuthStateChanged(auth, function(user){
    if(user){
      currentUser = user;
      showApp(user);
      listenToState(user.uid);
    } else {
      currentUser = null;
      if(unsubscribeSnapshot){ unsubscribeSnapshot(); unsubscribeSnapshot = null; }
      showAuthGate();
    }
  });

  /* ===================== EVENT WIRING ===================== */
  document.addEventListener('click', function(e){
    var btn = e.target.closest('[data-action]');
    if(!btn) return;
    var action = btn.dataset.action, id = btn.dataset.id;
    switch(action){
      case 'login': login(); break;
      case 'logout': logout(); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'toggle-focus': toggleFocus(); break;
      case 'toggle-axis':
        var axis = btn.dataset.axis;
        draft[axis] = !draft[axis];
        btn.classList.toggle('active', draft[axis]);
        updateQuadPreview();
        break;
      case 'quick-date':
        var q = btn.dataset.quick;
        var iso = q==='today' ? todayISO() : q==='tomorrow' ? addDaysISO(1) : addDaysISO(7);
        document.getElementById('dueInput').value = iso;
        if(q==='today' || q==='tomorrow'){
          draft.urgent = true;
          document.getElementById('pillUrgent').classList.add('active');
          updateQuadPreview();
        }
        break;
      case 'toggle-done': toggleDone(id); break;
      case 'toggle-menu':
        if(expandedTaskIds.has(id)) expandedTaskIds.delete(id); else expandedTaskIds.add(id);
        btn.closest('.task').classList.toggle('expanded');
        break;
      case 'rename-task': renameTask(id); break;
      case 'move-task': moveTask(id, btn.dataset.target); break;
      case 'set-due': setDue(id, btn.dataset.due); break;
      case 'link-pomodoro':
        pomo.linkedTaskId = id;
        renderPomoTaskSelect();
        document.querySelector('.pomodoro-panel').scrollIntoView({ behavior:'smooth', block:'center' });
        break;
      case 'delete-task': deleteTask(id); break;
      case 'undo-delete': undoDelete(); break;
      case 'clear-done': confirmable(btn, clearDone); break;
      case 'pomodoro-toggle': pomo.running ? pomoPause() : pomoStart(); break;
      case 'pomodoro-reset': pomoReset(); break;
      case 'pomodoro-sound': state.settings.soundOn = !state.settings.soundOn; renderSoundBtn(); scheduleSave(); break;
      case 'sync-calendar': syncCalendar(); break;
      case 'import-event': importEvent(parseInt(btn.dataset.index,10)); break;
    }
  });

  document.addEventListener('change', function(e){
    if(e.target.id === 'pomoTaskSelect'){ pomo.linkedTaskId = e.target.value; }
    if(e.target.id === 'workMinInput'){
      var v = Math.max(1, Math.min(90, parseInt(e.target.value,10)||25));
      state.settings.workMin = v;
      if(pomo.mode==='work' && !pomo.running) pomo.remaining = v*60;
      renderPomoDial(); scheduleSave();
    }
    if(e.target.id === 'breakMinInput'){
      var vb = Math.max(1, Math.min(60, parseInt(e.target.value,10)||5));
      state.settings.breakMin = vb;
      if(pomo.mode==='break' && !pomo.isLongBreak && !pomo.running) pomo.remaining = vb*60;
      renderPomoDial(); scheduleSave();
    }
    if(e.target.id === 'longBreakMinInput'){
      var vl = Math.max(1, Math.min(120, parseInt(e.target.value,10)||15));
      state.settings.longBreakMin = vl;
      if(pomo.mode==='break' && pomo.isLongBreak && !pomo.running) pomo.remaining = vl*60;
      renderPomoDial(); scheduleSave();
    }
  });

  // Validation / annulation du renommage inline d'une tâche, centralisées ici
  // pour éviter toute course entre la touche Échap et la perte de focus.
  document.addEventListener('focusout', function(e){
    if(e.target.classList && e.target.classList.contains('task-title-edit')){
      if(cancelRename){ editingTaskId = null; renderAll(); }
      else { commitRename(e.target.dataset.id, e.target.value); }
      cancelRename = false;
    }
  });

  document.getElementById('addForm').addEventListener('submit', function(e){
    e.preventDefault();
    var input = document.getElementById('taskInput');
    var title = input.value.trim();
    if(!title) return;
    var due = document.getElementById('dueInput').value || null;
    addTask(title, draft.important, draft.urgent, due);
    input.value = '';
    document.getElementById('dueInput').value = '';
    draft = { important:false, urgent:false };
    document.getElementById('pillImportant').classList.remove('active');
    document.getElementById('pillUrgent').classList.remove('active');
    updateQuadPreview();
    input.focus();
  });

  document.addEventListener('keydown', function(e){
    if(document.getElementById('mainContent').hidden) return;
    if(e.target.classList && e.target.classList.contains('task-title-edit')){
      if(e.key === 'Enter'){ e.preventDefault(); e.target.blur(); }
      else if(e.key === 'Escape'){ e.preventDefault(); cancelRename = true; e.target.blur(); }
      return;
    }
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag==='input' || tag==='textarea' || tag==='select';
    if(typing){ if(e.key === 'Escape') e.target.blur(); return; }
    if(e.key === 'n' || e.key === 'N'){ e.preventDefault(); document.getElementById('taskInput').focus(); }
    if(e.key === 'f' || e.key === 'F'){ toggleFocus(); }
    if(e.key === 'd' || e.key === 'D'){ toggleTheme(); }
  });

  if('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('./sw.js').catch(function(){ /* installation impossible, sans gravité */ });
    });
  }

  /* ===================== INIT ===================== */
  applyTheme(window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.getElementById('workMinInput').value = state.settings.workMin;
  document.getElementById('breakMinInput').value = state.settings.breakMin;
  document.getElementById('longBreakMinInput').value = state.settings.longBreakMin;
  pomo.remaining = state.settings.workMin*60;
  updateQuadPreview();
  renderPomodoro();
})();
