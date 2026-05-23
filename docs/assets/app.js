(() => {
  "use strict";

  const MARKET_DATA = window.TRADING_ASSISTANT_MARKET_DATA || {
    officialSchedule: {},
    researchNotes: [],
    sources: []
  };

  const STORAGE_KEY = "ichwan.usTradingControlRoom.v1";
  const BACKEND_STORAGE_KEY = "ichwan.usTradingControlRoom.backend.v1";
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
  let renderTimer = null;
  let autoSyncTimer = null;

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
    bindRiskLab();
    bindBackendControls();
    hydrateForms();
    renderAll();
    refreshBackendStatus();
    window.setInterval(() => renderClocksAndMarket(), 1000);
    window.addEventListener("resize", () => {
      window.clearTimeout(renderTimer);
      renderTimer = window.setTimeout(renderCharts, 120);
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeState(state)));
    scheduleAutoSync();
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

    nextState.entries = nextState.entries
      .filter((entry) => isIsoDate(entry.date))
      .map((entry) => {
        const start = positiveNumber(entry.start, nextState.settings.startingCapital);
        const end = positiveNumber(entry.end, start);
        const returnPct = numberOr(entry.returnPct, start > 0 ? ((end - start) / start) * 100 : 0);
        return {
          date: entry.date,
          start,
          end,
          returnPct,
          trades: Math.max(0, Math.round(numberOr(entry.trades, 0))),
          wins: Math.max(0, Math.round(numberOr(entry.wins, 0))),
          grade: entry.grade || "B",
          discipline: String(entry.discipline || "3"),
          mood: entry.mood || "calm",
          regime: entry.regime || "trend",
          mistakes: entry.mistakes || "",
          notes: entry.notes || "",
          plan: entry.plan || ""
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

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
        window.setTimeout(renderCharts, 60);
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
    const startInput = $("#entryStart");
    const endInput = $("#entryEnd");
    const returnInput = $("#entryReturn");

    endInput.addEventListener("input", () => {
      const start = numberOr(startInput.value, 0);
      const end = numberOr(endInput.value, 0);
      if (start > 0 && end > 0) returnInput.value = roundTo(((end - start) / start) * 100, 2);
    });

    returnInput.addEventListener("input", () => {
      const start = numberOr(startInput.value, 0);
      const returnPct = numberOr(returnInput.value, 0);
      if (start > 0) endInput.value = roundTo(start * (1 + returnPct / 100), 2);
    });

    $("#useLatestStart").addEventListener("click", () => {
      startInput.value = roundTo(getLatestCapital(), 2);
      endInput.value = "";
      returnInput.value = "";
    });

    $("#dailyForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const date = $("#entryDate").value;
      if (!isIsoDate(date)) {
        setTemporaryText("#entryStatus", "Date invalid");
        return;
      }

      const start = positiveNumber(startInput.value, getLatestCapitalBefore(date));
      let end = positiveNumber(endInput.value, NaN);
      const returnPctInput = numberOr(returnInput.value, NaN);
      if (!Number.isFinite(end) && Number.isFinite(returnPctInput)) {
        end = start * (1 + returnPctInput / 100);
      }
      if (!Number.isFinite(end)) end = start;
      const returnPct = start > 0 ? ((end - start) / start) * 100 : 0;

      const entry = {
        date,
        start,
        end,
        returnPct,
        trades: Math.max(0, Math.round(numberOr($("#entryTrades").value, 0))),
        wins: Math.max(0, Math.round(numberOr($("#entryWins").value, 0))),
        grade: $("#entryGrade").value,
        discipline: $("#entryDiscipline").value,
        mood: $("#entryMood").value,
        regime: $("#entryRegime").value,
        mistakes: $("#entryMistakes").value.trim(),
        notes: $("#entryNotes").value.trim(),
        plan: $("#entryPlan").value.trim()
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
        ["date", "start", "end", "returnPct", "trades", "wins", "grade", "discipline", "mood", "regime", "mistakes", "notes", "plan"],
        ...state.entries.map((entry) => [
          entry.date,
          entry.start,
          entry.end,
          entry.returnPct,
          entry.trades,
          entry.wins,
          entry.grade,
          entry.discipline,
          entry.mood,
          entry.regime,
          entry.mistakes,
          entry.notes,
          entry.plan
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

  function bindRiskLab() {
    $("#riskForm").addEventListener("submit", (event) => {
      event.preventDefault();
      renderRiskSimulation();
    });
    $("#runRiskSimulation").addEventListener("click", renderRiskSimulation);

    ["#permEnergy", "#permMarket", "#permCatalyst", "#permDiscipline"].forEach((selector) => {
      $(selector).addEventListener("change", renderPermission);
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
      renderBackendStatus("Backend config saved.");
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
    $("#entryStart").value = roundTo(getLatestCapitalBefore(nextDate), 2);
    $("#entryEnd").value = "";
    $("#entryReturn").value = "";
    $("#entryTrades").value = "";
    $("#entryWins").value = "";
    $("#entryGrade").value = "B";
    $("#entryDiscipline").value = "3";
    $("#entryMood").value = "calm";
    $("#entryRegime").value = "trend";
    $("#entryMistakes").value = "";
    $("#entryNotes").value = "";
    $("#entryPlan").value = "";
  }

  function fillDailyForm(entry) {
    $("#entryDate").value = entry.date;
    $("#entryStart").value = roundTo(entry.start, 2);
    $("#entryEnd").value = roundTo(entry.end, 2);
    $("#entryReturn").value = roundTo(entry.returnPct, 2);
    $("#entryTrades").value = entry.trades;
    $("#entryWins").value = entry.wins;
    $("#entryGrade").value = entry.grade;
    $("#entryDiscipline").value = entry.discipline;
    $("#entryMood").value = entry.mood;
    $("#entryRegime").value = entry.regime;
    $("#entryMistakes").value = entry.mistakes;
    $("#entryNotes").value = entry.notes;
    $("#entryPlan").value = entry.plan;
  }

  function renderAll() {
    renderClocksAndMarket();
    renderMetricsAndProjection();
    renderJournal();
    renderCoach();
    renderCalendar();
    renderPermission();
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

    $("#metricCapital").textContent = moneyFormat.format(latestCapital);
    $("#metricReturn").textContent = `Cumulative return ${formatPercent(cumulativeReturn)}`;
    $("#metricEta").textContent = Number.isFinite(projection.days)
      ? `${integerFormat.format(projection.days)} days`
      : "Need positive pace";
    $("#metricEtaSub").textContent = projection.targetDate
      ? `ETA ${formatDate(projection.targetDate)}`
      : "Trading days tersisa";
    $("#metricPace").textContent = formatPercent(projection.rate * 100);
    $("#metricPaceSub").textContent = projection.modeLabel;
    $("#metricDrawdown").textContent = formatPercent(drawdown.current * 100);
    $("#metricDrawdownSub").textContent = `Max historical ${formatPercent(drawdown.max * 100)}`;
    $("#goalProgress").textContent = `${formatPercent(progress)}`;
    $("#goalRing").style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress / 100));
    $("#projectionModePill").textContent = projection.modeLabel;
    $("#targetDate").textContent = projection.targetDate ? `${formatDate(projection.targetDate)} (${projection.targetDate})` : "-";
    $("#firstSession").textContent = projection.firstSession ? `${formatDate(projection.firstSession)} (${projection.firstSession})` : "-";
    $("#nextMilestone").textContent = projection.nextMilestone
      ? `${moneyFormat.format(projection.nextMilestone.amount)} in ${integerFormat.format(projection.nextMilestone.days)} days`
      : "Goal reached";
    $("#projectionSummary").textContent = projection.summary;

    renderMilestones(projection.rate, projection.firstSession);
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
          <td colspan="8" class="muted">Belum ada entry. Tambahkan performa hari pertama dari form di atas.</td>
        </tr>
      `;
      return;
    }

    $("#journalTable").innerHTML = [...state.entries]
      .reverse()
      .map((entry) => {
        const winRate = entry.trades > 0 ? `, WR ${formatPercent((entry.wins / entry.trades) * 100)}` : "";
        const returnClass = entry.returnPct >= 0 ? "gain" : "loss";
        return `
          <tr>
            <td>${escapeHtml(entry.date)}<br><span class="muted">${escapeHtml(entry.regime)}</span></td>
            <td class="num">${moneyFormat.format(entry.start)}</td>
            <td class="num">${moneyFormat.format(entry.end)}</td>
            <td class="num ${returnClass}">${formatPercent(entry.returnPct)}</td>
            <td class="num">${entry.trades}${winRate}</td>
            <td>${escapeHtml(entry.grade)}</td>
            <td>${escapeHtml(entry.discipline)} / 5</td>
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
    $("#coachCard").className = `coach-card ${cardClass}`;
    $("#coachCard").innerHTML = `
      <div>
        <h3>${escapeHtml(actions.title)}</h3>
        <p>${escapeHtml(actions.summary)}</p>
      </div>
      <div>
        <strong>Do now</strong>
        <ul>${actions.doNow.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>
      <div>
        <strong>Do not</strong>
        <ul>${actions.doNot.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>
    `;

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
        "Trade hanya saat spread, volume, dan VWAP context mendukung."
      ],
      doNot: ["Jangan tambah posisi rugi.", "Jangan ubah stop karena emosi.", "Jangan mengejar candle yang sudah jauh dari plan."]
    };

    const overlays = {
      euphoric: {
        title: "Win high control",
        summary: "Profit besar sering bikin kualitas keputusan turun karena merasa market mudah.",
        doNow: ["Lock jurnal profit hari ini.", "Turunkan size untuk trade berikutnya.", "Ambil jeda 10 menit sebelum entry ulang."],
        doNot: ["Jangan menaikkan size karena baru menang.", "Jangan membuka trade tambahan hanya karena ingin memperbesar hari hijau."]
      },
      fomo: {
        title: "FOMO interrupt",
        summary: "Kalau entry terasa harus sekarang juga, biasanya edge sudah turun.",
        doNow: ["Tunggu pullback atau reclaim level jelas.", "Tuliskan invalidation sebelum klik buy.", "Lewati trade jika reward/risk di bawah 2:1."],
        doNot: ["Jangan market order ke candle extended.", "Jangan beli hanya karena ticker ramai di chat atau scanner."]
      },
      revenge: {
        title: "Revenge lockout",
        summary: "Dorongan membalas rugi adalah sinyal stop, bukan sinyal entry.",
        doNow: ["Stop trading minimal 30 menit.", "Tutup platform order entry.", "Tulis satu kalimat: kerugian hari ini adalah biaya menjaga akun tetap hidup."],
        doNot: ["Jangan cari trade baru untuk balik modal.", "Jangan gandakan size.", "Jangan pindah ke ticker asing tanpa setup."]
      },
      drawdown: {
        title: "Drawdown recovery",
        summary: "Tujuan fase ini adalah memulihkan eksekusi, bukan memulihkan P/L secepat mungkin.",
        doNow: ["Size 50% sampai dua hari hijau berturut-turut.", "Ambil hanya A/A+ setup.", "Review tiga loss terakhir sebelum sesi berikutnya."],
        doNot: ["Jangan mengejar target $1M ketika equity curve sedang turun.", "Jangan overtrade untuk mempercepat recovery."]
      },
      tired: {
        title: "Low energy filter",
        summary: "Energi rendah membuat disiplin stop-loss dan sabar entry biasanya memburuk.",
        doNow: ["Trade maksimal satu setup A+.", "Gunakan size 50%.", "No trade jika belum tidur cukup atau fokus pecah."],
        doNot: ["Jangan trading premarket yang spread-nya lebar.", "Jangan ambil scalping cepat saat reaksi melambat."]
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
      doNot: [...(chosen.doNot || base.doNot)]
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

  function renderRiskSimulation() {
    const winRate = clamp(numberOr($("#riskWinRate").value, 55) / 100, 0, 1);
    const avgWin = Math.max(0, numberOr($("#riskAvgWin").value, 2.2) / 100);
    const avgLoss = Math.max(0, numberOr($("#riskAvgLoss").value, 1.2) / 100);
    const tradesPerDay = Math.max(1, Math.round(numberOr($("#riskTradesPerDay").value, 3)));
    const maxDrawdownStop = Math.max(0.01, numberOr($("#riskMaxDrawdown").value, 20) / 100);
    const paths = clamp(Math.round(numberOr($("#riskPaths").value, 1000)), 100, 3000);
    const maxDays = 520;
    const startCapital = getLatestCapital();
    const goal = state.settings.goal;
    const results = [];
    let reached = 0;
    let stopped = 0;

    for (let path = 0; path < paths; path += 1) {
      let equity = startCapital;
      let peak = startCapital;
      let reachedDay = null;
      let stopDay = null;
      for (let day = 1; day <= maxDays; day += 1) {
        let dailyReturn = 0;
        for (let trade = 0; trade < tradesPerDay; trade += 1) {
          const isWin = Math.random() < winRate;
          const noise = 0.65 + Math.random() * 0.7;
          dailyReturn += isWin ? avgWin * noise : -avgLoss * noise;
        }
        equity *= Math.max(0.05, 1 + dailyReturn);
        peak = Math.max(peak, equity);
        const drawdown = peak > 0 ? equity / peak - 1 : 0;
        if (equity >= goal) {
          reachedDay = day;
          break;
        }
        if (drawdown <= -maxDrawdownStop) {
          stopDay = day;
          break;
        }
      }
      if (reachedDay) reached += 1;
      if (stopDay) stopped += 1;
      results.push({
        equity,
        reachedDay,
        stopDay
      });
    }

    const reachedDays = results.filter((item) => item.reachedDay).map((item) => item.reachedDay).sort((a, b) => a - b);
    const finalEquities = results.map((item) => item.equity).sort((a, b) => a - b);
    const reachProbability = reached / paths;
    const stopProbability = stopped / paths;
    const medianReach = reachedDays.length ? percentile(reachedDays, 0.5) : null;
    const p10 = percentile(finalEquities, 0.1);
    const p50 = percentile(finalEquities, 0.5);
    const p90 = percentile(finalEquities, 0.9);
    const expectedPerTrade = winRate * avgWin - (1 - winRate) * avgLoss;
    const roughDailyEdge = expectedPerTrade * tradesPerDay;

    const level = stopProbability > 0.35 ? "danger" : reachProbability > 0.5 ? "positive" : "warning";
    setPill("#riskResultPill", `${formatPercent(reachProbability * 100)} reach rate`, level);
    $("#riskOutput").innerHTML = [
      ["Reach $1M probability", formatPercent(reachProbability * 100), "Within 520 trading days under the entered assumptions."],
      ["Drawdown stop probability", formatPercent(stopProbability * 100), `Stopped after ${formatPercent(maxDrawdownStop * 100)} drawdown from peak.`],
      ["Median days if reached", medianReach ? `${integerFormat.format(medianReach)} days` : "Not reached in most paths", "Use this as a planning stress test, not a promise."],
      ["Model daily edge", formatPercent(roughDailyEdge * 100), "Expected value before slippage, bad fills, fees, and emotional mistakes."],
      ["Final equity p10 / p50 / p90", `${moneyFormat.format(p10)} / ${moneyFormat.format(p50)} / ${moneyFormat.format(p90)}`, "Distribution after 520 trading days or earlier stop/reach."]
    ]
      .map(
        ([title, value, note]) => `
          <article class="scenario-item">
            <strong>${escapeHtml(title)}</strong>
            <p class="metric-inline">${escapeHtml(value)}</p>
            <span class="muted">${escapeHtml(note)}</span>
          </article>
        `
      )
      .join("");
  }

  function renderPermission() {
    const energy = numberOr($("#permEnergy").value, 3);
    const market = numberOr($("#permMarket").value, 3);
    const catalyst = numberOr($("#permCatalyst").value, 3);
    const discipline = numberOr($("#permDiscipline").value, 3);
    const drawdown = getDrawdownStats().current;
    const latest = getLatestEntry();
    const lossPenalty = latest && latest.returnPct < 0 ? 1 : 0;
    const drawdownPenalty = drawdown <= -0.1 ? 2 : drawdown <= -0.05 ? 1 : 0;
    const score = energy + market + catalyst + discipline - lossPenalty - drawdownPenalty;
    let title = "Trade permission: normal";
    let level = "positive";
    let size = "Normal size hanya untuk A setup, maksimal sesuai risk cap.";
    let rules = [
      "Predefine entry, stop, and target before order.",
      "Skip if spread/volume is not clean.",
      "Stop after max daily loss or two low-quality decisions."
    ];

    if (score < 11) {
      title = "Trade permission: restricted";
      level = "warning";
      size = "Use half size, one trade at a time, no chasing.";
      rules = [
        "Only A/A+ catalyst with clean RTH liquidity.",
        "No premarket thin-spread entries.",
        "End session after one rule violation."
      ];
    }

    if (score < 8 || market <= 1 || discipline <= 1 || drawdown <= -0.12) {
      title = "Trade permission: no-trade / defense";
      level = "danger";
      size = "No new risk unless this is a pre-planned exceptional setup with tiny size.";
      rules = [
        "Protect capital and review last trades.",
        "Do not attempt to recover losses today.",
        "Prepare tomorrow's watchlist instead of forcing execution."
      ];
    }

    setPill("#permissionPill", `${score}/20`, level);
    $("#permissionCard").className = `coach-card ${level === "danger" ? "danger" : level === "warning" ? "warning" : ""}`;
    $("#permissionCard").innerHTML = `
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(size)}</p>
      </div>
      <ul>${rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}</ul>
    `;
  }

  async function refreshBackendStatus() {
    renderBackendStatus();
    const client = getBackendClient(false);
    if (!client) return;
    try {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) {
        renderBackendStatus("Backend configured. Sign in to sync.", "warning", null);
        return;
      }
      await updateRemoteStatus(client, data.user);
    } catch (error) {
      renderBackendStatus(`Backend check failed: ${error.message}`, "danger", null);
    }
  }

  function renderBackendStatus(message, level, user) {
    const configured = Boolean(backendConfig.url && backendConfig.anonKey);
    const statusText = configured ? "Configured" : "Offline local";
    setPill("#backendStatusPill", statusText, configured ? "warning" : "");
    $("#backendLastSync").textContent = backendConfig.lastSyncAt || "Never";
    $("#backendMessage").textContent = message || (configured
      ? "Backend configured. Login via magic link, then push/pull/merge."
      : "Add Supabase URL and publishable/anon key to enable cloud sync.");
    if (level) {
      $("#backendMessage").className = `coach-banner ${level}`;
    } else {
      $("#backendMessage").className = "coach-banner";
    }
    setPill("#backendUserPill", user ? user.email || "Signed in" : "Not signed in", user ? "positive" : "warning");
  }

  function getBackendClient(showAlert) {
    if (!backendConfig.url || !backendConfig.anonKey) {
      if (showAlert) window.alert("Isi Supabase URL dan anon key dulu.");
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
      renderBackendStatus("Magic link terkirim. Buka email di browser yang sama untuk menyelesaikan login.", "positive", null);
    } catch (error) {
      renderBackendStatus(`Login link failed: ${error.message}`, "danger", null);
    }
  }

  async function signOutBackend() {
    const client = getBackendClient(false);
    if (!client) return;
    await client.auth.signOut();
    renderBackendStatus("Signed out from Supabase.", "warning", null);
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
      renderBackendStatus("Local state pushed to Supabase.", "positive", user);
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
    renderBackendStatus("Remote snapshot pulled and applied locally.", "positive", remote.user);
  }

  async function mergeBackendSnapshot() {
    const remote = await fetchRemoteSnapshot();
    if (!remote) return;
    state = mergeStates(state, remote.payload || DEFAULT_STATE);
    saveState();
    hydrateForms();
    renderAll();
    await pushBackendSnapshot(true);
    renderBackendStatus("Remote and local data merged, then pushed back.", "positive", remote.user);
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
        renderBackendStatus("No remote snapshot found. Push local first.", "warning", user);
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
      renderBackendStatus("Sign in via magic link before sync.", "warning", null);
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
      renderBackendStatus(`Backend configured, but table/schema is not ready: ${error.message}`, "danger", user);
      $("#backendRemoteStatus").textContent = "Schema missing";
      return;
    }
    $("#backendRemoteStatus").textContent = data ? `Snapshot ${data.updated_at}` : "No snapshot";
    renderBackendStatus(data ? "Signed in. Remote snapshot available." : "Signed in. Push local to create remote backup.", "positive", user);
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
    drawEquityChart();
    drawReturnChart();
  }

  function drawEquityChart() {
    const canvas = $("#equityChart");
    if (!canvas) return;
    const { ctx, width, height } = prepCanvas(canvas);
    const entries = state.entries;
    const points = [{ date: "Start", value: state.settings.startingCapital }].concat(
      entries.map((entry) => ({ date: entry.date.slice(5), value: entry.end }))
    );
    drawChartFrame(ctx, width, height);

    if (points.length < 2) {
      drawEmptyChart(ctx, width, height, "Equity curve muncul setelah minimal 1 daily log.");
      return;
    }

    const values = points.map((point) => point.value);
    const min = Math.min(...values, state.settings.startingCapital) * 0.98;
    const max = Math.max(...values, state.settings.goal * 0.001, state.settings.startingCapital) * 1.04;
    const xStep = points.length > 1 ? (width - 54) / (points.length - 1) : width - 54;
    const mapY = (value) => height - 32 - ((value - min) / Math.max(1, max - min)) * (height - 58);

    ctx.beginPath();
    points.forEach((point, index) => {
      const x = 38 + index * xStep;
      const y = mapY(point.value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#12805c";
    ctx.stroke();

    points.forEach((point, index) => {
      const x = 38 + index * xStep;
      const y = mapY(point.value);
      ctx.fillStyle = index === points.length - 1 ? "#1f67c2" : "#12805c";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = "#657589";
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(moneyFormat.format(max / 1.04), 8, 18);
    ctx.fillText(moneyFormat.format(min / 0.98), 8, height - 12);
  }

  function drawReturnChart() {
    const canvas = $("#returnChart");
    if (!canvas) return;
    const { ctx, width, height } = prepCanvas(canvas);
    drawChartFrame(ctx, width, height);

    const entries = state.entries.slice(-20);
    if (!entries.length) {
      drawEmptyChart(ctx, width, height, "Daily return bars muncul setelah log pertama.");
      return;
    }

    const maxAbs = Math.max(1, ...entries.map((entry) => Math.abs(entry.returnPct)));
    const zeroY = height / 2;
    const barGap = 4;
    const barWidth = Math.max(10, (width - 48) / entries.length - barGap);

    ctx.strokeStyle = "#9fb0c2";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(28, zeroY);
    ctx.lineTo(width - 14, zeroY);
    ctx.stroke();

    entries.forEach((entry, index) => {
      const x = 30 + index * (barWidth + barGap);
      const barHeight = (Math.abs(entry.returnPct) / maxAbs) * ((height - 38) / 2);
      const y = entry.returnPct >= 0 ? zeroY - barHeight : zeroY;
      ctx.fillStyle = entry.returnPct >= 0 ? "#12805c" : "#c43d3d";
      ctx.fillRect(x, y, barWidth, Math.max(2, barHeight));
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
    ctx.fillStyle = "#fbfcfd";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#e2e9ef";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  function drawEmptyChart(ctx, width, height, message) {
    ctx.fillStyle = "#657589";
    ctx.font = "14px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(message, width / 2, height / 2);
    ctx.textAlign = "left";
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
    const summary = Number.isFinite(days)
      ? `${moneyFormat.format(current)} menuju ${moneyFormat.format(goal)} butuh sekitar ${integerFormat.format(days)} trading sessions pada pace ${formatPercent(rate * 100)}. Calendar memakai libur/early close NYSE/Nasdaq dan manual override jika ada penutupan mendadak.`
      : "Pace projection belum positif. Fokus dulu ke stabilitas, bukan target date.";
    return { current, goal, rate, days, firstSession, targetDate, nextMilestone, modeLabel, summary };
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
    if (state.settings.projectionMode === "actual") return "Actual pace";
    if (state.settings.projectionMode === "conservative") return "Conservative pace";
    return "Target mode";
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

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function percentile(values, ratio) {
    if (!values.length) return 0;
    const index = clamp(Math.round((values.length - 1) * ratio), 0, values.length - 1);
    return values[index];
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return "-";
    return `${value >= 0 ? "" : "-"}${Math.abs(value).toFixed(2)}%`;
  }

  function setPill(selector, text, level) {
    const pill = $(selector);
    pill.textContent = text;
    pill.classList.remove("positive", "warning", "danger");
    if (level) pill.classList.add(level);
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
