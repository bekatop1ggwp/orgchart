import { handleError, json, requireWriteAccess } from "./_shared/http.mjs";
import { readStructure, writeStructure } from "./_shared/storage.mjs";

export default async request => {
  try {
    if (request.method === "GET") return json(await readStructure());
    if (request.method === "PUT") {
      requireWriteAccess(request);
      return json(await writeStructure(await request.json()));
    }
    return json({ error: "Метод не поддерживается." }, 405, { Allow: "GET, PUT" });
  } catch (error) {
    return handleError(error);
  }
};
