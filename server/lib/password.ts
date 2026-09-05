const BCRYPT = { algorithm: 'bcrypt' as const, cost: 12 };

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, BCRYPT);
}

export function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
