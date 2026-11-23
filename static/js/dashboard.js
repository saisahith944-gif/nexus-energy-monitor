(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { dashboard: null, knownAlertIds: new Set(), alertsInitialized: false, charts: {}, muted: localStorage.getItem("nexus-alerts-muted") === "true", audioEnabled: false, timer: null, toastTimer: null, history: [], historyLoaded: false, chartPeriod: "daily", buildingFloor: "all", selectedRoomId: null };
  const demoBuildingFloors = {
    3: ["301", "302", "303", "304", "305"],
    2: ["201", "202", "203", "204", "205"],
    1: ["101", "102", "103", "104", "105"],
  };
  const colors = { Normal: "#22C55E", Warning: "#F59E0B", Critical: "#EF4444", "No recent reading": "#64748B" };
  const statusClass = (status) => status === "Normal" ? "normal" : status === "Warning" ? "warning" : status === "Critical" ? "critical" : "unknown";
  const money = (amount) => `₹${Number(amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const kwh = (amount) => `${Number(amount || 0).toLocaleString("en-IN", { maximumFractionDigits: 1 })}`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const dateTime = (value) => value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";

  async function api(url, options = {}) {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
        "X-CSRF-Token": csrfToken,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  function toast(message, error = false) {
    const element = $("#toast");
    element.textContent = message;
    element.style.background = error ? "#a33238" : "#1c324b";
    element.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.remove("show"), 3000);
  }

  function goTo(page) {
    $$(".page-view").forEach((view) => view.classList.toggle("active", view.id === `page-${page}`));
    $$(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.page === page && !link.hasAttribute("data-dashboard-target")));
    document.body.classList.toggle("dashboard-mode", page === "dashboard");
    const titles = { dashboard: "Dashboard", building: "Building map", analytics: "Energy analytics", alerts: "Alerts", history: "Reports", insights: "Saving insights", settings: "Settings", room: "Room details" };
    $("#page-title").textContent = titles[page] || "Dashboard";
    $("#sidebar").classList.remove("open");
    if (page === "analytics") renderAnalytics();
    if (page === "alerts") loadAlerts();
    if (page === "history") loadHistory();
    if (page === "insights") renderInsights();
  }

  function navigate() {
    const requested = location.hash.replace("#", "");
    if (requested.startsWith("room-")) {
      loadRoom(Number(requested.slice(5)));
      return;
    }
    const page = ["dashboard", "building", "analytics", "alerts", "settings", "history", "insights"].includes(requested) ? requested : "dashboard";
    goTo(page);
  }

  function setMetric(id, value) { $(`#${id}`).textContent = value; }

  function renderSavingsProjection() {
    if (!state.dashboard || !$("#savings-reduction")) return;
    const reduction = Number($("#savings-reduction").value || 20) / 100;
    const total = state.dashboard.summary.total_consumption;
    const tariff = state.dashboard.settings.electricity_price_per_kwh;
    const emissionsFactor = state.dashboard.settings.emissions_factor_kg_per_kwh || 0;
    const projected = total * (1 - reduction);
    $("#projected-consumption").textContent = `${kwh(projected)} kWh`;
    $("#projected-cost").textContent = money(projected * tariff);
    $("#projected-savings").textContent = money(total * reduction * tariff);
    $("#projected-emissions").textContent = `${kwh(projected * emissionsFactor)} kg CO₂e`;
  }

  function renderDashboardCostProjection(data) {
    if (!data?.summary) return;
    const reduction = Number($("#dashboard-reduction").value || 20) / 100;
    const cost = Number(data.summary.estimated_cost) || 0;
    const savings = cost * reduction;
    setMetric("dashboard-current-cost", money(cost));
    setMetric("dashboard-projected-cost", money(cost - savings));
    setMetric("dashboard-projected-saving", money(savings));
  }

  function renderDashboardCarbonEstimate(data) {
    const chart = $("#dashboard-carbon-bars");
    if (!chart) return;
    const factor = Number(data.settings.emissions_factor_kg_per_kwh) || 0;
    const dailyKwh = Number(data.summary.estimated_daily_run_rate) || 0;
    const monthlyKwh = Number(data.summary.total_consumption) || 0;
    const periods = [
      { label: "Daily run rate", consumption: dailyKwh },
      { label: "7-day estimate", consumption: dailyKwh * 7 },
      { label: "Month to date", consumption: monthlyKwh },
    ].map((period) => ({ ...period, emissions: period.consumption * factor }));
    const maximum = Math.max(...periods.map((period) => period.emissions), 0);
    chart.innerHTML = maximum > 0
      ? periods.map((period) => {
        const height = period.emissions ? Math.max(period.emissions / maximum * 100, 8) : 0;
        return `<div class="dashboard-carbon-column"><strong>${kwh(period.emissions)} <small>kg</small></strong><div class="dashboard-carbon-track"><i style="height:${height}%"></i></div><span>${period.label}</span></div>`;
      }).join("")
      : '<div class="dashboard-carbon-empty">No consumption or emissions-factor data available.</div>';
  }

  function updateReportLinks() {
    const params = new URLSearchParams();
    const start = $("#history-start")?.value;
    const end = $("#history-end")?.value;
    if (start) params.set("start", start);
    if (end) params.set("end", end);
    const query = params.toString();
    ["export-report", "export-history"].forEach((id) => {
      const link = $(`#${id}`);
      if (link) link.href = `/api/reports.csv${query ? `?${query}` : ""}`;
    });
  }

  function floorMarkup(floor, rooms, filterText = "") {
    const visibleRooms = rooms.filter((room) => `${room.room_number} ${room.floor_number}`.toLowerCase().includes(filterText.toLowerCase()));
    if (!visibleRooms.length) return "";
    const recentRooms = visibleRooms.filter((room) => room.reading_state === "current");
    const consumption = recentRooms.reduce((sum, room) => sum + room.current_consumption, 0);
    const expected = recentRooms.reduce((sum, room) => sum + room.expected_consumption_limit, 0);
    const percent = expected ? Math.round(consumption / expected * 100) : 0;
    const barStatus = percent > 100 ? "critical" : percent >= 80 ? "warning" : "normal";
    const floorCost = consumption * (state.dashboard?.settings.electricity_price_per_kwh || 0);
    const warningCount = visibleRooms.filter((room) => room.status === "Warning").length;
    const criticalCount = visibleRooms.filter((room) => room.status === "Critical").length;
    const average = recentRooms.length ? consumption / recentRooms.length : 0;
    const floorStatus = criticalCount ? "Critical" : warningCount ? "Warning" : "Normal";
    const noReadingCount = visibleRooms.length - recentRooms.length;
    return `<article class="floor-card"><div class="floor-card-head"><div class="floor-name-wrap"><span class="floor-building-icon">⌂</span><div><button class="floor-title floor-open-button" data-floor-opening="${floor}">Floor ${floor} <span>↗</span></button><div class="floor-caption">${visibleRooms.length} rooms · ${noReadingCount} no recent reading · avg ${kwh(average)} kWh/room</div></div></div><div class="floor-use">${kwh(consumption)} <small>kWh recorded</small><small>${money(floorCost)} est.</small></div></div><div class="floor-load"><div class="floor-load-label"><span>Usage vs expected (recent rooms)</span><b class="floor-load-${barStatus}">${percent}%</b></div><div class="floor-load-track"><span class="floor-load-fill ${barStatus}" style="width:${Math.min(percent, 100)}%"></span></div><span class="floor-attention"><i class="status-dot ${statusClass(floorStatus)}"></i>${warningCount} warning · ${criticalCount} critical · ${noReadingCount} unknown</span></div><div class="room-grid">${visibleRooms.map((room) => { const status = statusClass(room.status); const description = room.reading_state === "current" ? `${kwh(room.current_consumption)} kWh · ${room.percent_of_limit}% of expected` : "No recent reading"; return `<button class="room-tile ${status}" data-room-id="${room.id}" title="Room ${escapeHtml(room.room_number)} · ${description}" aria-label="Room ${escapeHtml(room.room_number)}, ${description}, ${room.status}"><strong>${escapeHtml(room.room_number)}</strong><span>${room.reading_state === "current" ? `${kwh(room.current_consumption)} kWh` : "No recent reading"}</span><span>${room.reading_state === "current" ? `${room.percent_of_limit}% of limit` : "Status unknown"}</span></button>`; }).join("")}</div><div class="floor-legend"><span class="legend-item"><i class="status-dot normal"></i> Normal</span><span class="legend-item"><i class="status-dot warning"></i> Warning</span><span class="legend-item"><i class="status-dot critical"></i> Critical</span><span class="legend-item"><i class="status-dot unknown"></i> No recent reading</span></div></article>`;
  }

  function renderFloors() {
    if (!state.dashboard) return;
    const rooms = state.dashboard.rooms;
    const floors = [...new Set(rooms.map((room) => room.floor_number))].sort((a, b) => a - b);
    const draw = (containerId, filterId, searchId) => {
      const floorValue = $(`#${filterId}`).value;
      const search = $(`#${searchId}`).value.trim();
      const selected = floorValue ? floors.filter((floor) => String(floor) === floorValue) : floors;
      const statusValue = containerId === "building-floor-cards" ? $("#building-status-filter").value : "";
      $(`#${containerId}`).innerHTML = selected.map((floor) => floorMarkup(floor, rooms.filter((room) => room.floor_number === floor && (!statusValue || room.status === statusValue)), search)).join("") || '<div class="panel empty-state">No rooms match your filters.</div>';
    };
    draw("floor-cards", "floor-filter", "room-search");
    draw("building-floor-cards", "building-floor-filter", "building-search");
    $$(".room-tile").forEach((tile) => tile.addEventListener("click", () => { location.hash = `room-${tile.dataset.roomId}`; }));
    renderBuildingFloorplan(rooms);
    $$(".floor-open-button").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      $("#building-floor-filter").value = button.dataset.floorOpening;
      location.hash = "building";
      renderFloors();
    }));
    renderBuildingSummary(rooms, floors);
    renderBuildingModel(rooms);
  }

  function renderBuildingFloorplan(rooms) {
    const container = $("#building-floorplan-map");
    if (!container) return;
    if (!container.dataset.roomNavigationBound) {
      container.addEventListener("click", (event) => {
        const button = event.target.closest(".plan-room[data-room-id]");
        if (!button) return;
        state.selectedRoomId = Number(button.dataset.roomId);
        location.hash = `room-${button.dataset.roomId}`;
      });
      container.dataset.roomNavigationBound = "true";
    }
    const roomArt = [
      '<svg viewBox="0 0 120 48" aria-hidden="true"><path class="plan-window" d="M12 3h31v3H12zm65 0h31v3H77z"/><rect class="plan-desk" x="22" y="13" width="35" height="15" rx="2"/><rect class="plan-screen" x="34" y="15" width="12" height="7" rx="1"/><circle class="plan-chair" cx="39" cy="36" r="5"/><rect class="plan-side-table" x="78" y="15" width="22" height="19" rx="2"/><path class="plan-plant" d="M88 15V8m0 5-5-4m5 3 5-5"/></svg>',
      '<svg viewBox="0 0 120 48" aria-hidden="true"><path class="plan-window" d="M12 3h31v3H12zm65 0h31v3H77z"/><rect class="plan-desk" x="35" y="12" width="50" height="22" rx="5"/><path class="plan-table-line" d="M42 19h36M42 25h36"/><circle class="plan-chair" cx="26" cy="22" r="5"/><circle class="plan-chair" cx="94" cy="22" r="5"/><circle class="plan-chair" cx="60" cy="39" r="4"/><path class="plan-plant" d="M103 16V9m0 5-5-4m5 3 5-5"/></svg>',
      '<svg viewBox="0 0 120 48" aria-hidden="true"><path class="plan-window" d="M12 3h31v3H12zm65 0h31v3H77z"/><rect class="plan-desk" x="19" y="13" width="28" height="22" rx="2"/><rect class="plan-screen" x="26" y="17" width="14" height="9" rx="1"/><rect class="plan-desk" x="68" y="13" width="32" height="10" rx="2"/><rect class="plan-desk" x="68" y="29" width="32" height="8" rx="2"/><path class="plan-plant" d="M55 31v-8m0 5-5-4m5 2 5-5"/></svg>',
    ];
    const floorLabels = { 1: "Ground floor", 2: "Second floor", 3: "Third floor" };
    const knownNumbers = Object.values(demoBuildingFloors).flat();
    const modelRooms = knownNumbers.map((number) => rooms.find((room) => room.room_number === number) || {
      room_number: number,
      floor_number: Number(number[0]),
      status: "No recent reading",
      reading_state: "missing",
      current_consumption: null,
      percent_of_limit: null,
    });
    container.innerHTML = Object.keys(demoBuildingFloors)
      .sort((left, right) => Number(right) - Number(left))
      .map((floor) => {
        const floorRooms = demoBuildingFloors[floor].map((number) => modelRooms.find((room) => room.room_number === number));
        const usage = floorRooms.reduce((sum, room) => sum + (room.reading_state === "current" ? Number(room.current_consumption) || 0 : 0), 0);
        const attention = floorRooms.filter((room) => ["Warning", "Critical"].includes(room.status)).length;
        return `<section class="plan-floor" aria-label="${floorLabels[floor]}, five rooms">
          <div class="plan-floor-heading"><span class="plan-floor-badge">F${floor}</span><div><strong>${floorLabels[floor]}</strong><small>${floorRooms.length} rooms · ${attention} need attention</small></div><span class="plan-floor-total">${kwh(usage)} <small>kWh</small></span></div>
          <div class="plan-room-row">${floorRooms.map((room, index) => {
            const recent = room.reading_state === "current";
            const status = statusClass(room.status);
            const selected = room.id && Number(room.id) === state.selectedRoomId;
            const usageText = recent ? `${kwh(room.current_consumption)} kWh` : "No recent reading";
            return `<button type="button" class="plan-room ${status}${selected ? " selected" : ""}" ${room.id ? `data-room-id="${room.id}"` : "disabled"} aria-pressed="${Boolean(selected)}" aria-label="Open Room ${escapeHtml(room.room_number)}, ${room.status}${recent ? `, ${kwh(room.current_consumption)} kilowatt hours` : ", no recent reading"}" title="Room ${escapeHtml(room.room_number)} · ${room.status}">
              <span class="plan-room-top"><span>ROOM ${escapeHtml(room.room_number)}</span><i class="status-dot ${status}"></i></span>
              <span class="plan-room-art">${roomArt[(Number(room.room_number.slice(-1)) + index) % roomArt.length]}</span>
              <span class="plan-room-bottom"><strong>${usageText}</strong><small>${recent ? `${room.percent_of_limit}% of expected` : "Status unknown"}</small></span>
              <span class="plan-room-door" aria-hidden="true"></span></button>`;
          }).join("")}</div>
          <div class="plan-corridor" aria-hidden="true"><span>MAIN CORRIDOR</span><i></i><i></i><i></i><i></i><i></i><span>EXIT</span></div>
        </section>`;
      }).join("");
  }

  function renderBuildingModel(rooms) {
    const container = $("#building-model");
    if (!container) return;
    const modelRooms = Object.values(demoBuildingFloors).flat().map((number) =>
      rooms.find((room) => room.room_number === number) || {
        room_number: number,
        floor_number: Number(number[0]),
        status: "No recent reading",
        reading_state: "missing",
        current_consumption: null,
        percent_of_limit: null,
      });
    const roomCounts = { Normal: 0, Warning: 0, Critical: 0, "No recent reading": 0 };
    modelRooms.forEach((room) => { roomCounts[room.status] = (roomCounts[room.status] || 0) + 1; });
    const total = modelRooms.reduce((sum, room) =>
      sum + (room.reading_state === "current" ? Number(room.current_consumption) || 0 : 0), 0);
    const floorTotals = Object.keys(demoBuildingFloors).map((floor) => {
      const floorRooms = modelRooms.filter((room) => String(room.floor_number) === floor);
      const consumption = floorRooms.reduce((sum, room) =>
        sum + (room.reading_state === "current" ? Number(room.current_consumption) || 0 : 0), 0);
      return { floor, consumption };
    });
    const leading = floorTotals.reduce((highest, item) =>
      item.consumption > highest.consumption ? item : highest, floorTotals[0]);
    const lastUpdate = modelRooms
      .filter((room) => room.reading_state === "current" && room.last_reading_at)
      .map((room) => new Date(room.last_reading_at))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((left, right) => right - left)[0];

    container.innerHTML = '<div class="model-roof" aria-hidden="true"><span class="model-roof-cap"></span><span class="model-solar-array"><i></i><i></i><i></i><i></i></span><span class="model-roof-plant"></span></div>'
      + Object.keys(demoBuildingFloors).sort((left, right) => Number(right) - Number(left)).map((floor) => {
      const numbers = demoBuildingFloors[floor];
      const floorRooms = numbers.map((number) => modelRooms.find((room) => room.room_number === number));
      const floorUsage = floorRooms.reduce((sum, room) =>
        sum + (room.reading_state === "current" ? Number(room.current_consumption) || 0 : 0), 0);
      const floorAttention = floorRooms.filter((room) => ["Warning", "Critical"].includes(room.status)).length;
      const isHidden = state.buildingFloor !== "all" && state.buildingFloor !== floor;
      return `<section class="model-floor" data-model-floor="${floor}" ${isHidden ? "hidden" : ""} aria-label="Floor ${floor}, five rooms">
        <div class="model-floor-label"><span>F${floor}</span><div><strong>FLOOR ${floor}</strong><small>${floorRooms.length} rooms · ${floorAttention} need attention</small></div></div>
        <div class="model-floor-rooms">${floorRooms.map((room) => {
          const recent = room.reading_state === "current";
          const status = statusClass(room.status);
          const selected = room.id && Number(room.id) === state.selectedRoomId;
          return `<button type="button" class="model-room ${status}${selected ? " selected" : ""}" ${room.id ? `data-room-id="${room.id}"` : "disabled"} aria-pressed="${Boolean(selected)}" aria-label="Room ${escapeHtml(room.room_number)}, ${room.status}${recent ? `, ${kwh(room.current_consumption)} kilowatt hours, ${room.percent_of_limit}% of expected limit` : ", no recent reading"}" title="Room ${escapeHtml(room.room_number)} · ${room.status}${recent ? ` · ${kwh(room.current_consumption)} kWh · ${room.percent_of_limit}% of limit` : ""}">
            <span class="model-room-window" aria-hidden="true"></span><strong>${escapeHtml(room.room_number)}</strong>
            <span class="model-room-usage">${recent ? `${kwh(room.current_consumption)} kWh` : "No recent data"}</span>
            <span class="model-room-status"><i class="status-dot ${status}"></i>${recent ? `${room.percent_of_limit}% of limit` : "Status unknown"}</span>
            <span class="model-room-door" aria-hidden="true"></span></button>`;
        }).join("")}</div>
        <div class="model-floor-footer"><span>${kwh(floorUsage)} kWh recorded</span><span>${money(floorUsage * (state.dashboard?.settings.electricity_price_per_kwh || 0))} estimated</span></div>
      </section>`;
    }).join("") + '<div class="model-building-base" aria-hidden="true"><span></span><span></span><span></span><i></i></div>';

    $$(".model-room[data-room-id]", container).forEach((button) =>
      button.addEventListener("click", () => {
        state.selectedRoomId = Number(button.dataset.roomId);
        renderBuildingModel(state.dashboard?.rooms || []);
        location.hash = `room-${button.dataset.roomId}`;
      }));
    $("#model-total-consumption").textContent = kwh(total);
    $("#model-leading-floor").textContent = `Floor ${leading.floor}`;
    $("#model-floor-totals").innerHTML = floorTotals.map((item) =>
      `<div><span>Floor ${item.floor}</span><b>${kwh(item.consumption)} <small>kWh</small></b></div>`).join("");
    $("#model-normal-count").textContent = roomCounts.Normal;
    $("#model-warning-count").textContent = roomCounts.Warning;
    $("#model-critical-count").textContent = roomCounts.Critical;
    $("#model-unknown-count").textContent = roomCounts["No recent reading"];
    $("#model-last-update").textContent = lastUpdate ? dateTime(lastUpdate.toISOString()) : "No recent readings";
    const extraRooms = rooms.filter((room) =>
      !Object.values(demoBuildingFloors).flat().includes(room.room_number));
    const note = $("#building-extra-rooms-note");
    note.textContent = extraRooms.length
      ? `${extraRooms.length} additional saved ${extraRooms.length === 1 ? "room is" : "rooms are"} retained in Room Monitoring and are not part of this 15-room demonstration model.`
      : "The building model shows the 15 configured demonstration rooms.";
    $$(".building-floor-button").forEach((button) => {
      const active = button.dataset.buildingFloor === state.buildingFloor;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function renderBuildingSummary(rooms, floors) {
    const container = $("#building-summary");
    if (!container) return;
    container.innerHTML = floors.map((floor) => {
      const floorRooms = rooms.filter((room) => room.floor_number === floor);
      const recentRooms = floorRooms.filter((room) => room.reading_state === "current");
      const critical = floorRooms.filter((room) => room.status === "Critical").length;
      const warnings = floorRooms.filter((room) => room.status === "Warning").length;
      const total = recentRooms.reduce((sum, room) => sum + room.current_consumption, 0);
      const unknown = floorRooms.length - recentRooms.length;
      return `<div class="building-summary-card"><span>FLOOR ${floor}</span><b>${kwh(total)} <small>kWh</small></b><small>${floorRooms.length} rooms · ${warnings} warning · ${critical} critical · ${unknown} unknown</small></div>`;
    }).join("");
  }

  function renderSummary(data) {
    const summary = data.summary;
    setMetric("stat-rooms", summary.room_count);
    setMetric("stat-no-reading", summary.rooms_without_recent_readings || 0);
    setMetric("stat-consumption", kwh(summary.total_consumption));
    setMetric("stat-today-usage", kwh(summary.estimated_daily_run_rate));
    setMetric("stat-cost", money(summary.estimated_cost));
    setMetric("stat-normal", summary.normal_count);
    setMetric("stat-warning", summary.warning_count);
    setMetric("stat-critical", summary.critical_count);
    setMetric("stat-emissions", kwh(summary.estimated_emissions_kg));
    setMetric("sidebar-emissions", kwh(summary.estimated_emissions_kg));
    setMetric("status-critical-count", summary.critical_count);
    setMetric("stat-savings", money(summary.potential_savings));
    renderSavingsProjection();
    renderDashboardCostProjection(data);
    renderDashboardCarbonEstimate(data);
    const tariffInput = $("#dashboard-tariff");
    if (tariffInput && document.activeElement !== tariffInput) tariffInput.value = data.settings.electricity_price_per_kwh;
    setMetric("last-updated", new Date(data.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    setMetric("hero-refresh-interval", `${data.settings.refresh_interval_seconds} sec`);
    state.audioEnabled = Boolean(data.settings.sound_enabled);
    updateSoundControls();
    $("#stop-simulation").classList.toggle("hidden", !data.active_simulation);
    $("#simulate-alert").classList.toggle("hidden", data.active_simulation);
    $("#rail-stop-simulation").classList.toggle("hidden", !data.active_simulation);
    $(".rail-action-demo").classList.toggle("hidden", data.active_simulation);
    $("#demo-scenario-actions").classList.toggle("hidden", data.active_simulation);
    $(".rail-scenarios").classList.toggle("hidden", data.active_simulation);
    const recentRooms = data.rooms.filter((room) => room.reading_state === "current");
    const expectedTotal = recentRooms.reduce((sum, room) => sum + room.expected_consumption_limit, 0);
    const usagePercent = expectedTotal ? Math.round(summary.total_consumption / expectedTotal * 100) : 0;
    setMetric("hero-percent", `${usagePercent}%`);
    setMetric("hero-consumption", kwh(summary.total_consumption));
    setMetric("hero-limit", kwh(expectedTotal));
    $("#hero-meter-progress").style.strokeDashoffset = `${264 - Math.min(usagePercent, 100) / 100 * 264}`;
    $("#hero-meter-progress").classList.toggle("over-limit", usagePercent > 100);
    const floorUsage = [...new Set(data.rooms.map((room) => room.floor_number))]
      .map((floor) => ({ floor, consumption: recentRooms.filter((room) => room.floor_number === floor).reduce((sum, room) => sum + room.current_consumption, 0) }))
      .sort((left, right) => right.consumption - left.consumption)[0];
    setMetric("hero-leading-floor", floorUsage ? `Floor ${floorUsage.floor}` : "—");
    setMetric("hero-leading-consumption", floorUsage ? `${kwh(floorUsage.consumption)} kWh` : "—");
    const active = data.alerts;
    setMetric("active-count", active.length);
    setMetric("nav-alert-count", active.length);
    const banner = $("#critical-banner");
    const critical = active.filter((alert) => alert.alert_type === "CRITICAL");
    banner.classList.toggle("hidden", critical.length === 0);
    if (critical.length) {
      const alert = critical[0];
      const excess = Math.max(alert.consumption - alert.expected_limit, 0);
      $("#critical-summary").textContent = `Floor ${alert.floor_number}, Room ${alert.room_number} · ${kwh(alert.consumption)} kWh actual vs ${kwh(alert.expected_limit)} kWh expected · ${kwh(excess)} kWh above limit${alert.is_simulated ? " · simulated event" : ""}.`;
      $("#critical-simulated").classList.toggle("hidden", !alert.is_simulated);
    }
    setMetric("notification-count", active.length);
    $("#active-alerts").innerHTML = active.slice(0, 5).map((alert) => {
      const delta = alert.expected_limit > 0 ? ((alert.consumption - alert.expected_limit) / alert.expected_limit * 100) : null;
      const difference = delta === null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%`;
      return `<div class="compact-alert ${alert.alert_type === "WARNING" ? "warning-alert" : ""}"><i class="alert-marker"></i><div class="compact-alert-content"><strong>${escapeHtml(alert.alert_type)} · Floor ${alert.floor_number}, Room <button class="alert-room-link" data-alert-room="${alert.room_id}">${escapeHtml(alert.room_number)}</button><em class="alert-state">ACTIVE</em> ${alert.is_simulated ? '<span class="simulated-table-tag">SIMULATED</span>' : ""}<em class="alert-delta">${difference}</em></strong><span>${kwh(alert.consumption)} kWh actual vs ${kwh(alert.expected_limit)} kWh expected · ${kwh(Math.max(alert.consumption - alert.expected_limit, 0))} kWh excess</span><span>${escapeHtml(alert.reason || alert.message)}</span></div><time>${escapeHtml(dateTime(alert.created_at))}</time>${alert.acknowledged ? "" : `<button class="preview-ack" data-ack="${alert.id}" aria-label="Acknowledge alert ${alert.id}">✓</button>`}</div>`;
    }).join("") || '<div class="empty-state">All clear. No active alerts.</div>';
    $$("[data-ack].preview-ack").forEach((button) => button.addEventListener("click", () => acknowledgeAlert(button.dataset.ack)));
    $$("[data-alert-room]").forEach((button) => button.addEventListener("click", () => { location.hash = `room-${button.dataset.alertRoom}`; }));
    const live = $("#live-pill");
    live.classList.remove("checking", "offline");
    $("#live-label").textContent = "API POLLING";
    $("#sidebar-connection-label").textContent = "SYSTEM ONLINE";
    $("#sidebar-connection-detail").textContent = "Local database connected";
    $("#sidebar-connection-dot").classList.add("online");
    $("#critical-simulated").classList.toggle("hidden", !critical[0]?.is_simulated);
    renderInsightsPreview();
  }

  function populateFloorFilters() {
    if (!state.dashboard) return;
    const floors = [...new Set(state.dashboard.rooms.map((room) => room.floor_number))].sort((a, b) => a - b);
    ["floor-filter", "building-floor-filter", "alert-floor-filter"].forEach((id) => {
      const select = $(`#${id}`);
      const selected = select.value;
      select.innerHTML = `<option value="">All floors</option>${floors.map((floor) => `<option value="${floor}">Floor ${floor}</option>`).join("")}`;
      select.value = selected;
    });
    const roomSelect = $("#alert-room-filter");
    populateRoomSelect(roomSelect, roomSelect.value);
    populateRoomSelect($("#chart-room-filter"), $("#chart-room-filter").value);
    populateRoomSelect($("#history-room-filter"), $("#history-room-filter").value);
    ["chart-floor-filter", "history-floor-filter"].forEach((id) => {
      const select = $(`#${id}`);
      const selected = select.value;
      select.innerHTML = `<option value="">All floors</option>${floors.map((floor) => `<option value="${floor}">Floor ${floor}</option>`).join("")}`;
      select.value = selected;
    });
    if (state.historyLoaded) renderDashboardUsageChart();
  }

  function populateRoomSelect(select, previous) {
    const floorFilter = select.id === "chart-room-filter" ? $("#chart-floor-filter").value : "";
    const filteredRooms = state.dashboard.rooms.filter((room) => !floorFilter || String(room.floor_number) === floorFilter);
    select.innerHTML = `<option value="">All rooms</option>${filteredRooms.map((room) => `<option value="${room.id}">Floor ${room.floor_number} · Room ${escapeHtml(room.room_number)}</option>`).join("")}`;
    select.value = previous;
    if (select.value !== previous) select.value = "";
  }

  function chart(id, config) {
    if (!window.Chart) return;
    const canvas = $(`#${id}`);
    if (!canvas) return;
    if (state.charts[id]) state.charts[id].destroy();
    state.charts[id] = new Chart(canvas, config);
  }

  const chartDefaults = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: "#111827", borderColor: "#29364B", borderWidth: 1, titleColor: "#F8FAFC", bodyColor: "#CBD5E1", padding: 10, titleFont: { size: 10 }, bodyFont: { size: 9 } } }, scales: { x: { grid: { display: false }, ticks: { color: "#94A3B8", font: { size: 9 } }, border: { display: false } }, y: { beginAtZero: true, grid: { color: "#29364B" }, ticks: { color: "#94A3B8", font: { size: 9 } }, border: { display: false } } } };

  async function loadDashboardUsageChart() {
    try {
      state.history = await api("/api/consumption/history");
      state.historyLoaded = true;
      renderDashboardUsageChart();
    } catch (error) {
      $("#chart-empty").textContent = `Reading history unavailable: ${error.message}`;
      $("#chart-empty").classList.remove("hidden");
    }
  }

  function renderDashboardUsageChart() {
    if (!state.historyLoaded || !state.dashboard) return;
    const floor = $("#chart-floor-filter").value;
    const roomId = $("#chart-room-filter").value;
    const rangeDays = Number($("#top-date-range").value || 30);
    const cutoff = Date.now() - rangeDays * 86400000;
    const readings = state.history.filter((reading) => {
      const date = new Date(reading.recorded_at);
      return (!floor || String(reading.floor_number) === floor)
        && (!roomId || String(reading.room_id) === roomId)
        && date.getTime() >= cutoff;
    });
    const snapshots = new Map();
    readings.forEach((reading) => {
      const date = new Date(reading.recorded_at);
      if (Number.isNaN(date.getTime())) return;
      const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      let bucket;
      let label;
      if (state.chartPeriod === "monthly") {
        bucket = `${day.getFullYear()}-${day.getMonth()}`;
        label = day.toLocaleDateString([], { month: "short", year: "2-digit" });
      } else if (state.chartPeriod === "weekly") {
        const monday = new Date(day);
        monday.setDate(day.getDate() - ((day.getDay() + 6) % 7));
        bucket = monday.toISOString().slice(0, 10);
        label = `Week of ${monday.toLocaleDateString([], { month: "short", day: "numeric" })}`;
      } else {
        bucket = day.toISOString().slice(0, 10);
        label = day.toLocaleDateString([], { month: "short", day: "numeric" });
      }
      const key = `${bucket}:${reading.room_id}`;
      const previous = snapshots.get(key);
      if (!previous || new Date(previous.recorded_at) < date) {
        snapshots.set(key, { ...reading, bucket, label });
      }
    });
    const grouped = new Map();
    snapshots.forEach((reading) => {
      if (!grouped.has(reading.bucket)) grouped.set(reading.bucket, { label: reading.label, total: 0, floors: {}, simulated: false });
      const current = grouped.get(reading.bucket);
      const floorKey = String(reading.floor_number);
      current.total += reading.consumption_kwh;
      current.floors[floorKey] = (current.floors[floorKey] || 0) + reading.consumption_kwh;
      current.simulated = current.simulated || Boolean(reading.is_simulated);
    });
    const entries = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
    $("#chart-empty").classList.toggle("hidden", entries.length > 0);
    if (!entries.length) {
      if (state.charts["usage-chart"]) state.charts["usage-chart"].destroy();
      return;
    }
    const selectedRoom = roomId && state.dashboard.rooms.find((room) => String(room.id) === roomId);
    const availableFloors = floor
      ? [floor]
      : selectedRoom
        ? [String(selectedRoom.floor_number)]
        : [...new Set(state.dashboard.rooms.map((room) => String(room.floor_number)))].sort((left, right) => Number(left) - Number(right));
    const seriesColors = { "1": "#22C55E", "2": "#F59E0B", "3": "#EF4444" };
    const datasets = [{
      label: "Total consumption",
      data: entries.map(([, entry]) => Number(entry.total.toFixed(1))),
      borderColor: "#22D3EE",
      backgroundColor: "rgba(34,211,238,.08)",
      borderWidth: 2.2,
      fill: true,
      tension: .32,
      pointRadius: entries.length > 30 ? 0 : 2.5,
      pointHoverRadius: 5,
      pointBackgroundColor: "#22D3EE",
      spanGaps: false,
    }, ...availableFloors.map((floorNumber) => ({
      label: `Floor ${floorNumber}`,
      data: entries.map(([, entry]) => Object.prototype.hasOwnProperty.call(entry.floors, floorNumber) ? Number(entry.floors[floorNumber].toFixed(1)) : null),
      borderColor: seriesColors[floorNumber] || "#60A5FA",
      backgroundColor: "transparent",
      borderWidth: 1.6,
      fill: false,
      tension: .32,
      pointRadius: entries.length > 30 ? 0 : 2,
      pointHoverRadius: 4,
      pointBackgroundColor: seriesColors[floorNumber] || "#60A5FA",
      spanGaps: false,
    }))];
    chart("usage-chart", {
      type: "line",
      data: {
        labels: entries.map(([, entry]) => entry.label),
        datasets,
      },
      options: {
        ...chartDefaults,
        interaction: { intersect: false, mode: "index" },
        plugins: {
          ...chartDefaults.plugins,
          legend: { display: true, position: "bottom", labels: { color: "#94A3B8", boxWidth: 8, boxHeight: 2, usePointStyle: true, pointStyle: "line", padding: 10, font: { size: 8 } } },
          tooltip: { ...chartDefaults.plugins.tooltip, callbacks: { label: (context) => ` ${context.dataset.label}: ${kwh(context.raw)} kWh saved snapshot` } },
        },
        scales: {
          ...chartDefaults.scales,
          x: { ...chartDefaults.scales.x, ticks: { ...chartDefaults.scales.x.ticks, maxTicksLimit: 8 } },
          y: { ...chartDefaults.scales.y, title: { display: true, text: "Consumption (kWh)", color: "#94A3B8", font: { size: 9 } } },
        },
      },
    });
  }

  function rankingValue(room, mode, alertCounts) {
    if (mode === "relative") return room.percent_of_limit;
    if (mode === "average") return room.current_consumption - room.average_monthly_consumption;
    if (mode === "alerts") return alertCounts[room.id] || 0;
    return room.current_consumption;
  }

  function rankingMarkup(rooms, mode = "relative", alertCounts = {}) {
    const ranked = [...rooms].sort((left, right) => rankingValue(right, mode, alertCounts) - rankingValue(left, mode, alertCounts)).slice(0, 5);
    if (!ranked.length) return '<div class="empty-state">No room data is available.</div>';
    return ranked.map((room, index) => {
      const value = mode === "relative" ? `${room.percent_of_limit}% of limit`
        : mode === "average" ? `${room.current_consumption - room.average_monthly_consumption >= 0 ? "+" : ""}${kwh(room.current_consumption - room.average_monthly_consumption)} kWh vs avg`
          : mode === "alerts" ? `${alertCounts[room.id] || 0} critical alerts` : `${kwh(room.current_consumption)} kWh`;
      return `<button class="ranking-row" data-room-id="${room.id}"><span class="ranking-number">${String(index + 1).padStart(2, "0")}</span><span class="ranking-room"><b>Room ${escapeHtml(room.room_number)}</b><small>Floor ${room.floor_number} · ${room.status}</small></span><span class="ranking-value">${value}</span><span class="ranking-meter"><i class="${room.status.toLowerCase()}" style="width:${Math.min(Math.max(room.percent_of_limit, 4), 100)}%"></i></span></button>`;
    }).join("");
  }

  function renderInsightsPreview() {
    if (!state.dashboard) return;
    const rooms = state.dashboard.rooms;
    const rankedRooms = rooms.filter((room) => room.reading_state === "current");
    const leader = [...rankedRooms].sort((left, right) => right.current_consumption - left.current_consumption)[0];
    const relativeLeader = [...rankedRooms].sort((left, right) => right.percent_of_limit - left.percent_of_limit)[0];
    const warnings = rankedRooms.filter((room) => room.status === "Warning").length;
    const insightRows = [
      leader ? `<div class="insight-row"><span class="insight-symbol cyan">ϟ</span><span><b>Highest total reading</b><small>Room ${escapeHtml(leader.room_number)} · Floor ${leader.floor_number}</small></span><strong>${kwh(leader.current_consumption)} kWh</strong></div>` : "",
      relativeLeader ? `<div class="insight-row"><span class="insight-symbol ${relativeLeader.status.toLowerCase()}">%</span><span><b>Closest to limit</b><small>Room ${escapeHtml(relativeLeader.room_number)} · ${kwh(relativeLeader.current_consumption)} of ${kwh(relativeLeader.expected_consumption_limit)} kWh</small></span><strong>${relativeLeader.percent_of_limit}%</strong></div>` : "",
      `<div class="insight-row"><span class="insight-symbol warning">⌁</span><span><b>Approaching expected limit</b><small>${warnings} room${warnings === 1 ? "" : "s"} currently in Warning</small></span><strong>${warnings} rooms</strong></div>`,
    ];
    $("#dashboard-insights").innerHTML = insightRows.join("") || '<div class="empty-state">No insights available yet.</div>';
    $("#dashboard-ranking").innerHTML = rankingMarkup(rankedRooms, "total");
    $$("[data-room-id].ranking-row").forEach((button) => button.addEventListener("click", () => { location.hash = `room-${button.dataset.roomId}`; }));
  }

  async function renderInsights() {
    if (!state.dashboard) return;
    const rooms = state.dashboard.rooms;
    try {
      const alerts = await api("/api/alerts");
      const criticalCounts = {};
      alerts.filter((alert) => alert.alert_type === "CRITICAL").forEach((alert) => { criticalCounts[alert.room_id] = (criticalCounts[alert.room_id] || 0) + 1; });
      renderInsightRankings(criticalCounts);
      renderInsightSummary(rooms, alerts, criticalCounts);
    } catch (error) {
      toast(`Could not load insight history: ${error.message}`, true);
    }
  }

  function renderInsightRankings(alertCounts = {}) {
    const mode = $("#ranking-mode").value;
    const rooms = state.dashboard.rooms.filter((room) => room.reading_state === "current");
    $("#insight-ranking").innerHTML = rankingMarkup(rooms, mode, alertCounts);
    const sorted = [...rooms].sort((left, right) => {
      if (mode === "relative") return right.percent_of_limit - left.percent_of_limit;
      if (mode === "average") return (right.current_consumption - right.average_monthly_consumption) - (left.current_consumption - left.average_monthly_consumption);
      if (mode === "alerts") return (alertCounts[right.id] || 0) - (alertCounts[left.id] || 0);
      return right.current_consumption - left.current_consumption;
    }).slice(0, 5);
    $("#inspection-list").innerHTML = sorted.map((room) => `<div class="insight-row"><span class="insight-symbol ${room.status.toLowerCase()}">⌂</span><span><b>Room ${escapeHtml(room.room_number)} · Floor ${room.floor_number}</b><small>${room.status} · ${kwh(room.current_consumption)} kWh / ${kwh(room.expected_consumption_limit)} kWh limit</small></span><button class="text-link" data-room-id="${room.id}">Inspect →</button></div>`).join("") || '<div class="empty-state">No rooms to review.</div>';
    $$("[data-room-id].ranking-row, #inspection-list [data-room-id]").forEach((button) => button.addEventListener("click", () => { location.hash = `room-${button.dataset.roomId}`; }));
  }

  function renderInsightSummary(rooms, alerts, alertCounts) {
    const currentRooms = rooms.filter((room) => room.reading_state === "current");
    const excess = currentRooms.reduce((sum, room) => sum + room.excess_consumption, 0);
    const criticalRooms = currentRooms.filter((room) => room.status === "Critical").length;
    const repeated = Object.values(alertCounts).filter((count) => count > 1).length;
    const floorTotals = [...new Set(currentRooms.map((room) => room.floor_number))].map((floor) => ({ floor, total: currentRooms.filter((room) => room.floor_number === floor).reduce((sum, room) => sum + room.current_consumption, 0) })).sort((a, b) => b.total - a.total);
    const items = [
      ["Excess energy estimate", `${kwh(excess)} kWh`, "Current consumption above room limits"],
      ["Estimated excess cost", money(excess * state.dashboard.settings.electricity_price_per_kwh), "Not a guaranteed bill reduction"],
      ["Critical rooms", String(criticalRooms), "Currently above their configured limits"],
      ["Repeated critical alerts", String(repeated), "Rooms with multiple critical history entries"],
      ["Highest use floor", floorTotals.length ? `Floor ${floorTotals[0].floor}` : "—", floorTotals.length ? `${kwh(floorTotals[0].total)} kWh recorded` : "No floor data"],
    ];
    $("#insight-summary").innerHTML = items.map(([label, value, detail]) => `<article class="insight-stat"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><small>${escapeHtml(detail)}</small></article>`).join("");
  }

  function drawFloorChart(canvasId) {
    const rooms = (state.dashboard?.rooms || []).filter((room) => room.reading_state === "current");
    const floors = [...new Set(rooms.map((room) => room.floor_number))].sort((a, b) => a - b);
    chart(canvasId, { type: "bar", data: { labels: floors.map((floor) => `Floor ${floor}`), datasets: [{ data: floors.map((floor) => rooms.filter((room) => room.floor_number === floor).reduce((sum, room) => sum + room.current_consumption, 0)), backgroundColor: "#22D3EE", borderRadius: 4, maxBarThickness: 38 }] }, options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, tooltip: { ...chartDefaults.plugins.tooltip, callbacks: { label: (context) => ` ${kwh(context.raw)} kWh` } } }, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, title: { display: true, text: "kWh", color: "#94A3B8", font: { size: 9 } } } } } });
  }

  async function renderAnalytics() {
    if (!state.dashboard) return;
    renderSavingsProjection();
    drawFloorChart("analytics-floor-chart");
    const rooms = state.dashboard.rooms;
    chart("room-chart", { type: "bar", data: { labels: rooms.map((room) => room.room_number), datasets: [{ label: "Actual", data: rooms.map((room) => room.reading_state === "current" ? room.current_consumption : null), backgroundColor: rooms.map((room) => colors[room.status]), borderRadius: 3 }, { label: "Expected", data: rooms.map((room) => room.reading_state === "current" ? room.expected_consumption_limit : null), backgroundColor: "#35445b", borderRadius: 3 }] }, options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: true, position: "bottom", labels: { boxWidth: 8, font: { size: 9 } } } }, scales: { ...chartDefaults.scales, x: { ...chartDefaults.scales.x, ticks: { ...chartDefaults.scales.x.ticks, maxRotation: 45, minRotation: 45 } } } } });
    try {
      const [history, alerts] = await Promise.all([api("/api/consumption/history"), api("/api/alerts")]);
      const monthlySnapshots = new Map();
      history.forEach((reading) => {
        const date = new Date(reading.recorded_at);
        if (Number.isNaN(date.getTime())) return;
        const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
        const roomKey = `${monthKey}:${reading.room_id}`;
        const prior = monthlySnapshots.get(roomKey);
        if (!prior || new Date(prior.recorded_at) < date) {
          monthlySnapshots.set(roomKey, { ...reading, monthKey, label: date.toLocaleDateString([], { month: "short", year: "2-digit" }) });
        }
      });
      const months = new Map();
      monthlySnapshots.forEach((reading) => {
        if (!months.has(reading.monthKey)) months.set(reading.monthKey, { label: reading.label, floors: {} });
        const month = months.get(reading.monthKey);
        month.floors[reading.floor_number] = (month.floors[reading.floor_number] || 0) + reading.consumption_kwh;
      });
      const orderedMonths = [...months.entries()].sort(([left], [right]) => left.localeCompare(right));
      const labels = orderedMonths.map(([, item]) => item.label);
      const floors = [...new Set(history.map((reading) => reading.floor_number))].sort((a, b) => a - b);
      const lineColors = ["#60A5FA", "#22D3EE", "#A5B4FC"];
      chart("history-chart", { type: "line", data: { labels, datasets: floors.map((floor, index) => ({ label: `Floor ${floor}`, data: orderedMonths.map(([, item]) => item.floors[floor] || 0), borderColor: lineColors[index % lineColors.length], backgroundColor: `${lineColors[index % lineColors.length]}22`, tension: .35, pointRadius: 2, fill: false })) }, options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: true, position: "bottom", labels: { color: "#94A3B8", boxWidth: 8, font: { size: 9 } } } } } });
      const dailySnapshots = new Map();
      history.forEach((reading) => {
        const date = new Date(reading.recorded_at);
        if (Number.isNaN(date.getTime())) return;
        const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        const key = `${dayKey}:${reading.room_id}`;
        const prior = dailySnapshots.get(key);
        if (!prior || new Date(prior.recorded_at) < date) {
          dailySnapshots.set(key, { ...reading, dayKey, label: date.toLocaleDateString([], { day: "numeric", month: "short" }) });
        }
      });
      const byDay = new Map();
      dailySnapshots.forEach((reading) => {
        if (!byDay.has(reading.dayKey)) byDay.set(reading.dayKey, { label: reading.label, value: 0 });
        byDay.get(reading.dayKey).value += reading.consumption_kwh;
      });
      const daily = [...byDay.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(-30);
      chart("daily-chart", { type: "line", data: { labels: daily.map(([, item]) => item.label), datasets: [{ label: "Saved reading snapshot", data: daily.map(([, item]) => item.value), borderColor: "#22D3EE", backgroundColor: "rgba(34,211,238,.1)", tension: .3, fill: true, pointRadius: 2 }] }, options: chartDefaults });
      const alertBuckets = new Map();
      alerts.filter((alert) => alert.alert_type === "WARNING" || alert.alert_type === "CRITICAL").forEach((alert) => {
        const date = new Date(alert.created_at);
        if (Number.isNaN(date.getTime())) return;
        const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        if (!alertBuckets.has(key)) alertBuckets.set(key, { label: date.toLocaleDateString([], { day: "numeric", month: "short" }), warning: 0, critical: 0 });
        alertBuckets.get(key)[alert.alert_type.toLowerCase()] += 1;
      });
      const alertDays = [...alertBuckets.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(-30);
      chart("alert-frequency-chart", { type: "bar", data: { labels: alertDays.map(([, item]) => item.label), datasets: [{ label: "Warning", data: alertDays.map(([, item]) => item.warning), backgroundColor: "#F59E0B", borderRadius: 3 }, { label: "Critical", data: alertDays.map(([, item]) => item.critical), backgroundColor: "#EF4444", borderRadius: 3 }] }, options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: true, position: "bottom", labels: { color: "#94A3B8", boxWidth: 8, font: { size: 9 } } } } } });
      const floorTotals = floors.map((floor) => rooms.filter((room) => room.floor_number === floor).reduce((sum, room) => sum + room.estimated_cost, 0));
      chart("floor-cost-chart", { type: "bar", data: { labels: floors.map((floor) => `Floor ${floor}`), datasets: [{ label: "Estimated cost", data: floorTotals, backgroundColor: ["#60A5FA", "#22D3EE", "#A5B4FC"], borderRadius: 4, maxBarThickness: 36 }] }, options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, tooltip: { ...chartDefaults.plugins.tooltip, callbacks: { label: (context) => ` ${money(context.raw)} estimated` } } }, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, ticks: { ...chartDefaults.scales.y.ticks, callback: (value) => money(value) } } } } });
    } catch (error) {
      toast(`Could not load chart history: ${error.message}`, true);
    }
  }

  function checkForNewAlerts(alerts) {
    if (!state.dashboard) return;
    const currentIds = new Set(alerts.map((alert) => String(alert.id)));
    if (state.alertsInitialized) {
      const freshCritical = alerts.filter((alert) => alert.alert_type === "CRITICAL" && !state.knownAlertIds.has(String(alert.id)));
      if (freshCritical.length && state.audioEnabled && !state.muted) {
        window.NexusSound.alarm().then(() => setSoundPlaying(true)).catch((error) => toast(`Critical alert created. Enable browser sound to hear the alarm: ${error.message}`, true));
      }
    }
    state.knownAlertIds = currentIds;
    state.alertsInitialized = true;
  }

  function configurePolling() {
    clearInterval(state.timer);
    const seconds = Math.max(5, Math.min(300, state.dashboard?.settings.refresh_interval_seconds || 15));
    state.timer = setInterval(refreshDashboard, seconds * 1000);
  }

  async function refreshDashboard() {
    try {
      const data = await api("/api/dashboard");
      checkForNewAlerts(data.alerts);
      state.dashboard = data;
      renderSummary(data);
      populateFloorFilters();
      renderFloors();
      if ($("#page-analytics").classList.contains("active")) renderAnalytics();
      if ($("#page-alerts").classList.contains("active")) loadAlerts();
      if ($("#page-history").classList.contains("active")) loadHistory();
      if ($("#page-insights").classList.contains("active")) renderInsights();
      loadDashboardUsageChart();
    } catch (error) {
      $("#live-pill").classList.add("offline");
      $("#live-label").textContent = "OFFLINE";
      $("#sidebar-connection-label").textContent = "CONNECTION LOST";
      $("#sidebar-connection-detail").textContent = "Retrying local API";
      $("#sidebar-connection-dot").classList.remove("online");
      toast(`Dashboard refresh failed: ${error.message}`, true);
    }
  }

  async function loadAlerts() {
    const params = new URLSearchParams();
    const values = { severity: $("#alert-severity-filter").value, floor: $("#alert-floor-filter").value, room_id: $("#alert-room-filter").value, start: $("#alert-start").value, end: $("#alert-end").value };
    Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
    try {
      const alerts = await api(`/api/alerts?${params}`);
      const search = $("#alert-search").value.trim().toLowerCase();
      const filtered = alerts.filter((alert) => !search || `${alert.room_number} ${alert.floor_number} ${alert.message} ${alert.reason || ""}`.toLowerCase().includes(search));
        $("#alerts-table").innerHTML = filtered.map((alert) => {
        const excess = Math.max(alert.consumption - alert.expected_limit, 0);
          const status = alert.resolved ? "Resolved" : alert.acknowledged ? "Acknowledged" : "Active";
          const statusStyle = alert.resolved ? "resolved" : alert.acknowledged ? "acknowledged" : "active";
          const actions = alert.resolved ? "—" : `<div class="alert-row-actions">${alert.acknowledged ? "" : `<button class="table-action" data-ack="${alert.id}">Acknowledge</button>`}${alert.alert_type === "WARNING" || alert.alert_type === "CRITICAL" ? `<button class="table-action resolve-action" data-resolve="${alert.id}">Resolve</button>` : ""}</div>`;
          return `<tr><td><span class="severity-pill ${alert.alert_type.toLowerCase()}">${escapeHtml(alert.alert_type)}</span>${alert.is_simulated ? '<span class="simulated-table-tag">SIMULATED</span>' : ""}</td><td class="location-cell"><button class="table-room-link" data-room-id="${alert.room_id}"><b>Room ${escapeHtml(alert.room_number)}</b></button><span>Floor ${alert.floor_number}</span></td><td>${kwh(alert.consumption)} kWh</td><td>${kwh(alert.expected_limit)} kWh</td><td class="${excess > 0 ? "text-red" : ""}">${kwh(excess)} kWh</td><td>${escapeHtml(dateTime(alert.created_at))}</td><td><span class="status-pill ${statusStyle}">${status}</span></td><td>${escapeHtml(alert.reason || alert.message)}</td><td>${actions}</td></tr>`;
        }).join("") || '<tr><td colspan="9" class="empty-cell">No alerts match these filters.</td></tr>';
      $$("#alerts-table [data-ack]").forEach((button) => button.addEventListener("click", () => acknowledgeAlert(button.dataset.ack)));
      $$("#alerts-table [data-resolve]").forEach((button) => button.addEventListener("click", () => resolveAlert(button.dataset.resolve)));
      $$("#alerts-table .table-room-link").forEach((button) => button.addEventListener("click", () => { location.hash = `room-${button.dataset.roomId}`; }));
    } catch (error) {
      $("#alerts-table").innerHTML = `<tr><td colspan="9" class="empty-cell">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function loadHistory() {
      const params = new URLSearchParams();
      const values = { floor: $("#history-floor-filter").value, room_id: $("#history-room-filter").value, start: $("#history-start").value, end: $("#history-end").value };
      Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
      try {
        const history = await api(`/api/consumption/history?${params}`);
        const search = $("#history-search").value.trim().toLowerCase();
        const filtered = history.filter((item) => !search || `${item.room_number} ${item.floor_number} ${item.notes}`.toLowerCase().includes(search));
        $("#history-table").innerHTML = filtered.slice().reverse().map((item) => `<tr><td><button class="table-room-link" data-room-id="${item.room_id}"><b>Room ${escapeHtml(item.room_number)}</b></button></td><td>Floor ${item.floor_number}</td><td>${kwh(item.consumption_kwh)} kWh</td><td>${escapeHtml(dateTime(item.recorded_at))}</td><td>${item.is_simulated ? '<span class="simulated-table-tag">SIMULATED</span> ' : ""}${escapeHtml(item.notes || (item.is_simulated ? "Demo event" : "Manual reading"))}</td></tr>`).join("") || '<tr><td colspan="5" class="empty-cell">No saved readings match these filters.</td></tr>';
        $$("#history-table .table-room-link").forEach((button) => button.addEventListener("click", () => { location.hash = `room-${button.dataset.roomId}`; }));
      } catch (error) {
        $("#history-table").innerHTML = `<tr><td colspan="5" class="empty-cell">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function acknowledgeAlert(id) {
    try {
      await api(`/api/alerts/${id}/acknowledge`, { method: "POST", body: "{}" });
      toast("Alert acknowledged.");
      await refreshDashboard();
      await loadAlerts();
    } catch (error) { toast(error.message, true); }
  }

  async function resolveAlert(id) {
    try {
      await api(`/api/alerts/${id}/resolve`, { method: "POST", body: "{}" });
      toast("Alert resolved. The event remains in history.");
      await refreshDashboard();
      await loadAlerts();
    } catch (error) { toast(error.message, true); }
  }

  async function loadRoom(id) {
    state.selectedRoomId = id;
    goTo("room");
    $("#room-detail-content").innerHTML = '<div class="panel empty-state">Loading room details...</div>';
    try {
      const room = await api(`/api/rooms/${id}`);
      const recommendations = room.status === "Critical"
        ? ["Inspect electrical equipment for unusual power draw.", "Check air conditioning and appliances left running after hours.", "Compare this reading with previous months; investigate unexpected increases."]
        : room.status === "Warning"
          ? ["Switch off lights and fans when not required.", "Review air conditioning schedules and equipment use.", "Check whether the recent rise is expected for this room."]
          : ["Continue monitoring usage against the expected monthly limit.", "Switch off unused equipment to maintain efficient consumption."];
      const detailStatus = statusClass(room.status);
      const hasRecentReading = room.reading_state === "current";
      $("#room-detail-content").innerHTML = `<div class="room-detail-head"><div><div class="eyebrow">FLOOR ${room.floor_number} · ROOM DETAILS</div><div class="room-title-line"><h1>Room ${escapeHtml(room.room_number)}</h1><span class="room-status-chip ${detailStatus}">${room.status}</span></div><p>Last reading ${escapeHtml(dateTime(room.last_reading_at))}${room.current_is_simulated ? " · simulated" : ""}</p></div><button class="button button-primary" id="edit-room">Edit room details</button></div>
        <div class="room-metric-grid"><div class="room-metric"><span>Actual consumption</span><b>${hasRecentReading ? `${kwh(room.current_consumption)} kWh` : "No recent reading"}</b><div class="room-progress ${detailStatus}"><span style="width:${hasRecentReading ? Math.min(room.percent_of_limit, 100) : 0}%"></span></div><span>${hasRecentReading ? `${room.percent_of_limit}% of expected limit` : "Status is unknown until a current reading is saved"}</span></div><div class="room-metric"><span>Historical monthly average</span><b>${kwh(room.average_monthly_consumption)} kWh</b><span>${room.baseline_readings} saved non-simulated readings</span></div><div class="room-metric"><span>Expected monthly limit</span><b>${kwh(room.expected_consumption_limit)} kWh</b><span>${hasRecentReading ? (room.remaining_allowance ? `${kwh(room.remaining_allowance)} kWh remaining` : `${kwh(room.excess_consumption)} kWh above limit`) : "Comparison unavailable"}</span></div><div class="room-metric"><span>Estimated electricity cost</span><b>${hasRecentReading ? money(room.estimated_cost) : "—"}</b><span>Estimated at configured rate</span></div></div>
        <div class="room-info-grid"><article class="panel"><div class="panel-heading"><div><div class="eyebrow">READING HISTORY</div><h2>Saved readings</h2></div></div><div class="chart-wrap tall"><canvas id="room-history-chart"></canvas></div><form id="reading-form" class="room-reading-form"><input type="hidden" name="room_id" value="${room.id}"><label>Consumption (kWh)<input name="consumption_kwh" type="number" min="0" step="0.1" required placeholder="e.g. 125"></label><label>Reading date & time<input name="recorded_at" type="datetime-local" required></label><label>Notes (optional)<input name="notes" maxlength="500" placeholder="Inspection or context"></label><button class="button button-primary">Save reading</button></form></article><article class="panel"><div class="panel-heading"><div><div class="eyebrow">SUGGESTED ACTIONS</div><h2>Room recommendations</h2></div></div><p style="color:#8794a3;font-size:9px;line-height:1.6">A high reading can have many explanations; these suggestions help guide an inspection.</p>${recommendations.map((item) => `<div class="recommendation ${room.status === "Critical" ? "critical-rec" : ""}">${escapeHtml(item)}</div>`).join("")}<div class="panel-heading" style="margin-top:20px"><div><div class="eyebrow">RECENT EVENTS</div><h2>Room alert history</h2></div></div>${room.recent_alerts.map((alert) => `<div class="compact-alert"><i class="alert-marker"></i><div class="compact-alert-content"><strong>${escapeHtml(alert.alert_type)} ${alert.is_simulated ? "· SIMULATED" : ""} · ${kwh(alert.consumption)} kWh</strong><span>${escapeHtml(dateTime(alert.created_at))} · ${alert.resolved ? "Resolved" : alert.acknowledged ? "Acknowledged" : "Active"}</span><span>${escapeHtml(alert.reason || alert.message)}</span></div></div>`).join("") || '<div class="empty-state">No alerts recorded for this room.</div>'}</article></div>`;
      const datetimeInput = $("#reading-form").elements.recorded_at;
      datetimeInput.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      if (window.Chart) chart("room-history-chart", { type: "line", data: { labels: room.history.map((record) => new Date(record.recorded_at).toLocaleDateString([], { month: "short", day: "numeric" })), datasets: [{ data: room.history.map((record) => record.consumption_kwh), borderColor: "#3978e8", backgroundColor: "#3978e818", tension: .32, fill: true, pointRadius: 3 }, { data: room.history.map(() => room.expected_consumption_limit), borderColor: "#df9c3c", borderDash: [4, 4], pointRadius: 0 }] }, options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: false } } } });
      $("#reading-form").addEventListener("submit", submitReading);
      $("#edit-room").addEventListener("click", () => openRoomModal(room));
    } catch (error) {
      $("#room-detail-content").innerHTML = `<div class="panel empty-state">${escapeHtml(error.message)}</div>`;
    }
  }

  async function submitReading(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
    const result = await api("/api/consumption", { method: "POST", body: JSON.stringify({ room_id: Number(form.get("room_id")), consumption_kwh: Number(form.get("consumption_kwh")), recorded_at: form.get("recorded_at"), notes: form.get("notes") }) });
    toast(result.historical_only ? "Historical reading saved without changing the current room status." : result.new_alert_id ? "Reading saved. A new alert event was created." : "Consumption reading saved.");
      await refreshDashboard();
      await loadRoom(result.id);
    } catch (error) { toast(error.message, true); }
  }

  function openRoomModal(room = null) {
    const form = $("#room-form");
    form.reset();
    form.elements.id.value = room?.id || "";
    $("#modal-title").textContent = room ? `Edit Room ${room.room_number}` : "Add a room";
    $("#room-form-message").textContent = "";
    if (room) {
      ["room_number", "floor_number", "average_monthly_consumption", "expected_consumption_limit", "current_consumption"].forEach((field) => form.elements[field].value = room[field]);
    }
    $("#modal-backdrop").classList.remove("hidden");
    form.elements.room_number.focus();
  }

  async function saveRoom(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = form.get("id");
    const data = Object.fromEntries(["room_number", "floor_number", "average_monthly_consumption", "expected_consumption_limit", "current_consumption"].map((field) => [field, field === "room_number" ? form.get(field).trim() : Number(form.get(field))]));
    try {
      await api(id ? `/api/rooms/${id}` : "/api/rooms", { method: id ? "PUT" : "POST", body: JSON.stringify(data) });
      $("#modal-backdrop").classList.add("hidden");
      toast(id ? "Room details updated." : "Room added.");
      await refreshDashboard();
      if (id && location.hash === `#room-${id}`) await loadRoom(Number(id));
    } catch (error) { $("#room-form-message").textContent = error.message; $("#room-form-message").style.color = "#be3c42"; }
  }

  async function loadSettings() {
    try {
      const settings = await api("/api/settings");
      const form = $("#settings-form");
      Object.entries(settings).forEach(([key, value]) => {
        if (!form.elements[key]) return;
        if (form.elements[key].type === "checkbox") form.elements[key].checked = Boolean(value);
        else form.elements[key].value = value;
      });
      state.audioEnabled = Boolean(settings.sound_enabled);
      updateSoundControls();
    } catch (error) { toast(`Could not load settings: ${error.message}`, true); }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const settings = Object.fromEntries([...form.entries()].filter(([key]) => key !== "sound_enabled").map(([key, value]) => [key, Number(value)]));
    settings.sound_enabled = form.elements.sound_enabled.checked;
    const message = $("#settings-message");
    message.style.color = "#298162";
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      message.textContent = "Settings saved.";
      toast("Settings saved. Expected limits have been recalculated.");
      await refreshDashboard();
      updateSoundControls();
      configurePolling();
      if (location.hash.startsWith("#room-")) await loadRoom(Number(location.hash.slice(6)));
    } catch (error) { message.textContent = error.message; message.style.color = "#be3c42"; }
  }

  async function saveDashboardTariff(event) {
    event.preventDefault();
    const input = $("#dashboard-tariff");
    if (!input.reportValidity()) return;
    const message = $("#dashboard-tariff-message");
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ electricity_price_per_kwh: Number(input.value) }) });
      message.textContent = "Saved";
      toast("Electricity tariff updated.");
      await refreshDashboard();
      window.setTimeout(() => { message.textContent = ""; }, 2500);
    } catch (error) {
      message.textContent = error.message;
      toast(`Could not save tariff: ${error.message}`, true);
    }
  }

  function updateHeaderClock() {
    const now = new Date();
    $("#today-label").textContent = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    $("#header-time").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function setSoundPlaying(playing) {
    $("#stop-sound").disabled = !playing;
    $("#stop-sound").classList.toggle("hidden", !playing);
    $("#stop-sound").classList.toggle("is-playing", playing);
  }

  function updateSoundControls() {
    const button = $("#sound-enable");
    button.setAttribute("aria-pressed", String(state.audioEnabled));
    button.classList.toggle("is-enabled", state.audioEnabled);
    button.innerHTML = `${state.audioEnabled ? "◉" : "◖"} <span>SOUND ${state.audioEnabled ? "ON" : "OFF"}</span>`;
    const mute = $("#mute-button");
    mute.setAttribute("aria-pressed", String(state.muted));
    mute.setAttribute("aria-label", state.muted ? "Unmute alert sounds" : "Mute alert sounds");
    mute.textContent = state.muted ? "ALERTS MUTED" : "ALERTS ON";
    mute.title = state.muted ? "Unmute alert sounds" : "Mute alert sounds";
  }

  async function toggleSound() {
    if (state.audioEnabled && !window.NexusSound.isReady()) {
      try {
        await window.NexusSound.enable();
        toast("Browser sound is ready. Use Test Sound to check your speakers.");
      } catch (error) { toast(error.message, true); }
      return;
    }
    const next = !state.audioEnabled;
    if (next) {
      try {
        await window.NexusSound.enable();
        state.audioEnabled = true;
        await api("/api/settings", { method: "PUT", body: JSON.stringify({ sound_enabled: true }) });
        toast("Sound alerts enabled. Test sound to confirm your browser audio.");
      } catch (error) {
        state.audioEnabled = false;
        window.NexusSound.stop();
        toast(error.message, true);
      }
    } else {
      state.audioEnabled = false;
      window.NexusSound.stop();
      setSoundPlaying(false);
      try {
        await api("/api/settings", { method: "PUT", body: JSON.stringify({ sound_enabled: false }) });
        toast("Sound alerts disabled. Critical alerts will still appear on screen.");
      } catch (error) { toast(`Sound turned off locally, but could not save the setting: ${error.message}`, true); }
    }
    updateSoundControls();
  }

  async function testSound() {
    try {
      await window.NexusSound.test();
      setSoundPlaying(true);
      toast("Test sound is playing. Select Stop Sound to stop it early.");
      window.setTimeout(() => setSoundPlaying(false), 1100);
    } catch (error) {
      toast(`Sound could not play: ${error.message}`, true);
    }
  }

  function stopSound() {
    window.NexusSound.stop();
    setSoundPlaying(false);
    toast("Sound stopped.");
  }

  function toggleMute() {
    state.muted = !state.muted;
    localStorage.setItem("nexus-alerts-muted", String(state.muted));
    if (state.muted) {
      window.NexusSound.stop();
      setSoundPlaying(false);
    }
    updateSoundControls();
    toast(state.muted ? "Alert sounds muted. Visual alerts remain active." : "Alert sounds unmuted.");
  }

  async function simulateAlert() {
    await simulateScenario("spike");
  }

  async function simulateScenario(scenario) {
    const buttons = [...$$("[data-scenario]"), $("#simulate-alert")];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const result = await api("/api/demo/simulate", { method: "POST", body: JSON.stringify({ scenario }) });
      toast(`Simulated ${scenario.replace("_", " ")} event for Floor ${result.room.floor_number}, Room ${result.room.room_number}.`);
      await refreshDashboard();
    } catch (error) { toast(error.message, true); }
    finally { buttons.forEach((button) => { button.disabled = false; }); }
  }

  async function stopSimulation() {
    try {
      const result = await api("/api/demo/simulation/stop", { method: "POST", body: "{}" });
      toast(`Simulation stopped. Room ${result.room.room_number} is restored; its simulated alert remains in history.`);
      await refreshDashboard();
    } catch (error) { toast(error.message, true); }
  }

  function bindEvents() {
    window.addEventListener("hashchange", navigate);
    $("#mobile-menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    $("#sidebar-toggle").addEventListener("click", () => {
      document.body.classList.toggle("sidebar-collapsed");
      localStorage.setItem("nexus-sidebar-collapsed", String(document.body.classList.contains("sidebar-collapsed")));
    });
    $("#notifications-button").addEventListener("click", () => { location.hash = "alerts"; });
    $("#sound-enable").addEventListener("click", toggleSound);
    $("#test-sound").addEventListener("click", testSound);
    $("#stop-sound").addEventListener("click", stopSound);
    $("#mute-button").addEventListener("click", toggleMute);
    $$("[data-dashboard-target]").forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = document.getElementById(link.dataset.dashboardTarget);
      if (!target) {
        toast("That dashboard section is unavailable.", true);
        return;
      }
      if (location.hash !== "#dashboard") location.hash = "dashboard";
      goTo("dashboard");
      $$(".nav-link").forEach((item) => item.classList.toggle("active", item === link));
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      $("#sidebar").classList.remove("open");
    }));
    $("#simulate-alert").addEventListener("click", simulateAlert);
    $$("[data-scenario]").forEach((button) => button.addEventListener("click", () => simulateScenario(button.dataset.scenario)));
    $("#stop-simulation").addEventListener("click", stopSimulation);
    $("#rail-stop-simulation").addEventListener("click", stopSimulation);
    $("#savings-reduction").addEventListener("change", renderSavingsProjection);
    $("#dashboard-reduction").addEventListener("change", () => renderDashboardCostProjection(state.dashboard));
    $("#dashboard-tariff-form").addEventListener("submit", saveDashboardTariff);
    ["history-start", "history-end"].forEach((id) => $(`#${id}`).addEventListener("change", updateReportLinks));
    $("#room-search").addEventListener("input", renderFloors);
    $("#floor-filter").addEventListener("change", renderFloors);
    $("#building-search").addEventListener("input", renderFloors);
    $("#building-floor-filter").addEventListener("change", renderFloors);
    $("#building-status-filter").addEventListener("change", renderFloors);
    $$(".building-floor-button").forEach((button) => button.addEventListener("click", () => {
      state.buildingFloor = button.dataset.buildingFloor;
      renderBuildingModel(state.dashboard?.rooms || []);
    }));
    $("#chart-floor-filter").addEventListener("change", () => { populateRoomSelect($("#chart-room-filter"), ""); renderDashboardUsageChart(); });
    $("#chart-room-filter").addEventListener("change", renderDashboardUsageChart);
    $("#top-date-range").addEventListener("change", renderDashboardUsageChart);
    $$(".period-button").forEach((button) => button.addEventListener("click", () => {
      state.chartPeriod = button.dataset.period;
      $$(".period-button").forEach((item) => item.classList.toggle("active", item === button));
      renderDashboardUsageChart();
    }));
    $("#ranking-mode").addEventListener("change", renderInsights);
    ["alert-severity-filter", "alert-floor-filter", "alert-room-filter", "alert-start", "alert-end"].forEach((id) => $(`#${id}`).addEventListener("change", loadAlerts));
    $("#alert-search").addEventListener("input", loadAlerts);
    ["history-floor-filter", "history-room-filter", "history-start", "history-end"].forEach((id) => $(`#${id}`).addEventListener("change", loadHistory));
    $("#history-search").addEventListener("input", loadHistory);
    $("#add-room-open").addEventListener("click", () => openRoomModal());
    $("#add-room-open-building").addEventListener("click", () => openRoomModal());
    $("#rail-add-room-open").addEventListener("click", () => openRoomModal());
    $("#modal-close").addEventListener("click", () => $("#modal-backdrop").classList.add("hidden"));
    $("#modal-backdrop").addEventListener("click", (event) => { if (event.target === $("#modal-backdrop")) $("#modal-backdrop").classList.add("hidden"); });
    $("#room-form").addEventListener("submit", saveRoom);
    $("#settings-form").addEventListener("submit", saveSettings);
    $("#room-back").addEventListener("click", () => { location.hash = "building"; });
    $("#banner-alerts").addEventListener("click", () => { location.hash = "alerts"; });
    $("#reset-demo").addEventListener("click", async () => {
      if (!window.confirm("Restore the saved baseline room readings and default settings? Existing readings and alert history will be retained.")) return;
      try {
        await api("/api/demo/reset", { method: "POST", body: "{}" });
        toast("Demo data restored.");
        await loadSettings();
        await refreshDashboard();
        configurePolling();
        updateReportLinks();
        location.hash = "dashboard";
      } catch (error) { toast(error.message, true); }
    });
  }

  async function start() {
    updateHeaderClock();
    window.setInterval(updateHeaderClock, 30000);
    if (localStorage.getItem("nexus-sidebar-collapsed") === "true") document.body.classList.add("sidebar-collapsed");
    $("#live-pill").classList.add("checking");
    updateSoundControls();
    bindEvents();
    updateReportLinks();
    await refreshDashboard();
    await loadSettings();
    navigate();
    configurePolling();
  }

  start();
})();
