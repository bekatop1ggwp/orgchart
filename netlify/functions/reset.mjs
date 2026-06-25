import { handleError, json, requireWriteAccess } from "./_shared/http.mjs";
import { resetStructure } from "./_shared/storage.mjs";

export default async request => {
  try {
    if (request.method !== "POST") {
      return json({ error: "Метод не поддерживается." }, 405, { Allow: "POST" });
    }
    requireWriteAccess(request);
    return json(await resetStructure());
  } catch (error) {
    return handleError(error);
  }
};
