import { randomBytes } from 'node:crypto';

export function generateShareToken() {
  return randomBytes(16).toString('base64url');
}
