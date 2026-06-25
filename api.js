(function exposeApi(global) {
  "use strict";

  const WRITE_KEY_STORAGE = "org-chart-write-key";

  async function request(path, options = {}, canRetryAuth = true) {
    const writeKey = sessionStorage.getItem(WRITE_KEY_STORAGE) || "";
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(writeKey ? { "X-Org-Chart-Key": writeKey } : {}),
          ...options.headers
        }
      });
    } catch (error) {
      throw new Error("Нет связи с локальным сервером. Запустите: python server.py");
    }

    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && options.requiresWriteAccess && canRetryAuth) {
      sessionStorage.removeItem(WRITE_KEY_STORAGE);
      const provided = prompt("Введите ключ редактирования оргструктуры:");
      if (provided === null) throw new Error("Сохранение отменено: требуется ключ редактирования.");
      sessionStorage.setItem(WRITE_KEY_STORAGE, provided);
      return request(path, options, false);
    }
    if (!response.ok) {
      throw new Error(payload.error || `Ошибка сервера: ${response.status}`);
    }
    return payload;
  }

  global.OrgChartApi = {
    getStructure() {
      return request("/api/structure");
    },
    replaceStructure(structure) {
      return request("/api/structure", {
        method: "PUT",
        body: JSON.stringify(structure),
        requiresWriteAccess: true
      });
    },
    resetDemo() {
      return request("/api/reset", { method: "POST", requiresWriteAccess: true });
    }
  };
})(window);
