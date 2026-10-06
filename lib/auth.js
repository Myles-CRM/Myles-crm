import { timingSafeEqual } from 'node:crypto';

export function tokenMatches(expected, actual) {
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(String(expected));
  const actualBuffer = Buffer.from(String(actual));
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
