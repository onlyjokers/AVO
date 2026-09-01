import { randomUUID } from "node:crypto";

export const createId = (prefix: string) => `${prefix}-${randomUUID()}`;

export const assertSafeId = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error("invalid_id");
  }
  return value;
};
