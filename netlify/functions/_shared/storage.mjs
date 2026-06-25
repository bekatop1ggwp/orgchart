import { getStore } from "@netlify/blobs";
import demoData from "../../../demo-data.json";
import { normalizeAndValidate } from "./validation.mjs";

const KEY = "current";

function store() {
  return getStore({ name: "org-chart", consistency: "strong" });
}

export async function readStructure() {
  const existing = await store().get(KEY, { type: "json" });
  if (existing) return existing;
  return writeStructure(demoData, 1);
}

export async function writeStructure(payload, forcedRevision = null) {
  const structure = normalizeAndValidate(payload);
  const current = forcedRevision === null
    ? await store().get(KEY, { type: "json" })
    : null;
  const revision = forcedRevision ?? ((Number(current?.revision) || 0) + 1);
  const saved = { ...structure, revision, updatedAt: new Date().toISOString() };
  await store().setJSON(KEY, saved);
  return saved;
}

export function resetStructure() {
  return writeStructure(demoData);
}
