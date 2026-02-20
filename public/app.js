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

  function getChatId() {
    // In private chats chatId === userId
    return (webapp && webapp.initDataUnsafe && webapp.initDataUnsafe.user && webapp.initDataUnsafe.user.id) || 0;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var projects = [];
  var selectedProject = null; // project name string
  var sessions = [];
  var issues = [];
  var prs = [];
  var refreshTimer = null;
  var pendingRequests = 0;
  var commentPrNum = null; // PR number for comment modal

  var REFRESH_INTERVAL = 10000; // 10 seconds

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------

  var $projectSelect = document.getElementById("project-select");
  var $sessionsList = document.getElementById("sessions-list");
  var $sessionsCount = document.getElementById("sessions-count");
  var $sessionsSection = document.getElementById("sessions-section");
  var $issuesSection = document.getElementById("issues-section");
  var $issuesTree = document.getElementById("issues-tree");
  var $issuesCount = document.getElementById("issues-count");
  var $refreshBtn = document.getElementById("refresh-btn");
  var $loadingBar = document.getElementById("loading-bar");
  var $toast = document.getElementById("toast");
  var $commentModal = document.getElementById("comment-modal");
  var $commentPrNum = document.getElementById("comment-pr-num");
  var $commentText = document.getElementById("comment-text");
  var $commentCancel = document.getElementById("comment-cancel");
  var $commentSubmit = document.getElementById("comment-submit");

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
      html += '<div class="session-card">';
      html += '<div class="session-top">';
      html += '<div class="session-info">';
      html += '<div class="session-task">' + esc(s.taskId) + "</div>";
      html += '<div class="session-meta">';
      html += '<span class="status-dot ' + esc(s.status) + '"></span>';
      html += "<span>" + esc(statusLabel) + "</span>";
      html += "<span>" + esc(s.skill) + "</span>";
      html += "<span>" + esc(s.elapsed) + "</span>";
      html += "</div></div>";
      html +=
        '<button class="btn btn-danger btn-stop" data-task="' +
        escAttr(s.taskId) +
        '">Stop</button>';
      html += "</div>";
      if (s.pendingQuestion) {
        var q = s.pendingQuestion.questions;
        for (var j = 0; j < q.length; j++) {
          html +=
            '<div class="session-question">' + esc(q[j]) + "</div>";
        }
      }
      html += "</div>";
    }
    $sessionsList.innerHTML = html;

    // Attach stop handlers
    var stopBtns = $sessionsList.querySelectorAll(".btn-stop");
    for (var k = 0; k < stopBtns.length; k++) {
      stopBtns[k].addEventListener("click", handleStopClick);
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
  // Render: Issue Tree
  // ---------------------------------------------------------------------------

  function buildIssueTree() {
    // Map issue number -> issue object
    var issueMap = {};
    for (var i = 0; i < issues.length; i++) {
      issueMap[issues[i].number] = issues[i];
    }

    // Build PR map: issue number -> pr object
    var prMap = {};
    for (var j = 0; j < issues.length; j++) {
      if (issues[j].pr) {
        prMap[issues[j].number] = issues[j].pr;
      }
    }

    // Build children map: parent issue number -> [child issues]
    var childrenOf = {};
    var isChild = {};

    for (var k = 0; k < issues.length; k++) {
      var deps = issues[k].dependsOn || [];
      for (var d = 0; d < deps.length; d++) {
        var dep = deps[d];
        if (issueMap[dep]) {
          if (!childrenOf[dep]) childrenOf[dep] = [];
          childrenOf[dep].push(issues[k]);
          isChild[issues[k].number] = true;
        }
      }
    }

    // Root issues: not a child of any open issue
    var roots = [];
    for (var r = 0; r < issues.length; r++) {
      if (!isChild[issues[r].number]) {
        roots.push(issues[r]);
      }
    }

    return { roots: roots, childrenOf: childrenOf, prMap: prMap };
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
    numSpan.className = "issue-number";
    numSpan.textContent = "#" + issue.number;
    var titleSpan = document.createElement("span");
    titleSpan.className = "issue-title";
    titleSpan.textContent = issue.title;
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

    // PR status
    if (pr) {
      var prDiv = document.createElement("div");
      prDiv.className = "issue-pr";
      var prStatus = document.createElement("span");
      prStatus.className = "pr-status";
      if (pr.mergeable === true) {
        prStatus.classList.add("ready");
        prStatus.textContent = "\u2713 PR #" + pr.number + " ready";
      } else if (pr.mergeable === false) {
        prStatus.classList.add("conflicts");
        prStatus.textContent = "\u2717 PR #" + pr.number + " conflicts";
      } else {
        prStatus.classList.add("open");
        prStatus.textContent = "PR #" + pr.number + " open";
      }
      prDiv.appendChild(prStatus);
      card.appendChild(prDiv);
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

    var startBtn = document.createElement("button");
    startBtn.className = "btn btn-primary";
    startBtn.textContent = "Start";
    startBtn.setAttribute("data-issue", issue.number);
    startBtn.addEventListener("click", handleStartClick);
    actions.appendChild(startBtn);

    if (pr) {
      if (pr.mergeable === true) {
        var mergeBtn = document.createElement("button");
        mergeBtn.className = "btn btn-secondary";
        mergeBtn.textContent = "Merge";
        mergeBtn.setAttribute("data-pr", pr.number);
        mergeBtn.addEventListener("click", handleMergeClick);
        actions.appendChild(mergeBtn);
      }

      var commentBtn = document.createElement("button");
      commentBtn.className = "btn btn-secondary";
      commentBtn.textContent = "Comment";
      commentBtn.setAttribute("data-pr", pr.number);
      commentBtn.addEventListener("click", handleCommentClick);
      actions.appendChild(commentBtn);
    }

    card.appendChild(actions);
    li.appendChild(card);

    // Children
    var children = childrenOf[issue.number] || [];
    if (children.length > 0) {
      var ul = document.createElement("ul");
      for (var c = 0; c < children.length; c++) {
        ul.appendChild(renderIssueNode(children[c], childrenOf, depth + 1));
      }
      li.appendChild(ul);
    }

    return li;
  }

  function renderIssues() {
    if (!selectedProject) {
      $issuesSection.style.display = "none";
      return;
    }

    $issuesSection.style.display = "";

    if (issues.length === 0) {
      $issuesTree.innerHTML = '<div class="empty-state">No open issues</div>';
      $issuesCount.style.display = "none";
      return;
    }

    $issuesCount.textContent = issues.length;
    $issuesCount.style.display = "";

    var tree = buildIssueTree();
    var ul = document.createElement("ul");
    ul.className = "issue-tree";

    for (var i = 0; i < tree.roots.length; i++) {
      ul.appendChild(renderIssueNode(tree.roots[i], tree.childrenOf, 0));
    }

    $issuesTree.innerHTML = "";
    $issuesTree.appendChild(ul);
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  function handleStartClick(e) {
    var issueNum = e.currentTarget.getAttribute("data-issue");
    if (!issueNum || !selectedProject) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    api("POST", "/api/projects/" + encodeURIComponent(selectedProject) + "/issues/" + issueNum + "/start", {
      chatId: getChatId(),
    })
      .then(function () {
        showToast("Issue #" + issueNum + " started", "success");
        return loadSessions();
      })
      .catch(function (err) {
        btn.disabled = false;
        showToast(err.message, "error");
      });
  }

  function handleMergeClick(e) {
    var prNum = e.currentTarget.getAttribute("data-pr");
    if (!prNum || !selectedProject) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    api("POST", "/api/projects/" + encodeURIComponent(selectedProject) + "/prs/" + prNum + "/merge")
      .then(function () {
        showToast("PR #" + prNum + " merged", "success");
        return loadProjectData();
      })
      .catch(function (err) {
        btn.disabled = false;
        showToast(err.message, "error");
      });
  }

  function handleCommentClick(e) {
    var prNum = e.currentTarget.getAttribute("data-pr");
    if (!prNum) return;
    commentPrNum = prNum;
    $commentPrNum.textContent = prNum;
    $commentText.value = "";
    $commentModal.classList.add("visible");
    $commentText.focus();
  }

  function closeCommentModal() {
    $commentModal.classList.remove("visible");
    commentPrNum = null;
  }

  function submitComment() {
    var body = $commentText.value.trim();
    if (!body || !commentPrNum || !selectedProject) return;
    $commentSubmit.disabled = true;
    api("POST", "/api/projects/" + encodeURIComponent(selectedProject) + "/prs/" + commentPrNum + "/comment", {
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
      prs = [];
      renderIssues();
      return Promise.resolve();
    }

    var name = encodeURIComponent(selectedProject);
    return Promise.all([
      api("GET", "/api/projects/" + name + "/issues"),
      api("GET", "/api/projects/" + name + "/prs"),
    ]).then(function (results) {
      issues = results[0].issues || [];
      prs = results[1].prs || [];
      renderIssues();
    });
  }

  function refreshAll() {
    return Promise.all([loadSessions(), selectedProject ? loadProjectData() : Promise.resolve()]).catch(function (err) {
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
  }

  $projectSelect.addEventListener("change", function () {
    selectedProject = $projectSelect.value || null;
    if (selectedProject) {
      localStorage.setItem("miranda_project", selectedProject);
    } else {
      localStorage.removeItem("miranda_project");
    }
    issues = [];
    prs = [];
    renderIssues();
    if (selectedProject) {
      loadProjectData().catch(function (err) {
        showToast(err.message, "error");
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Event bindings
  // ---------------------------------------------------------------------------

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

    startAutoRefresh();
  }

  init();
})();
