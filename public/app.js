/**
 * Miranda Control Center — Telegram Mini App
 *
 * Vanilla JS dashboard for monitoring tasks, PRs, and dependencies.
 * Communicates with Miranda REST API using Telegram initData auth.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Telegram WebApp bridge
  // ---------------------------------------------------------------------------

  const webapp = window.Telegram && window.Telegram.WebApp;

  function getInitData() {
    return (webapp && webapp.initData) || "";
  }

  function openLink(url) {
    if (webapp && webapp.openLink) {
      webapp.openLink(url);
    } else {
      window.open(url, "_blank");
    }
  }


  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var projects = [];
  var selectedProject = null; // project name string
  var sessions = [];
  var issues = [];
  var allPRs = [];
  var repoUrl = null; // GitHub repo URL for constructing issue links
  var refreshTimer = null;
  var pendingRequests = 0;
  var commentPrNum = null; // PR number for comment modal
  var commentProject = null; // project name for comment modal (cross-project)

  var REFRESH_INTERVAL = 60000; // 60 seconds

  // Log panel state: { taskId: { es: EventSource, panel: Element, autoScroll: bool } }
  var logStreams = {};
  var MAX_LOG_LINES = 200;

  // Scheduler state
  var schedulerStatus = null; // { running, pollIntervalMs, maxConcurrentSessions, projects }
  var currentFactoryIssueNumbers = {}; // { issueNumber: true } for selected project

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------

  var $projectSelect = document.getElementById("project-select");
  var $sessionsList = document.getElementById("sessions-list");
  var $sessionsCount = document.getElementById("sessions-count");
  var $sessionsSection = document.getElementById("sessions-section");
  var $allPrsSection = document.getElementById("all-prs-section");
  var $allPrsList = document.getElementById("all-prs-list");
  var $allPrsCount = document.getElementById("all-prs-count");
  var $issuesSection = document.getElementById("issues-section");
  var $issuesTree = document.getElementById("issues-tree");
  var $factoryPipeline = document.getElementById("factory-pipeline");
  var $factoryPipelineSection = document.getElementById("factory-pipeline-section");
  var $issuesCount = document.getElementById("issues-count");
  var $refreshBtn = document.getElementById("refresh-btn");
  var $loadingBar = document.getElementById("loading-bar");
  var $toast = document.getElementById("toast");
  var $commentModal = document.getElementById("comment-modal");
  var $commentPrNum = document.getElementById("comment-pr-num");
  var $commentText = document.getElementById("comment-text");
  var $commentCancel = document.getElementById("comment-cancel");
  var $commentSubmit = document.getElementById("comment-submit");
  var $adminStatus = document.getElementById("admin-status");
  var $updateRestartBtn = document.getElementById("update-restart-btn");
  var $addProjectBtn = document.getElementById("add-project-btn");
  var $removeProjectBtn = document.getElementById("remove-project-btn");
  var $addProjectModal = document.getElementById("add-project-modal");
  var $addProjectInput = document.getElementById("add-project-input");
  var $addProjectCancel = document.getElementById("add-project-cancel");
  var $addProjectSubmit = document.getElementById("add-project-submit");
  var $schedulerSection = document.getElementById("scheduler-section");
  var $schedulerToggle = document.getElementById("scheduler-toggle");
  var $schedulerTriggerBtn = document.getElementById("scheduler-trigger-btn");
  var $schedulerStatus = document.getElementById("scheduler-status");
  var $schedulerBadge = document.getElementById("scheduler-badge");
  var $planBtn = document.getElementById("plan-btn");
  var $planModal = document.getElementById("plan-modal");
  var $planProjectName = document.getElementById("plan-project-name");
  var $planDescription = document.getElementById("plan-description");
  var $planCancel = document.getElementById("plan-cancel");
  var $planSubmit = document.getElementById("plan-submit");

  var adminBusy = false; // prevents concurrent admin operations

  // ---------------------------------------------------------------------------
  // API layer
  // ---------------------------------------------------------------------------

  function startLoading() {
    pendingRequests++;
    $loadingBar.classList.add("active");
  }

  function stopLoading() {
    pendingRequests = Math.max(0, pendingRequests - 1);
    if (pendingRequests === 0) {
      $loadingBar.classList.remove("active");
    }
  }

  function api(method, path, body) {
    startLoading();
    var opts = {
      method: method,
      headers: {
        "x-telegram-init-data": getInitData(),
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts)
      .then(function (res) {
        return res.text().then(function (text) {
          var data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            throw new Error("HTTP " + res.status + " (invalid response)");
          }
          if (res.status === 401) {
            showAuthExpired();
            throw new Error("Session expired");
          }
          if (!res.ok) {
            throw new Error(data.error || "HTTP " + res.status);
          }
          return data;
        });
      })
      .finally(stopLoading);
  }

  // ---------------------------------------------------------------------------
  // Toast notifications
  // ---------------------------------------------------------------------------

  var authExpiredShown = false;
  function showAuthExpired() {
    if (authExpiredShown) return;
    authExpiredShown = true;
    var overlay = document.createElement("div");
    overlay.className = "auth-expired-overlay";
    overlay.innerHTML = '<div class="auth-expired-box">' +
      '<p>Session expired</p>' +
      '<button class="btn btn-primary" id="auth-reload-btn">Reload</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById("auth-reload-btn").addEventListener("click", function () {
      if (window.Telegram && Telegram.WebApp) {
        Telegram.WebApp.close();
      } else {
        location.reload();
      }
    });
  }

  var toastTimeout = null;

  function showToast(message, type) {
    type = type || "info";
    if (toastTimeout) clearTimeout(toastTimeout);
    $toast.textContent = message;
    $toast.className = "toast " + type;
    // Force reflow so transition fires
    void $toast.offsetHeight;
    $toast.classList.add("visible");
    toastTimeout = setTimeout(function () {
      $toast.classList.remove("visible");
    }, 3000);
  }

  // ---------------------------------------------------------------------------
  // Render: Sessions
  // ---------------------------------------------------------------------------

  function renderSessions() {
    // Close log streams for sessions that no longer exist
    var currentTaskIds = {};
    for (var si = 0; si < sessions.length; si++) {
      currentTaskIds[sessions[si].taskId] = true;
    }
    for (var tid in logStreams) {
      if (!currentTaskIds[tid]) {
        closeLogStream(tid);
      }
    }
    if (sessions.length === 0) {
      $sessionsList.innerHTML = '<div class="empty-state">No active sessions</div>';
      $sessionsCount.style.display = "none";
      return;
    }
    $sessionsCount.textContent = sessions.length;
    $sessionsCount.style.display = "";
    var html = "";
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var statusLabel = s.status.replace("_", " ");
      var isLogOpen = !!logStreams[s.taskId];
      html += '<div class="session-card" data-session-task="' + escAttr(s.taskId) + '">';
      html += '<div class="session-top">';
      html += '<div class="session-info">';
      html += '<div class="session-task">' + esc(s.taskId) + "</div>";
      html += '<div class="session-meta">';
      html += '<span class="status-dot ' + esc(s.status) + '"></span>';
      html += "<span>" + esc(statusLabel) + "</span>";
      html += "<span>" + esc(s.skill) + "</span>";
      html += "<span>" + esc(s.elapsed) + "</span>";
      html += "</div></div>";
      html += '<div class="session-card-actions">';
      html +=
        '<button class="log-toggle' + (isLogOpen ? ' active' : '') + '" data-task="' +
        escAttr(s.taskId) +
        '">Logs</button>';
      html +=
        '<button class="btn btn-danger btn-stop" data-task="' +
        escAttr(s.taskId) +
        '">Stop</button>';
      html += "</div></div>";
      if (s.pendingQuestion) {
        var q = s.pendingQuestion.questions;
        for (var j = 0; j < q.length; j++) {
          html +=
            '<div class="session-question">' + esc(q[j]) + "</div>";
        }
      }
      // Placeholder for log panel (re-attached below if open)
      html += '<div class="log-panel-slot" data-log-slot="' + escAttr(s.taskId) + '"></div>';
      html += "</div>";
    }
    $sessionsList.innerHTML = html;
    var stopBtns = $sessionsList.querySelectorAll(".btn-stop");
    for (var k = 0; k < stopBtns.length; k++) {
      stopBtns[k].addEventListener("click", handleStopClick);
    }

    // Attach log toggle handlers
    var logBtns = $sessionsList.querySelectorAll(".log-toggle");
    for (var l = 0; l < logBtns.length; l++) {
      logBtns[l].addEventListener("click", handleLogToggle);
    }

    // Re-attach existing log panels
    for (var taskId in logStreams) {
      var slot = $sessionsList.querySelector('[data-log-slot="' + escAttr(taskId) + '"]');
      if (slot && logStreams[taskId].panel) {
        slot.appendChild(logStreams[taskId].panel);
      }
    }
  }

  function handleStopClick(e) {
    var taskId = e.currentTarget.getAttribute("data-task");
    if (!taskId) return;
    e.currentTarget.disabled = true;
    api("POST", "/api/sessions/" + encodeURIComponent(taskId) + "/stop")
      .then(function () {
        showToast("Session stopped", "success");
        return loadSessions();
      })
      .catch(function (err) {
        showToast(err.message, "error");
      });
  }

  // ---------------------------------------------------------------------------
  // Log Panel
  // ---------------------------------------------------------------------------

  function handleLogToggle(e) {
    var taskId = e.currentTarget.getAttribute("data-task");
    if (!taskId) return;
    if (logStreams[taskId]) {
      closeLogStream(taskId);
      renderSessions();
    } else {
      openLogStream(taskId);
      renderSessions();
    }
  }

  function openLogStream(taskId) {
    if (logStreams[taskId]) return;

    var panel = document.createElement("div");
    panel.className = "log-panel";

    var initData = getInitData();
    var url = "/api/sessions/" + encodeURIComponent(taskId) + "/logs?initData=" + encodeURIComponent(initData);
    var es = new EventSource(url);
    var state = { es: es, panel: panel, autoScroll: true };
    logStreams[taskId] = state;
    panel.addEventListener("scroll", function () {
      // If user scrolled up from bottom, pause auto-scroll
      var atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 30;
      state.autoScroll = atBottom;
    });


    es.onmessage = function (evt) {
      try {
        var event = JSON.parse(evt.data);
        appendLogLine(panel, state, event);
      } catch (err) {
        // Ignore parse errors
      }
    };

    es.onerror = function () {
      // EventSource auto-reconnects; on permanent close, clean up
      if (es.readyState === EventSource.CLOSED) {
        closeLogStream(taskId);
      }
    };
  }

  function closeLogStream(taskId) {
    var stream = logStreams[taskId];
    if (!stream) return;
    stream.es.close();
    if (stream.panel.parentNode) {
      stream.panel.parentNode.removeChild(stream.panel);
    }
    delete logStreams[taskId];
  }

  function appendLogLine(panel, state, event) {
    var line = document.createElement("div");
    line.className = "log-line";

    var timeSpan = document.createElement("span");
    timeSpan.className = "log-time";
    timeSpan.textContent = event.time || "";
    line.appendChild(timeSpan);

    var contentSpan = document.createElement("span");

    switch (event.type) {
      case "tool_start":
        contentSpan.className = "log-tool";
        contentSpan.textContent = "\u25B6 " + (event.tool || "tool") + (event.content ? " \u2014 " + event.content : "");
        break;
      case "tool_end":
        contentSpan.className = "log-tool";
        contentSpan.textContent = "\u2713 " + (event.tool || "tool");
        break;
      case "text":
        contentSpan.className = "log-text";
        contentSpan.textContent = event.content || "";
        break;
      case "question":
        contentSpan.className = "log-question";
        contentSpan.textContent = "\u23F8 Waiting: " + (event.content || "");
        break;
      case "complete":
        contentSpan.className = "log-complete";
        contentSpan.textContent = "\u2713 Session complete";
        break;
      case "error":
        contentSpan.className = "log-error";
        contentSpan.textContent = "\u2717 " + (event.content || "Error");
        break;
      default:
        contentSpan.textContent = event.type + ": " + (event.content || "");
    }

    line.appendChild(contentSpan);
    panel.appendChild(line);

    // Trim old lines
    while (panel.children.length > MAX_LOG_LINES) {
      panel.removeChild(panel.firstChild);
    }

    // Auto-scroll
    if (state.autoScroll) {
      panel.scrollTop = panel.scrollHeight;
    }
  }

  // ---------------------------------------------------------------------------
  // Render: Issue Tree
  // ---------------------------------------------------------------------------

  function buildIssueTree(excludeNumbers) {
    excludeNumbers = excludeNumbers || {};
    // Filter out excluded issues
    var filtered = [];
    for (var f = 0; f < issues.length; f++) {
      if (!excludeNumbers[issues[f].number]) filtered.push(issues[f]);
    }

    // Map issue number -> issue object
    var issueMap = {};
    for (var i = 0; i < filtered.length; i++) {
      issueMap[filtered[i].number] = filtered[i];
    }

    // Build PR map: issue number -> pr object
    var prMap = {};
    for (var j = 0; j < filtered.length; j++) {
      if (filtered[j].pr) {
        prMap[filtered[j].number] = filtered[j].pr;
      }
    }

    // Build children map: parent issue number -> [child issues]
    var childrenOf = {};
    var isChild = {};

    for (var k = 0; k < filtered.length; k++) {
      var deps = filtered[k].dependsOn || [];
      for (var d = 0; d < deps.length; d++) {
        var dep = deps[d];
        if (issueMap[dep]) {
          if (!childrenOf[dep]) childrenOf[dep] = [];
          childrenOf[dep].push(filtered[k]);
          isChild[filtered[k].number] = true;
        }
      }
    }

    // Root issues: not a child of any open issue
    var roots = [];
    for (var r = 0; r < filtered.length; r++) {
      if (!isChild[filtered[r].number]) {
        roots.push(filtered[r]);
      }
    }

    return { roots: roots, childrenOf: childrenOf, prMap: prMap };
  }

  function getQueuedSet() {
    var set = {};
    if (schedulerStatus && schedulerStatus.projects && selectedProject) {
      var proj = schedulerStatus.projects[selectedProject];
      if (proj && proj.scheduledChains) {
        for (var i = 0; i < proj.scheduledChains.length; i++) {
          set[proj.scheduledChains[i]] = true;
        }
      }
    }
    return set;
  }

  function isMultiDependencyIssue(issue) {
    return !!(issue && issue.dependsOn && issue.dependsOn.length > 1);
  }

  function renderIssueNode(issue, childrenOf, depth) {
    var isBlocked = issue.blockedBy && issue.blockedBy.length > 0;
    var pr = issue.pr;

    var li = document.createElement("li");
    li.className = "issue-node";

    var card = document.createElement("div");
    card.className = "issue-card" + (isBlocked ? " blocked" : "");

    // Header row: number + title
    var header = document.createElement("div");
    header.className = "issue-header";
    var numSpan = document.createElement("span");
    numSpan.className = "issue-number clickable";
    numSpan.textContent = "#" + issue.number;
    if (repoUrl) {
      numSpan.addEventListener("click", (function (url) {
        return function () { openLink(url); };
      })(repoUrl + "/issues/" + issue.number));
    }
    var titleSpan = document.createElement("span");
    titleSpan.className = "issue-title clickable";
    titleSpan.textContent = issue.title;
    if (repoUrl) {
      titleSpan.addEventListener("click", (function (url) {
        return function () { openLink(url); };
      })(repoUrl + "/issues/" + issue.number));
    }
    header.appendChild(numSpan);
    header.appendChild(titleSpan);
    card.appendChild(header);

    // Labels
    if (issue.labels && issue.labels.length > 0) {
      var labelsDiv = document.createElement("div");
      labelsDiv.className = "issue-labels";
      for (var i = 0; i < issue.labels.length; i++) {
        var labelSpan = document.createElement("span");
        labelSpan.className = "issue-label";
        labelSpan.textContent = issue.labels[i];
        labelsDiv.appendChild(labelSpan);
      }
      card.appendChild(labelsDiv);
    }

    // PR badge (compact — full PR details in separate section)
    if (pr) {
      var prBadge = document.createElement("span");
      prBadge.className = "issue-pr-badge clickable";
      if (pr.mergeable === true) {
        prBadge.classList.add("ready");
        prBadge.textContent = "\u2713 PR #" + pr.number;
      } else if (pr.mergeable === false) {
        prBadge.classList.add("conflicts");
        prBadge.textContent = "\u2717 PR #" + pr.number;
      } else {
        prBadge.classList.add("open");
        prBadge.textContent = "PR #" + pr.number;
      }
      if (pr.url) {
        prBadge.addEventListener("click", (function (url) {
          return function () { openLink(url); };
        })(pr.url));
      }
      card.appendChild(prBadge);
    }

    // Blocked by info
    if (isBlocked) {
      var blockedDiv = document.createElement("div");
      blockedDiv.className = "issue-blocked-by";
      blockedDiv.textContent =
        "Blocked by: " +
        issue.blockedBy.map(function (n) { return "#" + n; }).join(", ");
      card.appendChild(blockedDiv);
    }

    // Action buttons
    var actions = document.createElement("div");
    actions.className = "issue-actions";

    var issueTaskSessionId = selectedProject ? "oh-task-" + selectedProject + "-" + issue.number : null;
    var issueJoinSessionId = selectedProject ? "oh-join-" + selectedProject + "-" + issue.number : null;
    var hasActiveTaskSession = issueTaskSessionId && sessions.some(function (s) { return s.taskId === issueTaskSessionId; });
    var hasActiveJoinSession = issueJoinSessionId && sessions.some(function (s) { return s.taskId === issueJoinSessionId; });
    if (hasActiveTaskSession || hasActiveJoinSession) {
      var runningBtn = document.createElement("span");
      runningBtn.className = "btn btn-in-progress";
      runningBtn.textContent = hasActiveJoinSession ? "Joining…" : "In Progress…";
      actions.appendChild(runningBtn);
    } else {
      var startBtn = document.createElement("button");
      startBtn.className = "btn btn-primary";
      startBtn.textContent = "Start";
      startBtn.setAttribute("data-issue", issue.number);
      startBtn.addEventListener("click", handleStartClick);
      actions.appendChild(startBtn);

      if (isMultiDependencyIssue(issue)) {
        var joinBtn = document.createElement("button");
        joinBtn.className = "btn btn-secondary";
        joinBtn.textContent = "Join";
        joinBtn.setAttribute("data-issue", issue.number);
        joinBtn.addEventListener("click", handleJoinClick);
        actions.appendChild(joinBtn);
      }

      var closeBtn = document.createElement("button");
      closeBtn.className = "btn btn-danger";
      closeBtn.textContent = "Close";
      closeBtn.setAttribute("data-issue", issue.number);
      closeBtn.addEventListener("click", handleCloseClick);
      actions.appendChild(closeBtn);
    }

    // Queue button for scheduler
    var queuedSet = getQueuedSet();
    var isQueued = queuedSet[issue.number];
    var queueBtn = document.createElement("button");
    queueBtn.className = "btn " + (isQueued ? "btn-queued" : "btn-queue");
    queueBtn.textContent = isQueued ? "Queued" : "Queue";
    queueBtn.setAttribute("data-issue", issue.number);
    queueBtn.addEventListener("click", handleQueueClick);
    actions.appendChild(queueBtn);
    card.appendChild(actions);
    li.appendChild(card);

    // Children
    var children = childrenOf[issue.number] || [];
    if (children.length > 0) {
      li.classList.add("has-children");
      var ul = document.createElement("ul");
      for (var c = 0; c < children.length; c++) {
        ul.appendChild(renderIssueNode(children[c], childrenOf, depth + 1));
      }
      li.appendChild(ul);
    }

    return li;
  }

  var STANDARD_PHASE_ORDER = { build: 0, audit: 1, critique: 2 };

  function phaseDisplayLabel(phase) {
    return phase.charAt(0).toUpperCase() + phase.slice(1);
  }

  function detectFactoryPipelines() {
    // Scan open issues for factory:<app>:<phase> labels
    var apps = {}; // app -> { phase -> [issue, ...] }
    var factoryIssueNumbers = {};
    for (var i = 0; i < issues.length; i++) {
      var issue = issues[i];
      if (!issue.labels) continue;
      for (var j = 0; j < issue.labels.length; j++) {
        var m = issue.labels[j].match(/^factory:([^:]+):([^:]+)$/);
        if (!m) continue;
        var app = m[1];
        var phase = m[2];
        if (!apps[app]) apps[app] = {};
        if (!apps[app][phase]) apps[app][phase] = [];
        apps[app][phase].push(issue);
        factoryIssueNumbers[issue.number] = true;
      }
    }

    var pipelines = [];
    var appNames = Object.keys(apps);
    for (var a = 0; a < appNames.length; a++) {
      var appName = appNames[a];
      var phaseNames = Object.keys(apps[appName]);

      // Build issue-number-to-phase map for this app
      var issuePhaseMap = {};
      for (var pn = 0; pn < phaseNames.length; pn++) {
        var pIssues = apps[appName][phaseNames[pn]];
        for (var pi = 0; pi < pIssues.length; pi++) {
          issuePhaseMap[pIssues[pi].number] = phaseNames[pn];
        }
      }

      // For custom phases, compute sort order from dependencies
      var customPhaseOrder = {};
      for (var cn = 0; cn < phaseNames.length; cn++) {
        var pName = phaseNames[cn];
        if (STANDARD_PHASE_ORDER.hasOwnProperty(pName)) continue;
        var maxDepPhase = -1;
        var cIssues = apps[appName][pName];
        for (var ci = 0; ci < cIssues.length; ci++) {
          var deps = cIssues[ci].dependsOn || [];
          for (var di = 0; di < deps.length; di++) {
            var depPhase = issuePhaseMap[deps[di]];
            if (depPhase && STANDARD_PHASE_ORDER.hasOwnProperty(depPhase)) {
              var depIdx = STANDARD_PHASE_ORDER[depPhase];
              if (depIdx > maxDepPhase) maxDepPhase = depIdx;
            }
          }
        }
        customPhaseOrder[pName] = maxDepPhase >= 0 ? maxDepPhase + 0.5 : 1000;
      }

      phaseNames.sort(function(a, b) {
        var aOrder = STANDARD_PHASE_ORDER.hasOwnProperty(a) ? STANDARD_PHASE_ORDER[a] : (customPhaseOrder[a] !== undefined ? customPhaseOrder[a] : 1000);
        var bOrder = STANDARD_PHASE_ORDER.hasOwnProperty(b) ? STANDARD_PHASE_ORDER[b] : (customPhaseOrder[b] !== undefined ? customPhaseOrder[b] : 1000);
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a < b ? -1 : a > b ? 1 : 0;
      });

      var phases = [];
      for (var p = 0; p < phaseNames.length; p++) {
        var phaseName = phaseNames[p];
        var openIssues = apps[appName][phaseName] || [];
        phases.push({
          name: phaseName,
          label: phaseDisplayLabel(phaseName),
          issues: openIssues,
          open: openIssues.length
        });
      }
      pipelines.push({ app: appName, phases: phases });
    }
    return { pipelines: pipelines, factoryIssueNumbers: factoryIssueNumbers };
  }

  // Look up full PR data from allPRs global (enrichment, behindBy, etc.)
  function findFactoryPR(project, prNumber) {
    for (var i = 0; i < allPRs.length; i++) {
      if (allPRs[i].project === project && allPRs[i].number === prNumber) {
        return allPRs[i];
      }
    }
    return null;
  }

  function renderFactoryPipeline(pipelines) {
    $factoryPipeline.innerHTML = '';
    if (!pipelines.length) {
      $factoryPipelineSection.style.display = 'none';
      return;
    }

    var queuedSet = getQueuedSet();
    var container = document.createElement('div');
    container.className = 'factory-pipeline';

    for (var i = 0; i < pipelines.length; i++) {
      var pl = pipelines[i];
      var appDiv = document.createElement('div');
      appDiv.className = 'factory-pipeline-app';
      var storageKey = 'miranda_factory_collapsed_' + pl.app;

      // Header with title + chevron (collapsible)
      var header = document.createElement('div');
      header.className = 'factory-pipeline-header';

      var chevron = document.createElement('span');
      chevron.className = 'factory-pipeline-chevron';
      chevron.textContent = '\u25BE';
      header.appendChild(chevron);

      var titleSpan = document.createElement('span');
      titleSpan.className = 'factory-pipeline-title';
      titleSpan.textContent = pl.app.toUpperCase() + ' Pipeline';
      header.appendChild(titleSpan);

      // Summary badge in header (always visible even when collapsed)
      var allDone = true;
      var summaryParts = [];
      var firstActiveFound = false;
      for (var s = 0; s < pl.phases.length; s++) {
        var sp = pl.phases[s];
        if (sp.open === 0 && !firstActiveFound) {
          summaryParts.push('\u2713 ' + sp.label);
        } else if (sp.open > 0 && !firstActiveFound) {
          summaryParts.push(sp.label + ' (' + sp.open + ')');
          firstActiveFound = true;
          allDone = false;
        } else {
          summaryParts.push('\u25CB ' + sp.label);
          allDone = false;
        }
      }
      var summary = document.createElement('span');
      summary.className = 'factory-pipeline-summary';
      summary.textContent = summaryParts.join(' \u2192 ');
      header.appendChild(summary);

      appDiv.appendChild(header);

      // Body (collapsible content)
      var body = document.createElement('div');
      body.className = 'factory-pipeline-body';

      // Phase progress bar
      var stepsDiv = document.createElement('div');
      stepsDiv.className = 'factory-pipeline-steps';

      firstActiveFound = false;
      for (var p = 0; p < pl.phases.length; p++) {
        if (p > 0) {
          var arrow = document.createElement('span');
          arrow.className = 'factory-step-arrow';
          arrow.textContent = '\u2192';
          stepsDiv.appendChild(arrow);
        }
        var phase = pl.phases[p];
        var step = document.createElement('span');
        var cls, icon;
        if (phase.open === 0 && !firstActiveFound) {
          cls = 'done'; icon = '\u2713';
        } else if (phase.open > 0 && !firstActiveFound) {
          cls = 'active'; icon = null;
          firstActiveFound = true;
        } else {
          cls = 'pending'; icon = '\u25CB';
        }
        step.className = 'factory-step ' + cls;
        if (icon) {
          step.innerHTML = '<span class="factory-step-icon">' + icon + '</span> ' + esc(phase.label);
        } else {
          step.innerHTML = esc(phase.label) + ' <span class="factory-step-badge">' + phase.open + '</span>';
        }
        stepsDiv.appendChild(step);
      }
      body.appendChild(stepsDiv);

      // Issue rows per phase
      for (var q = 0; q < pl.phases.length; q++) {
        var ph = pl.phases[q];
        if (ph.issues.length === 0) continue;

        var phaseGroup = document.createElement('div');
        phaseGroup.className = 'factory-phase-group';

        var phaseLabel = document.createElement('div');
        phaseLabel.className = 'factory-phase-label';
        phaseLabel.textContent = ph.label;
        phaseGroup.appendChild(phaseLabel);

        for (var r = 0; r < ph.issues.length; r++) {
          var issue = ph.issues[r];
          var row = document.createElement('div');
          row.className = 'factory-issue-row';

          var num = document.createElement('span');
          num.className = 'issue-number clickable';
          num.textContent = '#' + issue.number;
          if (repoUrl) {
            num.addEventListener('click', (function (url) {
              return function () { openLink(url); };
            })(repoUrl + '/issues/' + issue.number));
          }
          row.appendChild(num);

          var title = document.createElement('span');
          title.className = 'factory-issue-title';
          title.textContent = issue.title;
          row.appendChild(title);

          // PR badge
          if (issue.pr) {
            var prBadge = document.createElement('span');
            prBadge.className = 'issue-pr-badge clickable';
            if (issue.pr.mergeable === true) {
              prBadge.classList.add('ready');
              prBadge.textContent = '\u2713 PR #' + issue.pr.number;
            } else if (issue.pr.mergeable === false) {
              prBadge.classList.add('conflicts');
              prBadge.textContent = '\u2717 PR #' + issue.pr.number;
            } else {
              prBadge.classList.add('open');
              prBadge.textContent = 'PR #' + issue.pr.number;
            }
            if (issue.pr.url) {
              prBadge.addEventListener('click', (function (url) {
                return function () { openLink(url); };
              })(issue.pr.url));
            }
            row.appendChild(prBadge);
          }

          // Action buttons — PR actions if PR exists, else issue actions
          var actions = document.createElement('span');
          actions.className = 'factory-issue-actions';

          if (issue.pr) {
            // PR actions inline in factory pipeline
            var fullPR = findFactoryPR(selectedProject, issue.pr.number);
            var enrichment = fullPR ? fullPR.enrichment : null;
            var behindBy = fullPR ? (fullPR.behindBy || 0) : 0;

            // Status indicators (CI + CodeRabbit)
            if (enrichment) {
              if (enrichment.ci) {
                var ciSpan = document.createElement('span');
                ciSpan.className = 'pr-ci ci-' + enrichment.ci.state;
                ciSpan.title = ciTooltip(enrichment.ci);
                ciSpan.textContent = ciIndicator(enrichment.ci.state);
                if (enrichment.ci.state === 'failure') {
                  ciSpan.classList.add('clickable');
                  ciSpan.setAttribute('data-pr', issue.pr.number);
                  ciSpan.setAttribute('data-project', selectedProject);
                  ciSpan.addEventListener('click', handleFixCiClick);
                }
                actions.appendChild(ciSpan);
              }
              if (enrichment.coderabbit && enrichment.coderabbit.reviewed) {
                var crSpan = document.createElement('span');
                crSpan.className = 'pr-coderabbit cr-' + enrichment.coderabbit.state;
                crSpan.textContent = coderabbitIndicator(enrichment.coderabbit);
                actions.appendChild(crSpan);
              }
            }

            // Merge / Conflicts
            if (issue.pr.mergeable === true) {
              var mergeBtn = document.createElement('button');
              mergeBtn.className = 'btn btn-merge btn-compact';
              mergeBtn.textContent = 'Merge';
              mergeBtn.setAttribute('data-pr', issue.pr.number);
              mergeBtn.setAttribute('data-project', selectedProject);
              mergeBtn.addEventListener('click', handleMergeClick);
              actions.appendChild(mergeBtn);
            } else if (issue.pr.mergeable === false) {
              var factoryConflictSessionId = 'oh-conflict-' + selectedProject + '-' + issue.pr.number;
              var factoryConflictActive = sessions.some(function (s) { return s.taskId === factoryConflictSessionId; });
              if (factoryConflictActive) {
                var conflictsSpan = document.createElement('span');
                conflictsSpan.className = 'btn btn-in-progress btn-compact';
                conflictsSpan.textContent = 'Fixing Conflicts\u2026';
                actions.appendChild(conflictsSpan);
              } else {
                var conflictsBtn = document.createElement('button');
                conflictsBtn.className = 'btn btn-danger btn-compact';
                conflictsBtn.textContent = 'Fix Conflicts';
                conflictsBtn.setAttribute('data-pr', issue.pr.number);
                conflictsBtn.setAttribute('data-project', selectedProject);
                conflictsBtn.addEventListener('click', handleFixConflictsClick);
                actions.appendChild(conflictsBtn);
              }
            } else {
              var checkingSpan = document.createElement('span');
              checkingSpan.className = 'btn btn-merge-disabled btn-compact';
              checkingSpan.textContent = 'Checking\u2026';
              actions.appendChild(checkingSpan);
            }

            // Update branch (if behind)
            if (behindBy > 0 && issue.pr.mergeable !== false) {
              var updateBtn = document.createElement('button');
              updateBtn.className = 'btn btn-update btn-compact';
              updateBtn.textContent = 'Update';
              updateBtn.setAttribute('data-pr', issue.pr.number);
              updateBtn.setAttribute('data-project', selectedProject);
              updateBtn.setAttribute('data-action', 'update-branch');
              updateBtn.addEventListener('click', handleUpdateBranchClick);
              actions.appendChild(updateBtn);
            }

            // Comment
            var commentBtn = document.createElement('button');
            commentBtn.className = 'btn btn-secondary btn-compact';
            commentBtn.textContent = 'Comment';
            commentBtn.setAttribute('data-pr', issue.pr.number);
            commentBtn.setAttribute('data-project', selectedProject);
            commentBtn.setAttribute('data-action', 'comment');
            commentBtn.addEventListener('click', handleCommentClick);
            actions.appendChild(commentBtn);

            // Notes (oh-notes)
            var notesSessionId = 'oh-notes-' + selectedProject + '-' + issue.pr.number;
            var notesActive = sessions.some(function (s) { return s.taskId === notesSessionId; });
            if (notesActive) {
              var notesSpan = document.createElement('span');
              notesSpan.className = 'btn btn-in-progress btn-compact';
              notesSpan.textContent = 'Notes\u2026';
              actions.appendChild(notesSpan);
            } else {
              var notesBtn = document.createElement('button');
              notesBtn.className = 'btn btn-notes btn-compact';
              notesBtn.textContent = 'Notes';
              notesBtn.setAttribute('data-pr', issue.pr.number);
              notesBtn.setAttribute('data-project', selectedProject);
              notesBtn.setAttribute('data-action', 'notes');
              notesBtn.addEventListener('click', handleNotesClick);
              actions.appendChild(notesBtn);
            }
          } else {
            // Issue actions (no PR yet)
            var issueTaskSessionId = selectedProject ? 'oh-task-' + selectedProject + '-' + issue.number : null;
            var issueJoinSessionId = selectedProject ? 'oh-join-' + selectedProject + '-' + issue.number : null;
            var hasActiveTaskSession = issueTaskSessionId && sessions.some(function (s) { return s.taskId === issueTaskSessionId; });
            var hasActiveJoinSession = issueJoinSessionId && sessions.some(function (s) { return s.taskId === issueJoinSessionId; });
            if (hasActiveTaskSession || hasActiveJoinSession) {
              var runSpan = document.createElement('span');
              runSpan.className = 'btn btn-in-progress btn-compact';
              runSpan.textContent = hasActiveJoinSession ? 'Joining\u2026' : 'In Progress\u2026';
              actions.appendChild(runSpan);
            } else {
              var startBtn = document.createElement('button');
              startBtn.className = 'btn btn-primary btn-compact';
              startBtn.textContent = 'Start';
              startBtn.setAttribute('data-issue', issue.number);
              startBtn.addEventListener('click', handleStartClick);
              actions.appendChild(startBtn);

              if (isMultiDependencyIssue(issue)) {
                var joinBtn = document.createElement('button');
                joinBtn.className = 'btn btn-secondary btn-compact';
                joinBtn.textContent = 'Join';
                joinBtn.setAttribute('data-issue', issue.number);
                joinBtn.addEventListener('click', handleJoinClick);
                actions.appendChild(joinBtn);
              }

              var closeBtn = document.createElement('button');
              closeBtn.className = 'btn btn-danger btn-compact';
              closeBtn.textContent = 'Close';
              closeBtn.setAttribute('data-issue', issue.number);
              closeBtn.addEventListener('click', handleCloseClick);
              actions.appendChild(closeBtn);
            }

            var isQueued = queuedSet[issue.number];
            var queueBtn = document.createElement('button');
            queueBtn.className = 'btn btn-compact ' + (isQueued ? 'btn-queued' : 'btn-queue');
            queueBtn.textContent = isQueued ? 'Queued' : 'Queue';
            queueBtn.setAttribute('data-issue', issue.number);
            queueBtn.addEventListener('click', handleQueueClick);
            actions.appendChild(queueBtn);
          }

          row.appendChild(actions);
          phaseGroup.appendChild(row);
        }
        body.appendChild(phaseGroup);
      }

      appDiv.appendChild(body);

      // Restore collapsed state
      if (localStorage.getItem(storageKey) === '1') {
        appDiv.classList.add('collapsed');
      }

      // Toggle handler
      header.addEventListener('click', (function (div, key) {
        return function () {
          div.classList.toggle('collapsed');
          if (div.classList.contains('collapsed')) {
            localStorage.setItem(key, '1');
          } else {
            localStorage.removeItem(key);
          }
        };
      })(appDiv, storageKey));

      container.appendChild(appDiv);
    }

    $factoryPipeline.appendChild(container);
    $factoryPipelineSection.style.display = '';
  }

  function renderIssues() {
    if (!selectedProject) {
      $issuesSection.style.display = "none";
      $planBtn.style.display = "none";
      currentFactoryIssueNumbers = {};
      renderFactoryPipeline([]);
      return;
    }

    $issuesSection.style.display = "";
    $planBtn.style.display = "";

    if (issues.length === 0) {
      $issuesTree.innerHTML = '<div class="empty-state">No open issues</div>';
      $issuesCount.style.display = "none";
      currentFactoryIssueNumbers = {};
      renderFactoryPipeline([]);
      return;
    }

    // Factory pipeline — detect first, filter from tree
    var factory = detectFactoryPipelines();
    var factoryNums = factory.factoryIssueNumbers;
    currentFactoryIssueNumbers = factoryNums;

    // Issue count excludes factory issues
    var nonFactoryCount = issues.length;
    var numKeys = Object.keys(factoryNums);
    for (var fn = 0; fn < numKeys.length; fn++) {
      if (factoryNums[numKeys[fn]]) nonFactoryCount--;
    }
    $issuesCount.textContent = nonFactoryCount > 0 ? nonFactoryCount : issues.length;
    $issuesCount.style.display = '';

    var tree = buildIssueTree(factoryNums);
    var ul = document.createElement('ul');
    ul.className = 'issue-tree';

    for (var i = 0; i < tree.roots.length; i++) {
      ul.appendChild(renderIssueNode(tree.roots[i], tree.childrenOf, 0));
    }

    $issuesTree.innerHTML = '';
    if (tree.roots.length > 0) {
      $issuesTree.appendChild(ul);
    } else if (nonFactoryCount === 0 && factory.pipelines.length > 0) {
      $issuesTree.innerHTML = '<div class="empty-state">All issues managed by factory pipeline</div>';
    } else {
      $issuesTree.innerHTML = '<div class="empty-state">No open issues</div>';
    }

    renderFactoryPipeline(factory.pipelines);
    // Re-render global PR view to filter out factory PRs
    renderAllPRs();
  }

  function renderAllPRs() {
    // Filter out PRs that belong to factory issues (shown inline in factory pipeline)
    var filteredPRs = allPRs.filter(function (pr) {
      if (pr.project !== selectedProject || !pr.linkedIssues) return true;
      for (var k = 0; k < pr.linkedIssues.length; k++) {
        if (currentFactoryIssueNumbers[pr.linkedIssues[k]]) return false;
      }
      return true;
    });

    if (filteredPRs.length === 0) {
      $allPrsList.innerHTML = '<div class="empty-state">No open PRs</div>';
      $allPrsCount.style.display = "none";
      return;
    }

    $allPrsCount.textContent = filteredPRs.length;
    $allPrsCount.style.display = "";
    var html = "";
    var prByProjectHead = {};
    for (var p = 0; p < filteredPRs.length; p++) {
      var key = filteredPRs[p].project + "::" + filteredPRs[p].head;
      prByProjectHead[key] = filteredPRs[p].number;
    }
    for (var j = 0; j < filteredPRs.length; j++) {
      var pr = filteredPRs[j];
      var enrichment = pr.enrichment;
      var isStacked = pr.base && pr.base !== "main" && pr.base !== "master";
      html += '<div class="pr-card' + (isStacked ? ' pr-stacked' : '') + '">';
      // PR header: project badge + number + title
      html += '<div class="pr-card-header">';
      html += '<span class="pr-card-project">' + esc(pr.project) + '</span>';
      if (isStacked) {
        html += '<span class="pr-stack-badge">⮕</span>';
      }
      html += '<span class="pr-card-number clickable" data-url="' + escAttr(pr.url || '') + '">#' + pr.number + '</span>';
      html += '<span class="pr-card-title">' + esc(pr.title) + '</span>';
      html += '</div>';
      // Stack target
      if (isStacked) {
        var baseKey = pr.project + "::" + pr.base;
        var basePrNumber = prByProjectHead[baseKey];
        html += '<div class="pr-card-stack">→ ' + (basePrNumber ? 'PR #' + basePrNumber : esc(pr.base)) + '</div>';
      }

      // Linked issues
      if (pr.linkedIssues && pr.linkedIssues.length > 0) {
        html += '<div class="pr-card-linked">';
        html += pr.linkedIssues.map(function (n) { return '#' + n; }).join(', ');
        html += '</div>';
      }
      // Status row: mergeable + CI + CodeRabbit
      html += '<div class="pr-card-status">';
      if (pr.mergeable === true) {
        html += '<span class="pr-status ready">\u2713 Ready</span>';
      } else if (pr.mergeable === false) {
        html += '<span class="pr-status conflicts clickable" data-pr="' + pr.number + '" data-project="' + escAttr(pr.project) + '" data-action="fix-conflicts">\u2717 Conflicts</span>';
      } else {
        html += '<span class="pr-status open">Checking\u2026</span>';
      }
      if (enrichment && enrichment.ci) {
        if (enrichment.ci.state === 'failure') {
          var ciSessionId = 'oh-ci-' + pr.project + '-' + pr.number;
          var ciActive = sessions.some(function (s) { return s.taskId === ciSessionId; });
          if (ciActive) {
            html += '<span class="pr-ci ci-failure" title="CI fix in progress\u2026">' + ciIndicator(enrichment.ci.state) + '\u2026</span>';
          } else {
            html += '<span class="pr-ci ci-failure clickable" data-pr="' + pr.number + '" data-project="' + escAttr(pr.project) + '" data-action="fix-ci" title="' + escAttr(ciTooltip(enrichment.ci)) + '">' + ciIndicator(enrichment.ci.state) + '</span>';
          }
        } else {
          html += '<span class="pr-ci ci-' + enrichment.ci.state + '" title="' + escAttr(ciTooltip(enrichment.ci)) + '">' + ciIndicator(enrichment.ci.state) + '</span>';
        }
      }
      if (enrichment && enrichment.coderabbit && enrichment.coderabbit.reviewed) {
        html += '<span class="pr-coderabbit cr-' + enrichment.coderabbit.state + '">' + coderabbitIndicator(enrichment.coderabbit) + '</span>';
      }
      html += '</div>';

      // Action buttons with data-project for cross-project ops
      html += '<div class="pr-card-actions">';
      if (pr.mergeable === true) {
        html += '<button class="btn btn-merge" data-pr="' + pr.number + '" data-project="' + escAttr(pr.project) + '">Merge</button>';
      } else if (pr.mergeable === false) {
        var conflictSessionId = 'oh-conflict-' + pr.project + '-' + pr.number;
        var conflictActive = sessions.some(function (s) { return s.taskId === conflictSessionId; });
        if (conflictActive) {
          html += '<span class="btn btn-in-progress">Fixing Conflicts\u2026</span>';
        } else {
          html += '<button class="btn btn-danger" data-pr="' + pr.number + '" data-project="' + escAttr(pr.project) + '" data-action="fix-conflicts">Fix Conflicts</button>';
        }
      } else {
        html += '<span class="btn btn-merge-disabled">Checking\u2026</span>';
      }
      if ((pr.behindBy || 0) > 0 && pr.mergeable !== false) {
        html += '<button class="btn btn-update" data-pr="' + pr.number + '" data-project="' + escAttr(pr.project) + '" data-action="update-branch">Update</button>';
      }
      html += '<button class="btn btn-secondary" data-pr="' + pr.number + '" data-project="' + escAttr(pr.project) + '" data-action="comment">Comment</button>';
      // Notes button (oh-notes)
      var notesSessionId = "oh-notes-" + pr.project + "-" + pr.number;
      var notesActive = sessions.some(function (s) { return s.taskId === notesSessionId; });
      if (notesActive) {
        html += '<span class="btn btn-in-progress">Notes\u2026</span>';
      } else {
        html += '<button class="btn btn-notes" data-pr="' + pr.number + '" data-project="' + escAttr(pr.project) + '" data-action="notes">Notes</button>';
      }
      html += '</div>';
      html += '</div>';
    }

    $allPrsList.innerHTML = html;
    // Attach handlers
    var mergeBtns = $allPrsList.querySelectorAll(".btn-merge");
    for (var m = 0; m < mergeBtns.length; m++) {
      mergeBtns[m].addEventListener("click", handleMergeClick);
    }
    var commentBtns = $allPrsList.querySelectorAll('[data-action="comment"]');
    for (var c = 0; c < commentBtns.length; c++) {
      commentBtns[c].addEventListener("click", handleCommentClick);
    }
    var notesBtns = $allPrsList.querySelectorAll('[data-action="notes"]');
    for (var nb = 0; nb < notesBtns.length; nb++) {
      notesBtns[nb].addEventListener("click", handleNotesClick);
    }
    var updateBtns = $allPrsList.querySelectorAll('[data-action="update-branch"]');
    for (var ub = 0; ub < updateBtns.length; ub++) {
      updateBtns[ub].addEventListener("click", handleUpdateBranchClick);
    }
    var fixConflictBtns = $allPrsList.querySelectorAll('[data-action="fix-conflicts"]');
    for (var fc = 0; fc < fixConflictBtns.length; fc++) {
      fixConflictBtns[fc].addEventListener('click', handleFixConflictsClick);
    }
    var fixCiBtns = $allPrsList.querySelectorAll('[data-action="fix-ci"]');
    for (var fi = 0; fi < fixCiBtns.length; fi++) {
      fixCiBtns[fi].addEventListener('click', handleFixCiClick);
    }
    var prNumLinks = $allPrsList.querySelectorAll(".pr-card-number");
    for (var n = 0; n < prNumLinks.length; n++) {
      prNumLinks[n].addEventListener("click", function () {
        var url = this.getAttribute("data-url");
        if (url) openLink(url);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  function handleFixConflictsClick(e) {
    var prNum = e.currentTarget.getAttribute('data-pr');
    var project = e.currentTarget.getAttribute('data-project') || selectedProject;
    if (!prNum || !project) return;
    if (!confirm('Start conflict resolution for PR #' + prNum + '?')) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Starting\u2026';
    api('POST', '/api/projects/' + encodeURIComponent(project) + '/prs/' + prNum + '/fix-conflicts')
      .then(function () {
        showToast('Conflict resolution started for PR #' + prNum, 'success');
        return loadSessions().then(function () { renderAllPRs(); });
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Fix Conflicts';
        showToast(err.message, 'error');
      });
  }

  function handleFixCiClick(e) {
    var prNum = e.currentTarget.getAttribute('data-pr');
    var project = e.currentTarget.getAttribute('data-project') || selectedProject;
    if (!prNum || !project) return;
    if (!confirm('Start CI fix for PR #' + prNum + '?')) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Starting\u2026';
    api('POST', '/api/projects/' + encodeURIComponent(project) + '/prs/' + prNum + '/fix-ci')
      .then(function () {
        showToast('CI fix started for PR #' + prNum, 'success');
        return loadSessions().then(function () { renderAllPRs(); });
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Fix CI';
        showToast(err.message, 'error');
      });
  }

  function handleStartClick(e) {
    var issueNum = e.currentTarget.getAttribute("data-issue");
    if (!issueNum || !selectedProject) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    api("POST", "/api/projects/" + encodeURIComponent(selectedProject) + "/issues/" + issueNum + "/start")
      .then(function () {
        showToast("Issue #" + issueNum + " started", "success");
        return loadSessions();
      })
      .catch(function (err) {
        btn.disabled = false;
        showToast(err.message, "error");
      });
  }

  function handleJoinClick(e) {
    var issueNum = e.currentTarget.getAttribute("data-issue");
    if (!issueNum || !selectedProject) return;
    if (!confirm("Start oh-join for issue #" + issueNum + "?")) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Joining…";
    api("POST", "/api/projects/" + encodeURIComponent(selectedProject) + "/issues/" + issueNum + "/join")
      .then(function () {
        showToast("Join started for issue #" + issueNum, "success");
        return loadSessions().then(function () { renderIssues(); });
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Join";
        showToast(err.message, "error");
      });
  }

  function handleCloseClick(e) {
    var issueNum = e.currentTarget.getAttribute("data-issue");
    if (!issueNum || !selectedProject) return;
    if (!confirm("Close issue #" + issueNum + "?")) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    api("POST", "/api/projects/" + encodeURIComponent(selectedProject) + "/issues/" + issueNum + "/close")
      .then(function () {
        showToast("Issue #" + issueNum + " closed", "success");
        return loadProjectData();
      })
      .catch(function (err) {
        btn.disabled = false;
        showToast(err.message, "error");
      });
  }

  function handleQueueClick(e) {
    var issueNum = e.currentTarget.getAttribute("data-issue");
    if (!issueNum || !selectedProject) return;
    var btn = e.currentTarget;
    var isQueued = btn.classList.contains("btn-queued");
    var method = isQueued ? "DELETE" : "POST";
    btn.disabled = true;
    api(method, "/api/scheduler/" + encodeURIComponent(selectedProject) + "/queue/" + issueNum)
      .then(function () {
        showToast(isQueued ? "#" + issueNum + " removed from queue" : "#" + issueNum + " queued for auto-stacking", "success");
        return loadSchedulerStatus().then(function () { renderIssues(); });
      })
      .catch(function (err) {
        btn.disabled = false;
        showToast(err.message, "error");
      });
  }

  function handleMergeClick(e) {
    var prNum = e.currentTarget.getAttribute("data-pr");
    var project = e.currentTarget.getAttribute("data-project") || selectedProject;
    if (!prNum || !project) return;
    if (!confirm("Squash-merge PR #" + prNum + "?")) return;
    var btn = e.currentTarget;
    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Merging\u2026";
    api("POST", "/api/projects/" + encodeURIComponent(project) + "/prs/" + prNum + "/merge")
      .then(function () {
        btn.textContent = "Merged \u2713";
        btn.className = "btn btn-merge-done";
        showToast("PR #" + prNum + " merged", "success");
        setTimeout(function () { loadAllPRs(); }, 1500);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = originalText;
        showToast(err.message, "error");
      });
  }

  function handleUpdateBranchClick(e) {
    var prNum = e.currentTarget.getAttribute("data-pr");
    var project = e.currentTarget.getAttribute("data-project") || selectedProject;
    if (!prNum || !project) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Updating\u2026";
    api("POST", "/api/projects/" + encodeURIComponent(project) + "/prs/" + prNum + "/update-branch")
      .then(function () {
        btn.textContent = "Updated \u2713";
        showToast("PR #" + prNum + " branch updated", "success");
        setTimeout(function () { loadAllPRs(); }, 2000);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Update";
        showToast(err.message, "error");
      });
  }

  function handleNotesClick(e) {
    var prNum = e.currentTarget.getAttribute("data-pr");
    var project = e.currentTarget.getAttribute("data-project") || selectedProject;
    if (!prNum || !project) return;
    if (!confirm("Start oh-notes for PR #" + prNum + "?")) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Starting\u2026";
    api("POST", "/api/projects/" + encodeURIComponent(project) + "/prs/" + prNum + "/notes")
      .then(function () {
        showToast("Notes started for PR #" + prNum, "success");
        return loadSessions().then(function () { renderAllPRs(); });
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Notes";
        showToast(err.message, "error");
      });
  }

  function handleCommentClick(e) {
    var prNum = e.currentTarget.getAttribute("data-pr");
    var project = e.currentTarget.getAttribute("data-project") || selectedProject;
    if (!prNum || !project) return;
    commentPrNum = prNum;
    commentProject = project;
    $commentPrNum.textContent = prNum;
    $commentText.value = "";
    $commentModal.classList.add("visible");
    $commentText.focus();
  }

  function closeCommentModal() {
    $commentModal.classList.remove("visible");
    commentPrNum = null;
    commentProject = null;
  }

  function submitComment() {
    var body = $commentText.value.trim();
    var project = commentProject || selectedProject;
    if (!body || !commentPrNum || !project) return;
    $commentSubmit.disabled = true;
    api("POST", "/api/projects/" + encodeURIComponent(project) + "/prs/" + commentPrNum + "/comment", {
      body: body,
    })
      .then(function () {
        showToast("Comment posted", "success");
        closeCommentModal();
      })
      .catch(function (err) {
        showToast(err.message, "error");
      })
      .finally(function () {
        $commentSubmit.disabled = false;
      });
  }

  function openPlanModal() {
    if (!selectedProject) return;
    $planProjectName.textContent = selectedProject;
    $planDescription.value = "";
    $planModal.classList.add("visible");
    $planDescription.focus();
  }

  function closePlanModal() {
    $planModal.classList.remove("visible");
  }

  function submitPlan() {
    var description = $planDescription.value.trim();
    if (!description || !selectedProject) return;
    $planSubmit.disabled = true;
    api("POST", "/api/projects/" + encodeURIComponent(selectedProject) + "/plan", {
      description: description,
    })
      .then(function () {
        showToast("Planning started", "success");
        closePlanModal();
        return loadSessions();
      })
      .catch(function (err) {
        showToast(err.message, "error");
      })
      .finally(function () {
        $planSubmit.disabled = false;
      });
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  function loadProjects() {
    return api("GET", "/api/projects").then(function (data) {
      projects = data.projects || [];
      renderProjectSelector();
    });
  }

  function loadSessions() {
    return api("GET", "/api/sessions").then(function (data) {
      sessions = data.sessions || [];
      renderSessions();
    });
  }

  function loadProjectData() {
    if (!selectedProject) {
      issues = [];
      renderIssues();
      renderScheduler();
      return Promise.resolve();
    }

    var name = encodeURIComponent(selectedProject);
    return api("GET", "/api/projects/" + name + "/issues")
      .then(function (data) {
        repoUrl = data.repoUrl || null;
        issues = data.issues || [];
        renderIssues();
      });
  }

  function loadAllPRs() {
    return api("GET", "/api/prs").then(function (data) {
      allPRs = data.prs || [];
      renderAllPRs();
    });
  }

  // ---------------------------------------------------------------------------
  // Scheduler
  // ---------------------------------------------------------------------------

  function loadSchedulerStatus() {
    return api("GET", "/api/scheduler/status").then(function (data) {
      schedulerStatus = data;
      renderScheduler();
    }).catch(function () {
      // Scheduler endpoint may not exist on older versions
      schedulerStatus = null;
      renderScheduler();
    });
  }

  function renderScheduler() {
    if (!selectedProject) {
      $schedulerSection.style.display = "none";
      return;
    }

    $schedulerSection.style.display = "";

    var projState = schedulerStatus && schedulerStatus.projects
      ? schedulerStatus.projects[selectedProject]
      : null;
    var enabled = projState ? projState.enabled : false;

    $schedulerToggle.checked = enabled;
    $schedulerBadge.textContent = enabled ? "on" : "off";
    $schedulerBadge.className = "section-badge scheduler-badge " + (enabled ? "on" : "off");
    $schedulerBadge.style.display = "";

  }

  $schedulerToggle.addEventListener("change", function () {
    if (!selectedProject) return;
    var action = $schedulerToggle.checked ? "enable" : "disable";
    api("POST", "/api/scheduler/" + encodeURIComponent(selectedProject) + "/" + action)
      .then(function () {
        showToast("Scheduler " + ($schedulerToggle.checked ? "enabled" : "disabled"), "success");
        return loadSchedulerStatus();
      })
      .catch(function (err) {
        $schedulerToggle.checked = !$schedulerToggle.checked;
        showToast(err.message, "error");
      });
  });

  $schedulerTriggerBtn.addEventListener("click", function () {
    if (!selectedProject) return;
    $schedulerTriggerBtn.disabled = true;
    $schedulerTriggerBtn.textContent = "Running\u2026";
    api("POST", "/api/scheduler/" + encodeURIComponent(selectedProject) + "/trigger")
      .then(function (data) {
        var parts = [];
        if (data.stacked && data.stacked.length > 0) {
          parts.push("Stacked: " + data.stacked.map(function (s) { return "#" + s.issue + " on #" + s.baseDep + " (" + s.baseBranch + ")"; }).join(", "));
        }
        if (data.alreadyRunning && data.alreadyRunning.length > 0) {
          parts.push("Already running: " + data.alreadyRunning.map(function (n) { return "#" + n; }).join(", "));
        }
        if (data.hasPR && data.hasPR.length > 0) {
          parts.push("Has PR: " + data.hasPR.map(function (n) { return "#" + n; }).join(", "));
        }
        if (data.blocked && data.blocked.length > 0) {
          parts.push("Blocked (max concurrent): " + data.blocked.map(function (n) { return "#" + n; }).join(", "));
        }
        if (data.cycles && data.cycles.length > 0) {
          parts.push("Circular deps detected!");
        }
        var msg = parts.length > 0 ? parts.join(". ") : "No unblocked issues found";
        showToast(msg, data.stacked && data.stacked.length > 0 ? "success" : "info");

        // Show debug info in scheduler status area
        if (data.debug) {
          var d = data.debug;
          var dbg = [];
          if (d.issuesWithDeps && d.issuesWithDeps.length > 0) {
            dbg.push("Issues with deps: " + d.issuesWithDeps.map(function (i) { return "#" + i.number + " \u2192 " + i.dependsOn.map(function (n) { return "#" + n; }).join(","); }).join("; "));
          } else {
            dbg.push("No issues with dependencies found");
          }
          if (d.resolvedIssues && d.resolvedIssues.length > 0) {
            dbg.push("Resolved: " + d.resolvedIssues.map(function (n) { return "#" + n; }).join(", "));
          }
          if (d.depCandidates && d.depCandidates.length > 0) {
            dbg.push("Dep checks:");
            d.depCandidates.forEach(function (c) {
              var line = "  #" + c.issue + ": session=" + c.sessionStatus + " PR=" + (c.linkedPR || "none") + " CI=" + (c.ci || "-") + " CR=" + (c.coderabbit || "-") + " ready=" + c.stackReady;
              if (c.reason) line += " (" + c.reason + ")";
              dbg.push(line);
            });
          } else {
            dbg.push("No dep candidates (no open issues are dependencies of other open issues)");
          }
          if (d.stackUnblocked && d.stackUnblocked.length > 0) {
            dbg.push("Stack-unblocked (all): " + d.stackUnblocked.map(function (s) { return "#" + s.issue + " on #" + s.baseDep; }).join(", "));
          }
          if (d.factoryPhaseBlocked && d.factoryPhaseBlocked.length > 0) {
            dbg.push("Factory phase blocked:");
            d.factoryPhaseBlocked.forEach(function (r) {
              dbg.push("  #" + r.issue + " (" + r.app + ":" + r.phase + ") blocked by " + r.blockedByPhase + " phase: " + r.blockerIssues.map(function (n) { return "#" + n; }).join(", "));
            });
          }
          if (d.queued && d.queued.length > 0) {
            dbg.push("Queued chains: " + d.queued.map(function (n) { return "#" + n; }).join(", "));
          } else {
            dbg.push("Queued chains: (none)");
          }
          if (d.filteredUnblocked && d.filteredUnblocked.length > 0) {
            dbg.push("Will auto-start: " + d.filteredUnblocked.map(function (s) { return "#" + s.issue + " on #" + s.baseDep; }).join(", "));
          }
          if (d.skippedHasPR && d.skippedHasPR.length > 0) {
            dbg.push("Skipped (has PR): " + d.skippedHasPR.map(function (s) { return "#" + s.issue + " (PR #" + s.pr + ")"; }).join(", "));
          }
          $schedulerStatus.textContent = dbg.join("\n");
          $schedulerStatus.style.whiteSpace = "pre-wrap";
          $schedulerStatus.style.fontSize = "12px";
        }

        return loadSessions();
      })
      .catch(function (err) {
        showToast(err.message, "error");
      })
      .finally(function () {
        $schedulerTriggerBtn.disabled = false;
        $schedulerTriggerBtn.textContent = "Execute Now";
      });
  });

  function refreshAll() {
    return Promise.all([loadSessions(), loadAllPRs(), loadSchedulerStatus(), selectedProject ? loadProjectData() : Promise.resolve()]).catch(function (err) {
      // Suppress refresh errors (network blips, etc.)
      console.warn("Refresh failed:", err.message);
    });
  }

  // ---------------------------------------------------------------------------
  // Project selector
  // ---------------------------------------------------------------------------

  function renderProjectSelector() {
    // Keep current selection
    var current = $projectSelect.value;

    // Clear options after the first placeholder
    while ($projectSelect.options.length > 1) {
      $projectSelect.remove(1);
    }

    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      var opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      if (p.openCount > 0) {
        opt.textContent += " (" + p.openCount + " open)";
      }
      $projectSelect.appendChild(opt);
    }

    // Restore selection
    if (current) {
      $projectSelect.value = current;
    }

    // Auto-select if only one project, or restore saved project
    if (!selectedProject) {
      var saved = localStorage.getItem("miranda_project");
      if (saved && projects.some(function (p) { return p.name === saved; })) {
        $projectSelect.value = saved;
        selectedProject = saved;
      } else if (projects.length === 1) {
        $projectSelect.value = projects[0].name;
        selectedProject = projects[0].name;
      }
    }
    $removeProjectBtn.style.display = selectedProject ? "" : "none";
  }

  $projectSelect.addEventListener("change", function () {
    selectedProject = $projectSelect.value || null;
    $removeProjectBtn.style.display = selectedProject ? "" : "none";
    if (selectedProject) {
      localStorage.setItem("miranda_project", selectedProject);
    } else {
      localStorage.removeItem("miranda_project");
    }
    issues = [];
    repoUrl = null;
    renderIssues();
    renderScheduler();
    if (selectedProject) {
      loadProjectData().catch(function (err) {
        showToast(err.message, "error");
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Event bindings
  // ---------------------------------------------------------------------------

  // --- Collapsible sections ---
  (function () {
    var sections = document.querySelectorAll(".section");
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      var id = section.id;
      // Restore collapsed state
      if (id && localStorage.getItem("miranda_collapsed_" + id) === "1") {
        section.classList.add("collapsed");
      }
      var header = section.querySelector(".section-header");
      if (header) {
        header.addEventListener("click", (function (sec, secId) {
          return function () {
            sec.classList.toggle("collapsed");
            if (secId) {
              if (sec.classList.contains("collapsed")) {
                localStorage.setItem("miranda_collapsed_" + secId, "1");
              } else {
                localStorage.removeItem("miranda_collapsed_" + secId);
              }
            }
          };
        })(section, id));
      }
    }
  })();

  $refreshBtn.addEventListener("click", function () {
    $refreshBtn.classList.add("spinning");
    refreshAll()
      .catch(function (err) {
        showToast(err.message, "error");
      })
      .finally(function () {
        $refreshBtn.classList.remove("spinning");
      });
  });

  $commentCancel.addEventListener("click", closeCommentModal);
  $commentSubmit.addEventListener("click", submitComment);

  // Close modal on overlay click
  $commentModal.addEventListener("click", function (e) {
    if (e.target === $commentModal) {
      closeCommentModal();
    }
  });

  // --- Plan modal handlers ---
  $planBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    openPlanModal();
  });
  $planCancel.addEventListener("click", closePlanModal);
  $planSubmit.addEventListener("click", submitPlan);
  $planModal.addEventListener("click", function (e) {
    if (e.target === $planModal) {
      closePlanModal();
    }
  });

  // --- Add/Remove project handlers ---

  $addProjectBtn.addEventListener("click", function () {
    $addProjectInput.value = "";
    $addProjectModal.classList.add("visible");
    $addProjectInput.focus();
  });

  $addProjectCancel.addEventListener("click", function () {
    $addProjectModal.classList.remove("visible");
  });

  $addProjectModal.addEventListener("click", function (e) {
    if (e.target === $addProjectModal) {
      $addProjectModal.classList.remove("visible");
    }
  });

  $addProjectSubmit.addEventListener("click", function () {
    var repo = $addProjectInput.value.trim();
    if (!repo) return;
    $addProjectSubmit.disabled = true;
    $addProjectSubmit.classList.add("updating");
    api("POST", "/api/projects", { repo: repo })
      .then(function (data) {
        $addProjectModal.classList.remove("visible");
        var msg = 'Project "' + data.name + '" added';
        if (data.warning) msg += ' (warning: ' + data.warning + ')';
        showToast(msg, "success");
        selectedProject = data.name;
        return loadProjects().then(function () {
          $projectSelect.value = data.name;
          localStorage.setItem("miranda_project", data.name);
          $removeProjectBtn.style.display = "";
          return loadProjectData();
        });
      })
      .catch(function (err) {
        showToast(err.message, "error");
      })
      .finally(function () {
        $addProjectSubmit.disabled = false;
        $addProjectSubmit.classList.remove("updating");
      });
  });

  $removeProjectBtn.addEventListener("click", function () {
    if (!selectedProject) return;
    if (!confirm('Remove project "' + selectedProject + '"? This deletes the local clone.')) return;
    api("DELETE", "/api/projects/" + encodeURIComponent(selectedProject))
      .then(function () {
        showToast('Project "' + selectedProject + '" removed', "success");
        selectedProject = null;
        localStorage.removeItem("miranda_project");
        $removeProjectBtn.style.display = "none";
        issues = [];
        repoUrl = null;
        renderIssues();
        return Promise.all([loadProjects(), loadAllPRs()]);
      })
      .catch(function (err) {
        showToast(err.message, "error");
      });
  });

  // --- Admin button handlers ---

  function setAdminBusy(busy) {
    adminBusy = busy;
    $updateRestartBtn.disabled = busy;
  }

  function setAdminStatus(html) {
    $adminStatus.innerHTML = html;
  }

  function doUpdateAndRestart() {
    if (adminBusy) return;
    setAdminBusy(true);
    $updateRestartBtn.classList.add("updating");
    setAdminStatus('<span class="status-info">Pulling and building\u2026</span>');

    api("POST", "/api/selfupdate")
      .then(function (data) {
        if (data.alreadyCurrent) {
          setAdminStatus('<span class="status-info">Already up to date. Restarting\u2026</span>');
        } else {
          var html = '<span class="status-success">' + esc(data.commits + ' commit(s) pulled') + '</span>';
          if (data.commitMessages && data.commitMessages.length > 0) {
            html += '<ul class="update-commits">';
            for (var i = 0; i < data.commitMessages.length; i++) {
              html += '<li>' + esc(data.commitMessages[i]) + '</li>';
            }
            html += '</ul>';
          }
          setAdminStatus(html + '<br><span class="status-info">Restarting\u2026</span>');
        }
        // Now restart
        $updateRestartBtn.classList.remove("updating");
        $updateRestartBtn.classList.add("restarting");
        stopAutoRefresh();
        return api("POST", "/api/restart").catch(function () {
          // Expected \u2014 server shuts down, fetch may fail
        });
      })
      .then(function () {
        return pollReconnect();
      })
      .then(function () {
        $updateRestartBtn.classList.remove("restarting");
        setAdminStatus('<span class="status-success">Back online</span>');
        showToast("Miranda is back online", "success");
        setAdminBusy(false);
        refreshAll();
        startAutoRefresh();
      })
      .catch(function (err) {
        $updateRestartBtn.classList.remove("updating");
        $updateRestartBtn.classList.remove("restarting");
        setAdminStatus('<span class="status-error">' + esc(err.message) + '</span>');
        showToast(err.message, "error");
        setAdminBusy(false);
        startAutoRefresh();
      });
  }

  function pollReconnect() {
    var POLL_INTERVAL = 2000;
    var TIMEOUT = 30000;
    var startTime = Date.now();

    return new Promise(function (resolve, reject) {
      function check() {
        if (Date.now() - startTime > TIMEOUT) {
          reject(new Error("Miranda did not come back within 30s"));
          return;
        }
        setAdminStatus('<span class="status-info">Reconnecting\u2026</span>');
        fetch("/api/sessions", {
          headers: { "x-telegram-init-data": getInitData() },
        })
          .then(function (res) {
            if (res.ok) {
              resolve();
            } else {
              setTimeout(check, POLL_INTERVAL);
            }
          })
          .catch(function () {
            setTimeout(check, POLL_INTERVAL);
          });
      }
      setTimeout(check, POLL_INTERVAL);
    });
  }

  $updateRestartBtn.addEventListener("click", function () {
    var sessionCount = sessions.length;
    var msg = "Update and restart Miranda?";
    if (sessionCount > 0) {
      msg += "\n\n" + sessionCount + " active session(s) will be terminated.";
    }
    if (!confirm(msg)) return;
    doUpdateAndRestart();
  });

  // ---------------------------------------------------------------------------
  // Auto-refresh
  // ---------------------------------------------------------------------------

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(refreshAll, REFRESH_INTERVAL);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // Pause refresh when tab not visible
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopAutoRefresh();
    } else {
      refreshAll();
      startAutoRefresh();
    }
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function esc(str) {
    if (!str) return "";
    var div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }

  function escAttr(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ---------------------------------------------------------------------------
  // CI / CodeRabbit indicator helpers
  // ---------------------------------------------------------------------------

  function ciIndicator(state) {
    switch (state) {
      case "success": return "\u2705CI";
      case "failure": return "\u274CCI";
      case "pending": return "\u23F3CI";
      default: return "";
    }
  }

  function ciTooltip(ci) {
    if (!ci || !ci.checks || ci.checks.length === 0) return "";
    return ci.checks.map(function (c) {
      var icon = c.conclusion === "success" ? "\u2705" : c.conclusion === "failure" ? "\u274C" : "\u23F3";
      return icon + " " + c.name;
    }).join("\n");
  }

  function coderabbitIndicator(cr) {
    if (!cr || !cr.reviewed) return "";
    switch (cr.state) {
      case "APPROVED": return "\uD83D\uDC30\u2705";
      case "CHANGES_REQUESTED": return "\uD83D\uDC30\u274C";
      case "COMMENTED":
      case "PENDING": return "\uD83D\uDC30\u23F3";
      default: return "\uD83D\uDC30";
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function init() {
    // Telegram Mini App setup
    if (webapp) {
      webapp.ready();
      webapp.expand();
      // Apply Telegram theme
      if (webapp.themeParams && webapp.themeParams.bg_color) {
        document.documentElement.style.setProperty(
          "--tg-theme-bg-color",
          webapp.themeParams.bg_color
        );
      }
      if (webapp.themeParams && webapp.themeParams.text_color) {
        document.documentElement.style.setProperty(
          "--tg-theme-text-color",
          webapp.themeParams.text_color
        );
      }
      if (webapp.themeParams && webapp.themeParams.hint_color) {
        document.documentElement.style.setProperty(
          "--tg-theme-hint-color",
          webapp.themeParams.hint_color
        );
      }
      if (webapp.themeParams && webapp.themeParams.link_color) {
        document.documentElement.style.setProperty(
          "--tg-theme-link-color",
          webapp.themeParams.link_color
        );
      }
      if (webapp.themeParams && webapp.themeParams.button_color) {
        document.documentElement.style.setProperty(
          "--tg-theme-button-color",
          webapp.themeParams.button_color
        );
      }
      if (webapp.themeParams && webapp.themeParams.button_text_color) {
        document.documentElement.style.setProperty(
          "--tg-theme-button-text-color",
          webapp.themeParams.button_text_color
        );
      }
      if (webapp.themeParams && webapp.themeParams.secondary_bg_color) {
        document.documentElement.style.setProperty(
          "--tg-theme-secondary-bg-color",
          webapp.themeParams.secondary_bg_color
        );
      }
    }

    // Load initial data
    loadProjects()
      .then(function () {
        // If project already selected (from localStorage), load its data
        if (selectedProject) {
          return loadProjectData();
        }
      })
      .catch(function (err) {
        showToast("Failed to load: " + err.message, "error");
      });

    loadSessions().catch(function (err) {
      console.warn("Failed to load sessions:", err.message);
    });

    loadAllPRs().catch(function (err) {
      console.warn("Failed to load PRs:", err.message);
    });

    loadSchedulerStatus().catch(function (err) {
      console.warn("Failed to load scheduler status:", err.message);
    });

    startAutoRefresh();
  }

  init();
})();
