const roles = new Set(["founder", "director", "manager", "employee"]);

const clean = value => String(value ?? "").trim();

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
      managerId: clean(raw?.managerId)
    };
  });

  const departments = payload.departments.map(raw => ({
    id: clean(raw?.id),
    name: clean(raw?.name),
    parentDepartmentId: clean(raw?.parentDepartmentId),
    reportsToId: clean(raw?.reportsToId),
    headId: joinIds(raw?.headId)
  }));

  const ids = [...people.map(item => item.id), ...departments.map(item => item.id)];
  if (ids.some(id => !id)) throw new ValidationError("ID не может быть пустым.");
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError("ID сотрудников и отделов должны быть уникальными.");
  }

  const peopleById = new Map(people.map(person => [person.id, person]));
  const departmentsById = new Map(departments.map(department => [department.id, department]));

  for (const person of people) {
    if (person.managerId && !peopleById.has(person.managerId)) {
      throw new ValidationError(`Руководитель сотрудника «${person.name}» не найден.`);
    }
    if (person.managerId && peopleById.get(person.managerId).departmentId !== person.departmentId) {
      throw new ValidationError(`Прямой руководитель сотрудника «${person.name}» должен быть из того же отдела.`);
    }
    if (person.departmentId && !departmentsById.has(person.departmentId)) {
      throw new ValidationError(`Отдел сотрудника «${person.name}» не найден.`);
    }
  }

  for (const department of departments) {
    if (department.parentDepartmentId && !departmentsById.has(department.parentDepartmentId)) {
      throw new ValidationError(`Родитель для отдела «${department.name}» не найден.`);
    }
    if (department.reportsToId && !peopleById.has(department.reportsToId)) {
      throw new ValidationError(`Куратор отдела «${department.name}» не найден.`);
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

  if (hasCycle(new Map(people.map(person => [person.id, person.managerId])))) {
    throw new ValidationError("Обнаружен цикл в подчинении сотрудников.");
  }
  if (hasCycle(new Map(departments.map(department => [department.id, department.parentDepartmentId])))) {
    throw new ValidationError("Обнаружен цикл во вложенности отделов.");
  }

  return { version: 2, people, departments };
}
