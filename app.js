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
  let collapsedDepartmentIds = new Set();
  let chartLayout = "horizontal";
  let zoom = 1;
  let autoFit = true;
  let fitFrame = 0;
  let saveQueue = Promise.resolve();

  function text(value) {
    return String(value ?? "").trim();
  }

  function numericText(value) {
    const cleaned = text(value);
    if (!cleaned) return "";
    const number = Number.parseInt(cleaned, 10);
    return Number.isFinite(number) ? String(number) : "";
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
        managerId: text(person.managerId),
        reportsToDepartmentId: text(person.reportsToDepartmentId),
        sortOrder: numericText(person.sortOrder)
      })),
      departments: departments.map(department => ({
        id: text(department.id),
        name: text(department.name),
        parentDepartmentId: text(department.parentDepartmentId),
        reportsToId: text(department.reportsToId),
        reportsToDepartmentId: text(department.reportsToDepartmentId),
        headId: text(department.headId),
        sortOrder: numericText(department.sortOrder)
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
        reportsToDepartmentId: "",
        headId: text(item.leaderId),
        sortOrder: numericText(item.sortOrder)
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
          managerId: peopleIds.has(parentId) ? parentId : "",
          reportsToDepartmentId: "",
          sortOrder: numericText(item.sortOrder)
        };
      });

    const peopleById = new Map(people.map(person => [person.id, person]));
    for (let pass = 0; pass < people.length; pass += 1) {
      let changed = false;
      people.forEach(person => {
        const manager = peopleById.get(idList(person.managerId)[0]);
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
      const roots = members.filter(person => !idList(person.managerId).some(managerId => memberIds.has(managerId)));
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

  function idList(value) {
    return text(value).split(",").map(text).filter(Boolean);
  }

  function idSet(value) {
    return new Set(idList(value));
  }

  function joinIds(values) {
    return [...new Set(values.map(text).filter(Boolean))].join(",");
  }

  function optionMulti(value, label, selectedValues) {
    return `<option value="${escapeHtml(value)}" ${selectedValues.has(value) ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }

  function departmentOptions(selectedValue, excludedId = "", emptyLabel = "— без отдела —") {
    return [option("", emptyLabel, selectedValue)]
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
        if (idList(person.managerId).includes(parentId) && !descendants.has(person.id)) {
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
        if ((department.parentDepartmentId === parentId || department.reportsToDepartmentId === parentId) && !descendants.has(department.id)) {
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

  function managerCandidates(person) {
    const excluded = personDescendantIds(person.id);
    excluded.add(person.id);
    return state.people.filter(candidate => {
      if (excluded.has(candidate.id)) return false;
      return person.departmentId
        ? candidate.departmentId === person.departmentId
        : !candidate.departmentId;
    }).sort(compareByName);
  }

  function managerCheckboxes(person) {
    const selected = idSet(person.managerId);
    const candidates = managerCandidates(person);
    if (!candidates.length) return `<div class="table-hint">Нет доступных руководителей</div>`;
    return `<div class="manager-checkboxes">${candidates.map(candidate => `
      <label class="manager-checkbox">
        <input
          type="checkbox"
          value="${escapeHtml(candidate.id)}"
          ${selected.has(candidate.id) ? "checked" : ""}
          data-entity="person"
          data-id="${escapeHtml(person.id)}"
          data-field="managerId">
        <span>${escapeHtml(candidate.name || `Сотрудник ${candidate.id}`)}${candidate.position ? ` — ${escapeHtml(candidate.position)}` : ""}</span>
      </label>
    `).join("")}</div>`;
  }

  function parentDepartmentOptions(department) {
    const excluded = departmentDescendantIds(department.id);
    excluded.add(department.id);
    return [option("", "— самостоятельный отдел —", department.parentDepartmentId)]
      .concat(state.departments
        .filter(candidate => !excluded.has(candidate.id))
        .map(candidate => option(candidate.id, candidate.name || `Отдел ${candidate.id}`, department.parentDepartmentId)))
      .join("");
  }

  function reportDepartmentOptions(department) {
    const excluded = departmentDescendantIds(department.id);
    excluded.add(department.id);
    return [option("", "— не выбран —", department.reportsToDepartmentId)]
      .concat(state.departments
        .filter(candidate => !excluded.has(candidate.id))
        .map(candidate => option(candidate.id, candidate.name || `Отдел ${candidate.id}`, department.reportsToDepartmentId)))
      .join("");
  }

  function headOptions(department) {
    const selected = idSet(department.headId);
    const members = state.people.filter(person => person.departmentId === department.id);
    return members
      .map(person => optionMulti(person.id, `${person.name} — ${person.position}`, selected))
      .join("");
  }

  function headCheckboxes(department) {
    const selected = idSet(department.headId);
    const members = state.people.filter(person => person.departmentId === department.id).sort(compareByName);
    if (!members.length) return `<div class="table-hint">Сначала назначьте сотрудников в отдел</div>`;
    return `<div class="head-checkboxes">${members.map(person => `
      <label class="head-checkbox">
        <input
          type="checkbox"
          value="${escapeHtml(person.id)}"
          ${selected.has(person.id) ? "checked" : ""}
          data-entity="department"
          data-id="${escapeHtml(department.id)}"
          data-field="headId">
        <span>${escapeHtml(person.name || `Сотрудник ${person.id}`)}${person.position ? ` — ${escapeHtml(person.position)}` : ""}</span>
      </label>
    `).join("")}</div>`;
  }

  function roleOptions(selectedValue) {
    return Object.entries(ROLE_LABELS).map(([value, label]) => option(value, label, selectedValue)).join("");
  }

  function inputControl(entity, item, field, label) {
    return `<input aria-label="${escapeHtml(label)}" data-entity="${entity}" data-id="${escapeHtml(item.id)}" data-field="${field}" value="${escapeHtml(item[field])}">`;
  }

  function numberControl(entity, item, field, label) {
    return `<input type="number" min="0" step="1" inputmode="numeric" aria-label="${escapeHtml(label)}" data-entity="${entity}" data-id="${escapeHtml(item.id)}" data-field="${field}" value="${escapeHtml(item[field])}">`;
  }

  function selectControl(entity, item, field, label, options) {
    return `<select aria-label="${escapeHtml(label)}" data-entity="${entity}" data-id="${escapeHtml(item.id)}" data-field="${field}">${options}</select>`;
  }

  function renderTables() {
    elements.peopleCount.textContent = state.people.length;
    elements.departmentsCount.textContent = state.departments.length;

    elements.peopleTable.innerHTML = [...state.people].sort(compareByName).map(person => `
      <tr>
        <td>${inputControl("person", person, "id", "ID сотрудника")}</td>
        <td>${numberControl("person", person, "sortOrder", "Сортировка")}</td>
        <td>${inputControl("person", person, "name", "ФИО")}</td>
        <td>${inputControl("person", person, "position", "Должность")}</td>
        <td>${selectControl("person", person, "departmentId", "Отдел", departmentOptions(person.departmentId))}</td>
        <td>${managerCheckboxes(person)}</td>
        <td>${selectControl("person", person, "reportsToDepartmentId", "Подчиняется отделу", departmentOptions(person.reportsToDepartmentId, "", "— не выбран —"))}</td>
        <td>${selectControl("person", person, "role", "Роль", roleOptions(person.role))}</td>
        <td><button type="button" class="delete-button danger" data-delete-entity="person" data-delete-id="${escapeHtml(person.id)}" aria-label="Удалить ${escapeHtml(person.name)}">×</button></td>
      </tr>
    `).join("");

    elements.departmentsTable.innerHTML = [...state.departments].sort(compareByName).map(department => `
      <tr>
        <td>${inputControl("department", department, "id", "ID отдела")}</td>
        <td>${numberControl("department", department, "sortOrder", "Сортировка")}</td>
        <td>${inputControl("department", department, "name", "Название отдела")}</td>
        <td>${selectControl("department", department, "parentDepartmentId", "Родительский отдел", parentDepartmentOptions(department))}</td>
        <td>${selectControl("department", department, "reportsToId", "Подчиняется сотруднику", personOptions(department.reportsToId, "", "— не выбран —"))}</td>
        <td>${selectControl("department", department, "reportsToDepartmentId", "Подчиняется отделу", reportDepartmentOptions(department))}</td>
        <td>${headCheckboxes(department)}</td>
        <td><button type="button" class="delete-button danger" data-delete-entity="department" data-delete-id="${escapeHtml(department.id)}" aria-label="Удалить ${escapeHtml(department.name)}">×</button></td>
      </tr>
    `).join("");
  }

  function compareByName(left, right) {
    const leftOrder = Number.parseInt(left.sortOrder, 10);
    const rightOrder = Number.parseInt(right.sortOrder, 10);
    const leftRank = Number.isFinite(leftOrder) ? leftOrder : Number.MAX_SAFE_INTEGER;
    const rightRank = Number.isFinite(rightOrder) ? rightOrder : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (left.name || left.id).localeCompare(right.name || right.id, "ru")
      || String(left.id).localeCompare(String(right.id), "ru");
  }

  function personCard(person) {
    return `
      <div class="org-node ${escapeHtml(person.role)}">
        <div class="name">${escapeHtml(person.name || "Без имени")}</div>
        <div class="position">${escapeHtml(person.position || ROLE_LABELS[person.role])}</div>
      </div>
    `;
  }

  function layoutDepartmentMembers(members) {
    const count = members.length;
    const presets = {
      1: [1],
      2: [2],
      3: [3],
      4: [2, 2],
      5: [3, 2],
      6: [2, 2, 2],
      7: [3, 2, 2],
      8: [3, 3, 2],
      9: [3, 3, 3],
      10: [4, 3, 3],
      11: [4, 4, 3],
      12: [4, 4, 4]
    };
    const rowSizes = presets[count] || (() => {
      const rowsCount = Math.ceil(count / 4);
      const base = Math.floor(count / rowsCount);
      let extra = count % rowsCount;
      return Array.from({ length: rowsCount }, () => {
        const size = base + (extra > 0 ? 1 : 0);
        extra -= 1;
        return Math.max(3, Math.min(4, size));
      });
    })();

    const rows = [];
    let offset = 0;
    rowSizes.forEach(size => {
      rows.push(members.slice(offset, offset + size));
      offset += size;
    });
    return rows.filter(row => row.length);
  }

  function renderPerson(person, scopeDepartmentId = "", path = new Set()) {
    const key = `person:${person.id}`;
    if (path.has(key)) return `<div class="org-node employee"><div class="name">Цикл: ${escapeHtml(person.name)}</div></div>`;
    const nextPath = new Set(path).add(key);
    const children = state.people
      .filter(child => idList(child.managerId).includes(person.id) && child.departmentId === scopeDepartmentId)
      .sort(compareByName);
    const departments = state.departments
      .filter(department => !department.parentDepartmentId && department.reportsToId === person.id)
      .sort(compareByName);
    const descendants = [
      ...children.map(child => ({ kind: "person", value: child })),
      ...departments.map(department => ({ kind: "department", value: department }))
    ];
    return `
      ${personCard(person)}
      ${renderChildren(descendants, nextPath)}
    `;
  }

  function hasDepartmentPersonDescendants(personId, departmentId, hiddenIds = new Set()) {
    return state.people.some(child => child.departmentId === departmentId && idList(child.managerId).includes(personId) && !hiddenIds.has(child.id))
      || state.departments.some(department => department.parentDepartmentId === departmentId && department.reportsToId === personId);
  }

  function primaryManagerId(person) {
    return idList(person.managerId)[0] || "";
  }

  function departmentMemberCount(departmentId, path = new Set()) {
    if (path.has(departmentId)) return 0;
    const nextPath = new Set(path).add(departmentId);
    const directCount = state.people.filter(person => person.departmentId === departmentId).length;
    const childCount = state.departments
      .filter(department => department.parentDepartmentId === departmentId)
      .reduce((total, department) => total + departmentMemberCount(department.id, nextPath), 0);
    return directCount + childCount;
  }

  function departmentSummary(department, members) {
    const headNames = idList(department.headId)
      .map(headId => state.people.find(person => person.id === headId)?.name)
      .filter(Boolean);
    const subdepartmentNames = state.departments
      .filter(item => item.parentDepartmentId === department.id || item.reportsToDepartmentId === department.id)
      .sort(compareByName)
      .map(item => item.name || "Отдел без названия");
    const fallbackHead = members.find(person => {
      const managerIds = idList(person.managerId);
      return !managerIds.length || !managerIds.some(managerId => members.some(member => member.id === managerId));
    })?.name;
    const leaders = headNames.length ? headNames : (fallbackHead ? [fallbackHead] : []);

    return `
      <div class="department-summary">
        <div class="department-summary-row">
          <span class="department-summary-label">Руководитель</span>
          <span class="department-summary-value">${leaders.length ? leaders.map(escapeHtml).join(", ") : "Не указан"}</span>
        </div>
        <div class="department-summary-row">
          <span class="department-summary-label">Подразделения</span>
          <span class="department-summary-value">${subdepartmentNames.length ? subdepartmentNames.map(escapeHtml).join(", ") : "Нет"}</span>
        </div>
      </div>
    `;
  }

  function renderDepartmentPerson(person, departmentId, path = new Set(), hiddenIds = new Set()) {
    const key = `department-person:${departmentId}:${person.id}`;
    if (path.has(key)) return `<div class="org-node employee"><div class="name">Цикл: ${escapeHtml(person.name)}</div></div>`;
    const nextPath = new Set(path).add(key);
    const children = state.people
      .filter(child => child.departmentId === departmentId && primaryManagerId(child) === person.id && !hiddenIds.has(child.id))
      .sort(compareByName)
      .map(child => ({ kind: "department-person", value: child, departmentId, hiddenIds }));
    const childDepartments = state.departments
      .filter(department => department.parentDepartmentId === departmentId && department.reportsToId === person.id)
      .sort(compareByName)
      .map(department => ({ kind: "department", value: department }));
    const descendants = [
      ...children,
      ...childDepartments
    ];
    const compactGrid = !childDepartments.length && children.length > 3 && children.every(item => !hasDepartmentPersonDescendants(item.value.id, departmentId, hiddenIds));

    return `
      ${personCard(person)}
      ${compactGrid ? renderDepartmentRows(children, nextPath, "with-parent-line") : renderChildren(descendants, nextPath)}
    `;
  }

  function renderDepartment(department, path = new Set()) {
    const key = `department:${department.id}`;
    if (path.has(key)) return `
      <div class="department-box">
        <div class="department-header">
          <div class="department-info">
            <div class="department-name">Цикл: ${escapeHtml(department.name)}</div>
          </div>
        </div>
      </div>
    `;
    const nextPath = new Set(path).add(key);
    const members = state.people.filter(person => person.departmentId === department.id).sort(compareByName);
    const memberIds = new Set(members.map(person => person.id));
    const headIds = idSet(department.headId);
    const reportedPeople = state.people
      .filter(person => person.reportsToDepartmentId === department.id)
      .sort(compareByName)
      .map(person => person.departmentId === department.id
        ? ({ kind: "department-person", value: person, departmentId: department.id })
        : ({ kind: "person", value: person, scopeDepartmentId: person.departmentId || "" }));
    const reportedIds = new Set(reportedPeople.map(item => item.value.id));
    const reportedDepartments = state.departments
      .filter(item => item.reportsToDepartmentId === department.id)
      .sort(compareByName)
      .map(item => ({ kind: "department", value: item }));
    const reportedDepartmentIds = new Set(reportedDepartments.map(item => item.value.id));
    const externalChildren = [...reportedPeople, ...reportedDepartments];
    const sharedHeadChildren = members
      .filter(person => !headIds.has(person.id))
      .filter(person => !reportedIds.has(person.id))
      .filter(person => {
        const managerIds = idList(person.managerId);
        return managerIds.length > 1 && managerIds.every(managerId => headIds.has(managerId));
      })
      .sort(compareByName)
      .map(person => ({ kind: "department-person", value: person, departmentId: department.id }));
    const sharedHeadChildIds = new Set(sharedHeadChildren.map(item => item.value.id));
    const headHiddenIds = new Set([...headIds, ...sharedHeadChildIds]);
    const headBranch = members
      .filter(person => headIds.has(person.id))
      .filter(person => !reportedIds.has(person.id))
      .map(person => ({ kind: "department-person", value: person, departmentId: department.id, hiddenIds: headHiddenIds }));
    const staffRoots = members
      .filter(person => !headIds.has(person.id))
      .filter(person => !reportedIds.has(person.id))
      .filter(person => !idList(person.managerId).some(managerId => memberIds.has(managerId)))
      .map(person => ({ kind: "department-person", value: person, departmentId: department.id }));
    const subdepartments = state.departments
      .filter(item => item.parentDepartmentId === department.id)
      .filter(item => !reportedDepartmentIds.has(item.id))
      .filter(item => !item.reportsToId || !memberIds.has(item.reportsToId))
      .sort(compareByName)
      .map(item => ({ kind: "department", value: item }));
    const headLeafGrid = headBranch.length > 1 && headBranch.every(item => !hasDepartmentPersonDescendants(item.value.id, department.id, item.hiddenIds ?? new Set()));
    const staffLeafGrid = staffRoots.length > 3 && staffRoots.every(item => !hasDepartmentPersonDescendants(item.value.id, department.id));
    const hasBody = headBranch.length || sharedHeadChildren.length || staffRoots.length || subdepartments.length;
    const isCollapsed = collapsedDepartmentIds.has(department.id);
    const totalMembers = departmentMemberCount(department.id);

    return `
      <div class="department-box ${isCollapsed ? "is-collapsed" : ""}">
        <div class="department-header">
          <div class="department-drag" aria-hidden="true">⋮⋮</div>
          <div class="department-info">
            <div class="department-name">${escapeHtml(department.name || "Отдел без названия")}</div>
            <div class="department-meta">
              <span class="department-badge">${totalMembers} ${plural(totalMembers, "сотрудник", "сотрудника", "сотрудников")}</span>
            </div>
          </div>
          <button
            type="button"
            class="department-toggle"
            data-action="toggle-department"
            data-department-id="${escapeHtml(department.id)}"
            aria-expanded="${isCollapsed ? "false" : "true"}"
            aria-label="${isCollapsed ? "Развернуть" : "Свернуть"} ${escapeHtml(department.name || "отдел")}"
            title="${isCollapsed ? "Развернуть" : "Свернуть"}"
          >${isCollapsed ? "+" : "−"}</button>
        </div>
        ${isCollapsed ? departmentSummary(department, members) : hasBody ? `
          <div class="department-body">
            ${headBranch.length ? `<div class="department-head-person">${headLeafGrid ? renderDepartmentRows(headBranch, nextPath) : renderChildren(headBranch, nextPath, "no-connectors")}</div>` : ""}
            ${sharedHeadChildren.length ? `<div class="department-shared-children">${renderChildren(sharedHeadChildren, nextPath, "shared-managers")}</div>` : ""}
            ${staffRoots.length ? `<div class="department-members">${staffLeafGrid ? renderDepartmentRows(staffRoots, nextPath) : renderChildren(staffRoots, nextPath, "no-connectors")}</div>` : ""}
            ${subdepartments.length ? `<div class="department-subdepartments">${renderDepartmentRows(subdepartments, nextPath)}</div>` : ""}
          </div>
        ` : `<div class="department-empty">Нет сотрудников</div>`}
      </div>
      ${isCollapsed ? "" : renderChildren(externalChildren, nextPath)}
    `;
  }

  function renderDepartmentRows(items, path, extraClass = "") {
    if (!items.length) return "";
    return `
      <div class="department-member-rows ${extraClass}">
        ${layoutDepartmentMembers(items).map(row => `
          <div class="department-row">
            ${row.map(item => `
              <div class="department-row-item">
                ${item.kind === "department-person"
                  ? renderDepartmentPerson(item.value, item.departmentId, path, item.hiddenIds ?? new Set())
                  : item.kind === "person"
                  ? renderPerson(item.value, item.scopeDepartmentId ?? item.value.departmentId, path)
                  : renderDepartment(item.value, path)}
              </div>
            `).join("")}
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderChildren(items, path, extraClass = "") {
    if (!items.length) return "";
    const relationClass = items.length === 1 ? "single" : "multiple";
    const countClass = `count-${Math.min(items.length, 3)}`;
    return `<div class="children ${relationClass} ${countClass} ${extraClass}">${items.map(item => `
      <div class="branch ${item.kind === "department" ? "department-branch" : "person-branch"}">
        ${item.kind === "department-person"
          ? renderDepartmentPerson(item.value, item.departmentId, path, item.hiddenIds ?? new Set())
          : item.kind === "person"
          ? renderPerson(item.value, item.scopeDepartmentId ?? item.value.departmentId, path)
          : renderDepartment(item.value, path)}
      </div>`).join("")}</div>`;
  }

  function renderVerticalItem(item, path) {
    if (item.kind === "department-person") {
      return renderVerticalDepartmentPerson(item.value, item.departmentId, path, item.hiddenIds ?? new Set());
    }
    if (item.kind === "person") {
      return renderVerticalPerson(item.value, item.scopeDepartmentId ?? item.value.departmentId ?? "", path);
    }
    return renderVerticalDepartment(item.value, path);
  }

  function renderVerticalChildren(items, path, extraClass = "", flowOverride = "") {
    if (!items.length) return "";
    const flowClass = flowOverride ? `is-${flowOverride}` : (path.size <= 2 ? "is-horizontal" : "is-vertical");
    const levelClass = `level-${Math.min(path.size, 4)}`;
    return `
      <div class="v-children ${items.length === 1 ? "single" : "multiple"} ${flowClass} ${levelClass} ${extraClass}">
        ${items.map(item => `
          <div class="v-branch ${item.kind === "department" ? "v-department-branch" : "v-person-branch"}">
            ${renderVerticalItem(item, path)}
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderVerticalSharedHeadGroup(heads, children, path) {
    if (!heads.length || !children.length) return "";
    return `
      <div class="department-shared-head-group">
        <div class="shared-head-heads">
          ${renderVerticalPlainList(heads, path, heads.length > 1 ? "is-row" : "")}
        </div>
        <div class="shared-head-connector-layer" aria-hidden="true">
          <span class="shared-head-bus"></span>
          <span class="shared-head-spine"></span>
          ${heads.map((_, index) => `<span class="shared-head-drop" data-head-index="${index}"></span>`).join("")}
        </div>
        <div class="shared-head-children">
          ${renderVerticalPlainList(children, path)}
        </div>
      </div>
    `;
  }

  function renderVerticalPerson(person, scopeDepartmentId = "", path = new Set()) {
    const key = `vertical-person:${scopeDepartmentId}:${person.id}`;
    if (path.has(key)) return `<div class="org-node employee"><div class="name">Цикл: ${escapeHtml(person.name)}</div></div>`;
    const nextPath = new Set(path).add(key);
    const people = state.people
      .filter(child => primaryManagerId(child) === person.id && child.departmentId === scopeDepartmentId)
      .sort(compareByName)
      .map(child => ({ kind: "person", value: child, scopeDepartmentId }));
    const departments = state.departments
      .filter(department => !department.parentDepartmentId && department.reportsToId === person.id)
      .sort(compareByName)
      .map(department => ({ kind: "department", value: department }));
    const descendants = [...people, ...departments];
    const steppedParentClass = descendants.length && path.size >= 2 ? "is-stepped-parent" : "";

    return `
      <div class="v-node v-person-node ${steppedParentClass}">
        ${personCard(person)}
        ${renderVerticalChildren(descendants, nextPath, descendants.length ? "has-managed-children" : "")}
      </div>
    `;
  }

  function renderVerticalDepartmentPerson(person, departmentId, path = new Set(), hiddenIds = new Set()) {
    const key = `vertical-department-person:${departmentId}:${person.id}`;
    if (path.has(key)) return `<div class="org-node employee"><div class="name">Цикл: ${escapeHtml(person.name)}</div></div>`;
    const nextPath = new Set(path).add(key);
    const people = state.people
      .filter(child => child.departmentId === departmentId && primaryManagerId(child) === person.id && !hiddenIds.has(child.id))
      .sort(compareByName)
      .map(child => ({ kind: "department-person", value: child, departmentId, hiddenIds }));
    const departments = state.departments
      .filter(department => department.parentDepartmentId === departmentId && department.reportsToId === person.id)
      .sort(compareByName)
      .map(department => ({ kind: "department", value: department }));
    const descendants = [...people, ...departments];
    const steppedParentClass = descendants.length && path.size >= 2 ? "is-stepped-parent" : "";

    return `
      <div class="v-node v-person-node ${steppedParentClass}">
        ${personCard(person)}
        ${renderVerticalChildren(descendants, nextPath, descendants.length ? "has-managed-children" : "")}
      </div>
    `;
  }

  function renderVerticalDepartment(department, path = new Set()) {
    const key = `vertical-department:${department.id}`;
    if (path.has(key)) return `
      <div class="department-box">
        <div class="department-header">
          <div class="department-info">
            <div class="department-name">Цикл: ${escapeHtml(department.name)}</div>
          </div>
        </div>
      </div>
    `;

    const nextPath = new Set(path).add(key);
    const members = state.people.filter(person => person.departmentId === department.id).sort(compareByName);
    const memberIds = new Set(members.map(person => person.id));
    const headIds = idSet(department.headId);
    const reportedPeople = state.people
      .filter(person => person.reportsToDepartmentId === department.id)
      .sort(compareByName)
      .map(person => person.departmentId === department.id
        ? ({ kind: "department-person", value: person, departmentId: department.id })
        : ({ kind: "person", value: person, scopeDepartmentId: person.departmentId || "" }));
    const reportedIds = new Set(reportedPeople.map(item => item.value.id));
    const reportedDepartments = state.departments
      .filter(item => item.reportsToDepartmentId === department.id)
      .sort(compareByName)
      .map(item => ({ kind: "department", value: item }));
    const reportedDepartmentIds = new Set(reportedDepartments.map(item => item.value.id));
    const externalChildren = [...reportedPeople, ...reportedDepartments];
    const sharedHeadChildren = members
      .filter(person => !headIds.has(person.id))
      .filter(person => !reportedIds.has(person.id))
      .filter(person => {
        const managerIds = idList(person.managerId);
        return managerIds.length > 1 && managerIds.every(managerId => headIds.has(managerId));
      })
      .sort(compareByName)
      .map(person => ({ kind: "department-person", value: person, departmentId: department.id }));
    const sharedHeadChildIds = new Set(sharedHeadChildren.map(item => item.value.id));
    const headHiddenIds = new Set([...headIds, ...sharedHeadChildIds]);
    const headBranch = members
      .filter(person => headIds.has(person.id))
      .filter(person => !reportedIds.has(person.id))
      .map(person => ({ kind: "department-person", value: person, departmentId: department.id, hiddenIds: headHiddenIds }));
    const staffRoots = members
      .filter(person => !headIds.has(person.id))
      .filter(person => !reportedIds.has(person.id))
      .filter(person => !idList(person.managerId).some(managerId => memberIds.has(managerId)))
      .map(person => ({ kind: "department-person", value: person, departmentId: department.id }));
    const subdepartments = state.departments
      .filter(item => item.parentDepartmentId === department.id)
      .filter(item => !reportedDepartmentIds.has(item.id))
      .filter(item => !item.reportsToId || !memberIds.has(item.reportsToId))
      .sort(compareByName)
      .map(item => ({ kind: "department", value: item }));
    const hasDepartmentBody = headBranch.length || sharedHeadChildren.length || staffRoots.length || subdepartments.length;
    const independentRoots = [...staffRoots, ...subdepartments];
    const isCollapsed = collapsedDepartmentIds.has(department.id);
    const totalMembers = departmentMemberCount(department.id);

    return `
      <div class="v-node v-department-node">
        <div class="department-box ${isCollapsed ? "is-collapsed" : ""}">
          <div class="department-header">
            <div class="department-drag" aria-hidden="true">⋮⋮</div>
            <div class="department-info">
              <div class="department-name">${escapeHtml(department.name || "Отдел без названия")}</div>
              <div class="department-meta">
                <span class="department-badge">${totalMembers} ${plural(totalMembers, "сотрудник", "сотрудника", "сотрудников")}</span>
              </div>
            </div>
            <button
              type="button"
              class="department-toggle"
              data-action="toggle-department"
              data-department-id="${escapeHtml(department.id)}"
              aria-expanded="${isCollapsed ? "false" : "true"}"
              aria-label="${isCollapsed ? "Развернуть" : "Свернуть"} ${escapeHtml(department.name || "отдел")}"
              title="${isCollapsed ? "Развернуть" : "Свернуть"}"
            >${isCollapsed ? "+" : "−"}</button>
          </div>
          ${isCollapsed ? departmentSummary(department, members) : hasDepartmentBody ? `
            <div class="v-department-body">
              ${sharedHeadChildren.length && headBranch.length
                ? renderVerticalSharedHeadGroup(headBranch, sharedHeadChildren, nextPath)
                : headBranch.length
                ? `<div class="department-head-person v-dept-heads">${renderVerticalPlainList(headBranch, nextPath, headBranch.length > 1 ? "is-row" : "")}</div>`
                : ""}
              ${independentRoots.length ? `<div class="department-managed independent">${renderVerticalPlainList(independentRoots, nextPath)}</div>` : ""}
            </div>
          ` : `<div class="department-empty">Нет сотрудников</div>`}
        </div>
        ${isCollapsed ? "" : renderVerticalChildren(externalChildren, nextPath)}
      </div>
    `;
  }

  function renderVerticalPlainList(items, path, extraClass = "") {
    if (!items.length) return "";
    return `
      <div class="v-plain-list ${extraClass}">
        ${items.map(item => `<div class="v-plain-item">${renderVerticalItem(item, path)}</div>`).join("")}
      </div>
    `;
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
      .filter(person => !person.reportsToDepartmentId)
      .filter(person => !person.departmentId && !idList(person.managerId).some(managerId => peopleIds.has(managerId)))
      .map(person => ({ kind: "person", value: person, scopeDepartmentId: "" }));
    const rootDepartments = state.departments
      .filter(department => !department.parentDepartmentId && !department.reportsToId && !department.reportsToDepartmentId)
      .map(department => ({ kind: "department", value: department }));
    return [...roots, ...rootDepartments].sort((left, right) => compareByName(left.value, right.value));
  }

  function renderChart() {
    const roots = rootItems();
    elements.chart.className = `chart chart-${chartLayout}`;
    if (!roots.length) {
      elements.chart.innerHTML = `<div class="empty-state">Добавьте сотрудника или отдел верхнего уровня.</div>`;
    } else if (chartLayout === "vertical") {
      elements.chart.innerHTML = `<div class="v-forest">${roots.map(item => `<div class="v-root">${renderVerticalItem(item, new Set())}</div>`).join("")}</div>`;
    } else {
      elements.chart.innerHTML = `<div class="root-list">${roots.map(item => `<div class="branch ${item.kind === "department" ? "department-branch" : "person-branch"}">${item.kind === "person" ? renderPerson(item.value, "") : renderDepartment(item.value)}</div>`).join("")}</div>`;
    }

    elements.chartSummary.textContent = `${state.people.length} ${plural(state.people.length, "сотрудник", "сотрудника", "сотрудников")} · ${state.departments.length} ${plural(state.departments.length, "отдел", "отдела", "отделов")}`;
    document.querySelectorAll("[data-layout]").forEach(button => {
      button.classList.toggle("is-active", button.dataset.layout === chartLayout);
    });
    renderWarnings();
    updateVerticalConnectors();
    applyZoom();
    if (autoFit) {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(fitChart);
    }
  }

  function updateVerticalConnectors() {
    if (chartLayout !== "vertical") return;
    const offsetPosition = (element, ancestor) => {
      let left = 0;
      let top = 0;
      let current = element;
      while (current && current !== ancestor) {
        left += current.offsetLeft;
        top += current.offsetTop;
        current = current.offsetParent;
      }
      return { left, top };
    };
    const branchCard = branch => {
      const node = branch.firstElementChild;
      return node
        ? [...node.children].find(child => child.classList.contains("org-node") || child.classList.contains("department-box"))
        : null;
    };
    const parentLinkOverlap = 26;
    const connectorLists = elements.chart.querySelectorAll([
      ".v-department-node > .v-children.is-vertical",
      ".v-person-node.is-stepped-parent > .v-children.has-managed-children.is-vertical"
    ].join(", "));
    connectorLists.forEach(list => {
      const lastBranch = [...list.children].filter(child => child.classList.contains("v-branch")).at(-1);
      if (!lastBranch) return;
      const elbowY = lastBranch.offsetTop + 34;
      list.style.setProperty("--v-spine-height", `${elbowY + parentLinkOverlap}px`);
    });

    elements.chart.querySelectorAll(".shared-head-children > .v-plain-list").forEach(list => {
      const lastItem = [...list.children].filter(child => child.classList.contains("v-plain-item")).at(-1);
      if (!lastItem) return;
      const elbowY = lastItem.offsetTop + 29;
      list.style.setProperty("--shared-spine-height", `${elbowY}px`);
    });

    elements.chart.querySelectorAll(".department-shared-head-group").forEach(group => {
      const heads = [...group.querySelectorAll(".shared-head-heads > .v-plain-list > .v-plain-item .org-node")];
      const childList = group.querySelector(".shared-head-children > .v-plain-list");
      const bus = group.querySelector(".shared-head-bus");
      const spine = group.querySelector(".shared-head-spine");
      const drops = [...group.querySelectorAll(".shared-head-drop")];
      if (!heads.length || !childList || !bus || !spine) return;

      const headCenters = heads.map(card => {
        const position = offsetPosition(card, group);
        return {
          x: position.left + card.offsetWidth / 2,
          bottom: position.top + card.offsetHeight
        };
      });
      const primaryX = headCenters[0].x;
      const left = Math.min(...headCenters.map(item => item.x));
      const right = Math.max(...headCenters.map(item => item.x));
      const bottom = Math.max(...headCenters.map(item => item.bottom));
      const busY = bottom + 14;
      const childTop = offsetPosition(childList, group).top;

      group.style.setProperty("--shared-head-primary-x", `${primaryX}px`);
      group.style.setProperty("--shared-head-bus-left", `${left}px`);
      group.style.setProperty("--shared-head-bus-top", `${busY}px`);
      group.style.setProperty("--shared-head-bus-width", `${right - left}px`);
      group.style.setProperty("--shared-head-spine-top", `${busY}px`);
      group.style.setProperty("--shared-head-spine-height", `${Math.max(0, childTop - 14 - busY)}px`);

      drops.forEach((drop, index) => {
        const head = headCenters[index];
        if (!head) return;
        drop.style.left = `${head.x}px`;
        drop.style.top = `${head.bottom}px`;
        drop.style.height = `${Math.max(0, busY - head.bottom)}px`;
      });
    });

    elements.chart.querySelectorAll(".v-children.level-2.is-horizontal.multiple:not(.no-parent)").forEach(list => {
      const branches = [...list.children].filter(child => child.classList.contains("v-branch"));
      if (branches.length < 2) return;
      const branchTargets = branches.map(branch => {
        const card = branchCard(branch);
        if (!card) return null;
        const positionInList = offsetPosition(card, list);
        const positionInBranch = offsetPosition(card, branch);
        return {
          branch,
          centerXInList: positionInList.left + card.offsetWidth / 2,
          centerXInBranch: positionInBranch.left + card.offsetWidth / 2,
          topInList: positionInList.top,
          topInBranch: positionInBranch.top
        };
      }).filter(Boolean);
      if (branchTargets.length < 2) return;
      const first = branchTargets[0];
      const last = branchTargets[branchTargets.length - 1];
      const left = first.centerXInList;
      const right = last.centerXInList;
      list.style.setProperty("--top-row-line-left", `${left}px`);
      list.style.setProperty("--top-row-line-width", `${right - left}px`);
      const listStyles = getComputedStyle(list);
      const connectorY = Number.parseFloat(listStyles.getPropertyValue("--top-row-connector")) || 42;
      branchTargets.forEach(({ branch, centerXInBranch, topInList, topInBranch }) => {
        const branchHeight = Math.max(0, topInList - connectorY);
        branch.style.setProperty("--top-row-branch-x", `${centerXInBranch}px`);
        branch.style.setProperty("--top-row-branch-top", `${topInBranch}px`);
        branch.style.setProperty("--top-row-branch-height", `${branchHeight}px`);
      });
    });
  }

  function validationWarnings() {
    const warnings = [];
    const ids = [...state.people.map(item => item.id), ...state.departments.map(item => item.id)];
    const duplicates = [...new Set(ids.filter((id, index) => !id || ids.indexOf(id) !== index))];
    if (duplicates.length) warnings.push(`Незаполненные или повторяющиеся ID: ${duplicates.map(id => id || "пустой").join(", ")}.`);

    const personIds = new Set(state.people.map(item => item.id));
    const departmentIds = new Set(state.departments.map(item => item.id));
    const danglingPeople = state.people.filter(person =>
      idList(person.managerId).some(managerId => !personIds.has(managerId))
      || (person.departmentId && !departmentIds.has(person.departmentId))
      || (person.reportsToDepartmentId && !departmentIds.has(person.reportsToDepartmentId))
    );
    const danglingDepartments = state.departments.filter(department =>
      (department.parentDepartmentId && !departmentIds.has(department.parentDepartmentId))
      || (department.reportsToId && !personIds.has(department.reportsToId))
      || (department.reportsToDepartmentId && !departmentIds.has(department.reportsToDepartmentId))
      || idList(department.headId).some(headId => !personIds.has(headId))
    );
    if (danglingPeople.length || danglingDepartments.length) warnings.push("Есть ссылки на удалённых сотрудников или отделы.");
    if (state.people.some(person => personCycle(person.id, person.managerId))) warnings.push("Обнаружен цикл в подчинении сотрудников.");
    if (state.departments.some(department => departmentCycle(department.id, department.parentDepartmentId) || departmentCycle(department.id, department.reportsToDepartmentId))) warnings.push("Обнаружен цикл в связях отделов.");
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
    const queue = idList(managerId);
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      if (current === personId) return true;
      visited.add(current);
      idList(state.people.find(person => person.id === current)?.managerId).forEach(id => queue.push(id));
    }
    return false;
  }

  function departmentCycle(departmentId, parentId) {
    const queue = [parentId];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      if (current === departmentId) return true;
      visited.add(current);
      const department = state.departments.find(item => item.id === current);
      if (department?.parentDepartmentId) queue.push(department.parentDepartmentId);
      if (department?.reportsToDepartmentId) queue.push(department.reportsToDepartmentId);
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
      state.people.forEach(item => {
        item.managerId = joinIds(idList(item.managerId).map(managerId => managerId === oldId ? newId : managerId));
      });
      state.departments.forEach(item => {
        if (item.reportsToId === oldId) item.reportsToId = newId;
        item.headId = joinIds(idList(item.headId).map(headId => headId === oldId ? newId : headId));
      });
    } else {
      const department = state.departments.find(item => item.id === oldId);
      if (!department) return "Отдел не найден.";
      department.id = newId;
      state.people.forEach(item => { if (item.departmentId === oldId) item.departmentId = newId; });
      state.people.forEach(item => { if (item.reportsToDepartmentId === oldId) item.reportsToDepartmentId = newId; });
      state.departments.forEach(item => { if (item.parentDepartmentId === oldId) item.parentDepartmentId = newId; });
      state.departments.forEach(item => { if (item.reportsToDepartmentId === oldId) item.reportsToDepartmentId = newId; });
    }
    return "";
  }

  function handleFieldChange(control) {
    const entity = control.dataset.entity;
    const id = control.dataset.id;
    const field = control.dataset.field;
    const checkboxRoot = entity === "department" ? elements.departmentsTable : elements.peopleTable;
    const rawValue = control.type === "checkbox"
      ? joinIds([...checkboxRoot.querySelectorAll(`[data-entity="${entity}"][data-field="${field}"]`)]
        .filter(item => item.dataset.id === id && item.checked)
        .map(item => item.value))
      : control.multiple
      ? joinIds([...control.selectedOptions].map(item => item.value))
      : text(control.value);
    const value = field === "sortOrder" ? numericText(rawValue) : rawValue;
    const collection = entity === "person" ? state.people : state.departments;
    const item = collection.find(record => record.id === id);
    if (!item) return render();

    let error = "";
    if (field === "id") error = updateId(entity, id, value);
    else if (entity === "person" && field === "managerId" && personCycle(id, value)) error = "Нельзя назначить подчинённого руководителем: получится цикл.";
    else if (entity === "person" && field === "managerId" && value && (() => {
      const managerIds = idList(value);
      return managerIds.some(managerId => {
        const manager = state.people.find(person => person.id === managerId);
        return !manager || manager.departmentId !== item.departmentId;
      });
    })()) error = "Прямой руководитель должен быть сотрудником того же отдела.";
    else if (entity === "department" && field === "parentDepartmentId" && departmentCycle(id, value)) error = "Нельзя вложить отдел в самого себя или его дочерний отдел.";
    else if (entity === "department" && field === "reportsToDepartmentId" && departmentCycle(id, value)) error = "Нельзя подчинить отдел самому себе или его дочернему отделу.";
    else {
      if (entity === "person" && field === "departmentId") {
        state.departments.forEach(department => {
          if (department.id !== value) department.headId = joinIds(idList(department.headId).filter(headId => headId !== item.id));
        });
        item.managerId = joinIds(idList(item.managerId).filter(managerId => {
          const manager = state.people.find(person => person.id === managerId);
          return manager && manager.departmentId === value;
        }));
        state.people.forEach(person => {
          if (person.departmentId !== value) {
            person.managerId = joinIds(idList(person.managerId).filter(managerId => managerId !== item.id));
          }
        });
      }
      item[field] = value;
      if (entity === "person" && field === "managerId" && value) item.reportsToDepartmentId = "";
      if (entity === "person" && field === "reportsToDepartmentId" && value) item.managerId = "";
      if (entity === "department" && field === "reportsToId" && value) item.reportsToDepartmentId = "";
      if (entity === "department" && field === "reportsToDepartmentId" && value) item.reportsToId = "";
      if (entity === "department" && field === "headId" && value) {
        const selectedHeadIds = idList(value);
        state.departments.forEach(department => {
          if (department.id !== item.id) department.headId = joinIds(idList(department.headId).filter(headId => !selectedHeadIds.includes(headId)));
        });
        selectedHeadIds.forEach(headId => {
          const head = state.people.find(person => person.id === headId);
          if (head) head.departmentId = item.id;
        });
      }
    }

    if (error) alert(error);
    else saveState();
    render();
  }

  function addPerson() {
    const id = nextId();
    state.people.push({ id, name: "Новый сотрудник", position: "Должность", role: "employee", departmentId: "", managerId: "", reportsToDepartmentId: "", sortOrder: "" });
    saveState();
    render();
  }

  function addDepartment() {
    const id = nextId();
    state.departments.push({ id, name: "Новый отдел", parentDepartmentId: "", reportsToId: "", reportsToDepartmentId: "", headId: "", sortOrder: "" });
    saveState();
    render();
  }

  function deleteEntity(entity, id) {
    const item = entity === "person" ? state.people.find(record => record.id === id) : state.departments.find(record => record.id === id);
    if (!item || !confirm(`Удалить «${item.name}»? Связи с этой записью будут очищены.`)) return;

    if (entity === "person") {
      state.people = state.people.filter(person => person.id !== id);
      state.people.forEach(person => {
        person.managerId = joinIds(idList(person.managerId).filter(managerId => managerId !== id));
      });
      state.departments.forEach(department => {
        if (department.reportsToId === id) department.reportsToId = "";
        department.headId = joinIds(idList(department.headId).filter(headId => headId !== id));
      });
    } else {
      state.departments = state.departments.filter(department => department.id !== id);
      state.people.forEach(person => { if (person.departmentId === id) person.departmentId = ""; });
      state.people.forEach(person => { if (person.reportsToDepartmentId === id) person.reportsToDepartmentId = ""; });
      state.departments.forEach(department => { if (department.parentDepartmentId === id) department.parentDepartmentId = ""; });
      state.departments.forEach(department => { if (department.reportsToDepartmentId === id) department.reportsToDepartmentId = ""; });
    }
    saveState();
    render();
  }

  function csvEscape(value) {
    const result = String(value ?? "");
    return /[",\n\r]/.test(result) ? `"${result.replaceAll('"', '""')}"` : result;
  }

  function exportCsv() {
    const header = ["entity", "id", "sortOrder", "name", "position", "role", "departmentId", "managerId", "reportsToDepartmentId", "parentDepartmentId", "reportsToId", "headId"];
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
    const previousTransform = elements.chart.style.transform;
    const previousLeft = elements.chart.style.left;
    try {
      const width = Math.ceil(elements.chart.scrollWidth);
      const height = Math.ceil(elements.chart.scrollHeight);
      elements.chart.style.transform = "none";
      elements.chart.style.left = "0";
      await new Promise(requestAnimationFrame);
      const canvas = await window.html2canvas(elements.chart, {
        backgroundColor: "#ffffff",
        scale: 2,
        useCORS: true,
        width,
        height,
        windowWidth: width,
        windowHeight: height,
        scrollX: 0,
        scrollY: 0,
        onclone: doc => {
          const chart = doc.getElementById("chart");
          if (!chart) return;
          chart.style.transform = "none";
          chart.style.left = "0";
          chart.style.background = "#ffffff";
          chart.querySelectorAll("*").forEach(node => {
            node.style.boxShadow = "none";
            node.style.filter = "none";
          });
        }
      });
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
      elements.chart.style.transform = previousTransform;
      elements.chart.style.left = previousLeft;
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

  function toggleDepartment(departmentId) {
    if (!departmentId) return;
    if (collapsedDepartmentIds.has(departmentId)) collapsedDepartmentIds.delete(departmentId);
    else collapsedDepartmentIds.add(departmentId);
    autoFit = true;
    renderChart();
  }

  function setAllDepartmentsCollapsed(isCollapsed) {
    collapsedDepartmentIds = isCollapsed
      ? new Set(state.departments.map(department => department.id))
      : new Set();
    autoFit = true;
    renderChart();
  }

  function setChartLayout(layout) {
    if (!["horizontal", "vertical"].includes(layout)) return;
    chartLayout = layout;
    autoFit = true;
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
    else if (action === "toggle-department") toggleDepartment(event.target.closest("[data-department-id]")?.dataset.departmentId || "");
    else if (action === "expand-all-departments") setAllDepartmentsCollapsed(false);
    else if (action === "collapse-all-departments") setAllDepartmentsCollapsed(true);
    else if (action === "set-layout") setChartLayout(event.target.closest("[data-layout]")?.dataset.layout || "horizontal");
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
