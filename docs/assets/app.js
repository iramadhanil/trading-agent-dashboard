(() => {
  "use strict";

  const MARKET_DATA = window.TRADING_ASSISTANT_MARKET_DATA || {
    officialSchedule: {},
    researchNotes: [],
    sources: []
  };

  const STORAGE_KEY = "ichwan.usTradingControlRoom.v1";
  const BACKEND_STORAGE_KEY = "ichwan.usTradingControlRoom.backend.v1";
  const MEMORY_META_STORAGE_KEY = "ichwan.usTradingControlRoom.memoryMeta.v1";
  const SNAPSHOT_STORAGE_KEY = "ichwan.usTradingControlRoom.checkpoints.v1";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RING_CIRCUMFERENCE = 327;
  const DEFAULT_STATE = {
    settings: {
      startingCapital: 640,
      goal: 1000000,
      targetDailyReturn: 5,
      maxDailyLoss: 3,
      riskPerTrade: 1,
      maxTradesPerDay: 3,
      projectionMode: "target"
    },
    entries: [],
    manualClosures: []
  };

  let state = loadState();
  let backendConfig = loadBackendConfig();
  let memoryMeta = loadMemoryMeta();
  let renderTimer = null;
  let autoSyncTimer = null;
  let chartResizeObserver = null;
  const chartInstances = new Map();

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const moneyFormat = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  });

  const integerFormat = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  });

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindTabs();
    bindSettingsForm();
    bindDailyForm();
    bindDataTools();
    bindCoachControls();
    bindClosureForm();
    bindBackendControls();
    hydrateForms();
    setupChartResizeObserver();
    renderAll();
    refreshBackendStatus();
    window.setInterval(() => renderClocksAndMarket(), 1000);
    window.addEventListener("resize", () => {
      window.clearTimeout(renderTimer);
      renderTimer = window.setTimeout(() => {
        renderCharts();
        resizeChartsSoon();
      }, 120);
    });
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredCloneSafe(DEFAULT_STATE);
      const parsed = JSON.parse(raw);
      return normalizeState({
        settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        manualClosures: Array.isArray(parsed.manualClosures) ? parsed.manualClosures : []
      });
    } catch (error) {
      console.warn("Falling back to default state:", error);
      return structuredCloneSafe(DEFAULT_STATE);
    }
  }

  function saveState() {
    const normalized = normalizeState(state);
    state = normalized;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    memoryMeta = {
      ...memoryMeta,
      lastSavedAt: new Date().toISOString(),
      saveCount: Math.max(0, numberOr(memoryMeta.saveCount, 0)) + 1
    };
    saveMemoryMeta();
    recordLocalCheckpoint(normalized);
    scheduleAutoSync();
  }

  function loadMemoryMeta() {
    try {
      const raw = localStorage.getItem(MEMORY_META_STORAGE_KEY);
      if (!raw) return { lastSavedAt: "", saveCount: 0 };
      const parsed = JSON.parse(raw);
      return {
        lastSavedAt: parsed.lastSavedAt || "",
        saveCount: Math.max(0, Math.round(numberOr(parsed.saveCount, 0)))
      };
    } catch (error) {
      console.warn("Falling back to default memory meta:", error);
      return { lastSavedAt: "", saveCount: 0 };
    }
  }

  function saveMemoryMeta() {
    localStorage.setItem(MEMORY_META_STORAGE_KEY, JSON.stringify(memoryMeta));
  }

  function recordLocalCheckpoint(payload) {
    try {
      const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
      const snapshots = raw ? JSON.parse(raw) : [];
      const next = Array.isArray(snapshots) ? snapshots : [];
      next.unshift({
        at: memoryMeta.lastSavedAt || new Date().toISOString(),
        entries: payload.entries.length,
        capital: getLatestCapital(),
        payload
      });
      localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(next.slice(0, 12)));
    } catch (error) {
      console.warn("Checkpoint save skipped:", error);
    }
  }

  function loadBackendConfig() {
    try {
      const raw = localStorage.getItem(BACKEND_STORAGE_KEY);
      if (!raw) return { url: "", anonKey: "", email: "", autoSync: "off", lastSyncAt: "" };
      const parsed = JSON.parse(raw);
      return {
        url: parsed.url || "",
        anonKey: parsed.anonKey || "",
        email: parsed.email || "",
        autoSync: parsed.autoSync === "on" ? "on" : "off",
        lastSyncAt: parsed.lastSyncAt || ""
      };
    } catch (error) {
      console.warn("Falling back to offline backend config:", error);
      return { url: "", anonKey: "", email: "", autoSync: "off", lastSyncAt: "" };
    }
  }

  function saveBackendConfig() {
    localStorage.setItem(BACKEND_STORAGE_KEY, JSON.stringify(backendConfig));
  }

  function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeState(nextState) {
    nextState.settings.startingCapital = positiveNumber(nextState.settings.startingCapital, 640);
    nextState.settings.goal = positiveNumber(nextState.settings.goal, 1000000);
    nextState.settings.targetDailyReturn = numberOr(nextState.settings.targetDailyReturn, 5);
    nextState.settings.maxDailyLoss = positiveNumber(nextState.settings.maxDailyLoss, 3);
    nextState.settings.riskPerTrade = positiveNumber(nextState.settings.riskPerTrade, 1);
    nextState.settings.maxTradesPerDay = Math.max(1, Math.round(positiveNumber(nextState.settings.maxTradesPerDay, 3)));
    nextState.settings.projectionMode = ["target", "actual", "conservative"].includes(nextState.settings.projectionMode)
      ? nextState.settings.projectionMode
      : "target";

    const rawEntries = nextState.entries
      .filter((entry) => isIsoDate(entry.date))
      .map((entry) => {
        const legacyStart = positiveNumber(entry.start, nextState.settings.startingCapital);
        const legacyEnd = positiveNumber(entry.end, legacyStart);
        const returnPct = numberOr(entry.returnPct, legacyStart > 0 ? ((legacyEnd - legacyStart) / legacyStart) * 100 : 0);
        return {
          date: entry.date,
          returnPct,
          trades: Math.max(0, Math.round(numberOr(entry.trades, 0))),
          wins: Math.max(0, Math.round(numberOr(entry.wins, 0))),
          grade: entry.grade || "B",
          discipline: String(entry.discipline || "3"),
          mood: entry.mood || "calm",
          regime: entry.regime || "trend",
          mistakes: entry.mistakes || "",
          notes: entry.notes || "",
          plan: entry.plan || "",
          nextDo: entry.nextDo || entry.plan || "",
          nextDont: entry.nextDont || ""
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    let rollingCapital = nextState.settings.startingCapital;
    nextState.entries = rawEntries.map((entry) => {
      const start = rollingCapital;
      const end = Math.max(0, start * (1 + entry.returnPct / 100));
      rollingCapital = end;
      return { ...entry, start, end };
    });

    nextState.manualClosures = nextState.manualClosures
      .filter((closure) => isIsoDate(closure.date))
      .map((closure) => ({
        date: closure.date,
        type: closure.type === "early" ? "early" : "closed",
        label: closure.label || "Manual market override"
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return nextState;
  }

  function bindTabs() {
    $$(".tab-button").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.tab;
        $$(".tab-button").forEach((item) => item.classList.toggle("active", item === button));
        $$("[data-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tab));
        button.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
        window.setTimeout(() => {
          renderCharts();
          resizeChartsSoon();
        }, 80);
      });
    });
  }

  function bindSettingsForm() {
    $("#settingsForm").addEventListener("submit", (event) => {
      event.preventDefault();
      state.settings = {
        ...state.settings,
        startingCapital: positiveNumber($("#settingStartCapital").value, 640),
        goal: positiveNumber($("#settingGoal").value, 1000000),
        targetDailyReturn: numberOr($("#settingDailyTarget").value, 5),
        maxDailyLoss: positiveNumber($("#settingMaxDailyLoss").value, 3),
        riskPerTrade: positiveNumber($("#settingRiskTrade").value, 1),
        maxTradesPerDay: Math.max(1, Math.round(positiveNumber($("#settingMaxTrades").value, 3))),
        projectionMode: $("#settingProjectionMode").value
      };
      saveState();
      renderAll();
    });
  }

  function bindDailyForm() {
    const returnInput = $("#entryReturn");

    ["#entryDate", "#entryReturn"].forEach((selector) => {
      $(selector).addEventListener("input", updateDailyEntryPreview);
      $(selector).addEventListener("change", updateDailyEntryPreview);
    });

    $("#dailyForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const date = $("#entryDate").value;
      if (!isIsoDate(date)) {
        setTemporaryText("#entryStatus", "Date invalid");
        return;
      }

      const returnPctInput = numberOr(returnInput.value, NaN);
      if (!Number.isFinite(returnPctInput)) {
        setTemporaryText("#entryStatus", "Return invalid");
        return;
      }
      const start = getLatestCapitalBefore(date);
      const end = Math.max(0, start * (1 + returnPctInput / 100));

      const entry = {
        date,
        start,
        end,
        returnPct: returnPctInput,
        trades: 0,
        wins: 0,
        grade: $("#entryGrade").value,
        discipline: $("#entryDiscipline").value,
        mood: $("#entryMood").value,
        regime: $("#entryRegime").value,
        mistakes: $("#entryMistakes").value.trim(),
        notes: $("#entryNotes").value.trim(),
        plan: $("#entryNextDo").value.trim(),
        nextDo: $("#entryNextDo").value.trim(),
        nextDont: $("#entryNextDont").value.trim()
      };

      const existingIndex = state.entries.findIndex((item) => item.date === date);
      if (existingIndex >= 0 && !window.confirm("Entry tanggal ini sudah ada. Overwrite?")) return;
      if (existingIndex >= 0) state.entries.splice(existingIndex, 1, entry);
      else state.entries.push(entry);

      state = normalizeState(state);
      saveState();
      hydrateDailyFormDefaults();
      renderAll();
      setTemporaryText("#entryStatus", "Saved");
    });

    $("#journalTable").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const date = button.dataset.date;
      const entry = state.entries.find((item) => item.date === date);
      if (!entry) return;

      if (button.dataset.action === "edit") {
        fillDailyForm(entry);
        activateTab("log");
        $("#entryDate").focus();
      }

      if (button.dataset.action === "delete") {
        if (!window.confirm(`Delete entry ${date}?`)) return;
        state.entries = state.entries.filter((item) => item.date !== date);
        saveState();
        hydrateDailyFormDefaults();
        renderAll();
      }
    });
  }

  function updateDailyEntryPreview() {
    const date = $("#entryDate").value;
    const returnPct = numberOr($("#entryReturn").value, NaN);
    if (!isIsoDate(date) || !Number.isFinite(returnPct)) {
      setText("#entryPreview", "Input return harian untuk melihat equity dan target baru secara otomatis.");
      return;
    }
    const start = getLatestCapitalBefore(date);
    const end = Math.max(0, start * (1 + returnPct / 100));
    const existingIndex = state.entries.findIndex((entry) => entry.date === date);
    const sessionsUsed = existingIndex >= 0
      ? existingIndex + 1
      : state.entries.filter((entry) => entry.date < date).length + 1;
    const targetPlan = getTargetAdjustment(end, sessionsUsed);
    const adjusted = Number.isFinite(targetPlan.requiredRate)
      ? formatPercent(targetPlan.requiredRate * 100)
      : "Need recovery";
    const baselineDays = daysToReach(end, state.settings.goal, state.settings.targetDailyReturn / 100);
    const impact = Number.isFinite(baselineDays) && Number.isFinite(targetPlan.remainingPlanSessions)
      ? formatPlanDrift(baselineDays - targetPlan.remainingPlanSessions)
      : "Recovery";
    setText(
      "#entryPreview",
      `${formatPercent(returnPct)} -> ${moneyFormat.format(end)} equity. Required pace ${adjusted}. Plan drift ${impact}.`
    );
  }

  function bindDataTools() {
    $("#exportJson").addEventListener("click", () => {
      downloadText(
        `trading-control-room-${getTodayIso("Asia/Tokyo")}.json`,
        JSON.stringify(normalizeState(state), null, 2),
        "application/json"
      );
    });

    $("#exportCsv").addEventListener("click", () => {
      const rows = [
        ["date", "start", "end", "returnPct", "grade", "discipline", "mood", "regime", "mistakes", "notes", "nextDo", "nextDont"],
        ...state.entries.map((entry) => [
          entry.date,
          entry.start,
          entry.end,
          entry.returnPct,
          entry.grade,
          entry.discipline,
          entry.mood,
          entry.regime,
          entry.mistakes,
          entry.notes,
          entry.nextDo,
          entry.nextDont
        ])
      ];
      const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
      downloadText(`trading-journal-${getTodayIso("Asia/Tokyo")}.csv`, csv, "text/csv");
    });

    $("#importJsonButton").addEventListener("click", () => $("#importJson").click());
    $("#importJson").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        state = normalizeState({
          settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
          entries: parsed.entries || [],
          manualClosures: parsed.manualClosures || []
        });
        saveState();
        hydrateForms();
        renderAll();
      } catch (error) {
        window.alert(`Import gagal: ${error.message}`);
      } finally {
        event.target.value = "";
      }
    });
  }

  function bindCoachControls() {
    $("#coachState").addEventListener("change", renderCoach);
    $("#coachMarket").addEventListener("change", renderCoach);
  }

  function bindClosureForm() {
    $("#closureForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const closure = {
        date: $("#closureDate").value,
        type: $("#closureType").value,
        label: $("#closureLabel").value.trim() || "Manual market override"
      };
      if (!isIsoDate(closure.date)) return;
      state.manualClosures = state.manualClosures.filter((item) => item.date !== closure.date);
      state.manualClosures.push(closure);
      state = normalizeState(state);
      saveState();
      $("#closureLabel").value = "";
      renderAll();
    });

    $("#closureTable").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-date]");
      if (!button) return;
      state.manualClosures = state.manualClosures.filter((item) => item.date !== button.dataset.date);
      saveState();
      renderAll();
    });
  }

  function bindBackendControls() {
    $("#backendForm").addEventListener("submit", (event) => {
      event.preventDefault();
      backendConfig = {
        ...backendConfig,
        url: $("#backendUrl").value.trim().replace(/\/$/, ""),
        anonKey: $("#backendAnonKey").value.trim(),
        email: $("#backendEmail").value.trim(),
        autoSync: $("#backendAutoSync").value
      };
      saveBackendConfig();
      renderBackendStatus("Cloud backup settings saved.", "positive", null);
      refreshBackendStatus();
    });

    $("#backendSendOtp").addEventListener("click", sendBackendLoginLink);
    $("#backendSignOut").addEventListener("click", signOutBackend);
    $("#backendPush").addEventListener("click", () => pushBackendSnapshot(false));
    $("#backendPull").addEventListener("click", pullBackendSnapshot);
    $("#backendMerge").addEventListener("click", mergeBackendSnapshot);
  }

  function hydrateForms() {
    $("#settingStartCapital").value = state.settings.startingCapital;
    $("#settingGoal").value = state.settings.goal;
    $("#settingDailyTarget").value = state.settings.targetDailyReturn;
    $("#settingMaxDailyLoss").value = state.settings.maxDailyLoss;
    $("#settingRiskTrade").value = state.settings.riskPerTrade;
    $("#settingMaxTrades").value = state.settings.maxTradesPerDay;
    $("#settingProjectionMode").value = state.settings.projectionMode;
    hydrateDailyFormDefaults();
    $("#closureDate").value = getTodayIso("America/New_York");
    hydrateBackendForm();
  }

  function hydrateBackendForm() {
    $("#backendUrl").value = backendConfig.url;
    $("#backendAnonKey").value = backendConfig.anonKey;
    $("#backendEmail").value = backendConfig.email;
    $("#backendAutoSync").value = backendConfig.autoSync;
  }

  function hydrateDailyFormDefaults() {
    const today = getTodayIso("America/New_York");
    const nextDate = state.entries.some((entry) => entry.date === today) ? nextTradingDate(addDays(today, 1)) : today;
    $("#entryDate").value = nextDate;
    $("#entryReturn").value = "";
    $("#entryGrade").value = "B";
    $("#entryDiscipline").value = "3";
    $("#entryMood").value = "calm";
    $("#entryRegime").value = "trend";
    $("#entryMistakes").value = "";
    $("#entryNotes").value = "";
    $("#entryNextDo").value = "";
    $("#entryNextDont").value = "";
    updateDailyEntryPreview();
  }

  function fillDailyForm(entry) {
    $("#entryDate").value = entry.date;
    $("#entryReturn").value = roundTo(entry.returnPct, 2);
    $("#entryGrade").value = entry.grade;
    $("#entryDiscipline").value = entry.discipline;
    $("#entryMood").value = entry.mood;
    $("#entryRegime").value = entry.regime;
    $("#entryMistakes").value = entry.mistakes;
    $("#entryNotes").value = entry.notes;
    $("#entryNextDo").value = entry.nextDo || entry.plan || "";
    $("#entryNextDont").value = entry.nextDont || "";
    updateDailyEntryPreview();
  }

  function renderAll() {
    renderClocksAndMarket();
    renderMetricsAndProjection();
    renderJournal();
    renderNextSessionPlaybook();
    renderJournalFeedback();
    renderCoach();
    renderCalendar();
    renderPerformanceInsights();
    renderMemoryStatus();
    renderBackendStatus();
    renderResearch();
    renderCharts();
    refreshIcons();
  }

  function renderClocksAndMarket() {
    const jst = getZonedNow("Asia/Tokyo");
    const et = getZonedNow("America/New_York");
    $("#jstClock").textContent = `JST ${formatClock(jst)}`;
    $("#etClock").textContent = `ET ${formatClock(et)}`;

    const status = getMarketStatusNow();
    $("#todayEt").textContent = `${formatDate(status.today)} (${status.today})`;
    $("#sessionLabel").textContent = status.label;
    $("#nextOpen").textContent = status.nextOpen;
    const nextEvent = getNextMarketEvent(status.today);
    $("#nextMarketEvent").textContent = nextEvent
      ? `${formatDate(nextEvent.date)} - ${nextEvent.label}`
      : "No known event in next year";

    setPill("#marketStatusPill", status.pill, status.level);
    renderOverviewCoach(status);
  }

  function renderMetricsAndProjection() {
    const latestCapital = getLatestCapital();
    const cumulativeReturn = state.settings.startingCapital > 0
      ? ((latestCapital / state.settings.startingCapital) - 1) * 100
      : 0;
    const drawdown = getDrawdownStats();
    const projection = getProjection();
    const progress = clamp((latestCapital / state.settings.goal) * 100, 0, 100);
    const adjustment = projection.adjustment;

    $("#metricCapital").textContent = moneyFormat.format(latestCapital);
    $("#metricReturn").textContent = `Cumulative return ${formatPercent(cumulativeReturn)}`;
    $("#metricEta").textContent = Number.isFinite(projection.days)
      ? `${integerFormat.format(projection.days)} sessions`
      : "Need positive pace";
    $("#metricEtaSub").textContent = projection.targetDate
      ? `ETA ${formatCompactDate(projection.targetDate)}`
      : "Trading days tersisa";
    $("#metricPace").textContent = Number.isFinite(adjustment.requiredRate)
      ? formatPercent(adjustment.requiredRate * 100)
      : "Recovery";
    $("#metricPaceSub").textContent = `Adjusted target (${formatSignedPercent(adjustment.delta * 100)})`;
    $("#metricDrawdown").textContent = formatPercent(drawdown.current * 100);
    $("#metricDrawdownSub").textContent = `Max historical ${formatPercent(drawdown.max * 100)}`;
    $("#goalProgress").textContent = `${formatPercent(progress)}`;
    $("#goalRing").style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress / 100));
    $("#projectionModePill").textContent = projection.modeLabel;
    $("#targetDate").textContent = projection.targetDate ? formatCompactDate(projection.targetDate) : "-";
    $("#firstSession").textContent = projection.firstSession ? formatCompactDate(projection.firstSession) : "-";
    $("#nextMilestone").textContent = projection.nextMilestone
      ? `${shortMoney(projection.nextMilestone.amount)} / ${integerFormat.format(projection.nextMilestone.days)} sessions`
      : "Goal reached";
    $("#projectionSummary").textContent = projection.summary;
    renderCockpitStats(latestCapital, projection, progress, adjustment);
    renderAdaptivePlan(projection, adjustment);

    renderMilestones(projection.rate, projection.firstSession);
  }

  function renderCockpitStats(latestCapital, projection, progress, adjustment) {
    const gap = Math.max(0, state.settings.goal - latestCapital);
    const next = projection.nextMilestone;
    const baseline = state.settings.targetDailyReturn / 100;
    const required = adjustment.requiredRate;
    const delta = adjustment.delta;
    setText("#cockpitProgress", formatPercent(progress));
    setText("#cockpitGap", moneyFormat.format(gap));
    setText("#cockpitMilestone", next ? moneyFormat.format(next.amount) : "Goal reached");
    setText("#cockpitDailyTarget", Number.isFinite(required) ? formatPercent(required * 100) : "Recovery");
    setText("#runwayPill", Number.isFinite(projection.days) ? `${integerFormat.format(projection.days)} sessions` : "Needs pace");
    setText("#riskDailyStop", formatPercent(baseline * 100));
    setText("#riskPerTrade", Number.isFinite(required) ? formatPercent(required * 100) : "Need reset");
    setText("#riskTradeCap", Number.isFinite(delta) ? formatSignedPercent(delta * 100) : "-");
    setPill(
      "#riskBudgetPill",
      Number.isFinite(delta) ? `${formatSignedPercent(delta * 100)} needed` : "Recovery",
      delta > 0.005 ? "warning" : delta < -0.005 ? "positive" : "positive"
    );
  }

  function renderMilestones(rate, firstSession) {
    const current = getLatestCapital();
    const goals = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
    $("#milestoneTable").innerHTML = goals
      .map((amount) => {
        const reached = current >= amount;
        const days = reached ? 0 : daysToReach(current, amount, rate);
        const eta = reached
          ? "Reached"
          : Number.isFinite(days) && firstSession
            ? formatDate(addTradingDays(firstSession, days, true))
            : "Need positive pace";
        const needed = Math.max(0, amount - current);
        return `
          <tr>
            <td class="num">${moneyFormat.format(amount)}</td>
            <td class="num">${reached ? "Done" : moneyFormat.format(needed)}</td>
            <td class="num">${Number.isFinite(days) ? integerFormat.format(days) : "-"}</td>
            <td>${eta}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderOverviewCoach(status) {
    const monthRegime = getMonthRegime(getTodayIso("America/New_York"));
    const drawdown = getDrawdownStats().current;
    const latest = getLatestEntry();
    const statusRisk = status.level === "danger" || status.level === "warning";
    const lossRisk = latest && latest.returnPct <= -state.settings.maxDailyLoss;
    const ddRisk = drawdown <= -0.05;
    let text = monthRegime.summary;

    if (statusRisk) text = `${status.label}. ${monthRegime.execution}`;
    if (lossRisk) text = "Daily loss threshold kena atau dekat. Stop trading, journal, dan tunggu sesi berikutnya.";
    if (ddRisk) text = "Drawdown aktif. Fokusnya bukan mengejar target, tapi menjaga decision quality sampai equity curve stabil.";
    $("#overviewCoach").textContent = text;
  }

  function renderJournal() {
    $("#journalCount").textContent = `${state.entries.length} entries`;
    if (!state.entries.length) {
      $("#journalTable").innerHTML = `
        <tr>
          <td colspan="7" class="muted">Belum ada entry. Tambahkan return harian pertama dari form di atas.</td>
        </tr>
      `;
      return;
    }

    $("#journalTable").innerHTML = [...state.entries]
      .reverse()
      .map((entry) => {
        const returnClass = entry.returnPct >= 0 ? "gain" : "loss";
        const adjustment = getTargetAdjustment(entry.end, state.entries.findIndex((item) => item.date === entry.date) + 1);
        const nextPlan = [entry.nextDo, entry.nextDont].filter(Boolean).join(" / ");
        return `
          <tr>
            <td>${escapeHtml(entry.date)}<br><span class="muted">${escapeHtml(entry.regime)}</span></td>
            <td class="num ${returnClass}">${formatPercent(entry.returnPct)}</td>
            <td class="num">${moneyFormat.format(entry.end)}</td>
            <td class="num">${Number.isFinite(adjustment.requiredRate) ? formatPercent(adjustment.requiredRate * 100) : "-"}</td>
            <td>${escapeHtml(entry.grade)}</td>
            <td>${escapeHtml(entry.discipline)} / 5</td>
            <td>
              <span>${escapeHtml(entry.notes || "-")}</span>
              ${nextPlan ? `<br><span class="muted">${escapeHtml(nextPlan)}</span>` : ""}
            </td>
            <td>
              <div class="form-actions">
                <button type="button" data-action="edit" data-date="${escapeHtml(entry.date)}" title="Edit entry">
                  <i data-lucide="pencil"></i><span>Edit</span>
                </button>
                <button class="danger" type="button" data-action="delete" data-date="${escapeHtml(entry.date)}" title="Delete entry">
                  <i data-lucide="trash-2"></i><span>Delete</span>
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
    refreshIcons();
  }

  function renderAdaptivePlan(projection, adjustment) {
    const actualRate = getGeometricDailyReturn();
    const hasLogs = state.entries.length > 0;
    const baseline = state.settings.targetDailyReturn / 100;
    const required = adjustment.requiredRate;
    const drift = getPlanDrift(projection, adjustment);
    const fiveSessionAsk = Number.isFinite(required) ? ((1 + required) ** 5 - 1) * 100 : Infinity;
    const actualPct = hasLogs && Number.isFinite(actualRate) ? actualRate * 100 : NaN;
    const requiredPct = Number.isFinite(required) ? required * 100 : NaN;
    const maxScale = Math.max(8, state.settings.targetDailyReturn * 1.7, Math.abs(actualPct) * 1.25 || 0, requiredPct * 1.25 || 0);
    const targetLeft = Number.isFinite(requiredPct) ? clamp((requiredPct / maxScale) * 100, 0, 100) : 100;
    const actualLeft = Number.isFinite(actualPct) ? clamp((actualPct / maxScale) * 100, 0, 100) : targetLeft;
    const driftLevel = !Number.isFinite(drift) || drift > 3 ? "warning" : drift < -1 ? "positive" : "positive";

    setText("#adaptiveRequired", Number.isFinite(requiredPct) ? formatPercent(requiredPct) : "Recovery");
    setText("#adaptiveRequiredSub", `Baseline ${formatPercent(state.settings.targetDailyReturn)}`);
    setText("#adaptiveActual", hasLogs && Number.isFinite(actualPct) ? formatPercent(actualPct) : "-");
    setText("#adaptiveActualSub", hasLogs ? `Geometric ${state.entries.length} days` : "Waiting for logs");
    setText("#adaptiveDrift", formatPlanDrift(drift));
    setText("#adaptiveDriftSub", drift > 0 ? "Behind baseline ETA" : drift < 0 ? "Ahead of baseline ETA" : "On schedule");
    setText("#adaptiveFiveDay", Number.isFinite(fiveSessionAsk) ? formatPercent(fiveSessionAsk) : "Recovery");
    setText("#adaptiveFiveDaySub", "Required compound");
    $("#pressureTarget").style.left = `${targetLeft}%`;
    $("#pressureActual").style.left = `${actualLeft}%`;
    setPill("#edgeHealthPill", $("#edgeHealthPill").textContent || "Collecting data", driftLevel);
  }

  function renderNextSessionPlaybook() {
    const latest = getLatestEntry();
    if (!latest) {
      setPill("#nextSessionPill", "Waiting for log", "warning");
      $("#nextSessionPlaybook").innerHTML = `
        <section class="coach-action do">
          <span class="coach-label"><i data-lucide="check-circle-2"></i>Do next</span>
          <div class="coach-chip"><i data-lucide="arrow-right"></i><span>Save one trading day to generate tomorrow's playbook.</span></div>
        </section>
        <section class="coach-action dont">
          <span class="coach-label"><i data-lucide="ban"></i>Don't next</span>
          <div class="coach-chip"><i data-lucide="octagon-x"></i><span>Do not trade without a written setup review.</span></div>
        </section>
      `;
      return;
    }

    const nextSession = nextTradingDate(addDays(latest.date, 1));
    setPill("#nextSessionPill", formatCompactDate(nextSession), latest.returnPct < 0 ? "warning" : "positive");
    const doItems = splitPlanItems(latest.nextDo || latest.plan || "Trade only the cleanest setup from today's review.");
    const dontItems = splitPlanItems(latest.nextDont || latest.mistakes || "Do not repeat today's lowest-quality decision.");
    $("#nextSessionPlaybook").innerHTML = `
      <section class="coach-action do">
        <span class="coach-label"><i data-lucide="check-circle-2"></i>Do next</span>
        ${doItems.map((item) => `<div class="coach-chip"><i data-lucide="arrow-right"></i><span>${escapeHtml(item)}</span></div>`).join("")}
      </section>
      <section class="coach-action dont">
        <span class="coach-label"><i data-lucide="ban"></i>Don't next</span>
        ${dontItems.map((item) => `<div class="coach-chip"><i data-lucide="octagon-x"></i><span>${escapeHtml(item)}</span></div>`).join("")}
      </section>
    `;
  }

  function renderJournalFeedback() {
    const entries = state.entries.slice(-30);
    if (!entries.length) {
      setPill("#journalFeedbackPill", "Learning", "warning");
      $("#journalFeedbackGrid").innerHTML = [
        ["Setup base", "-", "Needs logged trading days"],
        ["Leak to fix", "-", "Mistake tags will surface here"],
        ["Process score", "-", "Discipline trend"],
        ["Tomorrow focus", "-", "Saved do/don'ts become the next plan"]
      ].map(renderFeedbackCard).join("");
      return;
    }

    const latest = getLatestEntry();
    const bestRegime = bestGroup(entries, (entry) => entry.regime, (entry) => entry.returnPct);
    const worstMistake = worstMistakeTag(entries);
    const avgDiscipline = average(entries.map((entry) => numberOr(entry.discipline, 3)));
    const avgReturn = average(entries.map((entry) => entry.returnPct));
    const lossStreak = getLossStreak();
    const processScore = clamp(
      avgDiscipline * 16 +
        Math.min(18, Math.max(-12, avgReturn * 3)) +
        (lossStreak ? -lossStreak * 6 : 10),
      0,
      100
    );
    const level = processScore >= 72 ? "positive" : processScore >= 50 ? "warning" : "danger";
    const focus = latest.nextDo || latest.plan || (latest.returnPct < 0
      ? "Review loss, reduce size, wait for only A setup"
      : "Repeat the cleanest setup condition from the last session");
    const avoid = latest.nextDont || latest.mistakes || "Do not trade outside written conditions";

    setPill("#journalFeedbackPill", `${Math.round(processScore)}/100`, level);
    $("#journalFeedbackGrid").innerHTML = [
      [
        "Setup base",
        bestRegime ? regimeLabel(bestRegime.key) : "-",
        bestRegime ? `${bestRegime.count} days | avg ${formatPercent(bestRegime.average)}` : "Needs more samples"
      ],
      [
        "Leak to fix",
        worstMistake ? worstMistake.label : "No repeated leak",
        worstMistake ? `${worstMistake.count}x | avg ${formatPercent(worstMistake.average)}` : "Mistake tags are clean"
      ],
      [
        "Process score",
        `${Math.round(processScore)}`,
        `Discipline ${roundTo(avgDiscipline, 1)}/5 | streak ${lossStreak}`
      ],
      [
        "Tomorrow focus",
        focus,
        avoid
      ]
    ].map(renderFeedbackCard).join("");
  }

  function renderCoach() {
    const selectedState = $("#coachState").value;
    const selectedMarket = $("#coachMarket").value;
    const latest = getLatestEntry();
    const drawdown = getDrawdownStats();
    const lossStreak = getLossStreak();
    const hardStopHit = latest && latest.returnPct <= -state.settings.maxDailyLoss;
    const highRisk =
      hardStopHit ||
      drawdown.current <= -0.1 ||
      selectedMarket === "circuit" ||
      selectedState === "revenge";
    const warning =
      highRisk ||
      drawdown.current <= -0.05 ||
      lossStreak >= 2 ||
      ["fomo", "drawdown", "tired", "euphoric"].includes(selectedState) ||
      ["thin", "chop", "gapdown"].includes(selectedMarket);

    const cardClass = highRisk ? "danger" : warning ? "warning" : "";
    const pillLevel = highRisk ? "danger" : warning ? "warning" : "positive";
    const pillText = highRisk ? "Defense mode" : warning ? "Caution mode" : "Normal";
    setPill("#coachRiskPill", pillText, pillLevel);

    const actions = buildCoachActions(selectedState, selectedMarket, latest, drawdown, lossStreak);
    const adjustment = getProjection().adjustment;
    $("#coachCard").className = `coach-card ${cardClass}`;
    $("#coachCard").innerHTML = `
      <div class="coach-head">
        <div>
          <span class="coach-kicker">Psychology protocol</span>
          <h3>${escapeHtml(actions.title)}</h3>
          <p>${escapeHtml(actions.summary)}</p>
        </div>
        <div class="coach-state-stack" aria-label="Current trading state">
          <span>${escapeHtml(pillText)}</span>
          <strong>${escapeHtml(selectedState.replace("-", " "))}</strong>
        </div>
      </div>
      <div class="coach-metrics">
        <span><strong>${formatPercent(drawdown.current * 100)}</strong> drawdown</span>
        <span><strong>${lossStreak}</strong> loss streak</span>
        <span><strong>${Number.isFinite(adjustment.requiredRate) ? formatPercent(adjustment.requiredRate * 100) : "-"}</strong> adjusted target</span>
        <span><strong>${latest ? formatPercent(latest.returnPct) : "0.00%"}</strong> latest day</span>
      </div>
      <div class="coach-action-grid">
        <section class="coach-action do">
          <span class="coach-label"><i data-lucide="check-circle-2"></i>Do now</span>
          ${actions.doNow.map((item) => `<div class="coach-chip"><i data-lucide="arrow-right"></i><span>${escapeHtml(item)}</span></div>`).join("")}
        </section>
        <section class="coach-action dont">
          <span class="coach-label"><i data-lucide="ban"></i>Do not</span>
          ${actions.doNot.map((item) => `<div class="coach-chip"><i data-lucide="octagon-x"></i><span>${escapeHtml(item)}</span></div>`).join("")}
        </section>
      </div>
      <div class="coach-principles">
        ${actions.principles.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      </div>
    `;
    refreshIcons();

    renderChecklist(warning, highRisk);
    renderScenarios();
  }

  function buildCoachActions(selectedState, selectedMarket, latest, drawdown, lossStreak) {
    const base = {
      title: "Process first, P/L second",
      summary: "Ambil hanya setup yang sudah jelas sebelum entry. Target harian tidak boleh mengalahkan risk cap.",
      doNow: [
        `Set max daily loss ${formatPercent(state.settings.maxDailyLoss)} sebelum entry pertama.`,
        `Batasi ${state.settings.maxTradesPerDay} trade, risk sekitar ${formatPercent(state.settings.riskPerTrade)} per trade.`,
        "Trade hanya saat spread, volume, dan VWAP context mendukung.",
        "Tulis skenario exit sebelum posisi masuk."
      ],
      doNot: ["Jangan tambah posisi rugi.", "Jangan ubah stop karena emosi.", "Jangan mengejar candle yang sudah jauh dari plan."],
      principles: ["Process score > P/L", "Size follows state", "No setup, no trade"]
    };

    const overlays = {
      euphoric: {
        title: "Win high control",
        summary: "Profit besar sering bikin kualitas keputusan turun karena merasa market mudah.",
        doNow: ["Lock jurnal profit hari ini.", "Turunkan size untuk trade berikutnya.", "Ambil jeda 10 menit sebelum entry ulang."],
        doNot: ["Jangan menaikkan size karena baru menang.", "Jangan membuka trade tambahan hanya karena ingin memperbesar hari hijau."],
        principles: ["Euphoria reduces selectivity", "Green day protection", "Walk away is alpha"]
      },
      fomo: {
        title: "FOMO interrupt",
        summary: "Kalau entry terasa harus sekarang juga, biasanya edge sudah turun.",
        doNow: ["Tunggu pullback atau reclaim level jelas.", "Tuliskan invalidation sebelum klik buy.", "Lewati trade jika reward/risk di bawah 2:1."],
        doNot: ["Jangan market order ke candle extended.", "Jangan beli hanya karena ticker ramai di chat atau scanner."],
        principles: ["Urgency is not edge", "Wait for structure", "Missed move is neutral"]
      },
      revenge: {
        title: "Revenge lockout",
        summary: "Dorongan membalas rugi adalah sinyal stop, bukan sinyal entry.",
        doNow: ["Stop trading minimal 30 menit.", "Tutup platform order entry.", "Tulis satu kalimat: kerugian hari ini adalah biaya menjaga akun tetap hidup."],
        doNot: ["Jangan cari trade baru untuk balik modal.", "Jangan gandakan size.", "Jangan pindah ke ticker asing tanpa setup."],
        principles: ["Revenge is a lockout signal", "Capital before ego", "Cooldown before analysis"]
      },
      drawdown: {
        title: "Drawdown recovery",
        summary: "Tujuan fase ini adalah memulihkan eksekusi, bukan memulihkan P/L secepat mungkin.",
        doNow: ["Size 50% sampai dua hari hijau berturut-turut.", "Ambil hanya A/A+ setup.", "Review tiga loss terakhir sebelum sesi berikutnya."],
        doNot: ["Jangan mengejar target ketika equity curve sedang turun.", "Jangan overtrade untuk mempercepat recovery."],
        principles: ["Recover process first", "Lower variance", "Small clean wins rebuild trust"]
      },
      tired: {
        title: "Low energy filter",
        summary: "Energi rendah membuat disiplin stop-loss dan sabar entry biasanya memburuk.",
        doNow: ["Trade maksimal satu setup A+.", "Gunakan size 50%.", "No trade jika belum tidur cukup atau fokus pecah."],
        doNot: ["Jangan trading premarket yang spread-nya lebar.", "Jangan ambil scalping cepat saat reaksi melambat."],
        principles: ["Fatigue lowers inhibition", "Reduce decisions", "One-and-done mode"]
      }
    };

    const marketOverlay = {
      thin: ["Holiday/thin tape: size 50%, hindari afternoon fade, dan jangan paksa target 5%."],
      chop: ["Choppy tape: kurangi breakout chasing; tunggu range break dengan volume."],
      gapdown: ["Risk-off gap: tunggu 15-30 menit pertama, validasi VWAP, dan jangan long ticker lemah hanya karena murah."],
      circuit: ["Circuit-breaker risk: no hero long. Cash is a position sampai market stabil."]
    };

    const chosen = overlays[selectedState] || base;
    const result = {
      title: chosen.title,
      summary: chosen.summary,
      doNow: [...(chosen.doNow || base.doNow)],
      doNot: [...(chosen.doNot || base.doNot)],
      principles: [...(chosen.principles || base.principles)]
    };

    if (marketOverlay[selectedMarket]) result.doNow.unshift(marketOverlay[selectedMarket][0]);
    if (latest && latest.returnPct <= -state.settings.maxDailyLoss) {
      result.doNow.unshift("Hard stop triggered by latest logged loss. No more trades for that day.");
    }
    if (drawdown.current <= -0.05) {
      result.doNow.unshift(`Current drawdown ${formatPercent(drawdown.current * 100)}. Reduce size before thinking about growth.`);
    }
    if (lossStreak >= 2) {
      result.doNow.unshift(`${lossStreak} losing days in a row. Next session starts in review mode.`);
    }
    return result;
  }

  function renderChecklist(warning, highRisk) {
    const checks = [
      {
        title: "Trade count locked",
        text: `Max ${state.settings.maxTradesPerDay} trades/day. Stop after max daily loss or after two emotional mistakes.`
      },
      {
        title: "Liquidity verified",
        text: "Avoid low volume, wide spread, and extended-hours fills unless the setup is exceptional and size is reduced."
      },
      {
        title: "Entry has invalidation",
        text: "Before entry: exact stop, target, and reason why the trade is invalid if price fails."
      },
      {
        title: "No averaging down",
        text: "Add only to winners after confirmation; never add because the position is red."
      },
      {
        title: highRisk ? "Defense mode active" : warning ? "Caution mode active" : "Normal sizing allowed",
        text: highRisk
          ? "Size down or stop. The task is account survival."
          : warning
            ? "Use smaller size until conditions or psychology normalize."
            : "Normal size only for A setup inside liquid RTH conditions."
      }
    ];

    $("#executionChecklist").innerHTML = checks
      .map(
        (item, index) => `
          <label class="checklist-item">
            <input type="checkbox" ${index < 3 ? "checked" : ""} />
            <span><strong>${escapeHtml(item.title)}</strong>${escapeHtml(item.text)}</span>
          </label>
        `
      )
      .join("");
  }

  function renderScenarios() {
    const scenarios = [
      {
        title: "Daily loss hit",
        items: [
          "Stop trading that day.",
          "Save chart screenshots in your own notes if needed.",
          "Next day: half size until first clean execution."
        ]
      },
      {
        title: "5-10% account drawdown",
        items: [
          "Switch to recovery mode.",
          "Only A/A+ setups, one trade at a time.",
          "No target chasing until two green days."
        ]
      },
      {
        title: "Market crash / MWCB risk",
        items: [
          "If SPX is near -7%, assume liquidity can deteriorate fast.",
          "No hero dip-buying before stabilization.",
          "Cash is valid; protect optionality."
        ]
      },
      {
        title: "Nov-Dec / holiday tape",
        items: [
          "Do not assume bearish just because funds rebalance.",
          "Watch spread, volume, and early close dates.",
          "Reduce size on thin days and skip late-session chop."
        ]
      },
      {
        title: "After big win",
        items: [
          "Move to capital preservation.",
          "Max one more A+ setup if you are calm.",
          "End green day early if discipline drops."
        ]
      },
      {
        title: "After missed move",
        items: [
          "Missed trade is not a loss.",
          "Wait for next base or next ticker.",
          "No entry without defined stop and target."
        ]
      }
    ];

    $("#scenarioGrid").innerHTML = scenarios
      .map(
        (scenario) => `
          <article class="scenario-item">
            <strong>${escapeHtml(scenario.title)}</strong>
            <ul>${scenario.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </article>
        `
      )
      .join("");
  }

  function renderPerformanceInsights() {
    const entries = state.entries.slice(-20);
    if (!entries.length) {
      setPill("#edgeHealthPill", "Collecting data", "warning");
      setText("#insightConsistency", "-");
      setText("#insightWinRate", "-");
      setText("#insightAvgReturn", "-");
      setText("#insightDiscipline", "-");
      setText("#edgeInsight", "Log at least one trading day to activate edge health tracking.");
      return;
    }

    const greenDays = entries.filter((entry) => entry.returnPct > 0).length;
    const avgReturn = average(entries.map((entry) => entry.returnPct));
    const discipline = average(entries.map((entry) => numberOr(entry.discipline, 3)));
    const tradeRows = entries.filter((entry) => entry.trades > 0);
    const winRate = tradeRows.length
      ? tradeRows.reduce((sum, entry) => sum + entry.wins, 0) / Math.max(1, tradeRows.reduce((sum, entry) => sum + entry.trades, 0))
      : greenDays / entries.length;
    const target = Math.max(0.1, state.settings.targetDailyReturn);
    const drawdown = Math.abs(getDrawdownStats().current * 100);
    const consistencyScore = clamp(
      (greenDays / entries.length) * 34 +
        clamp((avgReturn + target) / (target * 2), 0, 1.3) * 26 +
        (discipline / 5) * 30 -
        Math.min(18, drawdown * 1.2),
      0,
      100
    );
    const level = consistencyScore >= 74 ? "positive" : consistencyScore >= 52 ? "warning" : "danger";
    const message = consistencyScore >= 74
      ? "Edge health is constructive. Keep size tied to liquidity and process quality."
      : consistencyScore >= 52
        ? "Edge health is mixed. Prioritize A setups and reduce impulse trades."
        : "Edge health is defensive. Reduce size and rebuild consistency before pushing growth.";

    setPill("#edgeHealthPill", `${Math.round(consistencyScore)}/100`, level);
    setText("#insightConsistency", `${Math.round(consistencyScore)}`);
    setText("#insightWinRate", formatPercent(winRate * 100));
    setText("#insightAvgReturn", formatPercent(avgReturn));
    setText("#insightDiscipline", `${roundTo(discipline, 1)} / 5`);
    setText("#edgeInsight", `${message} Sample: last ${entries.length} logged days.`);
    $("#edgeInsight").className = `coach-banner ${level === "positive" ? "" : level}`;
  }

  function renderMemoryStatus() {
    const storageReady = isLocalStorageAvailable();
    const checkpoints = getLocalCheckpoints();
    const latest = getLatestEntry();
    const savedText = memoryMeta.lastSavedAt ? formatDateTimeCompact(memoryMeta.lastSavedAt) : "Not yet";

    setText("#memoryStorageStatus", storageReady ? "Ready" : "Blocked");
    setText("#memoryEntryCount", `${state.entries.length} days`);
    setText("#memoryLastSaved", savedText);
    setText("#memoryCheckpointCount", `${checkpoints.length} saved`);
    if (!backendConfig.url || !backendConfig.anonKey) setText("#backendRemoteStatus", "Private vault");
    setText("#entryStatus", latest ? `Saved ${formatCompactDate(latest.date)}` : "Ready");
  }

  function getLocalCheckpoints() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function isLocalStorageAvailable() {
    try {
      const testKey = "__trading_control_room_storage_test__";
      localStorage.setItem(testKey, "1");
      localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  async function refreshBackendStatus() {
    renderBackendStatus();
    const client = getBackendClient(false);
    if (!client) return;
    try {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) {
        renderBackendStatus("Cloud backup is configured. Sign in to sync.", "warning", null);
        return;
      }
      await updateRemoteStatus(client, data.user);
    } catch (error) {
      renderBackendStatus(`Cloud check failed: ${error.message}`, "danger", null);
    }
  }

  function renderBackendStatus(message, level, user) {
    const configured = Boolean(backendConfig.url && backendConfig.anonKey);
    const statusText = configured ? (backendConfig.autoSync === "on" ? "Cloud sync on" : "Cloud ready") : "Vault ready";
    setPill("#backendStatusPill", statusText, configured ? "warning" : "positive");
    $("#backendLastSync").textContent = backendConfig.lastSyncAt ? formatDateTimeCompact(backendConfig.lastSyncAt) : "Never";
    if (!configured) $("#backendRemoteStatus").textContent = "Private vault";
    $("#backendMessage").textContent = message || (configured
      ? "Cloud backup is optional. Login via magic link, then push, pull, or merge."
      : "Your journal is protected with autosave, checkpoints, export, and optional encrypted cloud backup.");
    if (level) {
      $("#backendMessage").className = `coach-banner ${level}`;
    } else {
      $("#backendMessage").className = "coach-banner";
    }
    setPill("#backendUserPill", user ? user.email || "Connected" : "Private mode", user ? "positive" : "warning");
  }

  function getBackendClient(showAlert) {
    if (!backendConfig.url || !backendConfig.anonKey) {
      if (showAlert) window.alert("Isi Supabase URL dan anon key dulu untuk cloud backup.");
      return null;
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      if (showAlert) window.alert("Supabase JS belum ter-load. Cek koneksi internet/CDN.");
      return null;
    }
    return window.supabase.createClient(backendConfig.url, backendConfig.anonKey);
  }

  async function sendBackendLoginLink() {
    backendConfig = {
      ...backendConfig,
      url: $("#backendUrl").value.trim().replace(/\/$/, ""),
      anonKey: $("#backendAnonKey").value.trim(),
      email: $("#backendEmail").value.trim(),
      autoSync: $("#backendAutoSync").value
    };
    saveBackendConfig();
    const client = getBackendClient(true);
    if (!client || !backendConfig.email) {
      window.alert("Isi email login dulu.");
      return;
    }
    try {
      const { error } = await client.auth.signInWithOtp({
        email: backendConfig.email,
        options: { emailRedirectTo: window.location.href.split("#")[0] }
      });
      if (error) throw error;
      renderBackendStatus("Magic link sent. Open it in this same browser to finish login.", "positive", null);
    } catch (error) {
      renderBackendStatus(`Login link failed: ${error.message}`, "danger", null);
    }
  }

  async function signOutBackend() {
    const client = getBackendClient(false);
    if (!client) return;
    await client.auth.signOut();
    renderBackendStatus("Signed out from cloud backup.", "warning", null);
  }

  async function pushBackendSnapshot(isAuto) {
    const client = getBackendClient(!isAuto);
    if (!client) return false;
    try {
      const user = await requireBackendUser(client);
      if (!user) return false;
      const payload = normalizeState(state);
      const { error } = await client
        .from("trading_control_snapshots")
        .upsert(
          {
            user_id: user.id,
            payload,
            updated_at: new Date().toISOString()
          },
          { onConflict: "user_id" }
        );
      if (error) throw error;
      backendConfig.lastSyncAt = new Date().toISOString();
      saveBackendConfig();
      renderBackendStatus("Local state pushed to cloud backup.", "positive", user);
      return true;
    } catch (error) {
      if (!isAuto) renderBackendStatus(`Push failed: ${error.message}`, "danger", null);
      return false;
    }
  }

  async function pullBackendSnapshot() {
    if (!window.confirm("Pull remote akan mengganti data lokal dengan snapshot Supabase. Lanjut?")) return;
    const remote = await fetchRemoteSnapshot();
    if (!remote) return;
    state = normalizeState(remote.payload || DEFAULT_STATE);
    saveState();
    hydrateForms();
    renderAll();
    renderBackendStatus("Cloud snapshot pulled and applied locally.", "positive", remote.user);
  }

  async function mergeBackendSnapshot() {
    const remote = await fetchRemoteSnapshot();
    if (!remote) return;
    state = mergeStates(state, remote.payload || DEFAULT_STATE);
    saveState();
    hydrateForms();
    renderAll();
    await pushBackendSnapshot(true);
    renderBackendStatus("Cloud and local data merged, then backed up.", "positive", remote.user);
  }

  async function fetchRemoteSnapshot() {
    const client = getBackendClient(true);
    if (!client) return null;
    try {
      const user = await requireBackendUser(client);
      if (!user) return null;
      const { data, error } = await client
        .from("trading_control_snapshots")
        .select("payload, updated_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        renderBackendStatus("No cloud snapshot found. Push local first.", "warning", user);
        return null;
      }
      backendConfig.lastSyncAt = data.updated_at || backendConfig.lastSyncAt;
      saveBackendConfig();
      return { payload: data.payload, updatedAt: data.updated_at, user };
    } catch (error) {
      renderBackendStatus(`Pull failed: ${error.message}`, "danger", null);
      return null;
    }
  }

  async function requireBackendUser(client) {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) {
      renderBackendStatus("Sign in via magic link before cloud sync.", "warning", null);
      return null;
    }
    return data.user;
  }

  async function updateRemoteStatus(client, user) {
    const { data, error } = await client
      .from("trading_control_snapshots")
      .select("updated_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      renderBackendStatus(`Cloud table/schema is not ready: ${error.message}`, "danger", user);
      $("#backendRemoteStatus").textContent = "Schema missing";
      return;
    }
    $("#backendRemoteStatus").textContent = data ? `Cloud ${formatDateTimeCompact(data.updated_at)}` : "No cloud snapshot";
    renderBackendStatus(data ? "Signed in. Cloud snapshot available." : "Signed in. Push local to create cloud backup.", "positive", user);
  }

  function mergeStates(localState, remoteState) {
    const local = normalizeState(structuredCloneSafe(localState));
    const remote = normalizeState({
      settings: { ...DEFAULT_STATE.settings, ...(remoteState.settings || {}) },
      entries: remoteState.entries || [],
      manualClosures: remoteState.manualClosures || []
    });

    const entryMap = new Map();
    [...local.entries, ...remote.entries].forEach((entry) => entryMap.set(entry.date, entry));
    const closureMap = new Map();
    [...local.manualClosures, ...remote.manualClosures].forEach((closure) => closureMap.set(closure.date, closure));
    return normalizeState({
      settings: { ...local.settings, ...remote.settings },
      entries: Array.from(entryMap.values()),
      manualClosures: Array.from(closureMap.values())
    });
  }

  function scheduleAutoSync() {
    if (backendConfig.autoSync !== "on") return;
    window.clearTimeout(autoSyncTimer);
    autoSyncTimer = window.setTimeout(() => {
      pushBackendSnapshot(true);
    }, 1200);
  }

  function renderCalendar() {
    const today = getTodayIso("America/New_York");
    const sessions = [];
    let cursor = today;
    let guard = 0;
    while (sessions.length < 14 && guard < 60) {
      const day = getMarketDay(cursor);
      if (day.type === "open" || day.type === "early") sessions.push({ date: cursor, ...day });
      cursor = addDays(cursor, 1);
      guard += 1;
    }

    $("#sessionTable").innerHTML = sessions
      .map((session) => {
        const level = session.type === "early" ? "warning" : "positive";
        const status = session.type === "early" ? "Early close 1:00 p.m. ET" : "Open";
        return `
          <tr>
            <td>${formatDate(session.date)}<br><span class="muted">${session.date}</span></td>
            <td><span class="status-pill ${level}">${status}</span></td>
            <td>${escapeHtml(session.label || "Regular session")}</td>
          </tr>
        `;
      })
      .join("");

    $("#closureTable").innerHTML = state.manualClosures.length
      ? state.manualClosures
          .map(
            (closure) => `
              <tr>
                <td>${escapeHtml(closure.date)}</td>
                <td>${escapeHtml(closure.type)}</td>
                <td>${escapeHtml(closure.label)}</td>
                <td>
                  <button class="danger" type="button" data-date="${escapeHtml(closure.date)}">
                    <i data-lucide="trash-2"></i><span>Remove</span>
                  </button>
                </td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="4" class="muted">Belum ada manual override.</td></tr>`;
    refreshIcons();
  }

  function renderResearch() {
    const currentRegime = getMonthRegime(getTodayIso("America/New_York"));
    const notes = [
      {
        title: `Current regime: ${currentRegime.title}`,
        note: `${currentRegime.summary} ${currentRegime.execution}`,
        source: "App rule"
      },
      ...(MARKET_DATA.researchNotes || [])
    ];

    $("#researchNotes").innerHTML = notes
      .map(
        (item) => `
          <article class="research-item">
            <strong>${escapeHtml(item.title)}</strong>
            <p>${escapeHtml(item.note)}</p>
            <span class="muted">${escapeHtml(item.source || "")}</span>
          </article>
        `
      )
      .join("");

    $("#sourceUpdated").textContent = `Updated ${MARKET_DATA.updatedAt || "local"}`;
    $("#sourceList").innerHTML = (MARKET_DATA.sources || [])
      .map(
        (source) => `
          <a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">
            <span>${escapeHtml(source.label)}</span>
            <i data-lucide="external-link"></i>
          </a>
        `
      )
      .join("");
    refreshIcons();
  }

  function renderCharts() {
    drawPortfolioDonutChart();
    drawRunwayChart();
    drawRiskDonutChart();
    renderActivityHeatmap();
    drawEquityChart();
    drawReturnChart();
  }

  function setupChartResizeObserver() {
    if (!("ResizeObserver" in window)) return;
    chartResizeObserver?.disconnect();
    chartResizeObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const chart = chartInstances.get(entry.target.id);
        if (chart && entry.contentRect.width > 20 && entry.contentRect.height > 20) chart.resize();
      });
    });
    $$(".chart-host").forEach((element) => chartResizeObserver.observe(element));
  }

  function resizeChartsSoon() {
    [40, 180, 420].forEach((delay) => {
      window.setTimeout(() => {
        chartInstances.forEach((chart, id) => {
          const element = document.getElementById(id);
          if (element && isRenderableChartElement(element)) chart.resize();
        });
      }, delay);
    });
  }

  function isRenderableChartElement(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 20 && rect.height > 20 && style.display !== "none" && style.visibility !== "hidden";
  }

  function isCompactChart(element) {
    return element.getBoundingClientRect().width < 720;
  }

  function renderEChart(element, option) {
    if (!window.echarts) {
      element.classList.add("chart-fallback");
      element.textContent = "Chart engine loading...";
      return;
    }
    if (!isRenderableChartElement(element)) return;
    element.classList.remove("chart-fallback");
    let chart = chartInstances.get(element.id);
    if (!chart) {
      element.textContent = "";
      chart = window.echarts.init(element, null, { renderer: "canvas" });
      chartInstances.set(element.id, chart);
    }
    chart.setOption(option, true);
    window.requestAnimationFrame(() => chart.resize());
  }

  function chartGradient(x0, y0, x1, y1, stops) {
    if (!window.echarts?.graphic?.LinearGradient) return stops[stops.length - 1]?.color || "#0b8f69";
    return new window.echarts.graphic.LinearGradient(x0, y0, x1, y1, stops);
  }

  function chartTooltip(options = {}, compact = false) {
    return {
      show: !compact,
      confine: true,
      appendToBody: true,
      borderWidth: 1,
      borderColor: "rgba(193, 206, 220, 0.78)",
      backgroundColor: "rgba(255, 255, 255, 0.97)",
      padding: [8, 10],
      extraCssText:
        "box-shadow:0 14px 34px rgba(24,42,64,.18);border-radius:8px;color:#122033;backdrop-filter:blur(10px);",
      textStyle: {
        color: "#122033",
        fontFamily: "Inter, Manrope, system-ui, sans-serif",
        fontSize: 12,
        fontWeight: 760
      },
      axisPointer: {
        type: "line",
        lineStyle: { color: "rgba(36, 95, 199, 0.34)", width: 1.2 },
        label: {
          show: false,
          borderWidth: 0,
          borderRadius: 6,
          padding: [4, 6],
          backgroundColor: "rgba(18, 32, 51, 0.9)",
          color: "#ffffff",
          fontFamily: "JetBrains Mono, IBM Plex Mono, monospace",
          fontSize: 10
        }
      },
      ...options
    };
  }

  function drawPortfolioDonutChart() {
    const element = $("#portfolioDonutChart");
    if (!element) return;
    const compact = isCompactChart(element);
    const current = getLatestCapital();
    const progress = clamp(current / state.settings.goal, 0, 1);
    renderEChart(element, {
      backgroundColor: "transparent",
      animationEasing: "cubicOut",
      animationDuration: 1000,
      tooltip: chartTooltip({
        trigger: "item",
        formatter: "{b}: {d}%"
      }, compact),
      graphic: [
        {
          type: "text",
          left: "center",
          top: "42%",
          style: {
            text: formatPercent(progress * 100),
            fill: "#ffffff",
            fontFamily: "IBM Plex Mono",
            fontSize: compact ? 23 : 26,
            fontWeight: 800,
            textAlign: "center"
          }
        },
        {
          type: "text",
          left: "center",
          top: "56%",
          style: {
            text: "TARGET PROGRESS",
            fill: "#9fc6bf",
            fontFamily: "Manrope",
            fontSize: 11,
            fontWeight: 800,
            textAlign: "center"
          }
        }
      ],
      series: [
        {
          name: "Goal exposure",
          type: "pie",
          radius: ["66%", "82%"],
          center: ["50%", "52%"],
          avoidLabelOverlap: true,
          silent: false,
          emphasis: { scale: !compact, scaleSize: 3 },
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderWidth: 0, borderRadius: 10 },
          data: [
            {
              value: Math.max(progress, 0.001),
              name: "Reached",
              itemStyle: {
                color: chartGradient(0, 0, 1, 1, [
                  { offset: 0, color: "#4df0b7" },
                  { offset: 1, color: "#0b8f69" }
                ])
              }
            },
            { value: Math.max(0, 1 - progress), name: "Remaining", itemStyle: { color: "rgba(255,255,255,0.15)" } }
          ]
        }
      ]
    });
  }

  function drawRiskDonutChart() {
    const element = $("#riskDonutChart");
    if (!element) return;
    const compact = isCompactChart(element);
    const adjustment = getProjection().adjustment;
    const baseline = Math.max(0.01, adjustment.baselineRate * 100);
    const required = Number.isFinite(adjustment.requiredRate) ? Math.max(0, adjustment.requiredRate * 100) : baseline;
    const extra = Math.max(0, required - baseline);
    const cushion = Math.max(0.01, Math.max(baseline, required) * 1.35 - required);
    const centerColor = extra > 0.35 ? "#b56a00" : "#0b8f69";
    renderEChart(element, {
      backgroundColor: "transparent",
      animationEasing: "cubicOut",
      animationDuration: 1000,
      tooltip: chartTooltip({
        trigger: "item",
        formatter: (params) => `${params.name}<br><strong>${formatPercent(params.value)}</strong>`
      }, compact),
      legend: {
        bottom: 0,
        icon: "roundRect",
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: "#66758a", fontFamily: "Manrope", fontWeight: 700, fontSize: compact ? 10 : 11 }
      },
      graphic: [
        {
          type: "text",
          left: "center",
          top: "38%",
          style: {
            text: Number.isFinite(adjustment.requiredRate) ? formatPercent(required) : "Reset",
            fill: centerColor,
            fontFamily: "IBM Plex Mono",
            fontSize: compact ? 19 : 22,
            fontWeight: 800,
            textAlign: "center"
          }
        },
        {
          type: "text",
          left: "center",
          top: "52%",
          style: {
            text: "REQUIRED",
            fill: "#66758a",
            fontFamily: "Manrope",
            fontSize: 10,
            fontWeight: 800,
            textAlign: "center"
          }
        }
      ],
      series: [
        {
          type: "pie",
          radius: ["60%", "78%"],
          center: ["50%", "45%"],
          emphasis: { scale: !compact, scaleSize: 3 },
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderRadius: 8, borderColor: "#ffffff", borderWidth: 2 },
          data: [
            { value: Math.min(required, baseline), name: "Baseline", itemStyle: { color: "#0b8f69" } },
            { value: extra, name: "Extra needed", itemStyle: { color: "#b56a00" } },
            { value: cushion, name: "Plan buffer", itemStyle: { color: "#d9e3ec" } }
          ]
        }
      ]
    });
  }

  function drawRunwayChart() {
    const element = $("#runwayChart");
    if (!element) return;
    const compact = isCompactChart(element);
    const projection = getProjection();
    const current = getLatestCapital();
    const days = Number.isFinite(projection.days) ? Math.min(projection.days, 180) : 90;
    const points = [];
    for (let index = 0; index <= days; index += Math.max(1, Math.ceil(days / 36))) {
      points.push({
        day: index,
        value: current * (1 + projection.rate) ** index
      });
    }
    if (points[points.length - 1].day !== days) {
      points.push({ day: days, value: current * (1 + projection.rate) ** days });
    }
    const adjustmentDays = Number.isFinite(projection.adjustment.remainingPlanSessions)
      ? Math.min(projection.adjustment.remainingPlanSessions, Math.max(days, 30))
      : days;
    const adjustedPoints = Number.isFinite(projection.adjustment.requiredRate)
      ? Array.from({ length: Math.min(36, adjustmentDays) + 1 }, (_, index) => {
          const step = Math.round((adjustmentDays / Math.min(36, adjustmentDays)) * index);
          return [step, current * (1 + projection.adjustment.requiredRate) ** step];
        })
      : [];
    const milestones = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000].flatMap((milestone) => {
      const neededDays = daysToReach(current, milestone, projection.rate);
      if (!Number.isFinite(neededDays) || neededDays > days || milestone < current) return [];
      return [[neededDays, milestone, shortMoney(milestone)]];
    });
    renderEChart(element, {
      backgroundColor: "transparent",
      animationDuration: 800,
      animationEasing: "cubicOut",
      tooltip: chartTooltip({
        trigger: "axis",
        valueFormatter: (value) => moneyFormat.format(value)
      }, compact),
      grid: { left: compact ? 42 : 60, right: compact ? 22 : 48, top: compact ? 18 : 26, bottom: compact ? 30 : 38 },
      xAxis: {
        type: "value",
        name: "",
        nameGap: 0,
        min: 0,
        max: days,
        axisLine: { lineStyle: { color: "#c4d0dd" } },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: "rgba(151, 167, 185, 0.16)" } },
        axisLabel: { color: "#66758a", fontFamily: "IBM Plex Mono", fontSize: compact ? 10 : 11 }
      },
      yAxis: {
        type: "log",
        logBase: 10,
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: "rgba(151, 167, 185, 0.18)" } },
        axisLabel: { color: "#66758a", fontFamily: "IBM Plex Mono", fontSize: compact ? 10 : 11, formatter: shortMoney }
      },
      series: [
        {
          name: "Projected equity",
          type: "line",
          smooth: 0.42,
          showSymbol: false,
          symbolSize: 7,
          endLabel: {
            show: !compact,
            formatter: (params) => shortMoney(params.value[1]),
            color: "#0b6b55",
            fontFamily: "JetBrains Mono",
            fontSize: 12,
            fontWeight: 800
          },
          emphasis: { focus: "series" },
          data: points.map((point) => [point.day, point.value]),
          lineStyle: {
            width: 4,
            color: chartGradient(0, 0, 1, 0, [
              { offset: 0, color: "#245fc7" },
              { offset: 0.55, color: "#0b8f69" },
              { offset: 1, color: "#46d79f" }
            ]),
            shadowBlur: 14,
            shadowColor: "rgba(11, 143, 105, 0.28)"
          },
          areaStyle: {
            color: chartGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(11, 143, 105, 0.3)" },
              { offset: 1, color: "rgba(36, 95, 199, 0.02)" }
            ])
          }
        },
        {
          name: "Adjusted target",
          type: "line",
          smooth: 0.38,
          showSymbol: false,
          data: adjustedPoints,
          lineStyle: {
            width: 2.5,
            type: "dashed",
            color: projection.adjustment.delta > 0 ? "#b56a00" : "#0b8f69"
          },
          emphasis: { focus: "series" }
        },
        {
          name: "Milestone",
          type: "scatter",
          symbolSize: 10,
          data: milestones,
          encode: { x: 0, y: 1 },
          itemStyle: { color: "#245fc7", borderColor: "#ffffff", borderWidth: 2 },
          label: {
            show: !compact,
            formatter: (params) => params.value[2],
            position: compact ? "inside" : "top",
            color: "#53657b",
            fontSize: compact ? 9 : 11,
            fontWeight: 800,
            fontFamily: "Manrope",
            hideOverlap: true
          }
        }
      ]
    });
  }

  function renderActivityHeatmap() {
    const container = $("#activityHeatmap");
    if (!container) return;
    const entriesByDate = new Map(state.entries.map((entry) => [entry.date, entry]));
    const today = getTodayIso("America/New_York");
    const start = addDays(today, -64);
    const cells = [];
    for (let index = 0; index < 65; index += 1) {
      const date = addDays(start, index);
      const entry = entriesByDate.get(date);
      const classes = ["heat-cell"];
      let title = `${date}: no log`;
      if (entry) {
        const abs = Math.abs(entry.returnPct);
        const intensity = abs >= 5 ? 3 : abs >= 2 ? 2 : 1;
        classes.push(entry.returnPct >= 0 ? `gain-${intensity}` : `loss-${intensity}`);
        title = `${date}: ${formatPercent(entry.returnPct)} | ${moneyFormat.format(entry.end)}`;
      }
      if (date === today) classes.push("today");
      cells.push(`<span class="${classes.join(" ")}" title="${escapeHtml(title)}"></span>`);
    }
    container.innerHTML = cells.join("");
    const logged = state.entries.filter((entry) => entry.date >= start && entry.date <= today).length;
    setText("#heatmapPill", logged ? `${logged} logged days` : "No logs");
  }

  function drawEquityChart() {
    const element = $("#equityChart");
    if (!element) return;
    const compact = isCompactChart(element);
    const entries = state.entries;
    const projection = getProjection();
    const actualPoints = [{ label: "Start", value: state.settings.startingCapital }].concat(
      entries.map((entry) => ({ label: entry.date.slice(5), value: entry.end }))
    );
    const rate = Math.max(0, projection.rate);
    const previewLength = entries.length ? 12 : 18;
    const projectionPoints = buildProjectionPreview(actualPoints[actualPoints.length - 1].value, rate, previewLength).map((point) => ({
      label: point.date,
      value: point.value
    }));
    const adjustedProjectionPoints = Number.isFinite(projection.adjustment.requiredRate)
      ? buildProjectionPreview(actualPoints[actualPoints.length - 1].value, Math.max(0, projection.adjustment.requiredRate), previewLength).map((point) => ({
          label: point.date,
          value: point.value
        }))
      : [];
    const categories = actualPoints.map((point) => point.label).concat(projectionPoints.map((point) => point.label));
    const projectionSeries = new Array(Math.max(0, actualPoints.length - 1)).fill(null).concat([
      actualPoints[actualPoints.length - 1].value,
      ...projectionPoints.map((point) => point.value)
    ]);
    const adjustedSeries = adjustedProjectionPoints.length
      ? new Array(Math.max(0, actualPoints.length - 1)).fill(null).concat([
          actualPoints[actualPoints.length - 1].value,
          ...adjustedProjectionPoints.map((point) => point.value)
        ])
      : [];
    const actualSeries = actualPoints.map((point) => point.value).concat(new Array(projectionPoints.length).fill(null));
    const latestValue = actualPoints[actualPoints.length - 1].value;
    const previewEndValue = projectionPoints.length ? projectionPoints[projectionPoints.length - 1].value : latestValue;
    const requiredRate = projection.adjustment.requiredRate;
    const planDrift = getPlanDrift(projection, projection.adjustment);
    const nextMilestone = projection.nextMilestone;
    const milestoneIndex = nextMilestone
      ? projectionPoints.findIndex((point) => point.value >= nextMilestone.amount)
      : -1;
    const milestoneCategory = milestoneIndex >= 0 ? categories[actualPoints.length + milestoneIndex] : null;
    const markLineData = [];
    if (nextMilestone && milestoneCategory) {
      markLineData.push({
        yAxis: nextMilestone.amount,
        name: "Next unlock",
        label: { show: false }
      });
    }
    setText("#runwayEngineState", entries.length ? `${entries.length} logs | ${projection.modeLabel} model` : `Preview | ${projection.modeLabel} model`);
    setText(
      "#runwayUnlockState",
      nextMilestone
        ? `${shortMoney(nextMilestone.amount)}${Number.isFinite(nextMilestone.days) ? ` in ${integerFormat.format(nextMilestone.days)} sessions` : ""}`
        : "Goal reached"
    );
    setText("#runwayNowMetric", moneyFormat.format(latestValue));
    setText("#runwayPreviewMetric", `${shortMoney(previewEndValue)} / +${previewLength}`);
    setText("#runwayRequiredMetric", Number.isFinite(requiredRate) ? formatPercent(requiredRate * 100) : "Recovery");
    setText("#runwayDriftMetric", formatPlanDrift(planDrift));

    renderEChart(element, {
      backgroundColor: "transparent",
      animationDuration: 850,
      animationEasing: "cubicOut",
      tooltip: chartTooltip({
        trigger: "axis",
        formatter: (params) => {
          const rows = params
            .filter((item) => item.value != null)
            .map((item) => {
              const value = Array.isArray(item.value) ? item.value[1] : item.value;
              const swatch = typeof item.color === "string"
                ? item.color
                : item.seriesName === "Adjusted target"
                  ? (projection.adjustment.delta > 0 ? "#b56a00" : "#0b8f69")
                  : item.seriesName === "Actual equity"
                    ? "#0b8f69"
                    : "#245fc7";
              return `
                <div style="display:flex;gap:18px;justify-content:space-between;align-items:center;margin-top:4px;">
                  <span><span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:${swatch};margin-right:6px;"></span>${escapeHtml(item.seriesName)}</span>
                  <strong>${moneyFormat.format(value)}</strong>
                </div>
              `;
            })
            .join("");
          const index = categories.indexOf(params[0]?.axisValue);
          const phase = index < actualPoints.length ? "Logged equity" : `Forward session ${index - actualPoints.length + 1}`;
          return `
            <div style="min-width:190px;">
              <div style="font-weight:850;color:#132033;">${escapeHtml(params[0]?.axisValue || "-")}</div>
              <div style="color:#66758a;font-size:11px;margin-top:2px;">${escapeHtml(phase)}</div>
              ${rows}
            </div>
          `;
        }
      }, compact),
      legend: {
        show: !compact,
        top: 10,
        right: compact ? 8 : 14,
        itemWidth: 18,
        itemHeight: 8,
        textStyle: { color: "#66758a", fontFamily: "Manrope", fontSize: compact ? 10 : 12, fontWeight: 760 }
      },
      grid: {
        left: compact ? 46 : 62,
        right: compact ? 18 : 34,
        top: compact ? 18 : 48,
        bottom: compact ? 34 : 42
      },
      dataZoom: [
        {
          type: "inside",
          xAxisIndex: 0,
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: true
        }
      ],
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: categories,
        axisLine: { lineStyle: { color: "#c4d0dd" } },
        axisTick: { show: false },
        splitLine: { show: true, lineStyle: { color: "rgba(151, 167, 185, 0.12)" } },
        axisLabel: {
          color: "#66758a",
          fontFamily: "IBM Plex Mono",
          fontSize: compact ? 10 : 11,
          interval: compact ? "auto" : 1
        }
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        splitArea: {
          show: true,
          areaStyle: {
            color: ["rgba(255,255,255,0.34)", "rgba(36,95,199,0.035)"]
          }
        },
        splitLine: { lineStyle: { color: "rgba(151, 167, 185, 0.16)" } },
        axisLabel: { color: "#66758a", fontFamily: "IBM Plex Mono", fontSize: compact ? 10 : 11, formatter: shortMoney }
      },
      series: [
        {
          name: "Actual equity",
          type: "line",
          smooth: 0.35,
          symbol: "circle",
          symbolSize: 7,
          connectNulls: false,
          data: actualSeries,
          lineStyle: { width: 3.6, color: "#0b8f69", shadowBlur: 12, shadowColor: "rgba(11, 143, 105, 0.28)" },
          itemStyle: { color: "#0b8f69", borderColor: "#ffffff", borderWidth: 2 },
          areaStyle: {
            color: chartGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(11, 143, 105, 0.2)" },
              { offset: 1, color: "rgba(11, 143, 105, 0.02)" }
            ])
          },
          emphasis: { focus: "series" }
        },
        {
          name: "Adjusted target",
          type: "line",
          smooth: 0.42,
          symbol: "none",
          connectNulls: true,
          data: adjustedSeries,
          lineStyle: {
            width: 2.4,
            type: "dotted",
            color: projection.adjustment.delta > 0 ? "#b56a00" : "#0b8f69"
          },
          emphasis: { focus: "series" },
          markLine: markLineData.length
            ? {
                silent: true,
                symbol: ["none", "none"],
                lineStyle: { color: "rgba(181, 106, 0, 0.44)", width: 1.4, type: "dashed" },
                label: {
                  color: "#7a4600",
                  fontFamily: "Manrope",
                  fontWeight: 850,
                  fontSize: compact ? 9 : 11,
                  backgroundColor: "rgba(255, 241, 216, 0.88)",
                  borderColor: "rgba(181, 106, 0, 0.22)",
                  borderWidth: 1,
                  borderRadius: 6,
                  padding: [3, 6]
                },
                data: markLineData
              }
            : undefined
        },
        {
          name: "Projected path",
          type: "line",
          smooth: 0.42,
          symbol: "none",
          connectNulls: true,
          data: projectionSeries,
          lineStyle: {
            width: 3.2,
            type: entries.length ? "dashed" : "solid",
            color: chartGradient(0, 0, 1, 0, [
              { offset: 0, color: "#245fc7" },
              { offset: 1, color: "#10a477" }
            ]),
            shadowBlur: 12,
            shadowColor: "rgba(36, 95, 199, 0.2)"
          },
          areaStyle: {
            color: chartGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(36, 95, 199, 0.2)" },
              { offset: 0.48, color: "rgba(77, 240, 183, 0.1)" },
              { offset: 1, color: "rgba(11, 143, 105, 0.03)" }
            ])
          },
          markArea: {
            silent: true,
            itemStyle: { color: "rgba(36, 95, 199, 0.045)" },
            label: { show: false },
            data: [[
              { xAxis: categories[Math.max(0, actualPoints.length - 1)] },
              { xAxis: categories[categories.length - 1] }
            ]]
          },
          markPoint: milestoneCategory
            ? {
                symbol: "pin",
                symbolSize: compact ? 38 : 48,
                itemStyle: { color: "#0b8f69" },
                label: {
                  color: "#ffffff",
                  fontFamily: "IBM Plex Mono",
                  fontWeight: 800,
                  formatter: shortMoney(nextMilestone.amount)
                },
                data: [{ coord: [milestoneCategory, nextMilestone.amount], name: "Next unlock" }]
              }
            : undefined,
          emphasis: {
            focus: "series"
          }
        }
      ]
    });
  }

  function drawReturnChart() {
    const element = $("#returnChart");
    if (!element) return;
    const compact = isCompactChart(element);
    const entries = state.entries.slice(-20);
    const categories = entries.length ? entries.map((entry) => entry.date.slice(5)) : Array.from({ length: 10 }, (_, index) => `T+${index + 1}`);
    const values = entries.length
      ? entries.map((entry) => roundTo(entry.returnPct, 2))
      : categories.map((_, index) => roundTo(state.settings.targetDailyReturn * (0.72 + index * 0.045), 2));
    const preview = !entries.length;

    renderEChart(element, {
      backgroundColor: "transparent",
      animationDuration: 750,
      animationEasing: "cubicOut",
      title: preview
        ? {
            text: "Target return preview",
            subtext: "Daily bars switch to actual results after your first log.",
            left: "center",
            top: 10,
            textStyle: { color: "#25384f", fontFamily: "Manrope", fontSize: compact ? 11 : 12, fontWeight: 850 },
            subtextStyle: { color: "#7a899d", fontFamily: "Manrope", fontSize: compact ? 10 : 11, fontWeight: 650 }
          }
        : undefined,
      tooltip: chartTooltip({
        trigger: "axis",
        valueFormatter: (value) => formatPercent(value)
      }, compact),
      grid: { left: compact ? 36 : 42, right: compact ? 12 : 18, top: preview ? (compact ? 68 : 58) : 18, bottom: 32 },
      xAxis: {
        type: "category",
        data: categories,
        axisLine: { lineStyle: { color: "#c4d0dd" } },
        axisTick: { show: false },
        axisLabel: { color: "#66758a", fontFamily: "IBM Plex Mono", fontSize: compact ? 9 : 10, interval: compact ? "auto" : 0 }
      },
      yAxis: {
        type: "value",
        min: preview ? 0 : (range) => Math.min(0, Math.floor(range.min)),
        max: (range) => Math.max(preview ? state.settings.targetDailyReturn * 1.35 : 1, Math.ceil(range.max)),
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: "rgba(151, 167, 185, 0.18)" } },
        axisLabel: { color: "#66758a", fontFamily: "IBM Plex Mono", fontSize: compact ? 9 : 10, formatter: (value) => `${value}%` }
      },
      series: [
        {
          name: preview ? "Target return" : "Daily return",
          type: "bar",
          barMaxWidth: 34,
          data: values.map((value) => ({
            value,
            itemStyle: {
              borderRadius: value >= 0 ? [7, 7, 2, 2] : [2, 2, 7, 7],
              color: preview
                ? chartGradient(0, 0, 0, 1, [
                    { offset: 0, color: "#4df0b7" },
                    { offset: 1, color: "#7fb1e6" }
                  ])
                : value >= 0
                  ? "#0b8f69"
                  : "#bd394a"
            }
          })),
          markLine: {
            symbol: "none",
            label: {
              color: "#53657b",
              fontFamily: "Inter",
              fontSize: 10,
              fontWeight: 800,
              formatter: (params) => (params.data?.name ? params.data.name : "")
            },
            lineStyle: { color: "rgba(102, 117, 138, 0.42)", width: 1 },
            data: [
              { yAxis: 0, name: "" },
              { yAxis: state.settings.targetDailyReturn, name: compact ? "" : "target" }
            ]
          }
        }
      ]
    });
  }

  function prepCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(260, rect.width);
    const height = Math.max(120, rect.height);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function drawChartFrame(ctx, width, height) {
    const fill = ctx.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, "#fcfeff");
    fill.addColorStop(1, "#f5f8fb");
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#e3ebf2";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(20, y);
      ctx.lineTo(width - 14, y);
      ctx.stroke();
    }
  }

  function buildProjectionPreview(startValue, rate, length) {
    const points = [];
    for (let index = 1; index <= length; index += 1) {
      points.push({ date: `+${index}`, value: startValue * (1 + rate) ** index });
    }
    return points;
  }

  function drawProjectionArea(ctx, width, height, actualLength, projectionPoints, xStep, mapY) {
    if (!projectionPoints.length) return;
    const startX = 40 + Math.max(0, actualLength - 1) * xStep;
    const firstY = mapY(getLatestCapital());
    const gradient = ctx.createLinearGradient(0, 20, width, height);
    gradient.addColorStop(0, "rgba(11, 143, 105, 0.2)");
    gradient.addColorStop(1, "rgba(36, 95, 199, 0.03)");

    ctx.beginPath();
    ctx.moveTo(startX, firstY);
    projectionPoints.forEach((point, index) => {
      ctx.lineTo(40 + (actualLength + index) * xStep, mapY(point.value));
    });
    ctx.lineTo(40 + (actualLength + projectionPoints.length - 1) * xStep, height - 32);
    ctx.lineTo(startX, height - 32);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(startX, firstY);
    projectionPoints.forEach((point, index) => {
      ctx.lineTo(40 + (actualLength + index) * xStep, mapY(point.value));
    });
    ctx.setLineDash([7, 7]);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = "#245fc7";
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawTargetBarPreview(ctx, width, height) {
    const zeroY = height * 0.62;
    const bars = 10;
    const gap = 7;
    const barWidth = Math.max(12, (width - 58) / bars - gap);
    ctx.strokeStyle = "#9aaec1";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(28, zeroY);
    ctx.lineTo(width - 18, zeroY);
    ctx.stroke();

    for (let index = 0; index < bars; index += 1) {
      const x = 30 + index * (barWidth + gap);
      const heightFactor = 0.42 + index * 0.035;
      const barHeight = (height - 46) * heightFactor;
      const gradient = ctx.createLinearGradient(0, zeroY - barHeight, 0, zeroY);
      gradient.addColorStop(0, "rgba(11, 143, 105, 0.74)");
      gradient.addColorStop(1, "rgba(36, 95, 199, 0.24)");
      ctx.fillStyle = gradient;
      ctx.fillRect(x, zeroY - barHeight, barWidth, barHeight);
    }

    drawChartLabel(ctx, width, "Target return preview", "Daily bars will switch to actual results after your first log.");
  }

  function drawChartLabel(ctx, width, title, subtitle) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#25384f";
    ctx.font = "700 13px Inter, system-ui, sans-serif";
    ctx.fillText(title, width / 2, 30);
    ctx.fillStyle = "#66758a";
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(subtitle, width / 2, 49);
    ctx.textAlign = "left";
  }

  function drawAxisLabels(ctx, width, height, max, min) {
    ctx.fillStyle = "#66758a";
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(moneyFormat.format(max), 10, 18);
    ctx.fillText(moneyFormat.format(min), 10, height - 12);
    ctx.textAlign = "right";
    ctx.fillText("projected", width - 12, 18);
    ctx.textAlign = "left";
  }

  function drawDonut(ctx, width, height, segments, options) {
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.38;
    const lineWidth = Math.max(16, radius * 0.24);
    const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0) || 1;
    let start = -Math.PI / 2;

    ctx.clearRect(0, 0, width, height);
    segments.forEach((segment) => {
      const angle = (Math.max(0, segment.value) / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, start, start + angle);
      ctx.strokeStyle = segment.color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      ctx.stroke();
      start += angle;
    });

    ctx.fillStyle = options.textColor;
    ctx.font = "700 24px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(options.title, cx, cy - 7);
    ctx.fillStyle = options.subColor;
    ctx.font = "700 12px 'Manrope', system-ui, sans-serif";
    ctx.fillText(options.subtitle, cx, cy + 18);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  function getProjection() {
    const current = getLatestCapital();
    const goal = state.settings.goal;
    const rate = getProjectionRate();
    const days = daysToReach(current, goal, rate);
    const firstSession = getFirstCountedSession();
    const targetDate = Number.isFinite(days) && firstSession ? addTradingDays(firstSession, days, true) : null;
    const nextMilestone = getNextMilestone(current, rate, firstSession);
    const modeLabel = getProjectionModeLabel();
    const adjustment = getTargetAdjustment(current);
    const summary = Number.isFinite(days)
      ? `${formatPercent(rate * 100)} projection pace | ${integerFormat.format(days)} sessions | adjusted target ${Number.isFinite(adjustment.requiredRate) ? formatPercent(adjustment.requiredRate * 100) : "recovery"}`
      : "Pace unavailable. Stabilize execution first.";
    return { current, goal, rate, days, firstSession, targetDate, nextMilestone, modeLabel, summary, adjustment };
  }

  function getTargetAdjustment(current = getLatestCapital(), sessionsUsed = state.entries.length) {
    const baselineRate = Math.max(0.000001, state.settings.targetDailyReturn / 100);
    const baselineSessions = daysToReach(state.settings.startingCapital, state.settings.goal, baselineRate);
    const remainingPlanSessions = Number.isFinite(baselineSessions)
      ? Math.max(1, baselineSessions - sessionsUsed)
      : Infinity;
    const requiredRate = current >= state.settings.goal
      ? 0
      : current > 0 && Number.isFinite(remainingPlanSessions)
        ? Math.pow(state.settings.goal / current, 1 / remainingPlanSessions) - 1
        : Infinity;
    return {
      baselineRate,
      baselineSessions,
      sessionsUsed,
      remainingPlanSessions,
      requiredRate,
      delta: Number.isFinite(requiredRate) ? requiredRate - baselineRate : Infinity
    };
  }

  function getProjectionRate() {
    const target = Math.max(0, state.settings.targetDailyReturn / 100);
    const actual = getGeometricDailyReturn();
    if (state.settings.projectionMode === "target") return target;
    if (state.settings.projectionMode === "actual") return actual > 0 ? actual : 0;
    if (!Number.isFinite(actual) || actual <= 0) return target * 0.6;
    return Math.max(0.001, Math.min(target, actual * 0.65 + target * 0.25));
  }

  function getProjectionModeLabel() {
    if (state.settings.projectionMode === "actual") return "Actual";
    if (state.settings.projectionMode === "conservative") return "Blended";
    return "Target";
  }

  function getNextMilestone(current, rate, firstSession) {
    const milestones = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
    const amount = milestones.find((item) => item > current);
    if (!amount) return null;
    const days = daysToReach(current, amount, rate);
    return { amount, days, eta: Number.isFinite(days) && firstSession ? addTradingDays(firstSession, days, true) : null };
  }

  function daysToReach(current, target, dailyRate) {
    if (current >= target) return 0;
    if (!Number.isFinite(current) || !Number.isFinite(target) || !Number.isFinite(dailyRate) || dailyRate <= 0) return Infinity;
    return Math.ceil(Math.log(target / current) / Math.log(1 + dailyRate));
  }

  function getGeometricDailyReturn() {
    if (!state.entries.length) return 0;
    const product = state.entries.reduce((acc, entry) => acc * (1 + entry.returnPct / 100), 1);
    if (product <= 0) return -1;
    return Math.pow(product, 1 / state.entries.length) - 1;
  }

  function getLatestCapital() {
    const latest = getLatestEntry();
    return latest ? latest.end : state.settings.startingCapital;
  }

  function getLatestCapitalBefore(date) {
    const prior = [...state.entries].filter((entry) => entry.date < date).pop();
    return prior ? prior.end : state.settings.startingCapital;
  }

  function getLatestEntry() {
    return state.entries.length ? state.entries[state.entries.length - 1] : null;
  }

  function getDrawdownStats() {
    const values = [state.settings.startingCapital, ...state.entries.map((entry) => entry.end)];
    let peak = values[0] || 0;
    let maxDrawdown = 0;
    values.forEach((value) => {
      peak = Math.max(peak, value);
      if (peak > 0) maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
    });
    const current = peak > 0 ? values[values.length - 1] / peak - 1 : 0;
    return { current, max: maxDrawdown, peak };
  }

  function getLossStreak() {
    let streak = 0;
    for (let index = state.entries.length - 1; index >= 0; index -= 1) {
      if (state.entries[index].returnPct < 0) streak += 1;
      else break;
    }
    return streak;
  }

  function splitPlanItems(value) {
    return String(value || "")
      .split(/\n|;|,/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 4);
  }

  function renderFeedbackCard([label, value, note]) {
    return `
      <article>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value || "-"))}</strong>
        <small>${escapeHtml(String(note || ""))}</small>
      </article>
    `;
  }

  function bestGroup(entries, keyFn, valueFn) {
    const groups = new Map();
    entries.forEach((entry) => {
      const key = keyFn(entry);
      if (!key) return;
      const bucket = groups.get(key) || [];
      bucket.push(valueFn(entry));
      groups.set(key, bucket);
    });
    return [...groups.entries()]
      .map(([key, values]) => ({ key, count: values.length, average: average(values) }))
      .sort((a, b) => b.average - a.average || b.count - a.count)[0] || null;
  }

  function worstMistakeTag(entries) {
    const groups = new Map();
    entries.forEach((entry) => {
      splitPlanItems(entry.mistakes).forEach((tag) => {
        const key = tag.toLowerCase();
        const bucket = groups.get(key) || { label: tag, returns: [] };
        bucket.returns.push(entry.returnPct);
        groups.set(key, bucket);
      });
    });
    return [...groups.values()]
      .map((item) => ({ label: item.label, count: item.returns.length, average: average(item.returns) }))
      .sort((a, b) => a.average - b.average || b.count - a.count)[0] || null;
  }

  function getPlanDrift(projection, adjustment) {
    if (!Number.isFinite(projection.days) || !Number.isFinite(adjustment.remainingPlanSessions)) return Infinity;
    return projection.days - adjustment.remainingPlanSessions;
  }

  function formatPlanDrift(value) {
    if (!Number.isFinite(value)) return "Recovery";
    const rounded = Math.round(value);
    if (rounded === 0) return "0 sessions";
    return `${rounded > 0 ? "+" : ""}${integerFormat.format(rounded)} sessions`;
  }

  function regimeLabel(value) {
    return {
      trend: "Trend day",
      range: "Range/chop",
      gap: "Gap and fade",
      crash: "Risk-off",
      thin: "Thin liquidity"
    }[value] || value;
  }

  function getFirstCountedSession() {
    const status = getMarketStatusNow();
    if (isTradingDay(status.today) && status.minutesEt < status.closeMinute) return status.today;
    return nextTradingDate(addDays(status.today, 1));
  }

  function getMarketStatusNow() {
    const now = getZonedNow("America/New_York");
    const day = getMarketDay(now.iso);
    const closeMinute = day.type === "early" ? 13 * 60 : 16 * 60;
    let label = "Closed";
    let level = "danger";
    let pill = "Closed";

    if (day.type === "closed" || day.type === "weekend") {
      label = day.label || "Market closed";
      pill = "Closed";
      level = "danger";
    } else if (now.minutes < 4 * 60) {
      label = "Before extended session";
      pill = "Closed";
      level = "warning";
    } else if (now.minutes < 9 * 60 + 30) {
      label = "Premarket / lower liquidity";
      pill = "Premarket";
      level = "warning";
    } else if (now.minutes < closeMinute) {
      label = day.type === "early" ? "Core open - early close" : "Core session open";
      pill = "Open";
      level = "positive";
    } else if (now.minutes < 20 * 60) {
      label = "After-hours / lower liquidity";
      pill = "After-hours";
      level = "warning";
    } else {
      label = "Closed after late session";
      pill = "Closed";
      level = "danger";
    }

    return {
      today: now.iso,
      minutesEt: now.minutes,
      closeMinute,
      label,
      level,
      pill,
      nextOpen: formatNextOpen(now.iso, now.minutes)
    };
  }

  function formatNextOpen(today, minutes) {
    const day = getMarketDay(today);
    if (isTradingDay(today) && minutes < 9 * 60 + 30) return `Today 9:30 a.m. ET`;
    const next = nextTradingDate(addDays(today, 1));
    return `${formatDate(next)} 9:30 a.m. ET`;
  }

  function getMarketDay(iso) {
    const manual = state.manualClosures.find((closure) => closure.date === iso);
    if (manual) {
      return {
        type: manual.type,
        label: manual.label,
        close: manual.type === "early" ? "13:00" : null,
        source: "Manual override"
      };
    }

    const official = MARKET_DATA.officialSchedule && MARKET_DATA.officialSchedule[iso];
    if (official) return { ...official };

    if (isWeekend(iso)) return { type: "weekend", label: "Weekend" };

    const rule = ruleBasedMarketDay(iso);
    if (rule) return rule;

    return { type: "open", label: "Regular session", close: "16:00" };
  }

  function isTradingDay(iso) {
    const day = getMarketDay(iso);
    return day.type === "open" || day.type === "early";
  }

  function nextTradingDate(startIso) {
    let cursor = startIso;
    let guard = 0;
    while (!isTradingDay(cursor) && guard < 5000) {
      cursor = addDays(cursor, 1);
      guard += 1;
    }
    return cursor;
  }

  function addTradingDays(startIso, tradingDays, includeStart) {
    if (tradingDays <= 0) return startIso;
    let cursor = startIso;
    let counted = 0;
    let guard = 0;
    while (counted < tradingDays && guard < 10000) {
      if ((includeStart || cursor !== startIso) && isTradingDay(cursor)) counted += 1;
      if (counted >= tradingDays) return cursor;
      cursor = addDays(cursor, 1);
      guard += 1;
    }
    return cursor;
  }

  function getNextMarketEvent(fromIso) {
    let cursor = fromIso;
    for (let i = 0; i < 370; i += 1) {
      const day = getMarketDay(cursor);
      const isPlainWeekend = day.type === "weekend";
      if (!isPlainWeekend && (day.type === "closed" || day.type === "early")) return { date: cursor, ...day };
      cursor = addDays(cursor, 1);
    }
    return null;
  }

  function ruleBasedMarketDay(iso) {
    const { year } = dateParts(iso);
    const closed = [
      [observedFixedHoliday(year, 1, 1, "New Year's Day"), "New Year's Day"],
      [nthWeekday(year, 1, 1, 3), "Martin Luther King, Jr. Day"],
      [nthWeekday(year, 2, 1, 3), "Washington's Birthday"],
      [addDays(easterSunday(year), -2), "Good Friday"],
      [lastWeekday(year, 5, 1), "Memorial Day"],
      [observedFixedHoliday(year, 6, 19, "Juneteenth National Independence Day"), "Juneteenth National Independence Day"],
      [observedFixedHoliday(year, 7, 4, "Independence Day"), "Independence Day"],
      [nthWeekday(year, 9, 1, 1), "Labor Day"],
      [nthWeekday(year, 11, 4, 4), "Thanksgiving Day"],
      [observedFixedHoliday(year, 12, 25, "Christmas Day"), "Christmas Day"]
    ];

    for (const [date, label] of closed) {
      if (date === iso) return { type: "closed", label, source: "Rule-based fallback" };
    }

    const thanksgiving = nthWeekday(year, 11, 4, 4);
    if (iso === addDays(thanksgiving, 1)) {
      return { type: "early", label: "Day after Thanksgiving", close: "13:00", source: "Rule-based fallback" };
    }

    const christmasEve = isoDate(year, 12, 24);
    if (iso === christmasEve && !isWeekend(iso) && !closed.some(([date]) => date === iso)) {
      return { type: "early", label: "Christmas Eve", close: "13:00", source: "Rule-based fallback" };
    }

    const julyThird = isoDate(year, 7, 3);
    const julyFourthDow = dayOfWeek(isoDate(year, 7, 4));
    if (iso === julyThird && [2, 3, 4, 5].includes(julyFourthDow) && !isWeekend(iso)) {
      return { type: "early", label: "Day before Independence Day", close: "13:00", source: "Rule-based fallback" };
    }

    return null;
  }

  function observedFixedHoliday(year, month, day) {
    const raw = isoDate(year, month, day);
    const dow = dayOfWeek(raw);
    if (dow === 6) {
      if (month === 1 && day === 1) return null;
      return addDays(raw, -1);
    }
    if (dow === 0) return addDays(raw, 1);
    return raw;
  }

  function getMonthRegime(iso) {
    const { month, day } = dateParts(iso);
    if (month === 11) {
      return {
        title: "November transition",
        summary: "November often sits inside the stronger Nov-Apr seasonal window, but Thanksgiving week can distort volume.",
        execution: "Use catalyst quality and RTH liquidity as the filter; do not assume year-end fund flows are automatically bearish."
      };
    }
    if (month === 12) {
      return {
        title: "December holiday tape",
        summary: "December can trend, but Christmas/New Year weeks can become thin and whippy.",
        execution: "Reduce size around early-close or holiday-adjacent sessions, especially after midday."
      };
    }
    if ([5, 6, 7, 8, 9, 10].includes(month)) {
      return {
        title: "May-October caution window",
        summary: "Academic seasonality research finds Nov-Apr returns stronger on average than May-Oct across broad samples.",
        execution: "Treat this as a caution flag only; still follow actual momentum, volume, and catalyst evidence."
      };
    }
    if (month === 1 && day <= 10) {
      return {
        title: "New-year reset",
        summary: "First trading days can reprice tax-loss names and crowded themes quickly.",
        execution: "Require clean liquidity and avoid assuming every small-cap gap has continuation."
      };
    }
    return {
      title: "Regular earnings/liquidity regime",
      summary: "Normal RTH liquidity is the default planning window.",
      execution: "Focus on confirmed catalysts, relative volume, VWAP behavior, and predefined risk."
    };
  }

  function getZonedNow(timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    return {
      iso: `${map.year}-${map.month}-${map.day}`,
      hour,
      minute,
      second: Number(map.second),
      minutes: hour * 60 + minute
    };
  }

  function getTodayIso(timeZone) {
    return getZonedNow(timeZone).iso;
  }

  function formatClock(parts) {
    return `${parts.iso} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
  }

  function formatDate(iso) {
    if (!isIsoDate(iso)) return "-";
    const date = dateFromIso(iso);
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC"
    }).format(date);
  }

  function formatCompactDate(iso) {
    if (!isIsoDate(iso)) return "-";
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC"
    }).format(dateFromIso(iso));
  }

  function formatDateTimeCompact(value) {
    if (!value) return "Never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function addDays(iso, count) {
    const date = dateFromIso(iso);
    date.setUTCDate(date.getUTCDate() + count);
    return dateToIso(date);
  }

  function nthWeekday(year, month, weekday, nth) {
    let date = isoDate(year, month, 1);
    while (dayOfWeek(date) !== weekday) date = addDays(date, 1);
    return addDays(date, (nth - 1) * 7);
  }

  function lastWeekday(year, month, weekday) {
    let date = isoDate(year, month + 1, 0);
    while (dayOfWeek(date) !== weekday) date = addDays(date, -1);
    return date;
  }

  function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return isoDate(year, month, day);
  }

  function isoDate(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    return dateToIso(date);
  }

  function dateFromIso(iso) {
    const [year, month, day] = iso.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12));
  }

  function dateToIso(date) {
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }

  function dateParts(iso) {
    const [year, month, day] = iso.split("-").map(Number);
    return { year, month, day };
  }

  function dayOfWeek(iso) {
    return dateFromIso(iso).getUTCDay();
  }

  function isWeekend(iso) {
    const dow = dayOfWeek(iso);
    return dow === 0 || dow === 6;
  }

  function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  }

  function positiveNumber(value, fallback) {
    const next = Number(value);
    return Number.isFinite(next) && next >= 0 ? next : fallback;
  }

  function numberOr(value, fallback) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
  }

  function roundTo(value, digits) {
    const factor = 10 ** digits;
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
  }

  function average(values) {
    const clean = values.filter((value) => Number.isFinite(value));
    if (!clean.length) return 0;
    return clean.reduce((sum, value) => sum + value, 0) / clean.length;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return "-";
    return `${value >= 0 ? "" : "-"}${Math.abs(value).toFixed(2)}%`;
  }

  function formatSignedPercent(value) {
    if (!Number.isFinite(value)) return "-";
    return `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}%`;
  }

  function shortMoney(value) {
    if (!Number.isFinite(value)) return "-";
    const abs = Math.abs(value);
    if (abs >= 1000000) return `$${formatCompactMagnitude(value / 1000000)}M`;
    if (abs >= 1000) return `$${formatCompactMagnitude(value / 1000, abs >= 10000 ? 0 : 1)}K`;
    return moneyFormat.format(value);
  }

  function formatCompactMagnitude(value, digits = 1) {
    return value.toFixed(digits).replace(/\.0$/, "");
  }

  function setPill(selector, text, level) {
    const pill = $(selector);
    if (!pill) return;
    pill.textContent = text;
    pill.classList.remove("positive", "warning", "danger");
    if (level) pill.classList.add(level);
  }

  function setText(selector, text) {
    const element = $(selector);
    if (element) element.textContent = text;
  }

  function setTemporaryText(selector, text) {
    const element = $(selector);
    const prior = element.textContent;
    element.textContent = text;
    window.setTimeout(() => {
      element.textContent = prior;
    }, 1800);
  }

  function activateTab(tab) {
    const button = $(`.tab-button[data-tab="${tab}"]`);
    if (button) button.click();
  }

  function downloadText(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return `"${text.replaceAll('"', '""')}"`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }
})();
