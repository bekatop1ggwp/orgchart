import { handleError, json } from "./_shared/http.mjs";
import { readStructure } from "./_shared/storage.mjs";

export default async request => {
  try {
    if (request.method !== "GET") {
      return json({ error: "Метод не поддерживается." }, 405, { Allow: "GET" });
    }
    const structure = await readStructure();
    return json({ status: "ok", storage: "netlify-blobs", revision: structure.revision });
  } catch (error) {
    return handleError(error);
  }
};
