const roles = new Set(["founder", "director", "manager", "employee"]);

const clean = value => String(value ?? "").trim();

function sortOrder(value) {
  const cleaned = clean(value);
  if (!cleaned) return "";
  const number = Number.parseInt(cleaned, 10);
  return Number.isFinite(number) ? String(number) : "";
}

function idList(value) {
  return clean(value).split(",").map(clean).filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
}

function joinIds(value) {
  return idList(value).join(",");
}

function hasCycle(parentById) {
  for (const start of parentById.keys()) {
    let current = start;
    const path = new Set();
    while (current) {
      if (path.has(current)) return true;
      path.add(current);
      current = parentById.get(current) || "";
    }
  }
  return false;
}

function hasGraphCycle(edgesById) {
  const visiting = new Set();
  const visited = new Set();

  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const parentId of edgesById.get(id) || []) {
      if (parentId && edgesById.has(parentId) && visit(parentId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const id of edgesById.keys()) {
    if (visit(id)) return true;
  }
  return false;
}

export class ValidationError extends Error {}

export function normalizeAndValidate(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Ожидался JSON-объект структуры.");
  }
  if (!Array.isArray(payload.people) || !Array.isArray(payload.departments)) {
    throw new ValidationError("people и departments должны быть массивами.");
  }

  const people = payload.people.map(raw => {
    const role = clean(raw?.role) || "employee";
    if (!roles.has(role)) throw new ValidationError(`Неизвестная роль: ${role}.`);
    return {
      id: clean(raw?.id),
      name: clean(raw?.name),
      position: clean(raw?.position),
      role,
      departmentId: clean(raw?.departmentId),
      managerId: joinIds(raw?.managerId),
      reportsToDepartmentId: clean(raw?.reportsToDepartmentId),
      sortOrder: sortOrder(raw?.sortOrder)
    };
  });

  const departments = payload.departments.map(raw => ({
    id: clean(raw?.id),
    name: clean(raw?.name),
    parentDepartmentId: clean(raw?.parentDepartmentId),
    reportsToId: clean(raw?.reportsToId),
    reportsToDepartmentId: clean(raw?.reportsToDepartmentId),
    headId: joinIds(raw?.headId),
    sortOrder: sortOrder(raw?.sortOrder)
  }));

  const ids = [...people.map(item => item.id), ...departments.map(item => item.id)];
  if (ids.some(id => !id)) throw new ValidationError("ID не может быть пустым.");
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError("ID сотрудников и отделов должны быть уникальными.");
  }

  const peopleById = new Map(people.map(person => [person.id, person]));
  const departmentsById = new Map(departments.map(department => [department.id, department]));

  for (const person of people) {
    const managerIds = idList(person.managerId);
    if (managerIds.includes(person.id)) {
      throw new ValidationError(`Сотрудник «${person.name}» не может быть руководителем самому себе.`);
    }
    for (const managerId of managerIds) {
      if (!peopleById.has(managerId)) {
        throw new ValidationError(`Руководитель сотрудника «${person.name}» не найден.`);
      }
      if (peopleById.get(managerId).departmentId !== person.departmentId) {
        throw new ValidationError(`Прямой руководитель сотрудника «${person.name}» должен быть из того же отдела.`);
      }
    }
    if (person.departmentId && !departmentsById.has(person.departmentId)) {
      throw new ValidationError(`Отдел сотрудника «${person.name}» не найден.`);
    }
    if (person.reportsToDepartmentId && !departmentsById.has(person.reportsToDepartmentId)) {
      throw new ValidationError(`Department parent for person "${person.name}" was not found.`);
    }
    if (managerIds.length && person.reportsToDepartmentId) {
      throw new ValidationError(`Person "${person.name}" can have only one hierarchy parent.`);
    }
  }

  for (const department of departments) {
    if (department.parentDepartmentId && !departmentsById.has(department.parentDepartmentId)) {
      throw new ValidationError(`Родитель для отдела «${department.name}» не найден.`);
    }
    if (department.reportsToId && !peopleById.has(department.reportsToId)) {
      throw new ValidationError(`Куратор отдела «${department.name}» не найден.`);
    }
    if (department.reportsToDepartmentId && !departmentsById.has(department.reportsToDepartmentId)) {
      throw new ValidationError(`Родительский отдел для «${department.name}» не найден.`);
    }
    if (department.reportsToId && department.reportsToDepartmentId) {
      throw new ValidationError(`У отдела «${department.name}» может быть только один внешний родитель.`);
    }
    for (const headId of idList(department.headId)) {
      if (!peopleById.has(headId)) {
        throw new ValidationError(`Руководитель отдела «${department.name}» не найден.`);
      }
      if (peopleById.get(headId).departmentId !== department.id) {
        throw new ValidationError(`Руководитель отдела «${department.name}» должен состоять в этом отделе.`);
      }
    }
  }

  if (hasGraphCycle(new Map(people.map(person => [person.id, idList(person.managerId)])))) {
    throw new ValidationError("Обнаружен цикл в подчинении сотрудников.");
  }
  if (hasGraphCycle(new Map(departments.map(department => [
    department.id,
    [department.parentDepartmentId, department.reportsToDepartmentId]
  ])))) {
    throw new ValidationError("Обнаружен цикл в связях отделов.");
  }

  return { version: 2, people, departments };
}
