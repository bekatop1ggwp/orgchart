(function startOrgChart() {
  "use strict";

  const STORAGE_KEY = "org-chart-data-v2";
  const LEGACY_STORAGE_KEY = "org-chart-employees-v1";
  const SQLITE_MIGRATION_KEY = "org-chart-sqlite-migrated-v1";
  const STORAGE_LABEL = location.hostname.endsWith("netlify.app")
    ? "Netlify Blobs"
    : "SQLite";
  const ROLE_LABELS = {
    founder: "Учредитель",
    director: "Директор",
    manager: "Руководитель",
    employee: "Сотрудник"
  };
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 1.8;

  const elements = {
    chart: document.getElementById("chart"),
    chartStage: document.getElementById("chartStage"),
    chartWrap: document.getElementById("chartWrap"),
    zoomValue: document.getElementById("zoomValue"),
    chartSummary: document.getElementById("chartSummary"),
    warnings: document.getElementById("dataWarnings"),
    peopleTable: document.getElementById("peopleTable"),
    departmentsTable: document.getElementById("departmentsTable"),
    peopleCount: document.getElementById("peopleCount"),
    departmentsCount: document.getElementById("departmentsCount"),
    saveStatus: document.getElementById("saveStatus"),
    csvInput: document.getElementById("csvInput")
  };

  let state = { version: 2, people: [], departments: [] };
  let zoom = 1;
  let autoFit = true;
  let fitFrame = 0;
  let saveQueue = Promise.resolve();

  function text(value) {
    return String(value ?? "").trim();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeState(value) {
    const source = value && typeof value === "object" ? value : {};
    const people = Array.isArray(source.people) ? source.people : [];
    const departments = Array.isArray(source.departments) ? source.departments : [];

    return {
      version: 2,
      people: people.map(person => ({
        id: text(person.id),
        name: text(person.name),
        position: text(person.position),
        role: ROLE_LABELS[person.role] ? person.role : "employee",
        departmentId: text(person.departmentId),
        managerId: text(person.managerId)
      })),
      departments: departments.map(department => ({
        id: text(department.id),
        name: text(department.name),
        parentDepartmentId: text(department.parentDepartmentId),
        reportsToId: text(department.reportsToId),
        headId: text(department.headId)
      }))
    };
  }

  function migrateLegacy(records) {
    const list = Array.isArray(records) ? records : [];
    const departmentIds = new Set(list.filter(item => item.type === "department").map(item => text(item.id)));
    const peopleIds = new Set(list.filter(item => item.type !== "department").map(item => text(item.id)));

    const departments = list
      .filter(item => item.type === "department")
      .map(item => ({
        id: text(item.id),
        name: text(item.name),
        parentDepartmentId: departmentIds.has(text(item.parentId)) ? text(item.parentId) : "",
        reportsToId: peopleIds.has(text(item.parentId)) ? text(item.parentId) : "",
        headId: text(item.leaderId)
      }));

    const people = list
      .filter(item => item.type !== "department")
      .map(item => {
        const parentId = text(item.parentId);
        return {
          id: text(item.id),
          name: text(item.name),
          position: text(item.position),
          role: ROLE_LABELS[item.type] ? item.type : "employee",
          departmentId: text(item.departmentId) || (departmentIds.has(parentId) ? parentId : ""),
          managerId: peopleIds.has(parentId) ? parentId : ""
        };
      });

    const peopleById = new Map(people.map(person => [person.id, person]));
    for (let pass = 0; pass < people.length; pass += 1) {
      let changed = false;
      people.forEach(person => {
        const manager = peopleById.get(person.managerId);
        if (!person.departmentId && manager?.departmentId) {
          person.departmentId = manager.departmentId;
          changed = true;
        }
      });
      if (!changed) break;
    }

    departments.forEach(department => {
      if (department.headId) return;
      const members = people.filter(person => person.departmentId === department.id);
      const memberIds = new Set(members.map(person => person.id));
      const roots = members.filter(person => !person.managerId || !memberIds.has(person.managerId));
      if (roots.length === 1) department.headId = roots[0].id;
    });

    return normalizeState({ version: 2, people, departments });
  }

  function readLegacyBrowserState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return normalizeState(JSON.parse(saved));

      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        return migrateLegacy(JSON.parse(legacy));
      }
    } catch (error) {
      console.warn("Не удалось прочитать сохранённую структуру", error);
    }
    return null;
  }

  function saveState() {
    const snapshot = clone(state);
    setSaveStatus("Сохранение…", "saving");
    saveQueue = saveQueue
      .catch(() => undefined)
      .then(() => window.OrgChartApi.replaceStructure(snapshot))
      .then(result => {
        setSaveStatus(`${STORAGE_LABEL} · ревизия ${result.revision}`);
        return result;
      })
      .catch(error => {
        setSaveStatus("Не сохранено", "error");
        alert(error.message);
        return null;
      });
    return saveQueue;
  }

  function setSaveStatus(message, className = "") {
    elements.saveStatus.textContent = message;
    elements.saveStatus.className = `save-status ${className}`.trim();
  }

  function allIds(exceptEntity = "", exceptId = "") {
    return new Set([
      ...state.people.filter(item => !(exceptEntity === "person" && item.id === exceptId)).map(item => item.id),
      ...state.departments.filter(item => !(exceptEntity === "department" && item.id === exceptId)).map(item => item.id)
    ]);
  }

  function nextId() {
    const numericIds = [...allIds()].map(value => Number(value)).filter(Number.isFinite);
    return String((numericIds.length ? Math.max(...numericIds) : 0) + 1);
  }

  function option(value, label, selectedValue) {
    return `<option value="${escapeHtml(value)}" ${value === selectedValue ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }

  function departmentOptions(selectedValue, excludedId = "") {
    return [option("", "— без отдела —", selectedValue)]
      .concat(state.departments
        .filter(department => department.id !== excludedId)
        .map(department => option(department.id, department.name || `Отдел ${department.id}`, selectedValue)))
      .join("");
  }

  function personDescendantIds(personId) {
    const descendants = new Set();
    const queue = [personId];
    while (queue.length) {
      const parentId = queue.shift();
      state.people.forEach(person => {
        if (person.managerId === parentId && !descendants.has(person.id)) {
          descendants.add(person.id);
          queue.push(person.id);
        }
      });
    }
    return descendants;
  }

  function departmentDescendantIds(departmentId) {
    const descendants = new Set();
    const queue = [departmentId];
    while (queue.length) {
      const parentId = queue.shift();
      state.departments.forEach(department => {
        if (department.parentDepartmentId === parentId && !descendants.has(department.id)) {
          descendants.add(department.id);
          queue.push(department.id);
        }
      });
    }
    return descendants;
  }

  function personOptions(selectedValue, excludedId = "", emptyLabel = "— не выбран —") {
    return [option("", emptyLabel, selectedValue)]
      .concat(state.people
        .filter(person => person.id !== excludedId)
        .map(person => option(person.id, `${person.name || `Сотрудник ${person.id}`} — ${person.position || ROLE_LABELS[person.role]}`, selectedValue)))
      .join("");
  }

  function managerOptions(person) {
    const excluded = personDescendantIds(person.id);
    excluded.add(person.id);
    return [option("", "— верхний уровень —", person.managerId)]
      .concat(state.people
        .filter(candidate => !excluded.has(candidate.id))
        .map(candidate => option(candidate.id, `${candidate.name || `Сотрудник ${candidate.id}`} — ${candidate.position || ROLE_LABELS[candidate.role]}`, person.managerId)))
      .join("");
  }

  function parentDepartmentOptions(department) {
    const excluded = departmentDescendantIds(department.id);
    excluded.add(department.id);
    return [option("", "— верхний уровень —", department.parentDepartmentId)]
      .concat(state.departments
        .filter(candidate => !excluded.has(candidate.id))
        .map(candidate => option(candidate.id, candidate.name || `Отдел ${candidate.id}`, department.parentDepartmentId)))
      .join("");
  }

  function headOptions(department) {
    const members = state.people.filter(person => person.departmentId === department.id);
    return [option("", "— не назначен —", department.headId)]
      .concat(members.map(person => option(person.id, `${person.name} — ${person.position}`, department.headId)))
      .join("");
  }

  function roleOptions(selectedValue) {
    return Object.entries(ROLE_LABELS).map(([value, label]) => option(value, label, selectedValue)).join("");
  }

  function inputControl(entity, item, field, label) {
    return `<input aria-label="${escapeHtml(label)}" data-entity="${entity}" data-id="${escapeHtml(item.id)}" data-field="${field}" value="${escapeHtml(item[field])}">`;
  }

  function selectControl(entity, item, field, label, options) {
    return `<select aria-label="${escapeHtml(label)}" data-entity="${entity}" data-id="${escapeHtml(item.id)}" data-field="${field}">${options}</select>`;
  }

  function renderTables() {
    elements.peopleCount.textContent = state.people.length;
    elements.departmentsCount.textContent = state.departments.length;

    elements.peopleTable.innerHTML = state.people.map(person => `
      <tr>
        <td>${inputControl("person", person, "id", "ID сотрудника")}</td>
        <td>${inputControl("person", person, "name", "ФИО")}</td>
        <td>${inputControl("person", person, "position", "Должность")}</td>
        <td>${selectControl("person", person, "departmentId", "Отдел", departmentOptions(person.departmentId))}</td>
        <td>${selectControl("person", person, "managerId", "Прямой руководитель", managerOptions(person))}</td>
        <td>${selectControl("person", person, "role", "Роль", roleOptions(person.role))}</td>
        <td><button type="button" class="delete-button danger" data-delete-entity="person" data-delete-id="${escapeHtml(person.id)}" aria-label="Удалить ${escapeHtml(person.name)}">×</button></td>
      </tr>
    `).join("");

    elements.departmentsTable.innerHTML = state.departments.map(department => `
      <tr>
        <td>${inputControl("department", department, "id", "ID отдела")}</td>
        <td>${inputControl("department", department, "name", "Название отдела")}</td>
        <td>${selectControl("department", department, "parentDepartmentId", "Родительский отдел", parentDepartmentOptions(department))}</td>
        <td>${selectControl("department", department, "reportsToId", "Кому подчиняется отдел", personOptions(department.reportsToId, "", "— верхний уровень —"))}</td>
        <td>${selectControl("department", department, "headId", "Руководитель отдела", headOptions(department))}</td>
        <td><button type="button" class="delete-button danger" data-delete-entity="department" data-delete-id="${escapeHtml(department.id)}" aria-label="Удалить ${escapeHtml(department.name)}">×</button></td>
      </tr>
    `).join("");
  }

  function renderPerson(person, scopeDepartmentId, path = new Set()) {
    const key = `person:${person.id}`;
    if (path.has(key)) return `<div class="org-node employee"><div class="name">Цикл: ${escapeHtml(person.name)}</div></div>`;
    const nextPath = new Set(path).add(key);
    const children = state.people.filter(child => child.managerId === person.id && child.departmentId === scopeDepartmentId);
    const departments = state.departments.filter(department => !department.parentDepartmentId && department.reportsToId === person.id);
    const descendants = [
      ...children.map(child => ({ kind: "person", value: child })),
      ...departments.map(department => ({ kind: "department", value: department }))
    ];
    const department = state.departments.find(item => item.id === person.departmentId);

    return `
      <div class="org-node ${escapeHtml(person.role)}">
        <div class="name">${escapeHtml(person.name || "Без имени")}</div>
        <div class="position">${escapeHtml(person.position || ROLE_LABELS[person.role])}</div>
        ${department ? `<div class="meta">${escapeHtml(department.name)}</div>` : ""}
      </div>
      ${renderChildren(descendants, nextPath)}
    `;
  }

  function renderDepartment(department, path = new Set()) {
    const key = `department:${department.id}`;
    if (path.has(key)) return `<div class="department-box"><div class="department-title">Цикл: ${escapeHtml(department.name)}</div></div>`;
    const nextPath = new Set(path).add(key);
    const members = state.people.filter(person => person.departmentId === department.id);
    const memberIds = new Set(members.map(person => person.id));
    const memberRoots = members.filter(person => !person.managerId || !memberIds.has(person.managerId));
    const orderedRoots = [...memberRoots].sort((left, right) => {
      if (left.id === department.headId) return -1;
      if (right.id === department.headId) return 1;
      return 0;
    });
    const subdepartments = state.departments.filter(item => item.parentDepartmentId === department.id);
    const descendants = [
      ...orderedRoots.map(person => ({ kind: "person", value: person, scopeDepartmentId: department.id })),
      ...subdepartments.map(item => ({ kind: "department", value: item }))
    ];
    const leafGrid = descendants.length > 3 && descendants.every(item => item.kind === "person" && !state.people.some(child => child.managerId === item.value.id && child.departmentId === department.id));
    const reportsTo = state.people.find(person => person.id === department.reportsToId);

    return `
      <div class="department-box">
        <div class="department-title">
          ${escapeHtml(department.name || "Отдел без названия")}
          <small>${members.length} ${plural(members.length, "сотрудник", "сотрудника", "сотрудников")}${reportsTo ? ` · ${escapeHtml(reportsTo.name)}` : ""}</small>
        </div>
        ${renderChildren(descendants, nextPath, leafGrid ? "leaf-grid" : "")}
      </div>
    `;
  }

  function renderChildren(items, path, extraClass = "") {
    if (!items.length) return "";
    return `<div class="children ${extraClass}">${items.map(item => `
      <div class="branch">
        ${item.kind === "person"
          ? renderPerson(item.value, item.scopeDepartmentId ?? item.value.departmentId, path)
          : renderDepartment(item.value, path)}
      </div>`).join("")}</div>`;
  }

  function plural(number, one, few, many) {
    const mod10 = number % 10;
    const mod100 = number % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function rootItems() {
    const peopleIds = new Set(state.people.map(person => person.id));
    const roots = state.people
      .filter(person => !person.departmentId && (!person.managerId || !peopleIds.has(person.managerId)))
      .map(person => ({ kind: "person", value: person, scopeDepartmentId: "" }));
    const rootDepartments = state.departments
      .filter(department => !department.parentDepartmentId && !department.reportsToId)
      .map(department => ({ kind: "department", value: department }));
    return [...roots, ...rootDepartments];
  }

  function renderChart() {
    const roots = rootItems();
    elements.chart.innerHTML = roots.length
      ? `<div class="root-list">${roots.map(item => `<div class="branch">${item.kind === "person" ? renderPerson(item.value, "") : renderDepartment(item.value)}</div>`).join("")}</div>`
      : `<div class="empty-state">Добавьте сотрудника или отдел верхнего уровня.</div>`;

    elements.chartSummary.textContent = `${state.people.length} ${plural(state.people.length, "сотрудник", "сотрудника", "сотрудников")} · ${state.departments.length} ${plural(state.departments.length, "отдел", "отдела", "отделов")}`;
    renderWarnings();
    applyZoom();
    if (autoFit) {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(fitChart);
    }
  }

  function validationWarnings() {
    const warnings = [];
    const ids = [...state.people.map(item => item.id), ...state.departments.map(item => item.id)];
    const duplicates = [...new Set(ids.filter((id, index) => !id || ids.indexOf(id) !== index))];
    if (duplicates.length) warnings.push(`Незаполненные или повторяющиеся ID: ${duplicates.map(id => id || "пустой").join(", ")}.`);

    const personIds = new Set(state.people.map(item => item.id));
    const departmentIds = new Set(state.departments.map(item => item.id));
    const danglingPeople = state.people.filter(person => (person.managerId && !personIds.has(person.managerId)) || (person.departmentId && !departmentIds.has(person.departmentId)));
    const danglingDepartments = state.departments.filter(department => (department.parentDepartmentId && !departmentIds.has(department.parentDepartmentId)) || (department.reportsToId && !personIds.has(department.reportsToId)) || (department.headId && !personIds.has(department.headId)));
    if (danglingPeople.length || danglingDepartments.length) warnings.push("Есть ссылки на удалённых сотрудников или отделы.");
    if (state.people.some(person => personCycle(person.id, person.managerId))) warnings.push("Обнаружен цикл в подчинении сотрудников.");
    if (state.departments.some(department => departmentCycle(department.id, department.parentDepartmentId))) warnings.push("Обнаружен цикл во вложенности отделов.");
    return warnings;
  }

  function renderWarnings() {
    const warnings = validationWarnings();
    elements.warnings.hidden = warnings.length === 0;
    elements.warnings.innerHTML = warnings.map(warning => `<div>${escapeHtml(warning)}</div>`).join("");
  }

  function applyZoom() {
    const baseWidth = Math.max(elements.chart.scrollWidth, 1);
    const baseHeight = Math.max(elements.chart.scrollHeight, 1);
    elements.chart.style.transform = `translateX(-50%) scale(${zoom})`;
    elements.chartStage.style.width = `${Math.max(elements.chartWrap.clientWidth - 56, baseWidth * zoom)}px`;
    elements.chartStage.style.height = `${Math.max(elements.chartWrap.clientHeight - 56, baseHeight * zoom)}px`;
    elements.zoomValue.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(value, manual = true) {
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    if (manual) autoFit = false;
    applyZoom();
  }

  function fitChart() {
    const width = Math.max(elements.chart.scrollWidth, 1);
    const height = Math.max(elements.chart.scrollHeight, 1);
    const availableWidth = Math.max(elements.chartWrap.clientWidth - 56, 1);
    const availableHeight = Math.max(elements.chartWrap.clientHeight - 56, 1);
    zoom = Math.max(MIN_ZOOM, Math.min(1, availableWidth / width, availableHeight / height));
    autoFit = true;
    applyZoom();
  }

  function personCycle(personId, managerId) {
    let current = managerId;
    const visited = new Set();
    while (current && !visited.has(current)) {
      if (current === personId) return true;
      visited.add(current);
      current = state.people.find(person => person.id === current)?.managerId || "";
    }
    return false;
  }

  function departmentCycle(departmentId, parentId) {
    let current = parentId;
    const visited = new Set();
    while (current && !visited.has(current)) {
      if (current === departmentId) return true;
      visited.add(current);
      current = state.departments.find(department => department.id === current)?.parentDepartmentId || "";
    }
    return false;
  }

  function updateId(entity, oldId, newId) {
    if (!newId) return "ID не может быть пустым.";
    if (newId !== oldId && allIds(entity, oldId).has(newId)) return `ID «${newId}» уже используется.`;

    if (entity === "person") {
      const person = state.people.find(item => item.id === oldId);
      if (!person) return "Сотрудник не найден.";
      person.id = newId;
      state.people.forEach(item => { if (item.managerId === oldId) item.managerId = newId; });
      state.departments.forEach(item => {
        if (item.reportsToId === oldId) item.reportsToId = newId;
        if (item.headId === oldId) item.headId = newId;
      });
    } else {
      const department = state.departments.find(item => item.id === oldId);
      if (!department) return "Отдел не найден.";
      department.id = newId;
      state.people.forEach(item => { if (item.departmentId === oldId) item.departmentId = newId; });
      state.departments.forEach(item => { if (item.parentDepartmentId === oldId) item.parentDepartmentId = newId; });
    }
    return "";
  }

  function handleFieldChange(control) {
    const entity = control.dataset.entity;
    const id = control.dataset.id;
    const field = control.dataset.field;
    const value = text(control.value);
    const collection = entity === "person" ? state.people : state.departments;
    const item = collection.find(record => record.id === id);
    if (!item) return render();

    let error = "";
    if (field === "id") error = updateId(entity, id, value);
    else if (entity === "person" && field === "managerId" && personCycle(id, value)) error = "Нельзя назначить подчинённого руководителем: получится цикл.";
    else if (entity === "department" && field === "parentDepartmentId" && departmentCycle(id, value)) error = "Нельзя вложить отдел в самого себя или его дочерний отдел.";
    else {
      if (entity === "person" && field === "departmentId") {
        state.departments.forEach(department => {
          if (department.headId === item.id && department.id !== value) department.headId = "";
        });
      }
      item[field] = value;
      if (entity === "department" && field === "parentDepartmentId" && value) item.reportsToId = "";
      if (entity === "department" && field === "reportsToId" && value) item.parentDepartmentId = "";
      if (entity === "department" && field === "headId" && value) {
        const head = state.people.find(person => person.id === value);
        if (head) {
          state.departments.forEach(department => {
            if (department.id !== item.id && department.headId === head.id) department.headId = "";
          });
          head.departmentId = item.id;
        }
      }
    }

    if (error) alert(error);
    else saveState();
    render();
  }

  function addPerson() {
    const id = nextId();
    state.people.push({ id, name: "Новый сотрудник", position: "Должность", role: "employee", departmentId: "", managerId: "" });
    saveState();
    render();
  }

  function addDepartment() {
    const id = nextId();
    state.departments.push({ id, name: "Новый отдел", parentDepartmentId: "", reportsToId: "", headId: "" });
    saveState();
    render();
  }

  function deleteEntity(entity, id) {
    const item = entity === "person" ? state.people.find(record => record.id === id) : state.departments.find(record => record.id === id);
    if (!item || !confirm(`Удалить «${item.name}»? Связи с этой записью будут очищены.`)) return;

    if (entity === "person") {
      state.people = state.people.filter(person => person.id !== id);
      state.people.forEach(person => { if (person.managerId === id) person.managerId = ""; });
      state.departments.forEach(department => {
        if (department.reportsToId === id) department.reportsToId = "";
        if (department.headId === id) department.headId = "";
      });
    } else {
      state.departments = state.departments.filter(department => department.id !== id);
      state.people.forEach(person => { if (person.departmentId === id) person.departmentId = ""; });
      state.departments.forEach(department => { if (department.parentDepartmentId === id) department.parentDepartmentId = ""; });
    }
    saveState();
    render();
  }

  function csvEscape(value) {
    const result = String(value ?? "");
    return /[",\n\r]/.test(result) ? `"${result.replaceAll('"', '""')}"` : result;
  }

  function exportCsv() {
    const header = ["entity", "id", "name", "position", "role", "departmentId", "managerId", "parentDepartmentId", "reportsToId", "headId"];
    const records = [
      ...state.people.map(person => ({ entity: "person", ...person })),
      ...state.departments.map(department => ({ entity: "department", ...department }))
    ];
    const csv = [header.join(","), ...records.map(record => header.map(key => csvEscape(record[key])).join(","))].join("\r\n");
    downloadBlob(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }), "org-structure.csv");
  }

  function parseCsv(source) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const input = source.replace(/^\uFEFF/, "");
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (quoted && character === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = !quoted;
      else if (character === "," && !quoted) { row.push(field); field = ""; }
      else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && input[index + 1] === "\n") index += 1;
        row.push(field); field = "";
        if (row.some(cell => cell !== "")) rows.push(row);
        row = [];
      } else field += character;
    }
    row.push(field);
    if (row.some(cell => cell !== "")) rows.push(row);
    if (!rows.length) return [];
    const headers = rows.shift().map(text);
    return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, text(values[index])])));
  }

  async function importCsv(file) {
    if (!file) return;
    try {
      const records = parseCsv(await file.text());
      if (!records.length) throw new Error("CSV не содержит данных.");
      if (Object.hasOwn(records[0], "entity")) {
        state = normalizeState({
          version: 2,
          people: records.filter(record => record.entity === "person"),
          departments: records.filter(record => record.entity === "department")
        });
      } else {
        state = migrateLegacy(records);
      }
      saveState();
      autoFit = true;
      render();
    } catch (error) {
      alert(`Не удалось импортировать CSV: ${error.message}`);
    } finally {
      elements.csvInput.value = "";
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function exportImage(format) {
    if (!window.html2canvas) return alert("Библиотека экспорта не загрузилась. Проверьте подключение к интернету.");
    const previousZoom = zoom;
    setZoom(1, false);
    await new Promise(requestAnimationFrame);
    try {
      const canvas = await window.html2canvas(elements.chart, { backgroundColor: "#ffffff", scale: 2, useCORS: true });
      if (format === "png") {
        canvas.toBlob(blob => blob && downloadBlob(blob, "org-chart.png"), "image/png");
      } else {
        const JsPdf = window.jspdf?.jsPDF;
        if (!JsPdf) return alert("Библиотека PDF не загрузилась. Проверьте подключение к интернету.");
        const pdf = new JsPdf({ orientation: canvas.width > canvas.height ? "landscape" : "portrait", unit: "px", format: [canvas.width, canvas.height] });
        pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, canvas.width, canvas.height);
        pdf.save("org-chart.pdf");
      }
    } finally {
      zoom = previousZoom;
      applyZoom();
    }
  }

  async function resetDemo() {
    if (!confirm("Вернуть демонстрационные данные? Текущие изменения будут заменены.")) return;
    try {
      setSaveStatus("Сброс…", "saving");
      state = normalizeState(await window.OrgChartApi.resetDemo());
      setSaveStatus(`${STORAGE_LABEL} · демо восстановлено`);
      autoFit = true;
      render();
    } catch (error) {
      setSaveStatus("Ошибка SQLite", "error");
      alert(error.message);
    }
  }

  function render() {
    renderTables();
    renderChart();
  }

  document.addEventListener("change", event => {
    const control = event.target.closest("[data-entity][data-field]");
    if (control) handleFieldChange(control);
  });

  document.addEventListener("click", event => {
    const deleteButton = event.target.closest("[data-delete-entity]");
    if (deleteButton) return deleteEntity(deleteButton.dataset.deleteEntity, deleteButton.dataset.deleteId);
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "add-person") addPerson();
    else if (action === "add-department") addDepartment();
    else if (action === "fit-chart") fitChart();
    else if (action === "zoom-in") setZoom(zoom + 0.1);
    else if (action === "zoom-out") setZoom(zoom - 0.1);
    else if (action === "export-csv") exportCsv();
    else if (action === "export-png") exportImage("png");
    else if (action === "export-pdf") exportImage("pdf");
    else if (action === "reset-demo") resetDemo();
  });

  elements.csvInput.addEventListener("change", event => importCsv(event.target.files?.[0]));
  elements.chartWrap.addEventListener("wheel", event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setZoom(zoom + (event.deltaY < 0 ? 0.08 : -0.08));
  }, { passive: false });
  window.addEventListener("resize", () => { if (autoFit) fitChart(); });

  async function initialize() {
    setSaveStatus("Подключение…", "saving");
    try {
      let serverState = await window.OrgChartApi.getStructure();
      const legacyState = readLegacyBrowserState();
      const shouldMigrate = legacyState && !localStorage.getItem(SQLITE_MIGRATION_KEY) && serverState.revision <= 1;
      if (shouldMigrate) {
        try {
          serverState = await window.OrgChartApi.replaceStructure(legacyState);
        } catch (migrationError) {
          console.warn("Локальные данные не удалось перенести в SQLite", migrationError);
        }
        localStorage.setItem(SQLITE_MIGRATION_KEY, "1");
      }
      state = normalizeState(serverState);
      setSaveStatus(`${STORAGE_LABEL} · ревизия ${serverState.revision}`);
      render();
    } catch (error) {
      setSaveStatus("Сервер не запущен", "error");
      elements.chart.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      elements.chartSummary.textContent = "Данные недоступны";
    }
  }

  initialize();
})();
